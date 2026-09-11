use crate::{
    domain::{FolderId, ManagedFile, NoteContent, NoteDocument, NoteId, NoteKind},
    error::CommandError,
    platform::{IndexMutationLock, SafeDirectory},
    storage::{
        entry::{self, MAX_FILE_BYTES, MAX_TEXT_BYTES},
        paths::StoragePaths,
        repository::NoteRepository,
    },
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportFilesInput {
    pub paths: Vec<String>,
    pub folder_id: Option<FolderId>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFailure {
    pub name: String,
    pub message: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFilesResult {
    pub imported: Vec<NoteDocument>,
    pub failed: Vec<ImportFailure>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedFileBytes {
    pub media_type: String,
    pub bytes: Vec<u8>,
}
pub fn import_files(
    paths: &StoragePaths,
    input: ImportFilesInput,
) -> Result<ImportFilesResult, CommandError> {
    if input.paths.len() > 1000 {
        return Err(CommandError::validation("too many files in one import"));
    }
    let guard = IndexMutationLock::acquire(paths.root())?;
    let mut result = ImportFilesResult {
        imported: Vec::new(),
        failed: Vec::new(),
    };
    for source in input.paths {
        let name = Path::new(&source)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".into());
        match import_one(paths, Path::new(&source), input.folder_id, &guard) {
            Ok(note) => result.imported.push(note),
            Err(error) => result.failed.push(ImportFailure {
                name,
                message: error.message().into(),
            }),
        }
    }
    Ok(result)
}
fn validated_parent(path: &Path) -> Result<(SafeDirectory, String), CommandError> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(CommandError::validation(
            "file path must be absolute without traversal",
        ));
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.contains(':'))
        .ok_or_else(|| CommandError::validation("invalid filename"))?;
    let parent = path
        .parent()
        .ok_or_else(|| CommandError::validation("file has no parent"))?;
    // Pin every ancestor from the volume root so an exchanged parent cannot redirect import or export.
    let mut anchor = PathBuf::new();
    let mut segments = Vec::new();
    for component in parent.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => anchor.push(component.as_os_str()),
            Component::Normal(segment) => segments.push(
                segment
                    .to_str()
                    .ok_or_else(|| CommandError::validation("invalid path encoding"))?,
            ),
            _ => return Err(CommandError::validation("path traversal is not allowed")),
        }
    }
    Ok((SafeDirectory::open(&anchor, &segments, false)?, name.into()))
}
fn import_one(
    paths: &StoragePaths,
    source_path: &Path,
    folder_id: Option<FolderId>,
    guard: &IndexMutationLock,
) -> Result<NoteDocument, CommandError> {
    let (source_parent, original_name) = validated_parent(source_path)?;
    let mut source = source_parent.open_regular(&original_name, MAX_FILE_BYTES)?;
    let initial = source
        .metadata()
        .map_err(|_| CommandError::io("could not inspect import source"))?;
    let id = NoteId::now_v7();
    let directory = SafeDirectory::open(paths.root(), &["notes", &id.to_string()], true)?;
    let storage_name = format!("payload-{}.bin", NoteId::now_v7());
    let mut target = directory.create_new(&storage_name)?;
    let mut hash = Sha256::new();
    let mut size = 0;
    let mut buffer = [0u8; 64 * 1024];
    let mut head = Vec::new();
    loop {
        let n = source
            .read(&mut buffer)
            .map_err(|_| CommandError::io("could not read import source"))?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > MAX_FILE_BYTES {
            return Err(CommandError::validation("file exceeds 256 MiB"));
        }
        if head.len() < 8192 {
            head.extend_from_slice(&buffer[..n.min(8192 - head.len())]);
        }
        hash.update(&buffer[..n]);
        target
            .write_all(&buffer[..n])
            .map_err(|_| CommandError::io("could not copy imported file"))?;
    }
    let after = source
        .metadata()
        .map_err(|_| CommandError::io("could not verify import source"))?;
    if initial.len() != size
        || after.len() != size
        || initial.modified().ok() != after.modified().ok()
    {
        return Err(CommandError::conflict(
            "source changed during import; retry",
        ));
    }
    target
        .sync_all()
        .map_err(|_| CommandError::io("could not flush imported payload"))?;
    drop(target);
    directory.sync()?;
    let extension = source_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let media_type = detect_media(&head, &extension);
    let mut file = ManagedFile {
        storage_name,
        original_name: original_name.clone(),
        media_type: media_type.into(),
        size,
        sha256: format!("{:x}", hash.finalize()),
    };
    // A magic header is insufficient for image preview: decode under the existing image limits.
    if file.media_type.starts_with("image/") {
        let bytes = entry::read_payload(&directory, &file)?;
        if crate::commands::assets::validate_image(&file.media_type, &bytes).is_err() {
            file.media_type = "application/octet-stream".into();
        }
    }
    let now = chrono::Utc::now().to_rfc3339();
    let mut note = NoteDocument {
        id,
        kind: NoteKind::Formal,
        title: original_name,
        folder_id,
        tags: Vec::new(),
        markdown: String::new(),
        content: Some(NoteContent::File { file: file.clone() }),
        revision: 0,
        created_at: now.clone(),
        updated_at: now,
    };
    if matches!(extension.as_str(), "md" | "txt") && size <= MAX_TEXT_BYTES {
        let bytes = entry::read_payload(&directory, &file)?;
        if let Some(text) = decode_text(&bytes) {
            if extension == "md" {
                note.markdown = text;
                note.content = None;
            } else {
                note.content = Some(NoteContent::Text { text });
            }
        }
    }
    NoteRepository::new(paths.clone()).create_locked(note, guard)
}
fn decode_text(bytes: &[u8]) -> Option<String> {
    if let Some(bytes) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        return String::from_utf8(bytes.to_vec()).ok();
    }
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        if !bytes.len().is_multiple_of(2) {
            return None;
        }
        let little = bytes[0] == 0xff;
        let units = bytes[2..]
            .chunks(2)
            .map(|c| {
                if little {
                    u16::from_le_bytes([c[0], c[1]])
                } else {
                    u16::from_be_bytes([c[0], c[1]])
                }
            })
            .collect::<Vec<_>>();
        return String::from_utf16(&units).ok();
    }
    String::from_utf8(bytes.to_vec())
        .ok()
        .filter(|text| !text.contains('\0'))
}
fn detect_media(head: &[u8], extension: &str) -> &'static str {
    if head.starts_with(b"%PDF-") {
        return "application/pdf";
    }
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        return "image/png";
    }
    if head.starts_with(&[0xff, 0xd8, 0xff]) {
        return "image/jpeg";
    }
    if head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WEBP") {
        return "image/webp";
    }
    let zip = head.starts_with(b"PK\x03\x04");
    let ole = head.starts_with(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    match extension {
        "doc" if ole => "application/msword",
        "xls" if ole => "application/vnd.ms-excel",
        "ppt" if ole => "application/vnd.ms-powerpoint",
        "docx" if zip => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" if zip => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" if zip => {
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        }
        _ => "application/octet-stream",
    }
}
pub fn read_file(paths: &StoragePaths, id: NoteId) -> Result<ManagedFileBytes, CommandError> {
    let guard = IndexMutationLock::acquire(paths.root())?;
    let note = NoteRepository::new(paths.clone()).load_locked(id, &guard)?;
    let Some(NoteContent::File { file }) = note.content else {
        return Err(CommandError::validation("entry is not a managed file"));
    };
    let directory = SafeDirectory::open(paths.root(), &["notes", &id.to_string()], false)?;
    Ok(ManagedFileBytes {
        media_type: file.media_type.clone(),
        bytes: entry::read_payload(&directory, &file)?,
    })
}
/// Reads a managed payload without attaching metadata so Tauri can return raw bytes over IPC.
pub fn read_file_bytes(paths: &StoragePaths, id: NoteId) -> Result<Vec<u8>, CommandError> {
    let guard = IndexMutationLock::acquire(paths.root())?;
    let note = NoteRepository::new(paths.clone()).load_locked(id, &guard)?;
    let Some(NoteContent::File { file }) = note.content else {
        return Err(CommandError::validation("entry is not a managed file"));
    };
    let directory = SafeDirectory::open(paths.root(), &["notes", &id.to_string()], false)?;
    entry::read_payload(&directory, &file)
}

pub fn export_file(
    paths: &StoragePaths,
    id: NoteId,
    destination: &Path,
) -> Result<(), CommandError> {
    let guard = IndexMutationLock::acquire(paths.root())?;
    let note = NoteRepository::new(paths.clone()).load_locked(id, &guard)?;
    publish_export(destination, |target| {
        match &note.content {
            Some(NoteContent::File { file }) => {
                let directory =
                    SafeDirectory::open(paths.root(), &["notes", &id.to_string()], false)?;
                let mut source = directory.open_regular(&file.storage_name, MAX_FILE_BYTES)?;
                let mut size = 0u64;
                let mut digest = Sha256::new();
                let mut buffer = [0u8; 64 * 1024];
                loop {
                    let count = source
                        .read(&mut buffer)
                        .map_err(|_| CommandError::io("could not read managed export source"))?;
                    if count == 0 {
                        break;
                    }
                    size += count as u64;
                    if size > file.size {
                        return Err(CommandError::conflict(
                            "managed payload changed during export",
                        ));
                    }
                    digest.update(&buffer[..count]);
                    target
                        .write_all(&buffer[..count])
                        .map_err(|_| CommandError::io("could not export managed file"))?;
                }
                if size != file.size || format!("{:x}", digest.finalize()) != file.sha256 {
                    return Err(CommandError::conflict(
                        "managed payload changed during export",
                    ));
                }
            }
            Some(NoteContent::Text { text }) => target
                .write_all(text.as_bytes())
                .map_err(|_| CommandError::io("could not export text"))?,
            Some(NoteContent::Document { .. }) | None => {
                let content = super::repository::serialize_document(&note)?;
                target
                    .write_all(content.as_bytes())
                    .map_err(|_| CommandError::io("could not export native entry"))?;
            }
        }
        Ok(())
    })
}
fn publish_export(
    destination: &Path,
    write: impl FnOnce(&mut std::fs::File) -> Result<(), CommandError>,
) -> Result<(), CommandError> {
    let (parent, name) = validated_parent(destination)?;
    if parent.regular_file_exists(&name)? {
        return Err(CommandError::conflict("export destination already exists"));
    }
    let staging = format!(".cay-export-{}.tmp", NoteId::now_v7());
    let mut target = parent.create_new_publishable(&staging)?;
    let result = (|| {
        write(&mut target)?;
        target
            .sync_all()
            .map_err(|_| CommandError::io("could not flush export"))?;
        match parent.publish_new(&staging, &name, &target)? {
            crate::platform::NewFilePublishState::Published => parent.sync(),
            crate::platform::NewFilePublishState::DestinationExists => {
                Err(CommandError::conflict("export destination already exists"))
            }
        }
    })();
    drop(target);
    parent.remove(&staging);
    result
}
pub fn save_document_export(
    paths: &StoragePaths,
    id: NoteId,
    destination: &Path,
    bytes: &[u8],
) -> Result<(), CommandError> {
    let note = NoteRepository::new(paths.clone()).load(id)?;
    if !matches!(note.content, Some(NoteContent::Document { .. }))
        || !destination
            .extension()
            .and_then(|v| v.to_str())
            .is_some_and(|v| v.eq_ignore_ascii_case("docx"))
    {
        return Err(CommandError::validation(
            "DOCX export requires a document and a .docx destination",
        ));
    }
    super::docx::validate(bytes)?;
    publish_export(destination, |file| {
        file.write_all(bytes)
            .map_err(|_| CommandError::io("could not write DOCX export"))
    })
}
pub fn external_copy(paths: &StoragePaths, id: NoteId) -> Result<PathBuf, CommandError> {
    let note = NoteRepository::new(paths.clone()).load(id)?;
    let Some(NoteContent::File { file }) = note.content else {
        return Err(CommandError::validation("entry is not a managed file"));
    };
    let extension = Path::new(&file.original_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx"
    ) || file.media_type == "application/octet-stream"
    {
        return Err(CommandError::validation(
            "only recognized Office files can open in a system application",
        ));
    }
    let directory = SafeDirectory::open(paths.root(), &["external-cache"], true)?;
    let destination = directory.child_path(&format!("{}.{extension}", NoteId::now_v7()))?;
    export_file(paths, id, &destination)?;
    Ok(destination)
}
