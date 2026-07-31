use crate::{
    domain::{FolderId, NoteDocument, NoteId, NoteKind, NoteSummary},
    error::CommandError,
    storage::{
        atomic_file::{PublishFailure, PublishResult, PublishState},
        database::Database,
        paths::StoragePaths,
    },
};
use chrono::DateTime;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, io::ErrorKind, path::PathBuf};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

const REBUILD_MARKER: &str = "rebuild-needed.json";
const RECOVERY_MARKER: &str = "recovery-needed.json";
const NOTE_RECOVERY_DESCRIPTOR: &str = ".note.md.replace-recovery.json";

pub struct NoteRepository {
    paths: StoragePaths,
    database: Database,
    writer: DocumentWriter,
}

pub type DocumentWriter = fn(&StoragePaths, NoteId, NoteKind, &[u8]) -> PublishResult;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteMetadata {
    id: NoteId,
    kind: NoteKind,
    title: String,
    folder_id: Option<FolderId>,
    tags: Vec<String>,
    revision: u64,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RebuildMarker<'a> {
    reason: &'a str,
    note_id: NoteId,
}

#[derive(Debug)]
pub(crate) struct ParsedLink {
    pub target: NoteId,
    pub label: String,
    pub start: usize,
    pub end: usize,
}

impl NoteRepository {
    pub fn new(paths: StoragePaths, database: Database) -> Self {
        Self {
            paths,
            database,
            writer: default_document_writer,
        }
    }

    #[doc(hidden)]
    pub fn new_with_writer(
        paths: StoragePaths,
        database: Database,
        writer: DocumentWriter,
    ) -> Self {
        Self {
            paths,
            database,
            writer,
        }
    }

    pub fn create(&self, document: NoteDocument) -> Result<NoteDocument, CommandError> {
        validate_document(&document)?;
        if document.revision != 0 {
            return Err(CommandError::validation(
                "new notes must start at revision zero",
            ));
        }
        self.validate_folder_exists(document.folder_id)?;
        if self.document_exists(document.id)? {
            return Err(CommandError::conflict("note identity already exists"));
        }
        self.write_document(&document)?;
        self.persist_after_content(&document)?;
        Ok(document)
    }

    pub fn load(&self, id: NoteId) -> Result<NoteDocument, CommandError> {
        let mut found = None;
        for kind in [NoteKind::Formal, NoteKind::Temporary] {
            let note_directory = self.paths.note_dir(id, kind)?;
            match fs::symlink_metadata(&note_directory) {
                Err(source) if source.kind() == ErrorKind::NotFound => continue,
                Err(source) => {
                    return Err(CommandError::io(format!(
                        "could not inspect note directory: {source}"
                    )))
                }
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                    return Err(CommandError::validation(
                        "canonical note directory must be a directory and not a symlink",
                    ))
                }
                Ok(_) => {}
            }
            let collection = kind_directory(kind);
            let id_string = id.to_string();
            let directory = crate::platform::SafeDirectory::open(
                self.paths.root(),
                &[collection, id_string.as_str()],
                false,
            )?;
            let recovery_pending = directory.regular_file_exists(NOTE_RECOVERY_DESCRIPTOR)?;
            directory.recover("note.md")?;
            if recovery_pending {
                self.consume_recovery_marker(id)?;
            }
            if !directory.regular_file_exists("note.md")? {
                continue;
            }
            let bytes = directory.read("note.md", 64 * 1024 * 1024)?;
            let contents = String::from_utf8(bytes).map_err(|source| {
                CommandError::validation(format!("note document is not UTF-8: {source}"))
            })?;
            if found.is_some() {
                return Err(CommandError::conflict(
                    "note exists in multiple storage roots",
                ));
            }
            let document = parse_document(&contents)?;
            if document.id != id || document.kind != kind {
                return Err(CommandError::validation(
                    "note metadata does not match its canonical path",
                ));
            }
            found = Some(document);
        }
        found.ok_or_else(|| CommandError::not_found("note document does not exist"))
    }

    pub fn save(
        &self,
        mut document: NoteDocument,
        expected_revision: u64,
    ) -> Result<NoteDocument, CommandError> {
        validate_document(&document)?;
        let current = self.load(document.id)?;
        if current.revision != expected_revision {
            return Err(CommandError::conflict(format!(
                "stale revision: expected {expected_revision}, durable revision is {}",
                current.revision
            )));
        }
        if document.kind != current.kind {
            return Err(CommandError::validation("save cannot change note kind"));
        }
        if document.folder_id != current.folder_id {
            return Err(CommandError::validation(
                "save cannot change a note folder; use move_note",
            ));
        }
        self.validate_folder_exists(document.folder_id)?;
        if document.revision != expected_revision {
            return Err(CommandError::validation(
                "document revision does not match expected revision",
            ));
        }
        document.created_at = current.created_at;
        document.revision = expected_revision
            .checked_add(1)
            .ok_or_else(|| CommandError::validation("note revision overflow"))?;
        self.write_document(&document)?;
        self.persist_after_content(&document)?;
        Ok(document)
    }

    pub fn list(&self) -> Result<Vec<NoteSummary>, CommandError> {
        let mut statement = self
            .database
            .connection()
            .prepare("SELECT id FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC, id")
            .map_err(database_error("could not prepare note list"))?;
        let ids = statement
            .query_map([], |row| row.get::<_, Vec<u8>>(0))
            .map_err(database_error("could not query note list"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error("could not read note list"))?;
        let mut summaries = Vec::with_capacity(ids.len());
        for bytes in ids {
            let id = note_id_from_blob(&bytes)?;
            let document = self.load(id)?;
            summaries.push(NoteSummary {
                id: document.id,
                kind: document.kind,
                title: document.title,
                folder_id: document.folder_id,
                tags: document.tags,
                revision: document.revision,
                created_at: document.created_at,
                updated_at: document.updated_at,
                excerpt: document.markdown.chars().take(160).collect(),
            });
        }
        Ok(summaries)
    }

    pub fn list_in_folder(
        &self,
        folder_id: Option<FolderId>,
    ) -> Result<Vec<NoteSummary>, CommandError> {
        self.validate_folder_exists(folder_id)?;
        let folder = folder_id.map(folder_id_blob);
        let mut statement = self
            .database
            .connection()
            .prepare(
                "SELECT id FROM notes WHERE folder_id IS ?1 AND kind = 'formal' AND deleted_at IS NULL \
                 ORDER BY updated_at DESC, id",
            )
            .map_err(database_error("could not prepare folder note list"))?;
        let ids = statement
            .query_map(params![folder], |row| row.get::<_, Vec<u8>>(0))
            .map_err(database_error("could not query folder note list"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error("could not read folder note list"))?;
        let mut summaries = Vec::with_capacity(ids.len());
        for bytes in ids {
            let id = note_id_from_blob(&bytes)?;
            let document = self.load(id)?;
            summaries.push(NoteSummary {
                id: document.id,
                kind: document.kind,
                title: document.title,
                folder_id: document.folder_id,
                tags: document.tags,
                revision: document.revision,
                created_at: document.created_at,
                updated_at: document.updated_at,
                excerpt: document.markdown.chars().take(160).collect(),
            });
        }
        Ok(summaries)
    }

    pub fn move_note(
        &self,
        id: NoteId,
        folder_id: Option<FolderId>,
    ) -> Result<NoteDocument, CommandError> {
        let mut document = self.load(id)?;
        self.validate_folder_exists(folder_id)?;
        let revision = document.revision;
        document.folder_id = folder_id;
        document.revision = revision
            .checked_add(1)
            .ok_or_else(|| CommandError::validation("note revision overflow"))?;
        self.write_document(&document)?;
        self.persist_after_content(&document)?;
        Ok(document)
    }

    fn document_exists(&self, id: NoteId) -> Result<bool, CommandError> {
        for kind in [NoteKind::Formal, NoteKind::Temporary] {
            let path = self.document_path(id, kind)?;
            match fs::symlink_metadata(path) {
                Ok(_) => return Ok(true),
                Err(source) if source.kind() == ErrorKind::NotFound => {}
                Err(source) => {
                    return Err(CommandError::io(format!(
                        "could not inspect note identity: {source}"
                    )))
                }
            }
        }
        Ok(false)
    }

    fn document_path(&self, id: NoteId, kind: NoteKind) -> Result<PathBuf, CommandError> {
        let directory = self.paths.note_dir(id, kind)?;
        if directory.exists() {
            let resolved = directory.canonicalize().map_err(|source| {
                CommandError::io(format!("could not resolve note directory: {source}"))
            })?;
            if !resolved.starts_with(self.paths.root()) {
                return Err(CommandError::validation(
                    "note directory escapes the data root",
                ));
            }
        }
        Ok(directory.join("note.md"))
    }

    fn persist_after_content(&self, document: &NoteDocument) -> Result<(), CommandError> {
        let result = persist_document(&self.database, document);
        if let Err(database_failure) = result {
            let marker_result = self.write_rebuild_marker(document.id);
            let diagnostic = match marker_result {
                Ok(()) => database_failure
                    .diagnostic()
                    .unwrap_or("metadata transaction failed")
                    .to_owned(),
                Err(marker_failure) => format!(
                    "{}; rebuild marker also failed: {}",
                    database_failure
                        .diagnostic()
                        .unwrap_or("metadata transaction failed"),
                    marker_failure.diagnostic().unwrap_or("marker write failed")
                ),
            };
            return Err(CommandError::database(diagnostic));
        }
        Ok(())
    }

    fn write_rebuild_marker(&self, id: NoteId) -> Result<(), CommandError> {
        let marker = serde_json::to_vec(&RebuildMarker {
            reason: "metadata_update_failed_after_durable_content",
            note_id: id,
        })
        .map_err(|source| {
            CommandError::io(format!("could not serialize rebuild marker: {source}"))
        })?;
        crate::storage::atomic_file::atomic_replace_contained(
            self.paths.root(),
            &[],
            REBUILD_MARKER,
            &marker,
        )
        .map(|_| ())
        .map_err(PublishFailure::into_error)
    }

    fn write_recovery_marker(&self, id: NoteId) -> Result<(), CommandError> {
        let marker = serde_json::to_vec(&RebuildMarker {
            reason: "atomic_replace_recovery_required",
            note_id: id,
        })
        .map_err(|source| {
            CommandError::io(format!("could not serialize recovery marker: {source}"))
        })?;
        crate::storage::atomic_file::atomic_replace_contained(
            self.paths.root(),
            &[],
            RECOVERY_MARKER,
            &marker,
        )
        .map(|_| ())
        .map_err(PublishFailure::into_error)
    }

    fn consume_recovery_marker(&self, id: NoteId) -> Result<(), CommandError> {
        let root = crate::platform::SafeDirectory::open(self.paths.root(), &[], false)?;
        if !root.regular_file_exists(RECOVERY_MARKER)? {
            return Ok(());
        }
        let marker_bytes = root.read(RECOVERY_MARKER, 64 * 1024)?;
        let marker: RebuildMarker<'_> =
            serde_json::from_slice(&marker_bytes).map_err(|source| {
                CommandError::validation(format!("recovery marker is invalid: {source}"))
            })?;
        if marker.note_id == id {
            root.remove_checked(RECOVERY_MARKER)?;
            root.sync()?;
        }
        Ok(())
    }

    fn validate_folder_exists(&self, folder_id: Option<FolderId>) -> Result<(), CommandError> {
        let Some(folder_id) = folder_id else {
            return Ok(());
        };
        let exists = self
            .database
            .connection()
            .query_row(
                "SELECT 1 FROM folders WHERE id = ?1",
                [folder_id_blob(folder_id)],
                |_| Ok(()),
            )
            .optional()
            .map_err(database_error("could not validate note folder"))?
            .is_some();
        if !exists {
            return Err(CommandError::not_found("note folder does not exist"));
        }
        Ok(())
    }

    fn write_document(&self, document: &NoteDocument) -> Result<(), CommandError> {
        let bytes = serialize_document(document)?;
        match (self.writer)(&self.paths, document.id, document.kind, bytes.as_bytes()) {
            Ok(PublishState::Published) => Ok(()),
            Ok(state) => Err(CommandError::io(format!(
                "document writer returned invalid publication state: {state:?}"
            ))),
            Err(failure) if failure.state() == PublishState::PublishedButSyncFailed => {
                let original = failure.into_error();
                if let Err(marker_error) = self.write_rebuild_marker(document.id) {
                    return Err(CommandError::io(format!(
                        "{}; rebuild marker failed: {}",
                        original.diagnostic().unwrap_or("directory sync failed"),
                        marker_error.diagnostic().unwrap_or("marker write failed")
                    )));
                }
                Err(original)
            }
            Err(failure) if failure.state() == PublishState::RecoveryRequired => {
                let original = failure.into_error();
                if let Err(marker_error) = self.write_recovery_marker(document.id) {
                    return Err(CommandError::io(format!(
                        "{}; recovery marker failed: {}",
                        original.diagnostic().unwrap_or("atomic recovery required"),
                        marker_error.diagnostic().unwrap_or("marker write failed")
                    )));
                }
                Err(original)
            }
            Err(failure) => Err(failure.into_error()),
        }
    }
}

fn default_document_writer(
    paths: &StoragePaths,
    id: NoteId,
    kind: NoteKind,
    bytes: &[u8],
) -> PublishResult {
    let id = id.to_string();
    crate::storage::atomic_file::atomic_replace_contained(
        paths.root(),
        &[kind_directory(kind), id.as_str()],
        "note.md",
        bytes,
    )
}

pub(crate) fn serialize_document(document: &NoteDocument) -> Result<String, CommandError> {
    let metadata = NoteMetadata {
        id: document.id,
        kind: document.kind,
        title: document.title.clone(),
        folder_id: document.folder_id,
        tags: document.tags.clone(),
        revision: document.revision,
        created_at: document.created_at.clone(),
        updated_at: document.updated_at.clone(),
    };
    let yaml = serde_yml::to_string(&metadata).map_err(|source| {
        CommandError::validation(format!("could not serialize note metadata: {source}"))
    })?;
    Ok(format!(
        "---\n{}\n---\n{}",
        yaml.trim_end_matches(['\r', '\n']),
        document.markdown
    ))
}

pub(crate) fn parse_document(contents: &str) -> Result<NoteDocument, CommandError> {
    let normalized_start = contents
        .strip_prefix("---\n")
        .ok_or_else(|| CommandError::validation("note frontmatter opening delimiter is missing"))?;
    let (yaml, markdown) = normalized_start
        .split_once("\n---\n")
        .ok_or_else(|| CommandError::validation("note frontmatter closing delimiter is missing"))?;
    let metadata: NoteMetadata = serde_yml::from_str(yaml).map_err(|source| {
        CommandError::validation(format!("note frontmatter is invalid: {source}"))
    })?;
    let document = NoteDocument {
        id: metadata.id,
        kind: metadata.kind,
        title: metadata.title,
        folder_id: metadata.folder_id,
        tags: metadata.tags,
        markdown: markdown.to_owned(),
        revision: metadata.revision,
        created_at: metadata.created_at,
        updated_at: metadata.updated_at,
    };
    validate_document(&document)?;
    Ok(document)
}

pub(crate) fn persist_document(
    database: &Database,
    document: &NoteDocument,
) -> Result<(), CommandError> {
    let transaction = database
        .connection()
        .unchecked_transaction()
        .map_err(database_error("could not start note metadata transaction"))?;
    persist_document_in_transaction(&transaction, document)?;
    transaction
        .commit()
        .map_err(database_error("could not commit note metadata transaction"))
}

pub(crate) fn persist_document_in_transaction(
    transaction: &Transaction<'_>,
    document: &NoteDocument,
) -> Result<(), CommandError> {
    let id = note_id_blob(document.id);
    let folder_id = document.folder_id.map(folder_id_blob);
    let relative_path = format!("{}/{}", kind_directory(document.kind), document.id);
    transaction
        .execute(
            "INSERT INTO notes (id, kind, title, folder_id, relative_path, created_at, updated_at, revision, deleted_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL) \
             ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, title=excluded.title, folder_id=excluded.folder_id, \
             relative_path=excluded.relative_path, created_at=excluded.created_at, updated_at=excluded.updated_at, \
             revision=excluded.revision, deleted_at=NULL",
            params![
                id,
                kind_database(document.kind),
                document.title,
                folder_id,
                relative_path,
                document.created_at,
                document.updated_at,
                i64::try_from(document.revision)
                    .map_err(|source| CommandError::validation(format!("revision is too large: {source}")))?,
            ],
        )
        .map_err(database_error("could not update note metadata"))?;

    transaction
        .execute("DELETE FROM note_tags WHERE note_id = ?1", params![id])
        .map_err(database_error("could not clear note tags"))?;
    let tags = normalized_tags(&document.tags)?;
    for (display, normalized) in tags {
        let existing = transaction
            .query_row(
                "SELECT id FROM tags WHERE normalized_name = ?1",
                [&normalized],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()
            .map_err(database_error("could not resolve note tag"))?;
        let tag_id = existing.unwrap_or_else(|| Uuid::now_v7().as_bytes().to_vec());
        transaction
            .execute(
                "INSERT INTO tags (id, display_name, normalized_name) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(normalized_name) DO NOTHING",
                params![tag_id, display, normalized],
            )
            .map_err(database_error("could not update note tag"))?;
        transaction
            .execute(
                "INSERT INTO note_tags (note_id, tag_id) VALUES (?1, ?2)",
                params![id, tag_id],
            )
            .map_err(database_error("could not attach note tag"))?;
    }

    transaction
        .execute(
            "DELETE FROM note_links WHERE source_note_id = ?1",
            params![id],
        )
        .map_err(database_error("could not clear note links"))?;
    for link in parse_links(&document.markdown) {
        let source_start = i64::try_from(link.start).map_err(|source| {
            CommandError::validation(format!("link source start is too large: {source}"))
        })?;
        let source_end = i64::try_from(link.end).map_err(|source| {
            CommandError::validation(format!("link source end is too large: {source}"))
        })?;
        transaction
            .execute(
                "INSERT INTO note_links (source_note_id, target_note_id, visible_label, source_start, source_end) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    id,
                    note_id_blob(link.target),
                    link.label,
                    source_start,
                    source_end,
                ],
            )
            .map_err(database_error("could not update note link"))?;
    }

    transaction
        .execute(
            "INSERT INTO search_documents (note_id, title, plain_text) VALUES (?1, ?2, ?3) \
             ON CONFLICT(note_id) DO UPDATE SET title=excluded.title, plain_text=excluded.plain_text",
            params![id, document.title, document.markdown],
        )
        .map_err(database_error("could not update search document"))?;
    Ok(())
}

pub(crate) fn parse_links(markdown: &str) -> Vec<ParsedLink> {
    let mut links = Vec::new();
    let mut cursor = 0;
    while let Some(relative_start) = markdown[cursor..].find("[[") {
        let start = cursor + relative_start;
        let content_start = start + 2;
        let Some(relative_end) = markdown[content_start..].find("]]") else {
            break;
        };
        let end = content_start + relative_end + 2;
        let content = &markdown[content_start..end - 2];
        if let Some((label, target)) = content.rsplit_once('|') {
            if !label.is_empty() {
                if let Ok(target) = NoteId::parse_str(target) {
                    links.push(ParsedLink {
                        target,
                        label: label.to_owned(),
                        start,
                        end,
                    });
                }
            }
        }
        cursor = end;
    }
    links
}

pub(crate) fn note_id_blob(id: NoteId) -> Vec<u8> {
    Uuid::parse_str(&id.to_string())
        .expect("validated NoteId must remain a UUID")
        .as_bytes()
        .to_vec()
}

pub(crate) fn folder_id_blob(id: FolderId) -> Vec<u8> {
    Uuid::parse_str(&id.to_string())
        .expect("validated FolderId must remain a UUID")
        .as_bytes()
        .to_vec()
}

pub(crate) fn note_id_from_blob(bytes: &[u8]) -> Result<NoteId, CommandError> {
    let uuid = Uuid::from_slice(bytes)
        .map_err(|source| CommandError::database(format!("stored note ID is invalid: {source}")))?;
    NoteId::parse_str(&uuid.hyphenated().to_string())
        .map_err(|source| CommandError::database(format!("stored note ID is invalid: {source}")))
}

fn validate_document(document: &NoteDocument) -> Result<(), CommandError> {
    if document.title.trim().is_empty() {
        return Err(CommandError::validation("note title is empty"));
    }
    DateTime::parse_from_rfc3339(&document.created_at).map_err(|source| {
        CommandError::validation(format!("created timestamp is invalid: {source}"))
    })?;
    DateTime::parse_from_rfc3339(&document.updated_at).map_err(|source| {
        CommandError::validation(format!("updated timestamp is invalid: {source}"))
    })?;
    normalized_tags(&document.tags)?;
    Ok(())
}

pub(crate) fn normalized_tags(tags: &[String]) -> Result<Vec<(String, String)>, CommandError> {
    let mut seen = HashSet::new();
    let mut result = Vec::with_capacity(tags.len());
    for tag in tags {
        let (display, normalized) = normalized_tag_value(tag, 80)?;
        if !seen.insert(normalized.clone()) {
            return Err(CommandError::validation("duplicate normalized tag"));
        }
        result.push((display, normalized));
    }
    Ok(result)
}

pub(crate) fn normalized_tag_value(
    input: &str,
    maximum_length: usize,
) -> Result<(String, String), CommandError> {
    let canonical: String = input.nfkc().collect();
    let mut display = String::with_capacity(canonical.len());
    let mut pending_space = false;
    for character in canonical.chars() {
        if is_application_whitespace(character) {
            pending_space = !display.is_empty();
            continue;
        }
        if character.is_control() {
            return Err(CommandError::validation(
                "tag name contains a control character",
            ));
        }
        if pending_space {
            display.push(' ');
            pending_space = false;
        }
        display.push(character);
    }
    if display.is_empty() {
        return Err(CommandError::validation("tag name is empty"));
    }
    if display.chars().count() > maximum_length {
        return Err(CommandError::validation("tag name is too long"));
    }
    let mut upper = String::with_capacity(display.len());
    for character in display.chars() {
        if matches!(character, 'ß' | 'ẞ') {
            upper.push_str("SS");
        } else {
            upper.extend(character.to_uppercase());
        }
    }
    let mut folded = String::with_capacity(upper.len());
    for character in upper.chars().flat_map(char::to_lowercase) {
        folded.push(if character == 'ς' { 'σ' } else { character });
    }
    let normalized = folded.nfkc().collect();
    Ok((display, normalized))
}

fn is_application_whitespace(character: char) -> bool {
    matches!(
        character as u32,
        0x09..=0x0d
            | 0x20
            | 0x85
            | 0xa0
            | 0x1680
            | 0x2000..=0x200a
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
            | 0xfeff
    )
}

pub(crate) fn kind_directory(kind: NoteKind) -> &'static str {
    match kind {
        NoteKind::Formal => "notes",
        NoteKind::Temporary => "temporary",
    }
}

fn kind_database(kind: NoteKind) -> &'static str {
    match kind {
        NoteKind::Formal => "formal",
        NoteKind::Temporary => "temporary",
    }
}

fn database_error(context: &'static str) -> impl FnOnce(rusqlite::Error) -> CommandError {
    move |source| CommandError::database(format!("{context}: {source}"))
}
