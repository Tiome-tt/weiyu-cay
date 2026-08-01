use crate::{
    commands::notes::NoteCommandState,
    domain::{NoteDocument, NoteId, TemporaryWindowState},
    error::CommandError,
    storage::paths::StoragePaths,
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
    TemporaryRepository::new(state.paths.clone()).list()
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
