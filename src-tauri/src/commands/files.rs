use crate::{
    commands::storage::{StorageCommandState, StorageConsumer},
    domain::NoteId,
    error::CommandError,
    storage::{
        managed_files::{
            self, ImportFailure, ImportFilesInput, ImportFilesResult, ManagedFileBytes,
        },
        paths::StoragePaths,
    },
};
use tauri::{ipc::Response, State};
use tauri_plugin_fs::FsExt;
use tauri_plugin_opener::OpenerExt;
fn main_window(window: &tauri::WebviewWindow) -> Result<(), CommandError> {
    if window.label() != "main" {
        return Err(CommandError::validation(
            "file operations require the main window",
        ));
    }
    Ok(())
}
#[tauri::command(rename_all = "camelCase")]
pub fn import_files(
    window: tauri::WebviewWindow,
    state: State<'_, StorageCommandState>,
    input: ImportFilesInput,
) -> Result<ImportFilesResult, CommandError> {
    main_window(&window)?;
    let scope = window.fs_scope();
    import_files_with_scope(state.paths_for(StorageConsumer::Notes)?, input, |path| {
        scope.is_allowed(path)
    })
}

#[doc(hidden)]
pub fn import_files_with_scope(
    paths: &StoragePaths,
    input: ImportFilesInput,
    is_allowed: impl Fn(&std::path::Path) -> bool,
) -> Result<ImportFilesResult, CommandError> {
    if input.paths.len() > 1000 {
        return Err(CommandError::validation("too many files in one import"));
    }
    let mut selected = Vec::new();
    let mut failed = Vec::new();
    for source in input.paths {
        let path = std::path::Path::new(&source);
        if is_allowed(path) {
            selected.push(source);
        } else {
            failed.push(ImportFailure {
                name: path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "file".into()),
                message: "import source must be selected or dropped by the user".into(),
            });
        }
    }
    let mut result = managed_files::import_files(
        paths,
        ImportFilesInput {
            paths: selected,
            folder_id: input.folder_id,
        },
    )?;
    result.failed.extend(failed);
    Ok(result)
}
#[tauri::command(rename_all = "camelCase")]
pub fn read_managed_file(
    window: tauri::WebviewWindow,
    state: State<'_, StorageCommandState>,
    note_id: NoteId,
) -> Result<ManagedFileBytes, CommandError> {
    main_window(&window)?;
    // Keep the compatibility path identical to the original structured command.
    // The renderer only uses it after raw-byte IPC or PDF.js parsing fails.
    managed_files::read_file(state.paths_for(StorageConsumer::Notes)?, note_id)
}
#[tauri::command(rename_all = "camelCase")]
pub async fn read_managed_file_bytes(
    window: tauri::WebviewWindow,
    state: State<'_, StorageCommandState>,
    note_id: NoteId,
) -> Result<Response, CommandError> {
    main_window(&window)?;
    let paths = state.paths_for(StorageConsumer::Notes)?.clone();
    // Keep SQLite and managed-file I/O off Tauri's native UI event loop.
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        managed_files::read_file_bytes(&paths, note_id)
    })
    .await
    .map_err(|source| CommandError::io(format!("could not read managed file: {source}")))??;
    Ok(Response::new(bytes))
}
#[tauri::command(rename_all = "camelCase")]
pub fn export_managed_file(
    window: tauri::WebviewWindow,
    state: State<'_, StorageCommandState>,
    note_id: NoteId,
    destination: String,
) -> Result<(), CommandError> {
    main_window(&window)?;
    if !window
        .fs_scope()
        .is_allowed(std::path::Path::new(&destination))
    {
        return Err(CommandError::validation(
            "export destination must be selected by the user",
        ));
    }
    managed_files::export_file(
        state.paths_for(StorageConsumer::Notes)?,
        note_id,
        std::path::Path::new(&destination),
    )
}
#[tauri::command(rename_all = "camelCase")]
pub fn open_managed_file(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, StorageCommandState>,
    note_id: NoteId,
) -> Result<(), CommandError> {
    main_window(&window)?;
    let path = managed_files::external_copy(state.paths_for(StorageConsumer::Notes)?, note_id)?;
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|_| CommandError::io("could not open the external Office copy"))
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentExportInput {
    pub note_id: NoteId,
    pub destination: String,
    pub bytes: Vec<u8>,
}
#[tauri::command(rename_all = "camelCase")]
pub fn save_document_export(
    window: tauri::WebviewWindow,
    state: State<'_, StorageCommandState>,
    input: DocumentExportInput,
) -> Result<(), CommandError> {
    main_window(&window)?;
    if !window
        .fs_scope()
        .is_allowed(std::path::Path::new(&input.destination))
    {
        return Err(CommandError::validation(
            "DOCX destination must be selected by the user",
        ));
    }
    managed_files::save_document_export(
        state.paths_for(StorageConsumer::Notes)?,
        input.note_id,
        std::path::Path::new(&input.destination),
        &input.bytes,
    )
}
