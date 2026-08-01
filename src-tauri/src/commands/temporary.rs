use crate::{
    commands::notes::NoteCommandState,
    domain::{NoteDocument, NoteId, TemporaryWindowState},
    error::CommandError,
    storage::paths::StoragePaths,
    windows::sticky::{
        parse_temporary_window_label, TauriTemporaryWindowBackend, TemporaryRepository,
        TemporaryWindowService,
    },
};
use serde::Deserialize;
use std::sync::{atomic::AtomicBool, Arc};
use tauri::{Manager, State, WindowEvent};

pub struct TemporaryCommandState {
    paths: StoragePaths,
    backend: TauriTemporaryWindowBackend,
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
    let shutdown_backend = backend.clone();
    if let Some(main_window) = app.get_webview_window("main") {
        main_window.on_window_event(move |event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                shutdown_backend.mark_shutting_down();
            }
        });
    } else {
        return Err("main window is unavailable during temporary setup".into());
    }
    app.manage(TemporaryCommandState { paths, backend });
    Ok(())
}

#[tauri::command]
pub fn create_temporary(
    state: State<'_, TemporaryCommandState>,
) -> Result<NoteDocument, CommandError> {
    TemporaryRepository::new(state.paths.clone()).create()
}

#[tauri::command(rename_all = "camelCase")]
pub fn save_temporary(
    state: State<'_, TemporaryCommandState>,
    input: SaveTemporaryInput,
) -> Result<NoteDocument, CommandError> {
    TemporaryRepository::new(state.paths.clone()).save(input.document, input.expected_revision)
}

#[tauri::command]
pub fn list_temporary(
    state: State<'_, TemporaryCommandState>,
) -> Result<Vec<NoteDocument>, CommandError> {
    TemporaryRepository::new(state.paths.clone()).list()
}

#[tauri::command(rename_all = "camelCase")]
pub fn show_temporary_window(
    state: State<'_, TemporaryCommandState>,
    note_id: NoteId,
) -> Result<TemporaryWindowState, CommandError> {
    service(&state).show(note_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn hide_temporary_window(
    state: State<'_, TemporaryCommandState>,
    note_id: NoteId,
) -> Result<(), CommandError> {
    service(&state).hide(note_id).map(|_| ())
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_temporary_window_state(
    window: tauri::WebviewWindow,
    state: State<'_, TemporaryCommandState>,
    window_state: TemporaryWindowState,
) -> Result<TemporaryWindowState, CommandError> {
    let label_note_id = parse_temporary_window_label(window.label())?;
    if label_note_id != window_state.note_id {
        return Err(CommandError::validation(
            "temporary window label does not match the requested note",
        ));
    }
    service(&state).set_state(window_state)
}

fn service(state: &TemporaryCommandState) -> TemporaryWindowService<TauriTemporaryWindowBackend> {
    TemporaryWindowService::new(state.paths.clone(), state.backend.clone())
}
