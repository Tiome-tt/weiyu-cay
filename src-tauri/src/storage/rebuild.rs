use crate::{
    domain::{FolderId, NoteDocument, NoteId, NoteKind},
    error::CommandError,
    platform,
    storage::{
        database::Database,
        paths::StoragePaths,
        repository::{folder_id_blob, parse_document, persist_document_in_transaction},
    },
};
use chrono::DateTime;
use rusqlite::{params, Transaction};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildReport {
    pub notes_recovered: usize,
    pub notes_skipped: usize,
    pub notes_failed: usize,
    pub folders_recovered: usize,
    pub failures: Vec<RebuildFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildFailure {
    pub item: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FolderRecord {
    id: FolderId,
    parent_id: Option<FolderId>,
    name: String,
    sort_order: i64,
    created_at: String,
    updated_at: String,
}

pub fn rebuild_index(paths: &StoragePaths) -> Result<RebuildReport, CommandError> {
    let folders = read_folders(paths)?;
    let folder_ids = folders
        .iter()
        .map(|folder| folder.id)
        .collect::<HashSet<_>>();
    let (mut documents, mut report) = scan_documents(paths);
    documents.retain(|document| {
        if document.revision > i64::MAX as u64 {
            report.notes_failed += 1;
            report.failures.push(RebuildFailure {
                item: document.id.to_string(),
                message: "The note revision is too large for the local index.".to_owned(),
            });
            false
        } else if document
            .folder_id
            .is_some_and(|folder_id| !folder_ids.contains(&folder_id))
        {
            report.notes_failed += 1;
            report.failures.push(RebuildFailure {
                item: document.id.to_string(),
                message: "The note references a folder missing from folders.json.".to_owned(),
            });
            false
        } else {
            true
        }
    });

    report.notes_recovered = documents.len();
    report.folders_recovered = folders.len();
    let replacement = paths
        .root()
        .join(format!(".index.sqlite.{}.rebuild-new", Uuid::now_v7()));
    let build_result = build_replacement_database(&replacement, &folders, &documents);
    if let Err(error) = build_result {
        cleanup_replacement_files(&replacement);
        return Err(error);
    }
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&replacement)
        .and_then(|file| file.sync_all())
        .map_err(|source| {
            CommandError::io(format!("could not sync replacement index: {source}"))
        })?;

    let backup = paths
        .root()
        .join(format!(".index.sqlite.{}.rebuild-backup", Uuid::now_v7()));
    let isolated_sidecars = isolate_old_sidecars(paths.database(), &backup)?;
    let publication = platform::replace_file_with_backup(&replacement, paths.database(), &backup);
    match publication {
        Ok(crate::storage::atomic_file::PublishState::Published) => {}
        Ok(state) => {
            restore_old_sidecars(&isolated_sidecars);
            return Err(CommandError::io(format!(
                "replacement index returned invalid publication state: {state:?}"
            )));
        }
        Err(failure) => {
            restore_old_sidecars(&isolated_sidecars);
            if failure.cleanup_source() {
                cleanup_replacement_files(&replacement);
            }
            return Err(failure.into_error());
        }
    }
    if let Err(error) = platform::sync_parent(paths.root()) {
        return Err(CommandError::io(format!(
            "replacement index was published but its directory could not be synced: {}",
            error.diagnostic().unwrap_or("directory sync failed")
        )));
    }
    let marker = paths.root().join("rebuild-needed.json");
    match fs::remove_file(marker) {
        Ok(()) => {}
        Err(source) if source.kind() == ErrorKind::NotFound => {}
        Err(source) => {
            return Err(CommandError::io(format!(
                "index rebuilt but rebuild marker could not be removed: {source}"
            )))
        }
    }
    Ok(report)
}

fn build_replacement_database(
    path: &Path,
    folders: &[FolderRecord],
    documents: &[NoteDocument],
) -> Result<(), CommandError> {
    let database = Database::open_rebuild(path)?;
    database.migrate()?;
    let transaction = database
        .connection()
        .unchecked_transaction()
        .map_err(database_error("could not start index rebuild"))?;
    clear_rebuildable_rows(&transaction)?;
    insert_folders(&transaction, folders)?;
    for document in documents {
        persist_document_in_transaction(&transaction, document)?;
    }
    transaction
        .commit()
        .map_err(database_error("could not commit index rebuild"))?;
    database.close()
}

fn isolate_old_sidecars(
    database: &Path,
    backup: &Path,
) -> Result<Vec<(PathBuf, PathBuf)>, CommandError> {
    let mut isolated = Vec::new();
    for suffix in ["-wal", "-shm"] {
        let original = PathBuf::from(format!("{}{suffix}", database.display()));
        if !original.exists() {
            continue;
        }
        let destination = PathBuf::from(format!("{}{suffix}", backup.display()));
        if let Err(source) = fs::rename(&original, &destination) {
            restore_old_sidecars(&isolated);
            return Err(CommandError::io(format!(
                "could not isolate previous index sidecar: {source}"
            )));
        }
        isolated.push((original, destination));
    }
    Ok(isolated)
}

fn restore_old_sidecars(isolated: &[(PathBuf, PathBuf)]) {
    for (original, backup) in isolated.iter().rev() {
        if backup.exists() && !original.exists() {
            let _ = fs::rename(backup, original);
        }
    }
}

fn cleanup_replacement_files(database: &Path) {
    for path in [
        database.to_path_buf(),
        PathBuf::from(format!("{}-wal", database.display())),
        PathBuf::from(format!("{}-shm", database.display())),
        PathBuf::from(format!("{}-journal", database.display())),
    ] {
        let _ = fs::remove_file(path);
    }
}

fn read_folders(paths: &StoragePaths) -> Result<Vec<FolderRecord>, CommandError> {
    match fs::symlink_metadata(paths.folders_manifest()) {
        Err(source) if source.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => {
            return Err(CommandError::io(format!(
                "could not inspect folders manifest: {source}"
            )))
        }
        Ok(_) => {}
    }
    let directory = platform::SafeDirectory::open(paths.root(), &[], false)?;
    let contents =
        String::from_utf8(directory.read("folders.json", 8 * 1024 * 1024)?).map_err(|source| {
            CommandError::validation(format!("folders manifest is not UTF-8: {source}"))
        })?;
    let folders: Vec<FolderRecord> = serde_json::from_str(&contents).map_err(|source| {
        CommandError::validation(format!("folders manifest is invalid: {source}"))
    })?;
    let mut ids = HashSet::new();
    let mut root_names = HashSet::new();
    let mut child_names = HashSet::new();
    for folder in &folders {
        if folder.name.trim().is_empty() || folder.sort_order < 0 {
            return Err(CommandError::validation(
                "folders manifest contains invalid folder metadata",
            ));
        }
        DateTime::parse_from_rfc3339(&folder.created_at).map_err(|source| {
            CommandError::validation(format!("folder created timestamp is invalid: {source}"))
        })?;
        DateTime::parse_from_rfc3339(&folder.updated_at).map_err(|source| {
            CommandError::validation(format!("folder updated timestamp is invalid: {source}"))
        })?;
        if !ids.insert(folder.id) {
            return Err(CommandError::validation(
                "folders manifest contains duplicate IDs",
            ));
        }
        if let Some(parent) = folder.parent_id {
            if !child_names.insert((parent, folder.name.clone())) {
                return Err(CommandError::validation(
                    "folders manifest contains duplicate sibling names",
                ));
            }
        } else if !root_names.insert(folder.name.clone()) {
            return Err(CommandError::validation(
                "folders manifest contains duplicate root names",
            ));
        }
    }
    if folders.iter().any(|folder| {
        folder
            .parent_id
            .is_some_and(|parent| !ids.contains(&parent))
    }) {
        return Err(CommandError::validation(
            "folders manifest references a missing parent",
        ));
    }
    Ok(folders)
}

fn scan_documents(paths: &StoragePaths) -> (Vec<NoteDocument>, RebuildReport) {
    let mut documents = Vec::new();
    let mut seen = HashSet::new();
    let mut report = RebuildReport {
        notes_recovered: 0,
        notes_skipped: 0,
        notes_failed: 0,
        folders_recovered: 0,
        failures: Vec::new(),
    };
    for (root, expected_kind) in [
        (paths.notes(), NoteKind::Formal),
        (paths.temporary(), NoteKind::Temporary),
    ] {
        let entries = match fs::read_dir(root) {
            Ok(entries) => entries,
            Err(source) => {
                report.failures.push(RebuildFailure {
                    item: match expected_kind {
                        NoteKind::Formal => "notes".to_owned(),
                        NoteKind::Temporary => "temporary".to_owned(),
                    },
                    message: format!("The note collection could not be read: {source}"),
                });
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    report.notes_skipped += 1;
                    continue;
                }
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(path_id) = NoteId::parse_str(&name) else {
                report.notes_skipped += 1;
                continue;
            };
            let Ok(file_type) = entry.file_type() else {
                report.notes_skipped += 1;
                continue;
            };
            if !file_type.is_dir() || file_type.is_symlink() {
                report.notes_skipped += 1;
                continue;
            }
            let document_path = entry.path().join("note.md");
            let metadata = match fs::symlink_metadata(&document_path) {
                Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                    metadata
                }
                _ => {
                    report.notes_failed += 1;
                    report.failures.push(RebuildFailure {
                        item: name,
                        message: "The canonical note.md file is missing or unsafe.".to_owned(),
                    });
                    continue;
                }
            };
            if metadata.len() > 64 * 1024 * 1024 {
                report.notes_failed += 1;
                report.failures.push(RebuildFailure {
                    item: name,
                    message: "The note document exceeds the supported rebuild size.".to_owned(),
                });
                continue;
            }
            let collection = match expected_kind {
                NoteKind::Formal => "notes",
                NoteKind::Temporary => "temporary",
            };
            let contents = match platform::SafeDirectory::open(
                paths.root(),
                &[collection, name.as_str()],
                false,
            )
            .and_then(|directory| directory.read("note.md", 64 * 1024 * 1024))
            .and_then(|bytes| {
                String::from_utf8(bytes).map_err(|source| {
                    CommandError::validation(format!("note document is not UTF-8: {source}"))
                })
            }) {
                Ok(contents) => contents,
                Err(_) => {
                    report.notes_failed += 1;
                    report.failures.push(RebuildFailure {
                        item: name,
                        message: "The note document is unreadable or not UTF-8.".to_owned(),
                    });
                    continue;
                }
            };
            let document = match parse_document(&contents) {
                Ok(document) => document,
                Err(_) => {
                    report.notes_failed += 1;
                    report.failures.push(RebuildFailure {
                        item: name,
                        message: "The note frontmatter is malformed.".to_owned(),
                    });
                    continue;
                }
            };
            if document.id != path_id || document.kind != expected_kind || !seen.insert(document.id)
            {
                report.notes_failed += 1;
                report.failures.push(RebuildFailure {
                    item: name,
                    message: "The note identity or kind does not match its canonical directory."
                        .to_owned(),
                });
                continue;
            }
            documents.push(document);
        }
    }
    (documents, report)
}

fn clear_rebuildable_rows(transaction: &Transaction<'_>) -> Result<(), CommandError> {
    transaction
        .execute_batch(
            "DELETE FROM temporary_windows;\
             DELETE FROM note_links;\
             DELETE FROM note_tags;\
             DELETE FROM search_documents;\
             DELETE FROM notes;\
             DELETE FROM tags;\
             DELETE FROM folders;",
        )
        .map_err(database_error("could not clear rebuildable index rows"))
}

fn insert_folders(
    transaction: &Transaction<'_>,
    folders: &[FolderRecord],
) -> Result<(), CommandError> {
    let mut remaining = folders.iter().collect::<Vec<_>>();
    let mut inserted = HashSet::new();
    while !remaining.is_empty() {
        let before = remaining.len();
        let mut index = 0;
        while index < remaining.len() {
            let folder = remaining[index];
            if folder
                .parent_id
                .is_none_or(|parent| inserted.contains(&parent))
            {
                transaction
                    .execute(
                        "INSERT INTO folders (id, parent_id, name, sort_order, created_at, updated_at) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![
                            folder_id_blob(folder.id),
                            folder.parent_id.map(folder_id_blob),
                            folder.name,
                            folder.sort_order,
                            folder.created_at,
                            folder.updated_at,
                        ],
                    )
                    .map_err(database_error("could not rebuild folder metadata"))?;
                inserted.insert(folder.id);
                remaining.swap_remove(index);
            } else {
                index += 1;
            }
        }
        if remaining.len() == before {
            return Err(CommandError::validation(
                "folders manifest contains a parent cycle",
            ));
        }
    }
    Ok(())
}

fn database_error(context: &'static str) -> impl FnOnce(rusqlite::Error) -> CommandError {
    move |source| CommandError::database(format!("{context}: {source}"))
}
