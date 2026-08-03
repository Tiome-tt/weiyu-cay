use crate::{
    commands::folders::FolderRepository,
    domain::{
        CreateFolderInput, FolderId, NoteDocument, NoteId, NoteKind, PurgeTrashResult,
        RestoreTrashResult, TrashBatchResult, TrashEntry, TrashFailure,
    },
    error::CommandError,
    platform::{IndexMutationLock, SafeDirectory},
    storage::{
        atomic_file::{atomic_replace_contained, PublishState},
        database::Database,
        paths::StoragePaths,
        repository::{
            folder_id_blob, note_id_blob, persist_document, serialize_document, NoteRepository,
        },
    },
};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, path::Path};
use uuid::Uuid;

const MANIFEST_SUFFIX: &str = ".trash.json";
const RECOVERED_FOLDER_NAME: &str = "已恢复";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashManifest {
    pub version: u8,
    pub state: TrashItemState,
    pub operation_id: String,
    pub note_id: NoteId,
    pub kind: NoteKind,
    pub title: String,
    pub previous_folder_id: Option<FolderId>,
    pub previous_relative_path: String,
    pub deleted_at: String,
    pub assets: Vec<String>,
    pub original: NoteDocument,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrashItemState {
    Prepared,
    Deleted,
    Restoring,
    Purging,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[doc(hidden)]
pub enum TrashFailurePoint {
    Purge(NoteId),
    CrashAfterMove(NoteId),
    CrashAfterDatabase(NoteId),
}

#[derive(Clone)]
pub struct TrashService {
    paths: StoragePaths,
    failure: Option<TrashFailurePoint>,
}

impl TrashService {
    pub fn new(paths: StoragePaths) -> Self {
        Self {
            paths,
            failure: None,
        }
    }

    #[doc(hidden)]
    pub fn new_with_failure(paths: StoragePaths, failure: TrashFailurePoint) -> Self {
        Self {
            paths,
            failure: Some(failure),
        }
    }

    pub fn recover_pending(&self) -> Result<(), CommandError> {
        let _guard = IndexMutationLock::acquire(self.paths.root())?;
        for mut manifest in self.read_all_manifests()? {
            match manifest.state {
                TrashItemState::Prepared => self.recover_prepared(&mut manifest)?,
                TrashItemState::Deleted => {}
                TrashItemState::Restoring => self.recover_restoring(&manifest)?,
                TrashItemState::Purging => self.recover_purging(&manifest)?,
            }
        }
        Ok(())
    }

    pub fn trash(
        &self,
        ids: Vec<NoteId>,
        deleted_at: &str,
    ) -> Result<TrashBatchResult, CommandError> {
        parse_timestamp(deleted_at)?;
        let operation_id = Uuid::now_v7().hyphenated().to_string();
        let mut trashed = Vec::new();
        let mut failed = Vec::new();
        for id in unique_ids(ids) {
            match self.trash_one(&operation_id, id, deleted_at) {
                Ok(()) => trashed.push(id),
                Err(error) => failed.push(TrashFailure {
                    note_id: id,
                    message: error.message().to_owned(),
                }),
            }
        }
        Ok(TrashBatchResult {
            operation_id,
            trashed,
            failed,
        })
    }

    pub fn list(&self) -> Result<Vec<TrashEntry>, CommandError> {
        let _guard = IndexMutationLock::acquire(self.paths.root())?;
        let mut manifests = self.read_all_manifests()?;
        manifests.sort_by(|left, right| {
            right
                .deleted_at
                .cmp(&left.deleted_at)
                .then_with(|| left.note_id.to_string().cmp(&right.note_id.to_string()))
        });
        Ok(manifests
            .into_iter()
            .filter(|manifest| manifest.state == TrashItemState::Deleted)
            .map(entry_from_manifest)
            .collect())
    }

    pub fn restore(&self, ids: Vec<NoteId>) -> Result<RestoreTrashResult, CommandError> {
        self.restore_matching(unique_ids(ids), None)
    }

    pub fn undo(&self, operation_id: &str) -> Result<RestoreTrashResult, CommandError> {
        validate_operation_id(operation_id)?;
        self.restore_matching(Vec::new(), Some(operation_id))
    }

    pub fn purge_expired(&self, now: &str) -> Result<PurgeTrashResult, CommandError> {
        let now = parse_timestamp(now)?;
        let _guard = IndexMutationLock::acquire(self.paths.root())?;
        let manifests = self.read_all_manifests()?;
        let mut purged = Vec::new();
        let mut failed = Vec::new();
        for manifest in manifests {
            let deleted_at = parse_timestamp(&manifest.deleted_at)?;
            if now.signed_duration_since(deleted_at) <= Duration::days(30) {
                continue;
            }
            let id = manifest.note_id;
            let result = if self.failure == Some(TrashFailurePoint::Purge(id)) {
                Err(CommandError::io("injected purge failure"))
            } else {
                self.purge_one_locked(&manifest)
            };
            match result {
                Ok(()) => purged.push(id),
                Err(error) => failed.push(TrashFailure {
                    note_id: id,
                    message: error.message().to_owned(),
                }),
            }
        }
        Ok(PurgeTrashResult { purged, failed })
    }

    fn trash_one(
        &self,
        operation_id: &str,
        id: NoteId,
        deleted_at: &str,
    ) -> Result<(), CommandError> {
        let guard = IndexMutationLock::acquire(self.paths.root())?;
        let document = NoteRepository::new(self.paths.clone()).load_locked(id, &guard)?;
        let assets = asset_inventory(&self.paths, &document)?;
        let manifest = TrashManifest {
            version: 1,
            state: TrashItemState::Prepared,
            operation_id: operation_id.to_owned(),
            note_id: id,
            kind: document.kind,
            title: document.title.clone(),
            previous_folder_id: document.folder_id,
            previous_relative_path: format!("{}/{}", collection(document.kind), id),
            deleted_at: deleted_at.to_owned(),
            assets,
            original: document.clone(),
        };
        write_manifest(&self.paths, &manifest)?;
        let source = SafeDirectory::open(self.paths.root(), &[collection(document.kind)], false)?;
        let operation = SafeDirectory::open(self.paths.root(), &["trash", operation_id], true)?;
        if let Err(error) = move_published(source.move_directory_no_replace(
            &id.to_string(),
            &operation,
            &id.to_string(),
        )) {
            let _ = operation.remove_checked(&manifest_name(id));
            return Err(error);
        }
        if self.failure == Some(TrashFailurePoint::CrashAfterMove(id)) {
            return Err(CommandError::io("injected crash after trash move"));
        }
        if let Err(error) = mark_deleted(&self.paths, id, deleted_at) {
            let destination =
                SafeDirectory::open(self.paths.root(), &[collection(document.kind)], false)?;
            let _ = move_published(operation.move_directory_no_replace(
                &id.to_string(),
                &destination,
                &id.to_string(),
            ));
            let _ = operation.remove_checked(&manifest_name(id));
            return Err(error);
        }
        if self.failure == Some(TrashFailurePoint::CrashAfterDatabase(id)) {
            return Err(CommandError::io(
                "injected crash after trash database commit",
            ));
        }
        let mut manifest = manifest;
        manifest.state = TrashItemState::Deleted;
        // Durable content and deleted metadata already committed. A failed
        // final phase publication is replayed from the prepared manifest.
        let _ = write_manifest(&self.paths, &manifest);
        Ok(())
    }

    fn restore_matching(
        &self,
        ids: Vec<NoteId>,
        operation_id: Option<&str>,
    ) -> Result<RestoreTrashResult, CommandError> {
        let guard = IndexMutationLock::acquire(self.paths.root())?;
        let requested: HashSet<_> = ids.into_iter().collect();
        let manifests = self.read_all_manifests()?;
        let mut restored = Vec::new();
        let mut failed = Vec::new();
        for manifest in manifests.into_iter().filter(|manifest| {
            operation_id
                .map(|value| manifest.operation_id == value)
                .unwrap_or_else(|| requested.contains(&manifest.note_id))
        }) {
            let id = manifest.note_id;
            match self.restore_one_locked(&manifest, &guard) {
                Ok(document) => restored.push(document),
                Err(error) => failed.push(TrashFailure {
                    note_id: id,
                    message: error.message().to_owned(),
                }),
            }
        }
        for id in requested {
            if restored.iter().any(|document| document.id == id)
                || failed.iter().any(|failure| failure.note_id == id)
            {
                continue;
            }
            failed.push(TrashFailure {
                note_id: id,
                message: "trash entry does not exist".to_owned(),
            });
        }
        Ok(RestoreTrashResult { restored, failed })
    }

    fn restore_one_locked(
        &self,
        manifest: &TrashManifest,
        guard: &IndexMutationLock,
    ) -> Result<NoteDocument, CommandError> {
        validate_manifest(manifest)?;
        if manifest.state != TrashItemState::Deleted {
            return Err(CommandError::conflict("trash entry is not restorable"));
        }
        let mut restoring = manifest.clone();
        restoring.state = TrashItemState::Restoring;
        write_manifest(&self.paths, &restoring)?;
        let mut document = manifest.original.clone();
        if document.kind == NoteKind::Formal && !folder_exists(&self.paths, document.folder_id)? {
            document.folder_id = Some(recovered_folder(&self.paths, guard)?);
            document.revision = document
                .revision
                .checked_add(1)
                .ok_or_else(|| CommandError::validation("note revision overflow"))?;
        }
        let destination =
            SafeDirectory::open(self.paths.root(), &[collection(document.kind)], false)?;
        let operation =
            SafeDirectory::open(self.paths.root(), &["trash", &manifest.operation_id], false)?;
        if let Err(error) = move_published(operation.move_directory_no_replace(
            &manifest.note_id.to_string(),
            &destination,
            &manifest.note_id.to_string(),
        )) {
            let _ = write_manifest(&self.paths, manifest);
            return Err(error);
        }
        let rollback = || -> Result<(), CommandError> {
            move_published(destination.move_directory_no_replace(
                &manifest.note_id.to_string(),
                &operation,
                &manifest.note_id.to_string(),
            ))?;
            write_manifest(&self.paths, manifest)
        };
        if document != manifest.original {
            let bytes = serialize_document(&document)?;
            if let Err(error) = publish_document(&self.paths, &document, bytes.as_bytes()) {
                let _ = rollback();
                return Err(error);
            }
        }
        let database = open_database(&self.paths)?;
        if let Err(error) = persist_document(&database, &document) {
            let _ = rollback();
            return Err(error);
        }
        operation.remove_checked(&manifest_name(manifest.note_id))?;
        Ok(document)
    }

    fn purge_one_locked(&self, manifest: &TrashManifest) -> Result<(), CommandError> {
        validate_manifest(manifest)?;
        if manifest.state != TrashItemState::Deleted {
            return Err(CommandError::conflict("trash entry is not purgeable"));
        }
        let mut purging = manifest.clone();
        purging.state = TrashItemState::Purging;
        write_manifest(&self.paths, &purging)?;
        self.purge_one_in_progress(&purging)
    }

    fn purge_one_in_progress(&self, manifest: &TrashManifest) -> Result<(), CommandError> {
        let operation =
            SafeDirectory::open(self.paths.root(), &["trash", &manifest.operation_id], false)?;
        if operation
            .entry_names()?
            .iter()
            .any(|name| name == &manifest.note_id.to_string())
        {
            operation.validate_directory_tree(&manifest.note_id.to_string())?;
            let path = operation.child_path(&manifest.note_id.to_string())?;
            fs::remove_dir_all(&path).map_err(|source| {
                CommandError::io(format!("could not purge trash content: {source}"))
            })?;
            operation.sync()?;
        }
        delete_metadata(&self.paths, manifest.note_id)?;
        remove_catalog_manifest(&self.paths, &manifest.operation_id, manifest.note_id)
    }

    fn recover_prepared(&self, manifest: &mut TrashManifest) -> Result<(), CommandError> {
        let active = contained_note_exists(&self.paths, manifest.kind, manifest.note_id)?;
        let trashed =
            contained_trash_exists(&self.paths, &manifest.operation_id, manifest.note_id)?;
        let deleted = metadata_is_deleted(&self.paths, manifest.note_id)?;
        match (active, trashed, deleted) {
            (false, true, true) => {
                manifest.state = TrashItemState::Deleted;
                write_manifest(&self.paths, manifest)
            }
            (false, true, false) => {
                let operation = SafeDirectory::open(
                    self.paths.root(),
                    &["trash", &manifest.operation_id],
                    false,
                )?;
                let destination =
                    SafeDirectory::open(self.paths.root(), &[collection(manifest.kind)], false)?;
                move_published(operation.move_directory_no_replace(
                    &manifest.note_id.to_string(),
                    &destination,
                    &manifest.note_id.to_string(),
                ))?;
                remove_catalog_manifest(&self.paths, &manifest.operation_id, manifest.note_id)
            }
            (true, false, false) => {
                remove_catalog_manifest(&self.paths, &manifest.operation_id, manifest.note_id)
            }
            (true, false, true) => {
                persist_document(&open_database(&self.paths)?, &manifest.original)?;
                remove_catalog_manifest(&self.paths, &manifest.operation_id, manifest.note_id)
            }
            (true, true, _) => Err(CommandError::conflict(
                "trash recovery found duplicate durable note directories",
            )),
            (false, false, _) => Err(CommandError::io(
                "trash recovery could not find durable note content",
            )),
        }
    }

    fn recover_restoring(&self, manifest: &TrashManifest) -> Result<(), CommandError> {
        let active = contained_note_exists(&self.paths, manifest.kind, manifest.note_id)?;
        let trashed =
            contained_trash_exists(&self.paths, &manifest.operation_id, manifest.note_id)?;
        match (active, trashed) {
            (true, false) => {
                let document = NoteRepository::new(self.paths.clone()).load(manifest.note_id)?;
                persist_document(&open_database(&self.paths)?, &document)?;
                remove_catalog_manifest(&self.paths, &manifest.operation_id, manifest.note_id)
            }
            (false, true) => {
                let mut deleted = manifest.clone();
                deleted.state = TrashItemState::Deleted;
                write_manifest(&self.paths, &deleted)
            }
            (true, true) => Err(CommandError::conflict(
                "trash restore recovery found duplicate durable note directories",
            )),
            (false, false) => Err(CommandError::io(
                "trash restore recovery could not find durable note content",
            )),
        }
    }

    fn recover_purging(&self, manifest: &TrashManifest) -> Result<(), CommandError> {
        if contained_trash_exists(&self.paths, &manifest.operation_id, manifest.note_id)? {
            return self.purge_one_in_progress(manifest);
        }
        delete_metadata(&self.paths, manifest.note_id)?;
        remove_catalog_manifest(&self.paths, &manifest.operation_id, manifest.note_id)
    }

    fn read_all_manifests(&self) -> Result<Vec<TrashManifest>, CommandError> {
        let trash = SafeDirectory::open(self.paths.root(), &["trash"], false)?;
        let mut manifests = Vec::new();
        for operation_id in trash.entry_names()? {
            if validate_operation_id(&operation_id).is_err() {
                continue;
            }
            let Ok(operation) =
                SafeDirectory::open(self.paths.root(), &["trash", &operation_id], false)
            else {
                continue;
            };
            for name in operation.entry_names()? {
                if !name.ends_with(MANIFEST_SUFFIX) || !operation.entry_is_regular_file(&name)? {
                    continue;
                }
                let bytes = operation.read(&name, 4 * 1024 * 1024)?;
                let manifest: TrashManifest = serde_json::from_slice(&bytes).map_err(|source| {
                    CommandError::validation(format!("trash manifest is invalid: {source}"))
                })?;
                validate_manifest_path(&operation_id, &name, &manifest)?;
                manifests.push(manifest);
            }
        }
        Ok(manifests)
    }
}

fn unique_ids(ids: Vec<NoteId>) -> Vec<NoteId> {
    let mut seen = HashSet::new();
    ids.into_iter().filter(|id| seen.insert(*id)).collect()
}

fn collection(kind: NoteKind) -> &'static str {
    match kind {
        NoteKind::Formal => "notes",
        NoteKind::Temporary => "temporary",
    }
}

fn manifest_name(id: NoteId) -> String {
    format!("{id}{MANIFEST_SUFFIX}")
}

fn write_manifest(paths: &StoragePaths, manifest: &TrashManifest) -> Result<(), CommandError> {
    validate_manifest(manifest)?;
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|source| {
        CommandError::io(format!("could not serialize trash manifest: {source}"))
    })?;
    match atomic_replace_contained(
        paths.root(),
        &["trash", &manifest.operation_id],
        &manifest_name(manifest.note_id),
        &bytes,
    ) {
        Ok(PublishState::Published) => Ok(()),
        Ok(state) => Err(CommandError::io(format!(
            "trash manifest returned invalid state: {state:?}"
        ))),
        Err(failure) if failure.state() != PublishState::NotPublished => {
            recover_and_confirm_manifest(paths, manifest, &bytes).map_err(|_| failure.into_error())
        }
        Err(failure) => Err(failure.into_error()),
    }
}

fn recover_and_confirm_manifest(
    paths: &StoragePaths,
    manifest: &TrashManifest,
    expected: &[u8],
) -> Result<(), CommandError> {
    let operation = SafeDirectory::open(paths.root(), &["trash", &manifest.operation_id], false)?;
    let name = manifest_name(manifest.note_id);
    operation.recover(&name)?;
    if operation.read(&name, expected.len() as u64 + 1)? != expected {
        return Err(CommandError::conflict(
            "recovered trash state does not match the requested phase",
        ));
    }
    operation.sync_file(&name)?;
    operation.sync()
}

/// Adds the recoverable catalog record to Task 13's durable delete journal.
/// The content directory has already moved, but deleted SQLite state has not
/// yet committed when this is called.
pub(crate) fn catalog_moved_temporary(
    paths: &StoragePaths,
    operation_id: &str,
    document: &NoteDocument,
    deleted_at: &str,
) -> Result<(), CommandError> {
    if document.kind != NoteKind::Temporary || document.folder_id.is_some() {
        return Err(CommandError::validation(
            "trash catalog expected a temporary capture",
        ));
    }
    let operation = SafeDirectory::open(paths.root(), &["trash", operation_id], false)?;
    let assets = asset_inventory_in(&operation, &document.id.to_string())?;
    write_manifest(
        paths,
        &TrashManifest {
            version: 1,
            state: TrashItemState::Prepared,
            operation_id: operation_id.to_owned(),
            note_id: document.id,
            kind: document.kind,
            title: document.title.clone(),
            previous_folder_id: document.folder_id,
            previous_relative_path: format!("temporary/{}", document.id),
            deleted_at: deleted_at.to_owned(),
            assets,
            original: document.clone(),
        },
    )
}

pub(crate) fn mark_catalog_deleted(
    paths: &StoragePaths,
    operation_id: &str,
    id: NoteId,
) -> Result<(), CommandError> {
    let mut manifest = read_manifest(paths, operation_id, id)?;
    manifest.state = TrashItemState::Deleted;
    write_manifest(paths, &manifest)
}

fn read_manifest(
    paths: &StoragePaths,
    operation_id: &str,
    id: NoteId,
) -> Result<TrashManifest, CommandError> {
    validate_operation_id(operation_id)?;
    let operation = SafeDirectory::open(paths.root(), &["trash", operation_id], false)?;
    let name = manifest_name(id);
    let bytes = operation.read(&name, 4 * 1024 * 1024)?;
    let manifest: TrashManifest = serde_json::from_slice(&bytes).map_err(|source| {
        CommandError::validation(format!("trash manifest is invalid: {source}"))
    })?;
    validate_manifest_path(operation_id, &name, &manifest)?;
    Ok(manifest)
}

pub(crate) fn remove_catalog_manifest(
    paths: &StoragePaths,
    operation_id: &str,
    id: NoteId,
) -> Result<(), CommandError> {
    validate_operation_id(operation_id)?;
    let operation = SafeDirectory::open(paths.root(), &["trash", operation_id], false)?;
    operation.remove_checked(&manifest_name(id))?;
    operation.sync()
}

fn validate_manifest_path(
    operation_id: &str,
    name: &str,
    manifest: &TrashManifest,
) -> Result<(), CommandError> {
    if manifest.operation_id != operation_id || manifest_name(manifest.note_id) != name {
        return Err(CommandError::validation(
            "trash manifest identity does not match its path",
        ));
    }
    validate_manifest(manifest)
}

fn validate_manifest(manifest: &TrashManifest) -> Result<(), CommandError> {
    validate_operation_id(&manifest.operation_id)?;
    parse_timestamp(&manifest.deleted_at)?;
    let expected_path = format!("{}/{}", collection(manifest.kind), manifest.note_id);
    if manifest.version != 1
        || manifest.original.id != manifest.note_id
        || manifest.original.kind != manifest.kind
        || manifest.original.folder_id != manifest.previous_folder_id
        || manifest.original.title != manifest.title
        || manifest.previous_relative_path != expected_path
        || manifest.assets.iter().any(|path| !valid_asset_path(path))
    {
        return Err(CommandError::validation("trash manifest is inconsistent"));
    }
    Ok(())
}

fn validate_operation_id(value: &str) -> Result<(), CommandError> {
    let parsed = Uuid::parse_str(value)
        .map_err(|_| CommandError::validation("trash operation ID is invalid"))?;
    if parsed.get_version() != Some(uuid::Version::SortRand)
        || parsed.hyphenated().to_string() != value
    {
        return Err(CommandError::validation("trash operation ID is invalid"));
    }
    Ok(())
}

fn parse_timestamp(value: &str) -> Result<DateTime<Utc>, CommandError> {
    DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .map_err(|source| CommandError::validation(format!("trash timestamp is invalid: {source}")))
}

fn valid_asset_path(path: &str) -> bool {
    let mut parts = path.split('/');
    matches!(parts.next(), Some("assets"))
        && parts.clone().count() > 0
        && parts.all(|part| {
            !part.is_empty() && !matches!(part, "." | "..") && !part.contains(['\\', ':', '\0'])
        })
}

fn asset_inventory(
    paths: &StoragePaths,
    document: &NoteDocument,
) -> Result<Vec<String>, CommandError> {
    let collection = SafeDirectory::open(paths.root(), &[collection(document.kind)], false)?;
    asset_inventory_in(&collection, &document.id.to_string())
}

fn asset_inventory_in(parent: &SafeDirectory, child: &str) -> Result<Vec<String>, CommandError> {
    let directory = SafeDirectory::open(parent.child_path(child)?.as_path(), &[], false)?;
    let names = directory.entry_names()?;
    if !names.iter().any(|name| name == "assets") {
        return Ok(Vec::new());
    }
    directory.validate_directory_tree("assets")?;
    let root = directory.child_path("assets")?;
    let mut assets = Vec::new();
    collect_assets(&root, &root, &mut assets)?;
    assets.sort();
    Ok(assets)
}

fn collect_assets(
    root: &Path,
    directory: &Path,
    output: &mut Vec<String>,
) -> Result<(), CommandError> {
    for entry in fs::read_dir(directory)
        .map_err(|source| CommandError::io(format!("could not enumerate note assets: {source}")))?
    {
        let entry = entry.map_err(|source| {
            CommandError::io(format!("could not enumerate note assets: {source}"))
        })?;
        let file_type = entry.file_type().map_err(|source| {
            CommandError::io(format!("could not inspect note asset: {source}"))
        })?;
        if file_type.is_symlink() {
            return Err(CommandError::validation("note assets cannot contain links"));
        }
        if file_type.is_dir() {
            collect_assets(root, &entry.path(), output)?;
        } else if file_type.is_file() {
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|_| CommandError::validation("asset escaped its note directory"))?
                .to_string_lossy()
                .replace('\\', "/");
            output.push(format!("assets/{relative}"));
        } else {
            return Err(CommandError::validation(
                "note assets contain an unsupported entry",
            ));
        }
    }
    Ok(())
}

fn mark_deleted(paths: &StoragePaths, id: NoteId, deleted_at: &str) -> Result<(), CommandError> {
    let database = open_database(paths)?;
    let changed = database
        .connection()
        .execute(
            "UPDATE notes SET deleted_at=?1 WHERE id=?2 AND deleted_at IS NULL",
            params![deleted_at, note_id_blob(id)],
        )
        .map_err(database_error("could not mark note deleted"))?;
    if changed == 1 {
        Ok(())
    } else {
        Err(CommandError::conflict("note is already deleted"))
    }
}

fn metadata_is_deleted(paths: &StoragePaths, id: NoteId) -> Result<bool, CommandError> {
    let database = open_database(paths)?;
    database
        .connection()
        .query_row(
            "SELECT deleted_at IS NOT NULL FROM notes WHERE id=?1",
            [note_id_blob(id)],
            |row| row.get(0),
        )
        .optional()
        .map(|value| value.unwrap_or(false))
        .map_err(database_error("could not inspect trash metadata state"))
}

fn delete_metadata(paths: &StoragePaths, id: NoteId) -> Result<(), CommandError> {
    let database = open_database(paths)?;
    database
        .connection()
        .execute(
            "DELETE FROM notes WHERE id=?1 AND deleted_at IS NOT NULL",
            [note_id_blob(id)],
        )
        .map_err(database_error("could not remove purged note metadata"))?;
    Ok(())
}

fn contained_note_exists(
    paths: &StoragePaths,
    kind: NoteKind,
    id: NoteId,
) -> Result<bool, CommandError> {
    let parent = SafeDirectory::open(paths.root(), &[collection(kind)], false)?;
    Ok(parent
        .entry_names()?
        .iter()
        .any(|name| name == &id.to_string()))
}

fn contained_trash_exists(
    paths: &StoragePaths,
    operation_id: &str,
    id: NoteId,
) -> Result<bool, CommandError> {
    validate_operation_id(operation_id)?;
    let operation = SafeDirectory::open(paths.root(), &["trash", operation_id], false)?;
    Ok(operation
        .entry_names()?
        .iter()
        .any(|name| name == &id.to_string()))
}

fn folder_exists(paths: &StoragePaths, folder_id: Option<FolderId>) -> Result<bool, CommandError> {
    let Some(folder_id) = folder_id else {
        return Ok(true);
    };
    let database = open_database(paths)?;
    database
        .connection()
        .query_row(
            "SELECT 1 FROM folders WHERE id=?1",
            [folder_id_blob(folder_id)],
            |_| Ok(()),
        )
        .optional()
        .map(|value| value.is_some())
        .map_err(database_error("could not inspect previous note folder"))
}

fn recovered_folder(
    paths: &StoragePaths,
    guard: &IndexMutationLock,
) -> Result<FolderId, CommandError> {
    let database = open_database(paths)?;
    let existing: Option<Vec<u8>> = database
        .connection()
        .query_row(
            "SELECT id FROM folders WHERE parent_id IS NULL AND name=?1",
            [RECOVERED_FOLDER_NAME],
            |row| row.get(0),
        )
        .optional()
        .map_err(database_error("could not find recovered folder"))?;
    if let Some(bytes) = existing {
        let uuid = Uuid::from_slice(&bytes).map_err(|source| {
            CommandError::database(format!("recovered folder ID is invalid: {source}"))
        })?;
        return FolderId::parse_str(&uuid.hyphenated().to_string()).map_err(|source| {
            CommandError::database(format!("recovered folder ID is invalid: {source}"))
        });
    }
    FolderRepository::new(paths.clone())
        .create_locked(
            CreateFolderInput {
                parent_id: None,
                name: RECOVERED_FOLDER_NAME.to_owned(),
            },
            guard,
        )
        .map(|folder| folder.id)
}

fn publish_document(
    paths: &StoragePaths,
    document: &NoteDocument,
    bytes: &[u8],
) -> Result<(), CommandError> {
    match atomic_replace_contained(
        paths.root(),
        &[collection(document.kind), &document.id.to_string()],
        "note.md",
        bytes,
    ) {
        Ok(PublishState::Published) => Ok(()),
        Ok(state) => Err(CommandError::io(format!(
            "restored document returned invalid state: {state:?}"
        ))),
        Err(failure) => Err(failure.into_error()),
    }
}

fn move_published(
    result: Result<PublishState, crate::storage::atomic_file::PublishFailure>,
) -> Result<(), CommandError> {
    match result {
        Ok(PublishState::Published) => Ok(()),
        Ok(state) => Err(CommandError::io(format!(
            "directory move returned invalid state: {state:?}"
        ))),
        Err(failure) => Err(failure.into_error()),
    }
}

fn entry_from_manifest(manifest: TrashManifest) -> TrashEntry {
    TrashEntry {
        note_id: manifest.note_id,
        kind: manifest.kind,
        title: manifest.title,
        previous_folder_id: manifest.previous_folder_id,
        previous_relative_path: manifest.previous_relative_path,
        deleted_at: manifest.deleted_at,
        assets: manifest.assets,
        operation_id: manifest.operation_id,
    }
}

fn open_database(paths: &StoragePaths) -> Result<Database, CommandError> {
    let database = Database::open(paths.database())?;
    database.migrate()?;
    Ok(database)
}

fn database_error(context: &'static str) -> impl FnOnce(rusqlite::Error) -> CommandError {
    move |source| CommandError::database(format!("{context}: {source}"))
}
