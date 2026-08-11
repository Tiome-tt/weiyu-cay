use crate::{
    commands::storage::{StorageCommandState, StorageConsumer},
    domain::{
        FolderId, LinkRepairResult, NoteDocument, NoteId, NoteSummary, PurgeTrashResult,
        RenameNoteResult, RestoreTrashResult, TrashBatchResult, TrashEntry,
    },
    error::CommandError,
    storage::{
        database::Database,
        paths::StoragePaths,
        repository::{normalized_note_title, LinkRepository, NoteRepository},
        trash::TrashService,
    },
    windows::sticky::{authorize_temporary_caller, TemporaryCommandOperation},
};
use serde::Deserialize;
use tauri::{Manager, State};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveNoteInput {
    document: NoteDocument,
    expected_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateNoteInput {
    pub folder_id: Option<FolderId>,
    pub title: String,
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    prepare_startup_repository(&app.state::<StorageCommandState>())?;
    Ok(())
}

#[doc(hidden)]
pub fn prepare_startup_repository(state: &StorageCommandState) -> Result<(), CommandError> {
    if state.readiness().ensure_ready().is_err() {
        return Ok(());
    }
    let paths = state.configured_paths().clone();
    {
        let _guard = crate::platform::IndexMutationLock::acquire(paths.root())?;
        let database = Database::open(paths.database())?;
        database.migrate()?;
        database.close()?;
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn create_note(
    state: State<'_, StorageCommandState>,
    input: CreateNoteInput,
) -> Result<NoteDocument, CommandError> {
    let guard = crate::platform::IndexMutationLock::acquire(
        state.paths_for(StorageConsumer::Notes)?.root(),
    )?;
    let now = chrono::Utc::now().to_rfc3339();
    repository(&state)?.create_locked(
        NoteDocument {
            id: NoteId::now_v7(),
            kind: crate::domain::NoteKind::Formal,
            title: normalized_note_title(&input.title)?,
            folder_id: input.folder_id,
            tags: Vec::new(),
            markdown: String::new(),
            revision: 0,
            created_at: now.clone(),
            updated_at: now,
        },
        &guard,
    )
}

#[tauri::command(rename_all = "camelCase")]
pub fn rename_note(
    state: State<'_, StorageCommandState>,
    note_id: NoteId,
    title: String,
) -> Result<RenameNoteResult, CommandError> {
    rename_note_in_storage(state.paths_for(StorageConsumer::Notes)?, note_id, &title)
}

#[doc(hidden)]
pub fn rename_note_in_storage(
    paths: &StoragePaths,
    note_id: NoteId,
    title: &str,
) -> Result<RenameNoteResult, CommandError> {
    let guard = crate::platform::IndexMutationLock::acquire(paths.root())?;
    let notes = NoteRepository::new(paths.clone());
    let document = notes.rename_note_locked(note_id, title, &guard)?;
    let link_repair = LinkRepository::new(paths.clone()).rename_target_labels_locked(
        note_id,
        &document.title,
        &guard,
    )?;
    // A self-link repair can publish one more revision after the title update.
    let document = notes.load_locked(note_id, &guard)?;
    Ok(RenameNoteResult {
        document,
        link_repair,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn load_note(
    state: State<'_, StorageCommandState>,
    note_id: NoteId,
) -> Result<NoteDocument, CommandError> {
    repository(&state)?.load(note_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn save_note(
    state: State<'_, StorageCommandState>,
    input: SaveNoteInput,
) -> Result<NoteDocument, CommandError> {
    let guard = crate::platform::IndexMutationLock::acquire(
        state.paths_for(StorageConsumer::Notes)?.root(),
    )?;
    repository(&state)?.save_locked(input.document, input.expected_revision, &guard)
}

#[tauri::command(rename_all = "camelCase")]
pub fn list_notes(
    state: State<'_, StorageCommandState>,
    folder_id: Option<FolderId>,
) -> Result<Vec<NoteSummary>, CommandError> {
    repository(&state)?.list_in_folder(folder_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn move_note(
    state: State<'_, StorageCommandState>,
    note_id: NoteId,
    folder_id: Option<FolderId>,
) -> Result<NoteDocument, CommandError> {
    let guard = crate::platform::IndexMutationLock::acquire(
        state.paths_for(StorageConsumer::Notes)?.root(),
    )?;
    repository(&state)?.move_note_locked(note_id, folder_id, &guard)
}

#[tauri::command(rename_all = "camelCase")]
pub fn trash_notes(
    window: tauri::WebviewWindow,
    state: State<'_, StorageCommandState>,
    note_ids: Vec<NoteId>,
) -> Result<TrashBatchResult, CommandError> {
    authorize_temporary_caller(window.label(), TemporaryCommandOperation::Delete, None)?;
    TrashService::new(state.paths_for(StorageConsumer::Trash)?.clone())
        .trash(note_ids, &chrono::Utc::now().to_rfc3339())
}

#[tauri::command]
pub fn list_trash(
    window: tauri::WebviewWindow,
    state: State<'_, StorageCommandState>,
) -> Result<Vec<TrashEntry>, CommandError> {
    authorize_temporary_caller(window.label(), TemporaryCommandOperation::List, None)?;
    TrashService::new(state.paths_for(StorageConsumer::Trash)?.clone()).list()
}

#[tauri::command(rename_all = "camelCase")]
pub fn restore_trash(
    window: tauri::WebviewWindow,
    state: State<'_, StorageCommandState>,
    note_ids: Vec<NoteId>,
) -> Result<RestoreTrashResult, CommandError> {
    authorize_temporary_caller(window.label(), TemporaryCommandOperation::UndoDelete, None)?;
    TrashService::new(state.paths_for(StorageConsumer::Trash)?.clone()).restore(note_ids)
}

#[tauri::command(rename_all = "camelCase")]
pub fn undo_trash(
    window: tauri::WebviewWindow,
    state: State<'_, StorageCommandState>,
    operation_id: String,
) -> Result<RestoreTrashResult, CommandError> {
    authorize_temporary_caller(window.label(), TemporaryCommandOperation::UndoDelete, None)?;
    TrashService::new(state.paths_for(StorageConsumer::Trash)?.clone()).undo(&operation_id)
}

#[tauri::command]
pub fn purge_expired_trash(
    window: tauri::WebviewWindow,
    state: State<'_, StorageCommandState>,
) -> Result<PurgeTrashResult, CommandError> {
    authorize_temporary_caller(window.label(), TemporaryCommandOperation::Delete, None)?;
    TrashService::new(state.paths_for(StorageConsumer::Trash)?.clone())
        .purge_expired(&chrono::Utc::now().to_rfc3339())
}

#[tauri::command(rename_all = "camelCase")]
pub fn resolve_link(
    state: State<'_, StorageCommandState>,
    note_id: NoteId,
) -> Result<Option<NoteSummary>, CommandError> {
    LinkRepository::new(state.paths_for(StorageConsumer::Links)?.clone()).resolve(note_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn backlinks(
    state: State<'_, StorageCommandState>,
    note_id: NoteId,
) -> Result<Vec<NoteSummary>, CommandError> {
    LinkRepository::new(state.paths_for(StorageConsumer::Links)?.clone()).backlinks(note_id)
}

#[tauri::command]
pub fn list_link_targets(
    state: State<'_, StorageCommandState>,
) -> Result<Vec<NoteSummary>, CommandError> {
    Ok(repository(&state)?
        .list()?
        .into_iter()
        .filter(|note| note.kind == crate::domain::NoteKind::Formal)
        .collect())
}

#[tauri::command(rename_all = "camelCase")]
pub fn rename_target_labels(
    state: State<'_, StorageCommandState>,
    note_id: NoteId,
    title: String,
) -> Result<LinkRepairResult, CommandError> {
    LinkRepository::new(state.paths_for(StorageConsumer::Links)?.clone())
        .rename_target_labels(note_id, &title)
}

fn repository(state: &StorageCommandState) -> Result<NoteRepository, CommandError> {
    Ok(NoteRepository::new(
        state.paths_for(StorageConsumer::Notes)?.clone(),
    ))
}
