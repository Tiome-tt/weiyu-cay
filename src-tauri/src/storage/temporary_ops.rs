use crate::{
    domain::{
        BatchConversionFailure, BatchConversionResult, ConvertTemporaryInput,
        ConvertedTemporaryNote, DeleteTemporaryResult, FolderId, NoteDocument, NoteId, NoteKind,
        TemporaryOperationFailure, UndoTemporaryDeleteResult,
    },
    error::{CommandError, CommandErrorCode},
    platform::{IndexMutationLock, SafeDirectory},
    storage::{
        atomic_file::{atomic_replace_contained, PublishState},
        database::Database,
        paths::StoragePaths,
        repository::{
            folder_id_blob, is_application_whitespace, note_id_blob, parse_document,
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
    CrashAfterRollbackIntent,
    CrashAfterRollbackMove,
    CrashAfterRollbackDocument,
    RestoreBeforeDatabase,
    RestoreBeforeRollback,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversionJournal {
    version: u8,
    phase: ConversionPhase,
    original: NoteDocument,
    formal: NoteDocument,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum ConversionPhase {
    Prepared,
    Committed,
    RollingBack,
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
    original: NoteDocument,
    original_kind: NoteKind,
    original_location: DeleteOriginalLocation,
    window_state: Option<crate::domain::TemporaryWindowState>,
    state: DeleteItemState,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum DeleteOriginalLocation {
    Temporary,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum DeleteItemState {
    Prepared,
    RollingBack,
    Deleted,
    Restoring,
    RestoreRollingBack,
    Restored,
}

enum DirectoryMoveOutcome {
    Published,
    PublishedButSyncFailed(CommandError),
    PublishedUntrusted(CommandError),
    NotPublished(CommandError),
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
            version: 2,
            operation_id: operation_id.clone(),
            deleted_at: timestamp.clone(),
            items: Vec::new(),
        };
        let mut descriptor = descriptor;
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
            match self.delete_one(&mut descriptor, id) {
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
            if !matches!(
                item.state,
                DeleteItemState::Deleted | DeleteItemState::Restored
            ) {
                continue;
            }
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
            version: 2,
            phase: ConversionPhase::Prepared,
            original: original.clone(),
            formal: formal.clone(),
        };
        self.fail(TemporaryFailurePoint::BeforeJournal)?;
        write_conversion_journal(&self.paths, &journal)?;
        self.fail(TemporaryFailurePoint::BeforeMove)?;
        match move_note_directory(&self.paths, NoteKind::Temporary, NoteKind::Formal, id) {
            DirectoryMoveOutcome::Published => {}
            DirectoryMoveOutcome::NotPublished(error) => return Err(error),
            DirectoryMoveOutcome::PublishedButSyncFailed(error)
            | DirectoryMoveOutcome::PublishedUntrusted(error) => {
                self.rollback_conversion(id, &original, &guard)?;
                return Err(error);
            }
        }
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
        let mut committed = journal;
        committed.phase = ConversionPhase::Committed;
        if let Err(error) = write_conversion_journal(&self.paths, &committed) {
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
        let mut journal = read_conversion_journal(&self.paths, id)?;
        journal.phase = ConversionPhase::RollingBack;
        write_conversion_journal(&self.paths, &journal)?;
        self.fail(TemporaryFailurePoint::CrashAfterRollbackIntent)?;
        let mut move_sync_error = None;
        if contained_directory_exists(&self.paths, "notes", &id.to_string())? {
            validate_conversion_document(&self.paths, NoteKind::Formal, &journal)?;
            match move_note_directory(&self.paths, NoteKind::Formal, NoteKind::Temporary, id) {
                DirectoryMoveOutcome::Published => {}
                DirectoryMoveOutcome::PublishedButSyncFailed(error) => {
                    move_sync_error = Some(error)
                }
                DirectoryMoveOutcome::PublishedUntrusted(error)
                | DirectoryMoveOutcome::NotPublished(error) => return Err(error),
            }
        }
        self.fail(TemporaryFailurePoint::CrashAfterRollbackMove)?;
        write_note_document(&self.paths, original)?;
        self.fail(TemporaryFailurePoint::CrashAfterRollbackDocument)?;
        let database = open_database(&self.paths)?;
        let transaction = database
            .connection()
            .unchecked_transaction()
            .map_err(database_error("could not start conversion rollback"))?;
        persist_document_in_transaction(&transaction, original)?;
        transaction
            .commit()
            .map_err(database_error("could not commit conversion rollback"))?;
        if let Some(error) = move_sync_error {
            Err(error)
        } else {
            remove_conversion_journal(&self.paths, id)
        }
    }

    fn delete_one(
        &self,
        descriptor: &mut DeleteDescriptor,
        id: NoteId,
    ) -> Result<(), CommandError> {
        let guard = IndexMutationLock::acquire(self.paths.root())?;
        let document = NoteRepository::new(self.paths.clone()).load_locked(id, &guard)?;
        if document.kind != NoteKind::Temporary {
            return Err(CommandError::validation("capture is no longer temporary"));
        }
        let database = open_database(&self.paths)?;
        let window_state = load_temporary_window_state(database.connection(), id)?;
        descriptor.items.push(DeleteDescriptorItem {
            temporary_id: id,
            original: document.clone(),
            original_kind: NoteKind::Temporary,
            original_location: DeleteOriginalLocation::Temporary,
            window_state,
            state: DeleteItemState::Prepared,
        });
        write_delete_descriptor(&self.paths, descriptor)?;
        self.fail(TemporaryFailurePoint::BeforeMove)?;
        match move_temporary_to_trash(&self.paths, &descriptor.operation_id, id) {
            DirectoryMoveOutcome::Published => {}
            DirectoryMoveOutcome::NotPublished(error) => {
                descriptor.items.retain(|item| item.temporary_id != id);
                write_delete_descriptor(&self.paths, descriptor)?;
                return Err(error);
            }
            DirectoryMoveOutcome::PublishedButSyncFailed(error)
            | DirectoryMoveOutcome::PublishedUntrusted(error) => {
                self.rollback_delete_move(descriptor, id)?;
                return Err(error);
            }
        }
        if let Err(error) = crate::storage::trash::catalog_moved_temporary(
            &self.paths,
            &descriptor.operation_id,
            &document,
            &descriptor.deleted_at,
        ) {
            self.rollback_delete_move(descriptor, id)?;
            return Err(error);
        }
        self.fail(TemporaryFailurePoint::CrashAfterMove)?;
        if let Err(error) = self
            .fail(TemporaryFailurePoint::AfterMove)
            .and_then(|()| mark_deleted(&self.paths, id, &descriptor.deleted_at))
        {
            self.fail(TemporaryFailurePoint::BeforeRollback)?;
            self.rollback_delete_move(descriptor, id)?;
            return Err(error);
        }
        if let Err(error) =
            crate::storage::trash::mark_catalog_deleted(&self.paths, &descriptor.operation_id, id)
        {
            self.rollback_delete_move(descriptor, id)?;
            return Err(error);
        }
        descriptor
            .items
            .iter_mut()
            .find(|item| item.temporary_id == id)
            .expect("enrolled delete item")
            .state = DeleteItemState::Deleted;
        if let Err(error) = write_delete_descriptor(&self.paths, descriptor) {
            self.rollback_delete_move(descriptor, id)?;
            return Err(error);
        }
        let _ = self.backend.retire(&temporary_window_label(id));
        Ok(())
    }

    fn rollback_delete_move(
        &self,
        descriptor: &mut DeleteDescriptor,
        id: NoteId,
    ) -> Result<(), CommandError> {
        let item_index = descriptor
            .items
            .iter()
            .position(|item| item.temporary_id == id)
            .ok_or_else(|| CommandError::not_found("delete item is not enrolled"))?;
        descriptor.items[item_index].state = DeleteItemState::RollingBack;
        let _ = write_delete_descriptor(&self.paths, descriptor);
        validate_trashed_document(
            &self.paths,
            &descriptor.operation_id,
            &descriptor.items[item_index],
        )?;
        require_synced_move(move_trash_to_temporary(
            &self.paths,
            &descriptor.operation_id,
            id,
        ))?;
        validate_temporary_document(&self.paths, &descriptor.items[item_index])?;
        persist_temporary_restore(
            &self.paths,
            &descriptor.items[item_index].original,
            descriptor.items[item_index].window_state,
        )?;
        let _ = crate::storage::trash::remove_catalog_manifest(
            &self.paths,
            &descriptor.operation_id,
            id,
        );
        descriptor.items.remove(item_index);
        write_delete_descriptor(&self.paths, descriptor)
    }

    fn restore_one(&self, operation_id: &str, id: NoteId) -> Result<(), CommandError> {
        let guard = IndexMutationLock::acquire(self.paths.root())?;
        let mut descriptor = read_delete_descriptor(&self.paths, operation_id)?;
        let item_index = descriptor
            .items
            .iter()
            .position(|item| item.temporary_id == id)
            .ok_or_else(|| CommandError::not_found("delete item is not enrolled"))?;
        let window_state = descriptor.items[item_index].window_state;
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
            (true, false) => {
                let document = NoteRepository::new(self.paths.clone()).load_locked(id, &guard)?;
                persist_temporary_restore(&self.paths, &document, window_state)?;
                descriptor.items[item_index].state = DeleteItemState::Restored;
                write_delete_descriptor(&self.paths, &descriptor)?;
                return Ok(());
            }
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
        descriptor.items[item_index].state = DeleteItemState::Restoring;
        write_delete_descriptor(&self.paths, &descriptor)?;
        match move_trash_to_temporary(&self.paths, operation_id, id) {
            DirectoryMoveOutcome::Published => {}
            DirectoryMoveOutcome::NotPublished(error) => {
                descriptor.items[item_index].state = DeleteItemState::Deleted;
                write_delete_descriptor(&self.paths, &descriptor)?;
                return Err(error);
            }
            DirectoryMoveOutcome::PublishedButSyncFailed(error)
            | DirectoryMoveOutcome::PublishedUntrusted(error) => {
                self.rollback_restore_move(&mut descriptor, item_index, operation_id, id)?;
                return Err(error);
            }
        }
        let document = match NoteRepository::new(self.paths.clone()).load_locked(id, &guard) {
            Ok(document) => document,
            Err(error) => {
                self.rollback_restore_move(&mut descriptor, item_index, operation_id, id)?;
                return Err(error);
            }
        };
        if let Err(error) = self
            .fail(TemporaryFailurePoint::RestoreBeforeDatabase)
            .and_then(|()| persist_temporary_restore(&self.paths, &document, window_state))
        {
            self.fail(TemporaryFailurePoint::RestoreBeforeRollback)?;
            self.rollback_restore_move(&mut descriptor, item_index, operation_id, id)?;
            return Err(error);
        }
        descriptor.items[item_index].state = DeleteItemState::Restored;
        if let Err(error) = write_delete_descriptor(&self.paths, &descriptor) {
            self.rollback_restore_move(&mut descriptor, item_index, operation_id, id)?;
            return Err(error);
        }
        crate::storage::trash::remove_catalog_manifest(&self.paths, operation_id, id)?;
        Ok(())
    }

    fn rollback_restore_move(
        &self,
        descriptor: &mut DeleteDescriptor,
        item_index: usize,
        operation_id: &str,
        id: NoteId,
    ) -> Result<(), CommandError> {
        descriptor.items[item_index].state = DeleteItemState::RestoreRollingBack;
        let _ = write_delete_descriptor(&self.paths, descriptor);
        validate_temporary_document(&self.paths, &descriptor.items[item_index])?;
        match move_temporary_to_trash(&self.paths, operation_id, id) {
            DirectoryMoveOutcome::Published => {
                mark_deleted(&self.paths, id, &descriptor.deleted_at)?;
                descriptor.items[item_index].state = DeleteItemState::Deleted;
                write_delete_descriptor(&self.paths, descriptor)
            }
            DirectoryMoveOutcome::PublishedButSyncFailed(error)
            | DirectoryMoveOutcome::PublishedUntrusted(error)
            | DirectoryMoveOutcome::NotPublished(error) => Err(error),
        }
    }

    fn recover_conversions_locked(&self, _guard: &IndexMutationLock) -> Result<(), CommandError> {
        let root = SafeDirectory::open(self.paths.root(), &[], false)?;
        let mut names = root.entry_names()?;
        names.sort();
        for name in names {
            if !name.starts_with(CONVERSION_PREFIX) || !name.ends_with(".json") {
                continue;
            }
            if !root.entry_is_regular_file(&name)? {
                continue;
            }
            let bytes = match root.read(&name, 64 * 1024 * 1024) {
                Ok(bytes) => bytes,
                Err(error) if error.code() == CommandErrorCode::Validation => continue,
                Err(error) => return Err(error),
            };
            let journal = match parse_conversion_journal_bytes(&name, &bytes) {
                Ok(journal) => journal,
                Err(_) => {
                    quarantine_file(&root, &name)?;
                    continue;
                }
            };
            self.recover_conversion_entry(&journal, _guard)?;
        }
        Ok(())
    }

    fn recover_conversion_entry(
        &self,
        journal: &ConversionJournal,
        _guard: &IndexMutationLock,
    ) -> Result<(), CommandError> {
        let id = journal.formal.id;
        let temporary = contained_directory_exists(&self.paths, "temporary", &id.to_string())?;
        let formal = contained_directory_exists(&self.paths, "notes", &id.to_string())?;
        match journal.phase {
            ConversionPhase::Committed => match (temporary, formal) {
                (true, false) => {
                    validate_conversion_document(&self.paths, NoteKind::Temporary, journal)?;
                    remove_conversion_journal(&self.paths, id)
                }
                (false, true) => {
                    validate_conversion_document(&self.paths, NoteKind::Formal, journal)?;
                    write_note_document(&self.paths, &journal.formal)?;
                    let database = open_database(&self.paths)?;
                    persist_formal_and_retire_state(database.connection(), &journal.formal)?;
                    if self.backend.retire(&temporary_window_label(id)).is_ok() {
                        remove_conversion_journal(&self.paths, id)?;
                    }
                    Ok(())
                }
                (true, true) => Err(CommandError::conflict(
                    "conversion recovery found duplicate note directories",
                )),
                (false, false) => Err(CommandError::io(
                    "conversion recovery could not find durable content",
                )),
            },
            ConversionPhase::Prepared | ConversionPhase::RollingBack => match (temporary, formal) {
                (false, true) => {
                    validate_conversion_document(&self.paths, NoteKind::Formal, journal)?;
                    require_synced_move(move_note_directory(
                        &self.paths,
                        NoteKind::Formal,
                        NoteKind::Temporary,
                        id,
                    ))?;
                    finish_conversion_rollback(&self.paths, &journal.original)
                }
                (true, false) => {
                    validate_conversion_document(&self.paths, NoteKind::Temporary, journal)?;
                    finish_conversion_rollback(&self.paths, &journal.original)
                }
                (true, true) => Err(CommandError::conflict(
                    "conversion rollback found duplicate note directories",
                )),
                (false, false) => Err(CommandError::io(
                    "conversion rollback could not find durable content",
                )),
            },
        }
    }

    fn recover_deletions_locked(&self, _guard: &IndexMutationLock) -> Result<(), CommandError> {
        let trash = SafeDirectory::open(self.paths.root(), &["trash"], false)?;
        let mut names = trash.entry_names()?;
        names.sort();
        for name in names {
            if Uuid::parse_str(&name).is_err() {
                continue;
            }
            let Ok(operation) = SafeDirectory::open(self.paths.root(), &["trash", &name], false)
            else {
                continue;
            };
            if !operation.entry_is_regular_file(DESCRIPTOR_NAME)? {
                continue;
            }
            let bytes = match operation.read(DESCRIPTOR_NAME, 4 * 1024 * 1024) {
                Ok(bytes) => bytes,
                Err(error) if error.code() == CommandErrorCode::Validation => continue,
                Err(error) => return Err(error),
            };
            let descriptor = match parse_delete_descriptor_bytes(&name, &bytes) {
                Ok(descriptor) => descriptor,
                Err(_) => {
                    quarantine_file(&operation, DESCRIPTOR_NAME)?;
                    continue;
                }
            };
            self.recover_delete_operation(&name, descriptor, _guard)?;
        }
        Ok(())
    }

    fn recover_delete_operation(
        &self,
        operation_id: &str,
        mut descriptor: DeleteDescriptor,
        _guard: &IndexMutationLock,
    ) -> Result<(), CommandError> {
        let mut retain = Vec::with_capacity(descriptor.items.len());
        for item in descriptor.items.clone() {
            let original = item.clone();
            match self.recover_delete_item(operation_id, &descriptor.deleted_at, item) {
                Ok(Some(item)) => retain.push(item),
                Ok(None) => {}
                Err(_) => retain.push(original),
            }
        }
        descriptor.items = retain;
        write_delete_descriptor(&self.paths, &descriptor)
    }

    fn recover_delete_item(
        &self,
        operation_id: &str,
        deleted_at: &str,
        mut item: DeleteDescriptorItem,
    ) -> Result<Option<DeleteDescriptorItem>, CommandError> {
        let id = item.temporary_id;
        let temporary = contained_directory_exists(&self.paths, "temporary", &id.to_string())?;
        let operation = SafeDirectory::open(self.paths.root(), &["trash", operation_id], false)?;
        let trashed = operation
            .entry_names()?
            .iter()
            .any(|name| name == &id.to_string());
        match (item.state, temporary, trashed) {
            (DeleteItemState::Prepared | DeleteItemState::RollingBack, true, false) => {
                validate_temporary_document(&self.paths, &item)?;
                let _ =
                    crate::storage::trash::remove_catalog_manifest(&self.paths, operation_id, id);
                return Ok(None);
            }
            (DeleteItemState::Prepared | DeleteItemState::RollingBack, false, true) => {
                validate_trashed_document(&self.paths, operation_id, &item)?;
                require_synced_move(move_trash_to_temporary(&self.paths, operation_id, id))?;
                validate_temporary_document(&self.paths, &item)?;
                persist_temporary_restore(&self.paths, &item.original, item.window_state)?;
                let _ =
                    crate::storage::trash::remove_catalog_manifest(&self.paths, operation_id, id);
                return Ok(None);
            }
            (DeleteItemState::Deleted, false, true) => {
                validate_trashed_document(&self.paths, operation_id, &item)?;
                crate::storage::trash::catalog_moved_temporary(
                    &self.paths,
                    operation_id,
                    &item.original,
                    deleted_at,
                )?;
                mark_deleted(&self.paths, id, deleted_at)?;
                crate::storage::trash::mark_catalog_deleted(&self.paths, operation_id, id)?;
                let _ = self.backend.retire(&temporary_window_label(id));
            }
            (DeleteItemState::Restored, true, false) => {
                validate_temporary_document(&self.paths, &item)?;
                persist_temporary_restore(&self.paths, &item.original, item.window_state)?;
                let _ =
                    crate::storage::trash::remove_catalog_manifest(&self.paths, operation_id, id);
            }
            (DeleteItemState::Restoring | DeleteItemState::RestoreRollingBack, true, false) => {
                validate_temporary_document(&self.paths, &item)?;
                require_synced_move(move_temporary_to_trash(&self.paths, operation_id, id))?;
                validate_trashed_document(&self.paths, operation_id, &item)?;
                mark_deleted(&self.paths, id, deleted_at)?;
                item.state = DeleteItemState::Deleted;
            }
            (DeleteItemState::Restoring | DeleteItemState::RestoreRollingBack, false, true) => {
                validate_trashed_document(&self.paths, operation_id, &item)?;
                item.state = DeleteItemState::Deleted;
            }
            (_, true, true) => {
                return Err(CommandError::conflict(
                    "delete recovery found duplicate capture directories",
                ));
            }
            (_, false, false) => {
                return Err(CommandError::io(
                    "delete recovery could not find durable content",
                ));
            }
            (DeleteItemState::Deleted, true, false) => {
                validate_temporary_document(&self.paths, &item)?;
                persist_temporary_restore(&self.paths, &item.original, item.window_state)?;
                return Ok(None);
            }
            (DeleteItemState::Restored, false, true) => {
                return Err(CommandError::conflict(
                    "restored delete item unexpectedly remains in trash",
                ));
            }
        }
        Ok(Some(item))
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

fn load_temporary_window_state(
    connection: &rusqlite::Connection,
    id: NoteId,
) -> Result<Option<crate::domain::TemporaryWindowState>, CommandError> {
    connection
        .query_row(
            "SELECT visible, x, y, width, height, always_on_top FROM temporary_windows WHERE note_id=?1",
            [note_id_blob(id)],
            |row| {
                Ok(crate::domain::TemporaryWindowState {
                    note_id: id,
                    visible: row.get::<_, i64>(0)? != 0,
                    x: row.get(1)?,
                    y: row.get(2)?,
                    width: row.get(3)?,
                    height: row.get(4)?,
                    always_on_top: row.get::<_, i64>(5)? != 0,
                })
            },
        )
        .optional()
        .map_err(database_error("could not capture temporary window state"))
}

fn persist_temporary_restore(
    paths: &StoragePaths,
    document: &NoteDocument,
    window_state: Option<crate::domain::TemporaryWindowState>,
) -> Result<(), CommandError> {
    if document.kind != NoteKind::Temporary || document.folder_id.is_some() {
        return Err(CommandError::validation(
            "restored document is not a canonical temporary capture",
        ));
    }
    let database = open_database(paths)?;
    let transaction = database
        .connection()
        .unchecked_transaction()
        .map_err(database_error("could not start temporary restore"))?;
    persist_document_in_transaction(&transaction, document)?;
    if let Some(state) = window_state {
        if state.note_id != document.id {
            return Err(CommandError::validation(
                "restored window state identity does not match capture",
            ));
        }
        transaction
            .execute(
                "INSERT INTO temporary_windows (note_id, visible, x, y, width, height, always_on_top) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(note_id) DO UPDATE SET \
                 visible=excluded.visible, x=excluded.x, y=excluded.y, width=excluded.width, \
                 height=excluded.height, always_on_top=excluded.always_on_top",
                params![
                    note_id_blob(document.id),
                    state.visible,
                    state.x,
                    state.y,
                    state.width,
                    state.height,
                    state.always_on_top,
                ],
            )
            .map_err(database_error("could not restore temporary window state"))?;
    }
    transaction
        .commit()
        .map_err(database_error("could not commit temporary restore"))
}

fn finish_conversion_rollback(
    paths: &StoragePaths,
    original: &NoteDocument,
) -> Result<(), CommandError> {
    write_note_document(paths, original)?;
    let database = open_database(paths)?;
    let transaction = database
        .connection()
        .unchecked_transaction()
        .map_err(database_error(
            "could not start conversion rollback recovery",
        ))?;
    persist_document_in_transaction(&transaction, original)?;
    transaction.commit().map_err(database_error(
        "could not commit conversion rollback recovery",
    ))?;
    remove_conversion_journal(paths, original.id)
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
) -> DirectoryMoveOutcome {
    let source_name = match source_kind {
        NoteKind::Formal => "notes",
        NoteKind::Temporary => "temporary",
    };
    let destination_name = match destination_kind {
        NoteKind::Formal => "notes",
        NoteKind::Temporary => "temporary",
    };
    let source = match SafeDirectory::open(paths.root(), &[source_name], false) {
        Ok(source) => source,
        Err(error) => return DirectoryMoveOutcome::NotPublished(error),
    };
    let destination = match SafeDirectory::open(paths.root(), &[destination_name], false) {
        Ok(destination) => destination,
        Err(error) => return DirectoryMoveOutcome::NotPublished(error),
    };
    let id = id.to_string();
    classify_directory_move(source.move_directory_no_replace(&id, &destination, &id))
}

fn move_temporary_to_trash(
    paths: &StoragePaths,
    operation_id: &str,
    id: NoteId,
) -> DirectoryMoveOutcome {
    if let Err(error) = validate_operation_id(operation_id) {
        return DirectoryMoveOutcome::NotPublished(error);
    }
    let source = match SafeDirectory::open(paths.root(), &["temporary"], false) {
        Ok(source) => source,
        Err(error) => return DirectoryMoveOutcome::NotPublished(error),
    };
    let destination = match SafeDirectory::open(paths.root(), &["trash", operation_id], false) {
        Ok(destination) => destination,
        Err(error) => return DirectoryMoveOutcome::NotPublished(error),
    };
    let id = id.to_string();
    classify_directory_move(source.move_directory_no_replace(&id, &destination, &id))
}

fn move_trash_to_temporary(
    paths: &StoragePaths,
    operation_id: &str,
    id: NoteId,
) -> DirectoryMoveOutcome {
    if let Err(error) = validate_operation_id(operation_id) {
        return DirectoryMoveOutcome::NotPublished(error);
    }
    let source = match SafeDirectory::open(paths.root(), &["trash", operation_id], false) {
        Ok(source) => source,
        Err(error) => return DirectoryMoveOutcome::NotPublished(error),
    };
    let destination = match SafeDirectory::open(paths.root(), &["temporary"], false) {
        Ok(destination) => destination,
        Err(error) => return DirectoryMoveOutcome::NotPublished(error),
    };
    let id = id.to_string();
    classify_directory_move(source.move_directory_no_replace(&id, &destination, &id))
}

fn classify_directory_move(
    result: Result<PublishState, crate::storage::atomic_file::PublishFailure>,
) -> DirectoryMoveOutcome {
    match result {
        Ok(PublishState::Published) => DirectoryMoveOutcome::Published,
        Ok(state) => DirectoryMoveOutcome::PublishedUntrusted(CommandError::io(format!(
            "directory move returned invalid publication state: {state:?}"
        ))),
        Err(failure) => match failure.state() {
            PublishState::NotPublished => DirectoryMoveOutcome::NotPublished(failure.into_error()),
            PublishState::PublishedButSyncFailed => {
                DirectoryMoveOutcome::PublishedButSyncFailed(failure.into_error())
            }
            PublishState::RecoveryRequired | PublishState::Published => {
                DirectoryMoveOutcome::PublishedUntrusted(failure.into_error())
            }
        },
    }
}

fn require_synced_move(outcome: DirectoryMoveOutcome) -> Result<(), CommandError> {
    match outcome {
        DirectoryMoveOutcome::Published => Ok(()),
        DirectoryMoveOutcome::PublishedButSyncFailed(error)
        | DirectoryMoveOutcome::PublishedUntrusted(error)
        | DirectoryMoveOutcome::NotPublished(error) => Err(error),
    }
}

fn write_conversion_journal(
    paths: &StoragePaths,
    journal: &ConversionJournal,
) -> Result<(), CommandError> {
    let bytes = serde_json::to_vec(journal).map_err(|source| {
        CommandError::io(format!("could not serialize conversion journal: {source}"))
    })?;
    let name = conversion_journal_name(journal.formal.id);
    match atomic_replace_contained(paths.root(), &[], &name, &bytes) {
        Ok(PublishState::Published) => Ok(()),
        Ok(state) => Err(CommandError::io(format!(
            "conversion journal returned invalid publication state: {state:?}"
        ))),
        Err(failure) if failure.state() != PublishState::NotPublished => {
            recover_and_confirm_contained(paths, &[], &name, &bytes)
                .map_err(|_| failure.into_error())
        }
        Err(failure) => Err(failure.into_error()),
    }
}

fn read_conversion_journal(
    paths: &StoragePaths,
    id: NoteId,
) -> Result<ConversionJournal, CommandError> {
    let root = SafeDirectory::open(paths.root(), &[], false)?;
    let name = conversion_journal_name(id);
    let bytes = root.read(&name, 64 * 1024 * 1024)?;
    let journal: ConversionJournal = serde_json::from_slice(&bytes).map_err(|source| {
        CommandError::validation(format!("conversion journal is invalid: {source}"))
    })?;
    validate_conversion_journal(&name, &journal)?;
    Ok(journal)
}

fn parse_conversion_journal_bytes(
    name: &str,
    bytes: &[u8],
) -> Result<ConversionJournal, CommandError> {
    let journal: ConversionJournal = serde_json::from_slice(bytes).map_err(|source| {
        CommandError::validation(format!("conversion journal is invalid: {source}"))
    })?;
    validate_conversion_journal(name, &journal)?;
    Ok(journal)
}

fn validate_conversion_journal(
    name: &str,
    journal: &ConversionJournal,
) -> Result<(), CommandError> {
    if journal.version != 2
        || journal.original.id != journal.formal.id
        || name != conversion_journal_name(journal.formal.id)
        || journal.original.kind != NoteKind::Temporary
        || journal.original.folder_id.is_some()
        || journal.formal.kind != NoteKind::Formal
        || journal.formal.folder_id.is_none()
    {
        return Err(CommandError::validation(
            "conversion journal identity or state is invalid",
        ));
    }
    Ok(())
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
        Err(failure) if failure.state() != PublishState::NotPublished => {
            recover_and_confirm_contained(
                paths,
                &["trash", &descriptor.operation_id],
                DESCRIPTOR_NAME,
                &bytes,
            )
            .map_err(|_| failure.into_error())
        }
        Err(failure) => Err(failure.into_error()),
    }
}

fn recover_and_confirm_contained(
    paths: &StoragePaths,
    segments: &[&str],
    name: &str,
    expected: &[u8],
) -> Result<(), CommandError> {
    let directory = SafeDirectory::open(paths.root(), segments, false)?;
    directory.recover(name)?;
    if directory.read(name, expected.len() as u64 + 1)? != expected {
        return Err(CommandError::conflict(
            "recovered operation state does not match the requested phase",
        ));
    }
    directory.sync_file(name)?;
    directory.sync()
}

fn read_delete_descriptor(
    paths: &StoragePaths,
    operation_id: &str,
) -> Result<DeleteDescriptor, CommandError> {
    validate_operation_id(operation_id)?;
    let directory = SafeDirectory::open(paths.root(), &["trash", operation_id], false)?;
    let bytes = directory.read(DESCRIPTOR_NAME, 4 * 1024 * 1024)?;
    parse_delete_descriptor_bytes(operation_id, &bytes)
}

fn parse_delete_descriptor_bytes(
    operation_id: &str,
    bytes: &[u8],
) -> Result<DeleteDescriptor, CommandError> {
    let descriptor: DeleteDescriptor = serde_json::from_slice(bytes).map_err(|source| {
        CommandError::validation(format!("delete descriptor is invalid: {source}"))
    })?;
    if descriptor.operation_id != operation_id {
        return Err(CommandError::validation(
            "delete descriptor operation ID does not match its path",
        ));
    }
    validate_delete_descriptor(&descriptor)?;
    Ok(descriptor)
}

fn validate_delete_descriptor(descriptor: &DeleteDescriptor) -> Result<(), CommandError> {
    if descriptor.version != 2 {
        return Err(CommandError::validation(
            "delete descriptor version is unsupported",
        ));
    }
    let mut seen = HashSet::new();
    for item in &descriptor.items {
        if !seen.insert(item.temporary_id)
            || item.original.id != item.temporary_id
            || item.original.kind != NoteKind::Temporary
            || item.original.folder_id.is_some()
            || item.original_kind != NoteKind::Temporary
            || item.original_location != DeleteOriginalLocation::Temporary
            || item
                .window_state
                .is_some_and(|state| state.note_id != item.temporary_id)
        {
            return Err(CommandError::validation(
                "delete descriptor item identity or state is invalid",
            ));
        }
    }
    Ok(())
}

fn validate_trashed_document(
    paths: &StoragePaths,
    operation_id: &str,
    item: &DeleteDescriptorItem,
) -> Result<(), CommandError> {
    let id = item.temporary_id.to_string();
    let operation = SafeDirectory::open(paths.root(), &["trash", operation_id], false)?;
    operation.validate_directory_tree(&id)?;
    let directory = SafeDirectory::open(paths.root(), &["trash", operation_id, &id], false)?;
    let bytes = directory.read("note.md", 64 * 1024 * 1024)?;
    let text = String::from_utf8(bytes).map_err(|source| {
        CommandError::validation(format!("trashed note is not UTF-8: {source}"))
    })?;
    let document = parse_document(&text)?;
    if document != item.original {
        return Err(CommandError::validation(
            "trashed document does not match descriptor",
        ));
    }
    Ok(())
}

fn validate_temporary_document(
    paths: &StoragePaths,
    item: &DeleteDescriptorItem,
) -> Result<(), CommandError> {
    let id = item.temporary_id.to_string();
    let parent = SafeDirectory::open(paths.root(), &["temporary"], false)?;
    parent.validate_directory_tree(&id)?;
    let directory = SafeDirectory::open(paths.root(), &["temporary", &id], false)?;
    let bytes = directory.read("note.md", 64 * 1024 * 1024)?;
    let text = String::from_utf8(bytes).map_err(|source| {
        CommandError::validation(format!("temporary note is not UTF-8: {source}"))
    })?;
    if parse_document(&text)? != item.original {
        return Err(CommandError::validation(
            "temporary document does not match descriptor",
        ));
    }
    Ok(())
}

fn contained_directory_exists(
    paths: &StoragePaths,
    parent: &str,
    child: &str,
) -> Result<bool, CommandError> {
    let directory = SafeDirectory::open(paths.root(), &[parent], false)?;
    if !directory.entry_names()?.iter().any(|name| name == child) {
        return Ok(false);
    }
    SafeDirectory::open(paths.root(), &[parent, child], false)?;
    Ok(true)
}

fn validate_conversion_document(
    paths: &StoragePaths,
    location: NoteKind,
    journal: &ConversionJournal,
) -> Result<(), CommandError> {
    let base = match location {
        NoteKind::Temporary => "temporary",
        NoteKind::Formal => "notes",
    };
    let id = journal.original.id.to_string();
    let parent = SafeDirectory::open(paths.root(), &[base], false)?;
    parent.validate_directory_tree(&id)?;
    let directory = SafeDirectory::open(paths.root(), &[base, &id], false)?;
    let bytes = directory.read("note.md", 64 * 1024 * 1024)?;
    let text = String::from_utf8(bytes).map_err(|source| {
        CommandError::validation(format!("conversion document is not UTF-8: {source}"))
    })?;
    let document = parse_document(&text)?;
    if document != journal.original && document != journal.formal {
        return Err(CommandError::validation(
            "conversion document does not match its recovery journal",
        ));
    }
    Ok(())
}

fn quarantine_file(directory: &SafeDirectory, name: &str) -> Result<(), CommandError> {
    let destination = format!("quarantined-{name}-{}", Uuid::now_v7());
    directory.move_file(name, &destination)?;
    directory.sync()
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
