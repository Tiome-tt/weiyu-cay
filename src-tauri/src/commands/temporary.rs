use crate::{
    commands::notes::NoteCommandState,
    domain::{
        BatchConversionResult, DeleteTemporaryResult, FolderId, NoteDocument, NoteId,
        TemporaryWindowState, UndoTemporaryDeleteResult,
    },
    error::CommandError,
    storage::paths::StoragePaths,
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
}

impl TemporaryCommandState {
    pub(crate) fn paths(&self) -> &StoragePaths {
        &self.paths
    }

    pub(crate) fn backend(&self) -> &TauriTemporaryWindowBackend {
        &self.backend
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

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let paths = app.state::<NoteCommandState>().paths().clone();
    let shutting_down = Arc::new(AtomicBool::new(false));
    let backend =
        TauriTemporaryWindowBackend::new(app.handle().clone(), paths.clone(), shutting_down);
    TemporaryInboxService::new(paths.clone(), backend.clone()).recover_pending()?;
    app.manage(TemporaryCommandState { paths, backend });
    Ok(())
}

#[tauri::command]
pub fn create_temporary(
    window: tauri::WebviewWindow,
    state: State<'_, TemporaryCommandState>,
) -> Result<NoteDocument, CommandError> {
    authorize_temporary_caller(window.label(), TemporaryCommandOperation::Create, None)?;
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
    TemporaryRepository::new(state.paths.clone()).save(input.document, input.expected_revision)
}

#[tauri::command]
pub fn list_temporary(
    window: tauri::WebviewWindow,
    state: State<'_, TemporaryCommandState>,
) -> Result<Vec<NoteDocument>, CommandError> {
    authorize_temporary_caller(window.label(), TemporaryCommandOperation::List, None)?;
    inbox_service(&state).recover_pending()?;
    TemporaryRepository::new(state.paths.clone()).list()
}

#[tauri::command(rename_all = "camelCase")]
pub fn convert_temporary(
    window: tauri::WebviewWindow,
    state: State<'_, TemporaryCommandState>,
    ids: Vec<NoteId>,
    folder_id: FolderId,
) -> Result<BatchConversionResult, CommandError> {
    authorize_temporary_caller(window.label(), TemporaryCommandOperation::Convert, None)?;
    Ok(inbox_service(&state).convert(
        crate::domain::ConvertTemporaryInput { ids, folder_id },
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
    Ok(inbox_service(&state).delete(ids))
}

#[tauri::command(rename_all = "camelCase")]
pub fn undo_delete(
    window: tauri::WebviewWindow,
    state: State<'_, TemporaryCommandState>,
    operation_id: String,
) -> Result<UndoTemporaryDeleteResult, CommandError> {
    authorize_temporary_caller(window.label(), TemporaryCommandOperation::UndoDelete, None)?;
    inbox_service(&state).undo_delete(&operation_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn show_temporary_window(
    window: tauri::WebviewWindow,
    state: State<'_, TemporaryCommandState>,
    note_id: NoteId,
) -> Result<TemporaryWindowState, CommandError> {
    authorize_temporary_caller(window.label(), TemporaryCommandOperation::Show, None)?;
    service(&state).show(note_id)
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
