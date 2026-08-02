use crate::{
    domain::{
        BatchConversionFailure, BatchConversionResult, ConvertTemporaryInput,
        ConvertedTemporaryNote, DeleteTemporaryResult, FolderId, NoteDocument, NoteId, NoteKind,
        TemporaryOperationFailure, UndoTemporaryDeleteResult,
    },
    error::CommandError,
    platform::{IndexMutationLock, SafeDirectory},
    storage::{
        atomic_file::{atomic_replace_contained, PublishState},
        database::Database,
        paths::StoragePaths,
        repository::{
            folder_id_blob, is_application_whitespace, note_id_blob,
            persist_document_in_transaction, serialize_document, NoteRepository,
        },
    },
    windows::sticky::{temporary_window_label, TemporaryWindowBackend},
};
use chrono::DateTime;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

const DESCRIPTOR_NAME: &str = "descriptor.json";
const CONVERSION_PREFIX: &str = ".temporary-conversion-";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[doc(hidden)]
pub enum TemporaryFailurePoint {
    BeforeJournal,
    BeforeMove,
    AfterMove,
    CrashAfterMove,
    BeforeDatabase,
    BeforeRollback,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversionJournal {
    version: u8,
    document: NoteDocument,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteDescriptor {
    version: u8,
    operation_id: String,
    deleted_at: String,
    items: Vec<DeleteDescriptorItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteDescriptorItem {
    temporary_id: NoteId,
}

pub fn derive_temporary_title(markdown: &str, timestamp: &str) -> Result<String, CommandError> {
    let first = markdown
        .lines()
        .map(|line| line.trim_matches(is_application_whitespace))
        .find(|line| !line.is_empty());
    let Some(first) = first else {
        let parsed = DateTime::parse_from_rfc3339(timestamp).map_err(|source| {
            CommandError::validation(format!("temporary title timestamp is invalid: {source}"))
        })?;
        return Ok(format!("未命名笔记 {}", parsed.format("%Y-%m-%d %H-%M")));
    };
    let mut value = first;
    let hashes = value
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if (1..=6).contains(&hashes) {
        let remainder = &value[hashes..];
        if remainder
            .chars()
            .next()
            .is_some_and(is_application_whitespace)
        {
            value = remainder.trim_start_matches(is_application_whitespace);
        }
    }
    let mut collapsed = String::new();
    let mut in_space = false;
    for character in value.chars() {
        if is_application_whitespace(character) {
            in_space = !collapsed.is_empty();
        } else {
            if in_space {
                collapsed.push(' ');
            }
            collapsed.push(character);
            in_space = false;
        }
    }
    let truncated: String = collapsed.chars().take(80).collect();
    let title = truncated.trim_matches(is_application_whitespace).to_owned();
    if title.is_empty() {
        let parsed = DateTime::parse_from_rfc3339(timestamp).map_err(|source| {
            CommandError::validation(format!("temporary title timestamp is invalid: {source}"))
        })?;
        Ok(format!("未命名笔记 {}", parsed.format("%Y-%m-%d %H-%M")))
    } else {
        Ok(title)
    }
}

#[derive(Clone)]
pub struct TemporaryInboxService<B> {
    paths: StoragePaths,
    backend: B,
    failures: HashSet<TemporaryFailurePoint>,
}

impl<B: TemporaryWindowBackend> TemporaryInboxService<B> {
    pub fn new(paths: StoragePaths, backend: B) -> Self {
        Self {
            paths,
            backend,
            failures: HashSet::new(),
        }
    }

    #[doc(hidden)]
    pub fn new_with_failure(
        paths: StoragePaths,
        backend: B,
        failure: TemporaryFailurePoint,
    ) -> Self {
        Self {
            paths,
            backend,
            failures: HashSet::from([failure]),
        }
    }

    #[doc(hidden)]
    pub fn new_with_failures(
        paths: StoragePaths,
        backend: B,
        failures: impl IntoIterator<Item = TemporaryFailurePoint>,
    ) -> Self {
        Self {
            paths,
            backend,
            failures: failures.into_iter().collect(),
        }
    }

    pub fn recover_pending(&self) -> Result<(), CommandError> {
        let guard = IndexMutationLock::acquire(self.paths.root())?;
        self.recover_conversions_locked(&guard)?;
        self.recover_deletions_locked(&guard)
    }

    pub fn convert(&self, input: ConvertTemporaryInput, timestamp: &str) -> BatchConversionResult {
        let mut converted = Vec::new();
        let mut failed = Vec::new();
        for id in unique_ids(input.ids) {
            match self.convert_one(id, input.folder_id, timestamp) {
                Ok(()) => converted.push(ConvertedTemporaryNote {
                    temporary_id: id,
                    note_id: id,
                }),
                Err(error) => failed.push(BatchConversionFailure {
                    temporary_id: id,
                    message: error.message().to_owned(),
                }),
            }
        }
        BatchConversionResult { converted, failed }
    }

    pub fn delete(&self, ids: Vec<NoteId>) -> DeleteTemporaryResult {
        let operation_id = Uuid::now_v7().hyphenated().to_string();
        let ids = unique_ids(ids);
        let timestamp = chrono::Utc::now().to_rfc3339();
        let descriptor = DeleteDescriptor {
            version: 1,
            operation_id: operation_id.clone(),
            deleted_at: timestamp.clone(),
            items: ids
                .iter()
                .copied()
                .map(|temporary_id| DeleteDescriptorItem { temporary_id })
                .collect(),
        };
        let mut deleted = Vec::new();
        let mut failed = Vec::new();
        if let Err(error) = write_delete_descriptor(&self.paths, &descriptor) {
            failed.extend(
                ids.into_iter()
                    .map(|temporary_id| TemporaryOperationFailure {
                        temporary_id,
                        message: error.message().to_owned(),
                    }),
            );
            return DeleteTemporaryResult {
                operation_id,
                deleted,
                failed,
            };
        }
        for id in ids {
            match self.delete_one(&operation_id, id, &timestamp) {
                Ok(()) => deleted.push(id),
                Err(error) => failed.push(TemporaryOperationFailure {
                    temporary_id: id,
                    message: error.message().to_owned(),
                }),
            }
        }
        DeleteTemporaryResult {
            operation_id,
            deleted,
            failed,
        }
    }

    pub fn undo_delete(
        &self,
        operation_id: &str,
    ) -> Result<UndoTemporaryDeleteResult, CommandError> {
        let mut restored = Vec::new();
        let mut failed = Vec::new();
        let descriptor = read_delete_descriptor(&self.paths, operation_id)?;
        for item in descriptor.items {
            match self.restore_one(operation_id, item.temporary_id) {
                Ok(()) => restored.push(item.temporary_id),
                Err(error) => failed.push(TemporaryOperationFailure {
                    temporary_id: item.temporary_id,
                    message: error.message().to_owned(),
                }),
            }
        }
        Ok(UndoTemporaryDeleteResult {
            operation_id: operation_id.to_owned(),
            restored,
            failed,
        })
    }

    fn convert_one(
        &self,
        id: NoteId,
        folder_id: FolderId,
        timestamp: &str,
    ) -> Result<(), CommandError> {
        let guard = IndexMutationLock::acquire(self.paths.root())?;
        let database = open_database(&self.paths)?;
        validate_folder(database.connection(), folder_id)?;
        let original = NoteRepository::new(self.paths.clone()).load_locked(id, &guard)?;
        if original.kind != NoteKind::Temporary || original.folder_id.is_some() {
            return Err(CommandError::validation("capture is no longer temporary"));
        }
        let mut formal = original.clone();
        formal.kind = NoteKind::Formal;
        formal.folder_id = Some(folder_id);
        formal.title = derive_temporary_title(&original.markdown, timestamp)?;
        formal.updated_at = timestamp.to_owned();
        let journal = ConversionJournal {
            version: 1,
            document: formal.clone(),
        };
        self.fail(TemporaryFailurePoint::BeforeJournal)?;
        write_conversion_journal(&self.paths, &journal)?;
        self.fail(TemporaryFailurePoint::BeforeMove)?;
        move_note_directory(&self.paths, NoteKind::Temporary, NoteKind::Formal, id)?;
        self.fail(TemporaryFailurePoint::CrashAfterMove)?;
        self.fail(TemporaryFailurePoint::AfterMove)
            .or_else(|error| {
                self.rollback_conversion(id, &original, &guard)?;
                Err(error)
            })?;
        if let Err(error) = write_note_document(&self.paths, &formal) {
            self.rollback_conversion(id, &original, &guard)?;
            return Err(error);
        }
        if let Err(error) = self
            .fail(TemporaryFailurePoint::BeforeDatabase)
            .and_then(|()| persist_formal_and_retire_state(database.connection(), &formal))
        {
            self.rollback_conversion(id, &original, &guard)?;
            return Err(error);
        }
        if self.backend.retire(&temporary_window_label(id)).is_ok() {
            let _ = remove_conversion_journal(&self.paths, id);
        }
        Ok(())
    }

    fn rollback_conversion(
        &self,
        id: NoteId,
        original: &NoteDocument,
        _guard: &IndexMutationLock,
    ) -> Result<(), CommandError> {
        self.fail(TemporaryFailurePoint::BeforeRollback)?;
        if self.paths.note_dir(id, NoteKind::Formal)?.exists() {
            move_note_directory(&self.paths, NoteKind::Formal, NoteKind::Temporary, id)?;
        }
        write_note_document(&self.paths, original)?;
        let database = open_database(&self.paths)?;
        let transaction = database
            .connection()
            .unchecked_transaction()
            .map_err(database_error("could not start conversion rollback"))?;
        persist_document_in_transaction(&transaction, original)?;
        transaction
            .commit()
            .map_err(database_error("could not commit conversion rollback"))?;
        remove_conversion_journal(&self.paths, id)
    }

    fn delete_one(
        &self,
        operation_id: &str,
        id: NoteId,
        deleted_at: &str,
    ) -> Result<(), CommandError> {
        let _guard = IndexMutationLock::acquire(self.paths.root())?;
        let document = NoteRepository::new(self.paths.clone()).load_locked(id, &_guard)?;
        if document.kind != NoteKind::Temporary {
            return Err(CommandError::validation("capture is no longer temporary"));
        }
        self.fail(TemporaryFailurePoint::BeforeMove)?;
        move_temporary_to_trash(&self.paths, operation_id, id)?;
        self.fail(TemporaryFailurePoint::CrashAfterMove)?;
        if let Err(error) = self
            .fail(TemporaryFailurePoint::AfterMove)
            .and_then(|()| mark_deleted(&self.paths, id, deleted_at))
        {
            self.fail(TemporaryFailurePoint::BeforeRollback)?;
            move_trash_to_temporary(&self.paths, operation_id, id)?;
            return Err(error);
        }
        let _ = self.backend.retire(&temporary_window_label(id));
        Ok(())
    }

    fn restore_one(&self, operation_id: &str, id: NoteId) -> Result<(), CommandError> {
        let _guard = IndexMutationLock::acquire(self.paths.root())?;
        let temporary = self.paths.note_dir(id, NoteKind::Temporary)?;
        let trashed = self
            .paths
            .child(&["trash", operation_id, &id.to_string()])?;
        let formal = self.paths.note_dir(id, NoteKind::Formal)?;
        if formal.exists() {
            return Err(CommandError::conflict(
                "a formal note already uses this identity",
            ));
        }
        match (temporary.exists(), trashed.exists()) {
            (true, false) => return Ok(()),
            (true, true) => {
                return Err(CommandError::conflict("restore destination already exists"))
            }
            (false, false) => {
                return Err(CommandError::not_found(
                    "trashed temporary capture is missing",
                ))
            }
            (false, true) => {}
        }
        move_trash_to_temporary(&self.paths, operation_id, id)?;
        let document = match NoteRepository::new(self.paths.clone()).load_locked(id, &_guard) {
            Ok(document) => document,
            Err(error) => {
                let _ = move_temporary_to_trash(&self.paths, operation_id, id);
                return Err(error);
            }
        };
        let database = open_database(&self.paths)?;
        let transaction = database
            .connection()
            .unchecked_transaction()
            .map_err(database_error("could not start temporary restore"))?;
        if let Err(error) =
            persist_document_in_transaction(&transaction, &document).and_then(|()| {
                transaction
                    .commit()
                    .map_err(database_error("could not commit temporary restore"))
            })
        {
            let _ = move_temporary_to_trash(&self.paths, operation_id, id);
            return Err(error);
        }
        Ok(())
    }

    fn recover_conversions_locked(&self, _guard: &IndexMutationLock) -> Result<(), CommandError> {
        let root = SafeDirectory::open(self.paths.root(), &[], false)?;
        for name in root.entry_names()? {
            if !name.starts_with(CONVERSION_PREFIX) || !name.ends_with(".json") {
                continue;
            }
            let bytes = root.read(&name, 64 * 1024 * 1024)?;
            let journal: ConversionJournal = serde_json::from_slice(&bytes).map_err(|source| {
                CommandError::validation(format!("conversion journal is invalid: {source}"))
            })?;
            let id = journal.document.id;
            if journal.version != 1
                || name != conversion_journal_name(id)
                || journal.document.kind != NoteKind::Formal
                || journal.document.folder_id.is_none()
            {
                return Err(CommandError::validation(
                    "conversion journal identity or state is invalid",
                ));
            }
            let temporary = self.paths.note_dir(id, NoteKind::Temporary)?;
            let formal = self.paths.note_dir(id, NoteKind::Formal)?;
            match (temporary.exists(), formal.exists()) {
                (true, false) => remove_conversion_journal(&self.paths, id)?,
                (false, true) => {
                    write_note_document(&self.paths, &journal.document)?;
                    let database = open_database(&self.paths)?;
                    persist_formal_and_retire_state(database.connection(), &journal.document)?;
                    if self.backend.retire(&temporary_window_label(id)).is_ok() {
                        remove_conversion_journal(&self.paths, id)?;
                    }
                }
                (true, true) => {
                    return Err(CommandError::conflict(
                        "conversion recovery found duplicate note directories",
                    ))
                }
                (false, false) => {
                    return Err(CommandError::io(
                        "conversion recovery could not find durable content",
                    ))
                }
            }
        }
        Ok(())
    }

    fn recover_deletions_locked(&self, _guard: &IndexMutationLock) -> Result<(), CommandError> {
        let trash = SafeDirectory::open(self.paths.root(), &["trash"], false)?;
        for name in trash.entry_names()? {
            if Uuid::parse_str(&name).is_err() {
                continue;
            }
            let descriptor = read_delete_descriptor(&self.paths, &name)?;
            for item in descriptor.items {
                let temporary = self
                    .paths
                    .note_dir(item.temporary_id, NoteKind::Temporary)?;
                let trashed =
                    self.paths
                        .child(&["trash", &name, &item.temporary_id.to_string()])?;
                match (temporary.exists(), trashed.exists()) {
                    (true, false) => {}
                    (false, true) => {
                        mark_deleted(&self.paths, item.temporary_id, &descriptor.deleted_at)?;
                        let _ = self
                            .backend
                            .retire(&temporary_window_label(item.temporary_id));
                    }
                    (true, true) => {
                        return Err(CommandError::conflict(
                            "delete recovery found duplicate capture directories",
                        ))
                    }
                    (false, false) => {
                        return Err(CommandError::io(
                            "delete recovery could not find durable content",
                        ))
                    }
                }
            }
        }
        Ok(())
    }

    fn fail(&self, point: TemporaryFailurePoint) -> Result<(), CommandError> {
        if self.failures.contains(&point) {
            Err(CommandError::io(format!("injected {point:?} failure")))
        } else {
            Ok(())
        }
    }
}

fn unique_ids(ids: Vec<NoteId>) -> Vec<NoteId> {
    let mut seen = HashSet::new();
    ids.into_iter().filter(|id| seen.insert(*id)).collect()
}

fn validate_folder(connection: &rusqlite::Connection, id: FolderId) -> Result<(), CommandError> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM folders WHERE id = ?1",
            [folder_id_blob(id)],
            |_| Ok(()),
        )
        .optional()
        .map_err(database_error("could not validate conversion folder"))?
        .is_some();
    if exists {
        Ok(())
    } else {
        Err(CommandError::not_found("conversion folder does not exist"))
    }
}

fn write_note_document(paths: &StoragePaths, document: &NoteDocument) -> Result<(), CommandError> {
    let bytes = serialize_document(document)?;
    let id = document.id.to_string();
    let kind = match document.kind {
        NoteKind::Formal => "notes",
        NoteKind::Temporary => "temporary",
    };
    match atomic_replace_contained(paths.root(), &[kind, &id], "note.md", bytes.as_bytes()) {
        Ok(PublishState::Published) => Ok(()),
        Ok(state) => Err(CommandError::io(format!(
            "note write returned invalid publication state: {state:?}"
        ))),
        Err(failure) => Err(failure.into_error()),
    }
}

fn persist_formal_and_retire_state(
    connection: &rusqlite::Connection,
    document: &NoteDocument,
) -> Result<(), CommandError> {
    let transaction = connection
        .unchecked_transaction()
        .map_err(database_error("could not start temporary conversion"))?;
    persist_document_in_transaction(&transaction, document)?;
    transaction
        .execute(
            "DELETE FROM temporary_windows WHERE note_id = ?1",
            [note_id_blob(document.id)],
        )
        .map_err(database_error("could not retire temporary window state"))?;
    transaction
        .commit()
        .map_err(database_error("could not commit temporary conversion"))
}

fn mark_deleted(paths: &StoragePaths, id: NoteId, deleted_at: &str) -> Result<(), CommandError> {
    let database = open_database(paths)?;
    let transaction = database
        .connection()
        .unchecked_transaction()
        .map_err(database_error("could not start temporary deletion"))?;
    let changed = transaction
        .execute(
            "UPDATE notes SET deleted_at = ?1 WHERE id = ?2 AND kind = 'temporary' AND deleted_at IS NULL",
            params![deleted_at, note_id_blob(id)],
        )
        .map_err(database_error("could not mark temporary capture deleted"))?;
    if changed == 0 {
        let already_deleted = transaction
            .query_row(
                "SELECT deleted_at IS NOT NULL FROM notes WHERE id = ?1 AND kind = 'temporary'",
                [note_id_blob(id)],
                |row| row.get::<_, bool>(0),
            )
            .optional()
            .map_err(database_error("could not inspect temporary deletion"))?
            .unwrap_or(false);
        if !already_deleted {
            return Err(CommandError::not_found(
                "temporary capture metadata is missing",
            ));
        }
    }
    transaction
        .execute(
            "DELETE FROM temporary_windows WHERE note_id = ?1",
            [note_id_blob(id)],
        )
        .map_err(database_error("could not retire temporary window state"))?;
    transaction
        .commit()
        .map_err(database_error("could not commit temporary deletion"))
}

fn move_note_directory(
    paths: &StoragePaths,
    source_kind: NoteKind,
    destination_kind: NoteKind,
    id: NoteId,
) -> Result<(), CommandError> {
    let source_name = match source_kind {
        NoteKind::Formal => "notes",
        NoteKind::Temporary => "temporary",
    };
    let destination_name = match destination_kind {
        NoteKind::Formal => "notes",
        NoteKind::Temporary => "temporary",
    };
    let source = SafeDirectory::open(paths.root(), &[source_name], false)?;
    let destination = SafeDirectory::open(paths.root(), &[destination_name], false)?;
    let id = id.to_string();
    source.move_directory_no_replace(&id, &destination, &id)
}

fn move_temporary_to_trash(
    paths: &StoragePaths,
    operation_id: &str,
    id: NoteId,
) -> Result<(), CommandError> {
    validate_operation_id(operation_id)?;
    let source = SafeDirectory::open(paths.root(), &["temporary"], false)?;
    let destination = SafeDirectory::open(paths.root(), &["trash", operation_id], false)?;
    let id = id.to_string();
    source.move_directory_no_replace(&id, &destination, &id)
}

fn move_trash_to_temporary(
    paths: &StoragePaths,
    operation_id: &str,
    id: NoteId,
) -> Result<(), CommandError> {
    validate_operation_id(operation_id)?;
    let source = SafeDirectory::open(paths.root(), &["trash", operation_id], false)?;
    let destination = SafeDirectory::open(paths.root(), &["temporary"], false)?;
    let id = id.to_string();
    source.move_directory_no_replace(&id, &destination, &id)
}

fn write_conversion_journal(
    paths: &StoragePaths,
    journal: &ConversionJournal,
) -> Result<(), CommandError> {
    let bytes = serde_json::to_vec(journal).map_err(|source| {
        CommandError::io(format!("could not serialize conversion journal: {source}"))
    })?;
    let name = conversion_journal_name(journal.document.id);
    match atomic_replace_contained(paths.root(), &[], &name, &bytes) {
        Ok(PublishState::Published) => Ok(()),
        Ok(state) => Err(CommandError::io(format!(
            "conversion journal returned invalid publication state: {state:?}"
        ))),
        Err(failure) => Err(failure.into_error()),
    }
}

fn remove_conversion_journal(paths: &StoragePaths, id: NoteId) -> Result<(), CommandError> {
    let root = SafeDirectory::open(paths.root(), &[], false)?;
    root.remove_checked(&conversion_journal_name(id))?;
    root.sync()
}

fn conversion_journal_name(id: NoteId) -> String {
    format!("{CONVERSION_PREFIX}{id}.json")
}

fn write_delete_descriptor(
    paths: &StoragePaths,
    descriptor: &DeleteDescriptor,
) -> Result<(), CommandError> {
    validate_operation_id(&descriptor.operation_id)?;
    let bytes = serde_json::to_vec_pretty(descriptor).map_err(|source| {
        CommandError::io(format!("could not serialize delete descriptor: {source}"))
    })?;
    match atomic_replace_contained(
        paths.root(),
        &["trash", &descriptor.operation_id],
        DESCRIPTOR_NAME,
        &bytes,
    ) {
        Ok(PublishState::Published) => Ok(()),
        Ok(state) => Err(CommandError::io(format!(
            "delete descriptor returned invalid publication state: {state:?}"
        ))),
        Err(failure) => Err(failure.into_error()),
    }
}

fn read_delete_descriptor(
    paths: &StoragePaths,
    operation_id: &str,
) -> Result<DeleteDescriptor, CommandError> {
    validate_operation_id(operation_id)?;
    let directory = SafeDirectory::open(paths.root(), &["trash", operation_id], false)?;
    let bytes = directory.read(DESCRIPTOR_NAME, 4 * 1024 * 1024)?;
    let descriptor: DeleteDescriptor = serde_json::from_slice(&bytes).map_err(|source| {
        CommandError::validation(format!("delete descriptor is invalid: {source}"))
    })?;
    if descriptor.operation_id != operation_id {
        return Err(CommandError::validation(
            "delete descriptor operation ID does not match its path",
        ));
    }
    Ok(descriptor)
}

fn validate_operation_id(value: &str) -> Result<(), CommandError> {
    let uuid = Uuid::parse_str(value)
        .map_err(|_| CommandError::validation("trash operation ID is invalid"))?;
    if uuid.get_version() != Some(uuid::Version::SortRand) || uuid.hyphenated().to_string() != value
    {
        return Err(CommandError::validation("trash operation ID is invalid"));
    }
    Ok(())
}

fn open_database(paths: &StoragePaths) -> Result<Database, CommandError> {
    let database = Database::open(paths.database())?;
    database.migrate()?;
    Ok(database)
}

fn database_error(context: &'static str) -> impl FnOnce(rusqlite::Error) -> CommandError {
    move |source| CommandError::database(format!("{context}: {source}"))
}
