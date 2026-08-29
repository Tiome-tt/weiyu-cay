use crate::{
    commands::storage::{StorageCommandState, StorageConsumer},
    domain::{CreateFolderInput, Folder, FolderId, NoteId},
    error::CommandError,
    storage::{
        atomic_file::{atomic_replace_contained, PublishFailure, PublishState},
        database::Database,
        paths::StoragePaths,
        repository::folder_id_blob,
        trash::{TrashFolderSnapshot, TrashService},
    },
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

pub struct FolderRepository {
    paths: StoragePaths,
}

impl FolderRepository {
    pub fn new(paths: StoragePaths) -> Self {
        Self { paths }
    }

    pub fn list(&self) -> Result<Vec<Folder>, CommandError> {
        let _guard = crate::platform::IndexMutationLock::acquire(self.paths.root())?;
        let database = self.database()?;
        let mut statement = database
            .connection()
            .prepare(
                "SELECT id, parent_id, name, sort_order, starred FROM folders \
                 ORDER BY CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END, parent_id, sort_order, name, id",
            )
            .map_err(database_error("could not prepare folder list"))?;
        let folders = statement
            .query_map([], folder_from_row)
            .map_err(database_error("could not query folders"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error("could not read folders"))?;
        Ok(folders)
    }

    pub fn create(&self, input: CreateFolderInput) -> Result<Folder, CommandError> {
        let guard = crate::platform::IndexMutationLock::acquire(self.paths.root())?;
        self.create_locked(input, &guard)
    }

    pub(crate) fn ensure_system_root_locked(
        &self,
        id: FolderId,
        preferred_name: &str,
        _guard: &crate::platform::IndexMutationLock,
    ) -> Result<Folder, CommandError> {
        let database = self.database()?;
        let transaction = database
            .connection()
            .unchecked_transaction()
            .map_err(database_error("could not start system folder creation"))?;
        if let Some(existing) = transaction
            .query_row(
                "SELECT id, parent_id, name, sort_order, starred FROM folders WHERE id=?1",
                [folder_id_blob(id)],
                folder_from_row,
            )
            .optional()
            .map_err(database_error("could not inspect system folder"))?
        {
            return Ok(existing);
        }
        let preferred_name = validate_name(preferred_name)?;
        let mut name = preferred_name.clone();
        let mut suffix = 1_u32;
        while transaction
            .query_row(
                "SELECT 1 FROM folders WHERE parent_id IS NULL AND name=?1",
                [&name],
                |_| Ok(()),
            )
            .optional()
            .map_err(database_error("could not inspect system folder name"))?
            .is_some()
        {
            name = if suffix == 1 {
                format!("{preferred_name} (系统)")
            } else {
                format!("{preferred_name} (系统 {suffix})")
            };
            suffix = suffix
                .checked_add(1)
                .ok_or_else(|| CommandError::validation("system folder suffix overflow"))?;
        }
        let sort_order = next_sort_order(&transaction, None)?;
        transaction
            .execute(
                "INSERT INTO folders (id, parent_id, name, sort_order, created_at, updated_at) \
                 VALUES (?1, NULL, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                params![folder_id_blob(id), name, sort_order],
            )
            .map_err(database_error("could not create system folder"))?;
        write_manifest(&transaction, &self.paths)?;
        transaction
            .commit()
            .map_err(database_error("could not commit system folder creation"))?;
        Ok(Folder {
            id,
            parent_id: None,
            name,
            sort_order,
            starred: false,
        })
    }
    #[doc(hidden)]
    pub fn create_locked(
        &self,
        input: CreateFolderInput,
        _guard: &crate::platform::IndexMutationLock,
    ) -> Result<Folder, CommandError> {
        let database = self.database()?;
        let name = validate_name(&input.name)?;
        let transaction = database
            .connection()
            .unchecked_transaction()
            .map_err(database_error("could not start folder creation"))?;
        validate_parent(&transaction, input.parent_id)?;
        reject_name_conflict(&transaction, input.parent_id, &name, None)?;
        let sort_order = next_sort_order(&transaction, input.parent_id)?;
        let id =
            FolderId::parse_str(&Uuid::now_v7().hyphenated().to_string()).map_err(|source| {
                CommandError::database(format!("could not generate folder ID: {source}"))
            })?;
        let parent = input.parent_id.map(folder_id_blob);
        transaction
            .execute(
                "INSERT INTO folders (id, parent_id, name, sort_order, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                params![folder_id_blob(id), parent, name, sort_order],
            )
            .map_err(database_error("could not create folder"))?;
        write_manifest(&transaction, &self.paths)?;
        transaction
            .commit()
            .map_err(database_error("could not commit folder creation"))?;
        Ok(Folder {
            id,
            parent_id: input.parent_id,
            name,
            sort_order,
            starred: false,
        })
    }

    pub fn rename(&self, id: FolderId, name: String) -> Result<Folder, CommandError> {
        let guard = crate::platform::IndexMutationLock::acquire(self.paths.root())?;
        self.rename_locked(id, name, &guard)
    }
    #[doc(hidden)]
    pub fn rename_locked(
        &self,
        id: FolderId,
        name: String,
        _guard: &crate::platform::IndexMutationLock,
    ) -> Result<Folder, CommandError> {
        let database = self.database()?;
        let name = validate_name(&name)?;
        let transaction = database
            .connection()
            .unchecked_transaction()
            .map_err(database_error("could not start folder rename"))?;
        let current = find_folder(&transaction, id)?;
        reject_name_conflict(&transaction, current.parent_id, &name, Some(id))?;
        transaction
            .execute(
                "UPDATE folders SET name = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2",
                params![name, folder_id_blob(id)],
            )
            .map_err(database_error("could not rename folder"))?;
        write_manifest(&transaction, &self.paths)?;
        transaction
            .commit()
            .map_err(database_error("could not commit folder rename"))?;
        Ok(Folder { name, ..current })
    }

    pub fn move_folder(
        &self,
        id: FolderId,
        parent_id: Option<FolderId>,
    ) -> Result<Folder, CommandError> {
        let guard = crate::platform::IndexMutationLock::acquire(self.paths.root())?;
        self.move_folder_locked(id, parent_id, &guard)
    }

    pub fn set_starred(&self, id: FolderId, starred: bool) -> Result<Folder, CommandError> {
        let guard = crate::platform::IndexMutationLock::acquire(self.paths.root())?;
        let database = self.database()?;
        let transaction = database
            .connection()
            .unchecked_transaction()
            .map_err(database_error("could not start folder star update"))?;
        let changed = transaction
            .execute(
                "UPDATE folders SET starred=?1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?2",
                params![starred, folder_id_blob(id)],
            )
            .map_err(database_error("could not update folder star"))?;
        if changed == 0 {
            return Err(CommandError::not_found("folder does not exist"));
        }
        let folder = find_folder(&transaction, id)?;
        write_manifest(&transaction, &self.paths)?;
        transaction
            .commit()
            .map_err(database_error("could not commit folder star update"))?;
        drop(guard);
        Ok(folder)
    }

    pub fn reorder(
        &self,
        parent_id: Option<FolderId>,
        ordered_ids: Vec<FolderId>,
    ) -> Result<(), CommandError> {
        let _guard = crate::platform::IndexMutationLock::acquire(self.paths.root())?;
        let database = self.database()?;
        let transaction = database
            .connection()
            .unchecked_transaction()
            .map_err(database_error("could not start folder reorder"))?;
        let mut statement = transaction
            .prepare("SELECT id FROM folders WHERE parent_id IS ?1")
            .map_err(database_error("could not prepare folder reorder"))?;
        let existing = statement
            .query_map(params![parent_id.map(folder_id_blob)], |row| {
                let bytes: Vec<u8> = row.get(0)?;
                folder_id_from_blob(&bytes)
            })
            .map_err(database_error("could not query folder reorder"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error("could not read folder reorder"))?;
        drop(statement);
        let mut final_order = ordered_ids
            .into_iter()
            .filter(|id| existing.contains(id))
            .collect::<Vec<_>>();
        for id in existing {
            if !final_order.contains(&id) {
                final_order.push(id);
            }
        }
        for (index, id) in final_order.iter().enumerate() {
            transaction.execute("UPDATE folders SET sort_order=?1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?2", params![i64::try_from(index).map_err(|_| CommandError::validation("folder order is too large"))?, folder_id_blob(*id)]).map_err(database_error("could not update folder order"))?;
        }
        write_manifest(&transaction, &self.paths)?;
        transaction
            .commit()
            .map_err(database_error("could not commit folder reorder"))
    }
    #[doc(hidden)]
    pub fn move_folder_locked(
        &self,
        id: FolderId,
        parent_id: Option<FolderId>,
        _guard: &crate::platform::IndexMutationLock,
    ) -> Result<Folder, CommandError> {
        let database = self.database()?;
        let transaction = database
            .connection()
            .unchecked_transaction()
            .map_err(database_error("could not start folder move"))?;
        let current = find_folder(&transaction, id)?;
        validate_parent(&transaction, parent_id)?;
        if parent_id == Some(id) || parent_is_descendant(&transaction, id, parent_id)? {
            return Err(CommandError::conflict("folder move would create a cycle"));
        }
        if current.parent_id == parent_id {
            transaction
                .commit()
                .map_err(database_error("could not finish unchanged folder move"))?;
            return Ok(current);
        }
        reject_name_conflict(&transaction, parent_id, &current.name, Some(id))?;
        let new_order = next_sort_order(&transaction, parent_id)?;
        let old_parent = current.parent_id.map(folder_id_blob);
        transaction
            .execute(
                "UPDATE folders SET parent_id = ?1, sort_order = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?3",
                params![parent_id.map(folder_id_blob), new_order, folder_id_blob(id)],
            )
            .map_err(database_error("could not move folder"))?;
        transaction
            .execute(
                "UPDATE folders SET sort_order = sort_order - 1 WHERE parent_id IS ?1 AND sort_order > ?2",
                params![old_parent, current.sort_order],
            )
            .map_err(database_error("could not compact former folder siblings"))?;
        write_manifest(&transaction, &self.paths)?;
        transaction
            .commit()
            .map_err(database_error("could not commit folder move"))?;
        Ok(Folder {
            parent_id,
            sort_order: new_order,
            starred: current.starred,
            ..current
        })
    }

    pub fn delete_empty(&self, id: FolderId) -> Result<String, CommandError> {
        let guard = crate::platform::IndexMutationLock::acquire(self.paths.root())?;
        self.delete_empty_locked(id, &guard)
    }

    pub fn delete(&self, id: FolderId) -> Result<String, CommandError> {
        let (note_ids, folder_snapshot) = {
            let _guard = crate::platform::IndexMutationLock::acquire(self.paths.root())?;
            let database = self.database()?;
            let mut notes = database.connection().prepare("WITH RECURSIVE subtree(id) AS (SELECT ?1 UNION ALL SELECT folders.id FROM folders JOIN subtree ON folders.parent_id = subtree.id) SELECT notes.id FROM notes JOIN subtree ON notes.folder_id = subtree.id WHERE notes.deleted_at IS NULL AND notes.kind = 'formal'").map_err(database_error("could not prepare folder note deletion"))?;
            let note_ids = notes
                .query_map([folder_id_blob(id)], |row| {
                    let bytes: Vec<u8> = row.get(0)?;
                    note_id_from_blob(&bytes)
                })
                .map_err(database_error("could not query folder notes"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(database_error("could not read folder notes"))?;
            let mut folders = database.connection().prepare("WITH RECURSIVE subtree(id, depth) AS (SELECT id, 0 FROM folders WHERE id=?1 UNION ALL SELECT folders.id, subtree.depth + 1 FROM folders JOIN subtree ON folders.parent_id = subtree.id) SELECT folders.id, folders.parent_id, folders.name, folders.sort_order, folders.starred, folders.created_at, folders.updated_at FROM folders JOIN subtree ON subtree.id = folders.id ORDER BY subtree.depth ASC").map_err(database_error("could not prepare folder snapshot"))?;
            let folder_snapshot = folders
                .query_map([folder_id_blob(id)], |row| {
                    let id_bytes: Vec<u8> = row.get(0)?;
                    let parent_bytes: Option<Vec<u8>> = row.get(1)?;
                    Ok(TrashFolderSnapshot {
                        id: folder_id_from_blob(&id_bytes)?,
                        parent_id: parent_bytes
                            .as_deref()
                            .map(folder_id_from_blob)
                            .transpose()?,
                        name: row.get(2)?,
                        sort_order: row.get(3)?,
                        starred: row.get(4)?,
                        created_at: row.get(5)?,
                        updated_at: row.get(6)?,
                    })
                })
                .map_err(database_error("could not query folder snapshot"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(database_error("could not read folder snapshot"))?;
            (note_ids, folder_snapshot)
        };
        if folder_snapshot.is_empty() {
            return Err(CommandError::not_found("folder does not exist"));
        }
        let has_notes = !note_ids.is_empty();
        let trash = TrashService::new(self.paths.clone());
        let operation_id = if !has_notes {
            trash.prepare_folder_snapshot(
                folder_snapshot.clone(),
                &chrono::Utc::now().to_rfc3339(),
            )?
        } else {
            let result = trash.trash_with_folder_snapshot(
                note_ids,
                &chrono::Utc::now().to_rfc3339(),
                folder_snapshot,
            )?;
            if !result.failed.is_empty() {
                let rollback = trash.undo(&result.operation_id)?;
                if rollback.restored.len() != result.trashed.len() {
                    return Err(CommandError::io(
                        "folder deletion rollback is incomplete; retry recovery",
                    ));
                }
                return Err(CommandError::io(
                    "some folder notes could not be moved to the trash",
                ));
            }
            result.operation_id
        };
        let _guard = crate::platform::IndexMutationLock::acquire(self.paths.root())?;
        let database = self.database()?;
        let transaction = database
            .connection()
            .unchecked_transaction()
            .map_err(database_error("could not start folder deletion"))?;
        let current = find_folder(&transaction, id)?;
        let mut statement = transaction.prepare("WITH RECURSIVE subtree(id, depth) AS (SELECT id, 0 FROM folders WHERE id=?1 UNION ALL SELECT folders.id, subtree.depth + 1 FROM folders JOIN subtree ON folders.parent_id = subtree.id) SELECT id FROM subtree ORDER BY depth DESC").map_err(database_error("could not prepare folder tree deletion"))?;
        let folder_ids = statement
            .query_map([folder_id_blob(id)], |row| row.get::<_, Vec<u8>>(0))
            .map_err(database_error("could not query folder tree deletion"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error("could not read folder tree deletion"))?;
        drop(statement);
        for folder_id in folder_ids {
            transaction
                .execute("DELETE FROM folders WHERE id=?1", [folder_id])
                .map_err(database_error("could not delete folder tree"))?;
        }
        transaction.execute("UPDATE folders SET sort_order = sort_order - 1 WHERE parent_id IS ?1 AND sort_order > ?2", params![current.parent_id.map(folder_id_blob), current.sort_order]).map_err(database_error("could not compact folder siblings"))?;
        write_manifest(&transaction, &self.paths)?;
        transaction
            .commit()
            .map_err(database_error("could not commit folder deletion"))?;
        if !has_notes {
            trash.mark_folder_deleted(&operation_id, id)?;
        }
        Ok(operation_id)
    }
    #[doc(hidden)]
    pub fn delete_empty_locked(
        &self,
        id: FolderId,
        _guard: &crate::platform::IndexMutationLock,
    ) -> Result<String, CommandError> {
        let database = self.database()?;
        let transaction = database
            .connection()
            .unchecked_transaction()
            .map_err(database_error("could not start empty folder deletion"))?;
        let current = find_folder(&transaction, id)?;
        let id_blob = folder_id_blob(id);
        let child_count: i64 = transaction
            .query_row(
                "SELECT count(*) FROM folders WHERE parent_id = ?1",
                params![id_blob],
                |row| row.get(0),
            )
            .map_err(database_error("could not inspect child folders"))?;
        let note_count: i64 = transaction
            .query_row(
                "SELECT count(*) FROM notes WHERE folder_id = ?1",
                params![id_blob],
                |row| row.get(0),
            )
            .map_err(database_error("could not inspect folder notes"))?;
        if child_count > 0 || note_count > 0 {
            return Err(CommandError::conflict("folder is not empty"));
        }
        let snapshot = transaction
            .query_row(
                "SELECT id, parent_id, name, sort_order, starred, created_at, updated_at FROM folders WHERE id = ?1",
                params![id_blob],
                |row| {
                    let folder_id: Vec<u8> = row.get(0)?;
                    let parent_id: Option<Vec<u8>> = row.get(1)?;
                    Ok(TrashFolderSnapshot {
                        id: folder_id_from_blob(&folder_id)?,
                        parent_id: parent_id.as_deref().map(folder_id_from_blob).transpose()?,
                        name: row.get(2)?,
                        sort_order: row.get(3)?,
                        starred: row.get(4)?,
                        created_at: row.get(5)?,
                        updated_at: row.get(6)?,
                    })
                },
            )
            .map_err(database_error("could not snapshot empty folder"))?;
        let trash = TrashService::new(self.paths.clone());
        let operation_id =
            trash.prepare_folder_snapshot(vec![snapshot], &chrono::Utc::now().to_rfc3339())?;
        transaction
            .execute("DELETE FROM folders WHERE id = ?1", params![id_blob])
            .map_err(database_error("could not delete empty folder"))?;
        transaction
            .execute(
                "UPDATE folders SET sort_order = sort_order - 1 WHERE parent_id IS ?1 AND sort_order > ?2",
                params![current.parent_id.map(folder_id_blob), current.sort_order],
            )
            .map_err(database_error("could not compact folder siblings"))?;
        write_manifest(&transaction, &self.paths)?;
        transaction
            .commit()
            .map_err(database_error("could not commit empty folder deletion"))?;
        trash.mark_folder_deleted(&operation_id, id)?;
        Ok(operation_id)
    }
    fn database(&self) -> Result<Database, CommandError> {
        let database = Database::open(self.paths.database())?;
        database.migrate()?;
        Ok(database)
    }
}

#[tauri::command]
pub fn list_folders(state: State<'_, StorageCommandState>) -> Result<Vec<Folder>, CommandError> {
    repository(&state)?.list()
}

#[tauri::command]
pub fn create_folder(
    state: State<'_, StorageCommandState>,
    input: CreateFolderInput,
) -> Result<Folder, CommandError> {
    let guard = crate::platform::IndexMutationLock::acquire(
        state.paths_for(StorageConsumer::Folders)?.root(),
    )?;
    repository(&state)?.create_locked(input, &guard)
}

#[tauri::command(rename_all = "camelCase")]
pub fn rename_folder(
    state: State<'_, StorageCommandState>,
    folder_id: FolderId,
    name: String,
) -> Result<Folder, CommandError> {
    let guard = crate::platform::IndexMutationLock::acquire(
        state.paths_for(StorageConsumer::Folders)?.root(),
    )?;
    repository(&state)?.rename_locked(folder_id, name, &guard)
}

#[tauri::command(rename_all = "camelCase")]
pub fn move_folder(
    state: State<'_, StorageCommandState>,
    folder_id: FolderId,
    parent_id: Option<FolderId>,
) -> Result<Folder, CommandError> {
    let guard = crate::platform::IndexMutationLock::acquire(
        state.paths_for(StorageConsumer::Folders)?.root(),
    )?;
    repository(&state)?.move_folder_locked(folder_id, parent_id, &guard)
}

#[tauri::command(rename_all = "camelCase")]
pub fn reorder_folders(
    state: State<'_, StorageCommandState>,
    parent_id: Option<FolderId>,
    ordered_ids: Vec<FolderId>,
) -> Result<(), CommandError> {
    repository(&state)?.reorder(parent_id, ordered_ids)
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_empty_folder(
    state: State<'_, StorageCommandState>,
    folder_id: FolderId,
) -> Result<String, CommandError> {
    let guard = crate::platform::IndexMutationLock::acquire(
        state.paths_for(StorageConsumer::Folders)?.root(),
    )?;
    repository(&state)?.delete_empty_locked(folder_id, &guard)
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_folder_starred(
    state: State<'_, StorageCommandState>,
    folder_id: FolderId,
    starred: bool,
) -> Result<Folder, CommandError> {
    repository(&state)?.set_starred(folder_id, starred)
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_folder(
    state: State<'_, StorageCommandState>,
    folder_id: FolderId,
) -> Result<String, CommandError> {
    repository(&state)?.delete(folder_id)
}

fn repository(state: &StorageCommandState) -> Result<FolderRepository, CommandError> {
    Ok(FolderRepository::new(
        state.paths_for(StorageConsumer::Folders)?.clone(),
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFolder {
    id: FolderId,
    parent_id: Option<FolderId>,
    name: String,
    sort_order: i64,
    starred: bool,
    created_at: String,
    updated_at: String,
}

pub(crate) fn write_manifest(
    transaction: &Transaction<'_>,
    paths: &StoragePaths,
) -> Result<(), CommandError> {
    let mut statement = transaction
        .prepare(
            "SELECT id, parent_id, name, sort_order, starred, created_at, updated_at FROM folders \
             ORDER BY CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END, parent_id, sort_order, name, id",
        )
        .map_err(database_error("could not prepare folders manifest"))?;
    let folders = statement
        .query_map([], |row| {
            let id: Vec<u8> = row.get(0)?;
            let parent_id: Option<Vec<u8>> = row.get(1)?;
            Ok(ManifestFolder {
                id: folder_id_from_blob(&id)?,
                parent_id: parent_id.as_deref().map(folder_id_from_blob).transpose()?,
                name: row.get(2)?,
                sort_order: row.get(3)?,
                starred: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(database_error("could not query folders manifest"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(database_error("could not read folders manifest"))?;
    let bytes = serde_json::to_vec_pretty(&folders).map_err(|source| {
        CommandError::io(format!("could not serialize folders manifest: {source}"))
    })?;
    match atomic_replace_contained(paths.root(), &[], "folders.json", &bytes) {
        Ok(PublishState::Published) => Ok(()),
        Ok(state) => Err(CommandError::io(format!(
            "folders manifest returned invalid publication state: {state:?}"
        ))),
        Err(failure) => Err(PublishFailure::into_error(failure)),
    }
}

fn validate_name(value: &str) -> Result<String, CommandError> {
    let name = value.trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.chars().any(char::is_control)
        || name.contains('/')
        || name.contains('\\')
    {
        return Err(CommandError::validation("folder name is unsafe"));
    }
    if name.chars().count() > 120 {
        return Err(CommandError::validation("folder name is too long"));
    }
    Ok(name.to_owned())
}

fn find_folder(transaction: &Transaction<'_>, id: FolderId) -> Result<Folder, CommandError> {
    transaction
        .query_row(
            "SELECT id, parent_id, name, sort_order, starred FROM folders WHERE id = ?1",
            params![folder_id_blob(id)],
            folder_from_row,
        )
        .optional()
        .map_err(database_error("could not find folder"))?
        .ok_or_else(|| CommandError::not_found("folder does not exist"))
}

fn validate_parent(
    transaction: &Transaction<'_>,
    parent_id: Option<FolderId>,
) -> Result<(), CommandError> {
    let Some(parent_id) = parent_id else {
        return Ok(());
    };
    let exists = transaction
        .query_row(
            "SELECT 1 FROM folders WHERE id = ?1",
            params![folder_id_blob(parent_id)],
            |_| Ok(()),
        )
        .optional()
        .map_err(database_error("could not validate parent folder"))?
        .is_some();
    if exists {
        Ok(())
    } else {
        Err(CommandError::not_found("parent folder does not exist"))
    }
}

fn reject_name_conflict(
    transaction: &Transaction<'_>,
    parent_id: Option<FolderId>,
    name: &str,
    except: Option<FolderId>,
) -> Result<(), CommandError> {
    let conflict = transaction
        .query_row(
            "SELECT 1 FROM folders WHERE parent_id IS ?1 AND name = ?2 AND (?3 IS NULL OR id != ?3)",
            params![parent_id.map(folder_id_blob), name, except.map(folder_id_blob)],
            |_| Ok(()),
        )
        .optional()
        .map_err(database_error("could not validate sibling folder name"))?
        .is_some();
    if conflict {
        Err(CommandError::conflict(
            "a sibling folder already has this name",
        ))
    } else {
        Ok(())
    }
}

fn next_sort_order(
    transaction: &Transaction<'_>,
    parent_id: Option<FolderId>,
) -> Result<i64, CommandError> {
    transaction
        .query_row(
            "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM folders WHERE parent_id IS ?1",
            params![parent_id.map(folder_id_blob)],
            |row| row.get(0),
        )
        .map_err(database_error("could not choose folder sort order"))
}

fn parent_is_descendant(
    transaction: &Transaction<'_>,
    id: FolderId,
    parent_id: Option<FolderId>,
) -> Result<bool, CommandError> {
    let Some(parent_id) = parent_id else {
        return Ok(false);
    };
    transaction
        .query_row(
            "WITH RECURSIVE descendants(id) AS (\
                 SELECT id FROM folders WHERE parent_id = ?1 \
                 UNION ALL \
                 SELECT folders.id FROM folders JOIN descendants ON folders.parent_id = descendants.id\
             ) SELECT 1 FROM descendants WHERE id = ?2 LIMIT 1",
            params![folder_id_blob(id), folder_id_blob(parent_id)],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
        .map_err(database_error("could not validate folder hierarchy"))
}

fn folder_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Folder> {
    let id: Vec<u8> = row.get(0)?;
    let parent_id: Option<Vec<u8>> = row.get(1)?;
    Ok(Folder {
        id: folder_id_from_blob(&id)?,
        parent_id: parent_id.as_deref().map(folder_id_from_blob).transpose()?,
        name: row.get(2)?,
        sort_order: row.get(3)?,
        starred: row.get(4)?,
    })
}

fn folder_id_from_blob(bytes: &[u8]) -> rusqlite::Result<FolderId> {
    let uuid = Uuid::from_slice(bytes).map_err(|source| {
        rusqlite::Error::FromSqlConversionFailure(
            bytes.len(),
            rusqlite::types::Type::Blob,
            Box::new(source),
        )
    })?;
    FolderId::parse_str(&uuid.hyphenated().to_string()).map_err(|source| {
        rusqlite::Error::FromSqlConversionFailure(
            bytes.len(),
            rusqlite::types::Type::Blob,
            Box::new(source),
        )
    })
}

fn note_id_from_blob(bytes: &[u8]) -> rusqlite::Result<NoteId> {
    let uuid = Uuid::from_slice(bytes).map_err(|source| {
        rusqlite::Error::FromSqlConversionFailure(
            bytes.len(),
            rusqlite::types::Type::Blob,
            Box::new(source),
        )
    })?;
    NoteId::parse_str(&uuid.hyphenated().to_string()).map_err(|source| {
        rusqlite::Error::FromSqlConversionFailure(
            bytes.len(),
            rusqlite::types::Type::Blob,
            Box::new(source),
        )
    })
}

fn database_error(context: &'static str) -> impl FnOnce(rusqlite::Error) -> CommandError {
    move |source| CommandError::database(format!("{context}: {source}"))
}
