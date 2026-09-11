use crate::{
    domain::{ManagedFile, NoteContent, NoteDocument, NoteKind},
    error::CommandError,
    platform::SafeDirectory,
    storage::{
        atomic_file::{atomic_replace_contained, PublishState},
        paths::StoragePaths,
    },
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
pub const ENTRY_NAMES: [&str; 3] = ["note.md", "note.cay.json", "entry.json"];
pub const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_TEXT_BYTES: u64 = 16 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    format: String,
    schema_version: u32,
    content_type: String,
    note: NoteDocument,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    payload: Option<ManagedFile>,
}
pub fn format(note: &NoteDocument) -> &'static str {
    match &note.content {
        None => "markdown",
        Some(NoteContent::Document { .. }) => "document",
        Some(NoteContent::Text { .. }) => "text",
        Some(NoteContent::File { .. }) => "file",
    }
}
pub fn filename(note: &NoteDocument) -> &'static str {
    match &note.content {
        None => "note.md",
        Some(NoteContent::Document { .. }) => "note.cay.json",
        _ => "entry.json",
    }
}
pub fn filename_from_bytes(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"{") {
        if serde_json::from_slice::<serde_json::Value>(bytes)
            .ok()
            .and_then(|v| v["contentType"].as_str().map(str::to_owned))
            .as_deref()
            == Some("document")
        {
            "note.cay.json"
        } else {
            "entry.json"
        }
    } else {
        "note.md"
    }
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn text_descriptor(text: &str) -> ManagedFile {
    let sha256 = digest(text.as_bytes());
    ManagedFile {
        storage_name: format!("payload-{sha256}.txt"),
        original_name: "text.txt".into(),
        media_type: "text/plain".into(),
        size: text.len() as u64,
        sha256,
    }
}
pub fn validate_file(file: &ManagedFile) -> Result<(), CommandError> {
    if !file.storage_name.starts_with("payload-")
        || file.storage_name.contains(['/', '\\', ':'])
        || file.storage_name.chars().any(char::is_control)
        || file.storage_name.len() > 200
        || file.original_name.is_empty()
        || file.original_name.contains(['/', '\\'])
        || file.original_name.chars().any(char::is_control)
        || file.media_type.len() > 128
        || file.size > MAX_FILE_BYTES
        || file.sha256.len() != 64
        || !file
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(CommandError::validation("invalid managed payload metadata"));
    }
    Ok(())
}
pub fn validate_content(note: &NoteDocument) -> Result<(), CommandError> {
    if note.content.is_some() && (!note.markdown.is_empty() || note.kind == NoteKind::Temporary) {
        return Err(CommandError::validation(
            "typed content cannot contain Markdown or be a temporary capture",
        ));
    }
    match &note.content {
        Some(NoteContent::Document { document }) => super::rich_document::validate(document),
        Some(NoteContent::Text { text }) if text.len() as u64 > MAX_TEXT_BYTES => {
            Err(CommandError::validation("editable text exceeds 16 MiB"))
        }
        Some(NoteContent::File { file }) => validate_file(file),
        _ => Ok(()),
    }
}
pub fn serialize(note: &NoteDocument) -> Result<String, CommandError> {
    validate_content(note)?;
    let mut stored = note.clone();
    let payload = if let Some(NoteContent::Text { text }) = &note.content {
        stored.content = None;
        Some(text_descriptor(text))
    } else {
        None
    };
    let serialized = serde_json::to_string(&Envelope {
        format: "cay-entry".into(),
        schema_version: 1,
        content_type: format(note).into(),
        note: stored,
        payload,
    })
    .map_err(|_| CommandError::validation("could not serialize library entry"))?;
    if serialized.len() > 64 * 1024 * 1024 {
        return Err(CommandError::validation(
            "serialized document exceeds 64 MiB",
        ));
    }
    Ok(serialized)
}
pub fn parse(
    bytes: &[u8],
    directory: Option<&SafeDirectory>,
) -> Result<NoteDocument, CommandError> {
    let envelope: Envelope = serde_json::from_slice(bytes)
        .map_err(|_| CommandError::validation("invalid library entry manifest"))?;
    if envelope.format != "cay-entry" || envelope.schema_version != 1 {
        return Err(CommandError::validation(
            "unsupported library schema version",
        ));
    }
    let mut note = envelope.note;
    if envelope.content_type == "text" {
        if note.content.is_some() || !note.markdown.is_empty() {
            return Err(CommandError::validation("ambiguous text entry"));
        }
        let payload = envelope
            .payload
            .ok_or_else(|| CommandError::validation("text payload missing"))?;
        if payload.media_type != "text/plain" || payload.size > MAX_TEXT_BYTES {
            return Err(CommandError::validation("invalid text payload"));
        }
        let directory =
            directory.ok_or_else(|| CommandError::validation("text payload directory required"))?;
        let bytes = read_payload(directory, &payload)?;
        let text = String::from_utf8(bytes)
            .map_err(|_| CommandError::validation("text payload is not UTF-8"))?;
        note.content = Some(NoteContent::Text { text });
    } else if envelope.payload.is_some()
        || format(&note) != envelope.content_type
        || note.content.is_none()
    {
        return Err(CommandError::validation(
            "entry format does not match content",
        ));
    }
    validate_content(&note)?;
    if let (Some(directory), Some(NoteContent::File { file })) = (directory, &note.content) {
        verify_payload(directory, file)?;
    }
    Ok(note)
}
pub fn discover(directory: &SafeDirectory) -> Result<&'static str, CommandError> {
    let names = directory.entry_names()?;
    let families = ENTRY_NAMES
        .iter()
        .filter(|name| {
            names
                .iter()
                .any(|entry| entry == **name || entry == &format!(".{name}.replace-recovery.json"))
        })
        .count();
    if families > 1 {
        return Err(CommandError::conflict(
            "multiple durable entry formats exist; preserve all copies",
        ));
    }
    let mut found = None;
    for name in ENTRY_NAMES {
        directory.recover(name)?;
        if directory.regular_file_exists(name)? {
            if found.is_some() {
                return Err(CommandError::conflict(
                    "multiple durable entry files exist; preserve all copies",
                ));
            }
            found = Some(name);
        }
    }
    found.ok_or_else(|| CommandError::not_found("durable entry is missing"))
}
pub fn read(directory: &SafeDirectory) -> Result<NoteDocument, CommandError> {
    let name = discover(directory)?;
    read_named(directory, name)
}
pub fn read_named(directory: &SafeDirectory, name: &str) -> Result<NoteDocument, CommandError> {
    let bytes = directory.read(name, 64 * 1024 * 1024)?;
    let note = if bytes.starts_with(b"{") {
        parse(&bytes, Some(directory))?
    } else {
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| CommandError::validation("note is not UTF-8"))?;
        super::repository::parse_document(text)?
    };
    super::repository::validate_document(&note)?;
    if ENTRY_NAMES.contains(&name) && filename(&note) != name {
        return Err(CommandError::validation(
            "entry filename does not match its content",
        ));
    }
    Ok(note)
}
pub fn verify_payload(directory: &SafeDirectory, file: &ManagedFile) -> Result<(), CommandError> {
    validate_file(file)?;
    let mut source = directory.open_regular(&file.storage_name, MAX_FILE_BYTES)?;
    let mut hash = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = source
            .read(&mut buffer)
            .map_err(|_| CommandError::io("could not read managed payload"))?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > MAX_FILE_BYTES {
            return Err(CommandError::validation("managed payload exceeds limit"));
        }
        hash.update(&buffer[..n]);
    }
    if size != file.size || format!("{:x}", hash.finalize()) != file.sha256 {
        return Err(CommandError::validation(
            "managed payload size or digest mismatch",
        ));
    }
    Ok(())
}
pub fn read_payload(
    directory: &SafeDirectory,
    file: &ManagedFile,
) -> Result<Vec<u8>, CommandError> {
    validate_file(file)?;
    let source = directory.open_regular(&file.storage_name, MAX_FILE_BYTES)?;
    let mut bytes = Vec::new();
    source
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| CommandError::io("could not read managed payload"))?;
    if bytes.len() as u64 != file.size || digest(&bytes) != file.sha256 {
        return Err(CommandError::validation(
            "managed payload size or digest mismatch",
        ));
    }
    Ok(bytes)
}
pub fn prepare_payload(paths: &StoragePaths, note: &NoteDocument) -> Result<(), CommandError> {
    if note.content.is_none() {
        return Ok(());
    }
    let id = note.id.to_string();
    let directory = SafeDirectory::open(
        paths.root(),
        &[super::repository::kind_directory(note.kind), &id],
        true,
    )?;
    let root = SafeDirectory::open(paths.root(), &[], false)?;
    if !check_library_version(&root)? {
        match atomic_replace_contained(
            paths.root(),
            &[],
            "library-format.json",
            b"{\"schemaVersion\":2,\"minimumAppVersion\":\"1.1.0\"}",
        ) {
            Ok(PublishState::Published) => {}
            Ok(_) => return Err(CommandError::io("library version publication incomplete")),
            Err(error) => return Err(error.into_error()),
        }
    }
    if let Some(NoteContent::Text { text }) = &note.content {
        let descriptor = text_descriptor(text);
        if directory.regular_file_exists(&descriptor.storage_name)? {
            verify_payload(&directory, &descriptor)?;
        } else {
            let staging = format!(".payload-{}.tmp", crate::domain::NoteId::now_v7());
            let mut file = directory.create_new_publishable(&staging)?;
            file.write_all(text.as_bytes())
                .and_then(|()| file.sync_all())
                .map_err(|_| CommandError::io("could not durably write text payload"))?;
            match directory.publish_new(&staging, &descriptor.storage_name, &file)? {
                crate::platform::NewFilePublishState::Published => directory.sync()?,
                crate::platform::NewFilePublishState::DestinationExists => {
                    verify_payload(&directory, &descriptor)?
                }
            }
            drop(file);
            directory.remove(&staging);
        }
    }
    if let Some(NoteContent::File { file }) = &note.content {
        verify_payload(&directory, file)?;
    }
    Ok(())
}

/// Fail closed on future library versions; never rewrite an unknown marker.
pub(crate) fn check_library_version(root: &SafeDirectory) -> Result<bool, CommandError> {
    if !root.regular_file_exists("library-format.json")? {
        return Ok(false);
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Version {
        schema_version: u32,
        minimum_app_version: String,
    }
    let version: Version = serde_json::from_slice(&root.read("library-format.json", 4096)?)
        .map_err(|_| CommandError::validation("invalid library version marker"))?;
    if version.schema_version != 2 || version.minimum_app_version != "1.1.0" {
        return Err(CommandError::validation(
            "this library requires a newer application version",
        ));
    }
    Ok(true)
}
