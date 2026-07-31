use crate::{
    domain::{FolderId, NoteDocument, NoteId, NoteSummary},
    error::CommandError,
    storage::{database::Database, paths::StoragePaths, repository::NoteRepository},
};
use serde::Deserialize;
use tauri::{Manager, State};

pub struct NoteCommandState {
    paths: StoragePaths,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveNoteInput {
    document: NoteDocument,
    expected_revision: u64,
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let root = app.path().app_data_dir()?;
    let paths = StoragePaths::open(root)?;
    let database = Database::open(paths.database())?;
    database.migrate()?;
    database.close()?;
    app.manage(NoteCommandState { paths });
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn create_note(
    state: State<'_, NoteCommandState>,
    document: NoteDocument,
) -> Result<NoteDocument, CommandError> {
    repository(&state)?.create(document)
}

#[tauri::command(rename_all = "camelCase")]
pub fn load_note(
    state: State<'_, NoteCommandState>,
    note_id: NoteId,
) -> Result<NoteDocument, CommandError> {
    repository(&state)?.load(note_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn save_note(
    state: State<'_, NoteCommandState>,
    input: SaveNoteInput,
) -> Result<NoteDocument, CommandError> {
    repository(&state)?.save(input.document, input.expected_revision)
}

#[tauri::command(rename_all = "camelCase")]
pub fn list_notes(state: State<'_, NoteCommandState>) -> Result<Vec<NoteSummary>, CommandError> {
    repository(&state)?.list()
}

#[tauri::command(rename_all = "camelCase")]
pub fn move_note(
    state: State<'_, NoteCommandState>,
    note_id: NoteId,
    folder_id: Option<FolderId>,
) -> Result<NoteDocument, CommandError> {
    repository(&state)?.move_note(note_id, folder_id)
}

fn repository(state: &NoteCommandState) -> Result<NoteRepository, CommandError> {
    let database = Database::open(state.paths.database())?;
    database.migrate()?;
    Ok(NoteRepository::new(state.paths.clone(), database))
}
