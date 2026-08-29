use crate::{
    commands::storage::StorageCommandState,
    domain::{
        BatchConversionResult, DeleteTemporaryResult, FolderId, NoteDocument, NoteId,
        TemporaryWindowState, UndoTemporaryDeleteResult,
    },
    error::CommandError,
    storage::paths::StoragePaths,
    storage::recovery::StartupRecoveryReadiness,
    storage::temporary_ops::TemporaryInboxService,
    windows::sticky::{
        authorize_temporary_caller, AppLifecycleEvent, TauriTemporaryWindowBackend,
        TemporaryCommandOperation, TemporaryRepository, TemporaryWindowService,
    },
};
use serde::Deserialize;
use std::sync::{atomic::AtomicBool, Arc};
use tauri::{Manager, State};

pub struct TemporaryCommandState {
    paths: StoragePaths,
    backend: TauriTemporaryWindowBackend,
    readiness: StartupRecoveryReadiness,
}

impl TemporaryCommandState {
    pub(crate) fn paths(&self) -> &StoragePaths {
        &self.paths
    }

    pub(crate) fn backend(&self) -> &TauriTemporaryWindowBackend {
        &self.backend
    }

    pub(crate) fn readiness(&self) -> StartupRecoveryReadiness {
        self.readiness.clone()
    }

    fn ensure_ready(&self) -> Result<(), CommandError> {
        self.readiness.ensure_ready()
    }

    pub(crate) fn finish_startup_recovery(&self) -> Result<(), CommandError> {
        TemporaryInboxService::new(self.paths.clone(), self.backend.clone()).recover_pending()?;
        crate::storage::trash::run_startup_trash_maintenance(
            self.paths.clone(),
            &chrono::Utc::now().to_rfc3339(),
        )
    }

    pub fn mark_lifecycle(&self, event: AppLifecycleEvent) {
        if crate::windows::sticky::reduce_shutdown_lifecycle(false, event) {
            self.backend.mark_shutting_down();
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTemporaryInput {
    document: NoteDocument,
    expected_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConvertTemporaryCommandInput {
    ids: Vec<NoteId>,
    folder_id: FolderId,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let paths = app
        .state::<StorageCommandState>()
        .configured_paths()
        .clone();
    let shutting_down = Arc::new(AtomicBool::new(false));
    let window_paths = app
        .state::<StorageCommandState>()
        .configured_paths()
        .clone();
    let backend =
        TauriTemporaryWindowBackend::new(app.handle().clone(), window_paths, shutting_down);
    let readiness = app.state::<StorageCommandState>().readiness();
    let state = TemporaryCommandState {
        paths,
        backend,
        readiness,
    };
    if state.ensure_ready().is_ok() {
        state.finish_startup_recovery()?;
    }
    app.manage(state);
    Ok(())
}

#[tauri::command]
pub fn create_temporary(
    window: tauri::WebviewWindow,
    state: State<'_, TemporaryCommandState>,
) -> Result<NoteDocument, CommandError> {
    authorize_temporary_caller(window.label(), TemporaryCommandOperation::Create, None)?;
    state.ensure_ready()?;
    TemporaryRepository::new(state.paths.clone()).create()
}

#[tauri::command(rename_all = "camelCase")]
pub fn load_temporary(
    window: tauri::WebviewWindow,
    state: State<'_, TemporaryCommandState>,
    note_id: NoteId,
) -> Result<NoteDocument, CommandError> {
    authorize_temporary_caller(
        window.label(),
        TemporaryCommandOperation::Load,
        Some(note_id),
    )?;
    state.ensure_ready()?;
    TemporaryRepository::new(state.paths.clone()).load(note_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn save_temporary(
    window: tauri::WebviewWindow,
    state: State<'_, TemporaryCommandState>,
    input: SaveTemporaryInput,
) -> Result<NoteDocument, CommandError> {
    authorize_temporary_caller(
        window.label(),
        TemporaryCommandOperation::Save,
        Some(input.document.id),
    )?;
    state.ensure_ready()?;
    TemporaryRepository::new(state.paths.clone()).save(input.document, input.expected_revision)
}

#[tauri::command]
pub fn list_temporary(
    window: tauri::WebviewWindow,
    state: State<'_, TemporaryCommandState>,
) -> Result<Vec<NoteDocument>, CommandError> {
    authorize_temporary_caller(window.label(), TemporaryCommandOperation::List, None)?;
    state.ensure_ready()?;
    inbox_service(&state).recover_pending()?;
    TemporaryRepository::new(state.paths.clone()).list()
}

#[tauri::command(rename_all = "camelCase")]
pub fn convert_temporary(
    window: tauri::WebviewWindow,
    state: State<'_, TemporaryCommandState>,
    input: ConvertTemporaryCommandInput,
) -> Result<BatchConversionResult, CommandError> {
    authorize_temporary_caller(window.label(), TemporaryCommandOperation::Convert, None)?;
    state.ensure_ready()?;
    Ok(inbox_service(&state).convert_with_metadata(
        input.ids,
        input.folder_id,
        input.title,
        input.tags,
        &chrono::Utc::now().to_rfc3339(),
    ))
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_temporary(
    window: tauri::WebviewWindow,
    state: State<'_, TemporaryCommandState>,
    ids: Vec<NoteId>,
) -> Result<DeleteTemporaryResult, CommandError> {
    authorize_temporary_caller(window.label(), TemporaryCommandOperation::Delete, None)?;
    state.ensure_ready()?;
    Ok(inbox_service(&state).delete(ids))
}

#[tauri::command(rename_all = "camelCase")]
pub fn undo_delete(
    window: tauri::WebviewWindow,
    state: State<'_, TemporaryCommandState>,
    operation_id: String,
) -> Result<UndoTemporaryDeleteResult, CommandError> {
    authorize_temporary_caller(window.label(), TemporaryCommandOperation::UndoDelete, None)?;
    state.ensure_ready()?;
    inbox_service(&state).undo_delete(&operation_id)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn show_temporary_window(
    window: tauri::WebviewWindow,
    state: State<'_, TemporaryCommandState>,
    note_id: NoteId,
) -> Result<TemporaryWindowState, CommandError> {
    authorize_temporary_caller(window.label(), TemporaryCommandOperation::Show, None)?;
    state.ensure_ready()?;
    // Wry requires native window creation to happen off the event-loop thread.
    // Running the synchronous storage/native workflow in the async runtime's
    // blocking pool prevents a display request from freezing the main window
    // while WebView2 creates its child window.
    let paths = state.paths.clone();
    let backend = state.backend.clone();
    tauri::async_runtime::spawn_blocking(move || {
        TemporaryWindowService::new(paths, backend).show(note_id)
    })
    .await
    .map_err(|_| CommandError::io("temporary window task terminated unexpectedly"))?
}

#[tauri::command(rename_all = "camelCase")]
pub fn hide_temporary_window(
    window: tauri::WebviewWindow,
    state: State<'_, TemporaryCommandState>,
    note_id: NoteId,
) -> Result<(), CommandError> {
    authorize_temporary_caller(
        window.label(),
        TemporaryCommandOperation::Hide,
        Some(note_id),
    )?;
    state.ensure_ready()?;
    service(&state).hide(note_id).map(|_| ())
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_temporary_always_on_top(
    window: tauri::WebviewWindow,
    state: State<'_, TemporaryCommandState>,
    note_id: NoteId,
    always_on_top: bool,
) -> Result<TemporaryWindowState, CommandError> {
    authorize_temporary_caller(
        window.label(),
        TemporaryCommandOperation::SetPin,
        Some(note_id),
    )?;
    state.ensure_ready()?;
    service(&state).set_always_on_top(note_id, always_on_top)
}

fn service(state: &TemporaryCommandState) -> TemporaryWindowService<TauriTemporaryWindowBackend> {
    TemporaryWindowService::new(state.paths.clone(), state.backend.clone())
}

fn inbox_service(
    state: &TemporaryCommandState,
) -> TemporaryInboxService<TauriTemporaryWindowBackend> {
    TemporaryInboxService::new(state.paths.clone(), state.backend.clone())
}
