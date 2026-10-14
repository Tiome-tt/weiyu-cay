use crate::{
    domain::{ManagedFile, NoteContent, NoteDocument, NoteId},
    error::CommandError,
    platform::{IndexMutationLock, SafeDirectory},
    storage::{entry, paths::StoragePaths, repository::NoteRepository},
};
use serde::{Deserialize, Serialize};
use std::{
    io::{Cursor, Read, Write},
    path::PathBuf,
};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Session {
    filename: String,
    baseline: String,
    stamp: String,
}
fn publish(directory: &SafeDirectory, name: &str, bytes: &[u8]) -> Result<(), CommandError> {
    let staging = format!(".external-{}.tmp", NoteId::now_v7());
    let mut target = directory.create_new(&staging)?;
    target
        .write_all(bytes)
        .map_err(|_| CommandError::io("could not write external session"))?;
    target
        .sync_all()
        .map_err(|_| CommandError::io("could not flush external session"))?;
    drop(target);
    directory
        .publish(&staging, name)
        .map_err(|failure| failure.into_error())?;
    directory.sync()
}
fn write_session(directory: &SafeDirectory, session: &Session) -> Result<(), CommandError> {
    let bytes = serde_json::to_vec(session)
        .map_err(|_| CommandError::validation("invalid external session"))?;
    publish(directory, "session.json", &bytes)
}
fn stamp(directory: &SafeDirectory, name: &str) -> Result<String, CommandError> {
    let meta = directory
        .open_regular(name, entry::MAX_FILE_BYTES)?
        .metadata()
        .map_err(|_| CommandError::io("could not inspect editing copy"))?;
    Ok(format!("{}:{:?}", meta.len(), meta.modified().ok()))
}
pub fn open_copy(paths: &StoragePaths, id: NoteId) -> Result<PathBuf, CommandError> {
    sync_external_file(paths, id)?;
    let guard = IndexMutationLock::acquire(paths.root())?;
    let note = NoteRepository::new(paths.clone()).load_locked(id, &guard)?;
    let Some(NoteContent::File { file }) = note.content else {
        return Err(CommandError::validation("entry is not an Office file"));
    };
    let extension = file
        .original_name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx"
    ) || (file.size > 0 && file.media_type == "application/octet-stream")
    {
        return Err(CommandError::validation(
            "only recognized Office files can open for editing",
        ));
    }
    let directory = SafeDirectory::open(paths.root(), &["external-cache", &id.to_string()], true)?;
    let filename = format!("document.{extension}");
    if directory.entry_names()?.contains(&filename) {
        return directory.child_path(&filename);
    }
    let bytes = if file.size == 0 {
        blank_office(&extension)?
    } else {
        let owner = SafeDirectory::open(paths.root(), &["notes", &id.to_string()], false)?;
        entry::read_payload(&owner, &file)?
    };
    // Publish the baseline first; a crash never licenses overwriting an existing editing copy.
    write_session(
        &directory,
        &Session {
            filename: filename.clone(),
            baseline: file.sha256,
            stamp: String::new(),
        },
    )?;
    publish(&directory, &filename, &bytes)?;
    directory.child_path(&filename)
}
pub fn sync_external_file(
    paths: &StoragePaths,
    id: NoteId,
) -> Result<Option<NoteDocument>, CommandError> {
    sync_external_file_checked(paths, id, true)
}
pub fn sync_external_file_checked(
    paths: &StoragePaths,
    id: NoteId,
    force: bool,
) -> Result<Option<NoteDocument>, CommandError> {
    let cache = paths.root().join("external-cache").join(id.to_string());
    if matches!(std::fs::symlink_metadata(&cache),Err(error) if error.kind()==std::io::ErrorKind::NotFound)
    {
        return Ok(None);
    }
    let guard = IndexMutationLock::acquire(paths.root())?;
    let directory = SafeDirectory::open(paths.root(), &["external-cache", &id.to_string()], false)?;
    let mut session: Session = serde_json::from_slice(&directory.read("session.json", 4096)?)
        .map_err(|_| {
            CommandError::validation("editing session is invalid; both copies are retained")
        })?;
    if !directory.entry_names()?.contains(&session.filename) {
        return Ok(None);
    }
    let current_stamp = stamp(&directory, &session.filename)?;
    if !force && current_stamp == session.stamp {
        return Ok(None);
    }
    let repository = NoteRepository::new(paths.clone());
    let note = repository.load_locked(id, &guard)?;
    let Some(NoteContent::File { file }) = note.content.as_ref() else {
        return Err(CommandError::conflict(
            "entry format changed; editing copy retained",
        ));
    };
    let mut source = directory.open_regular(&session.filename, entry::MAX_FILE_BYTES)?;
    let before = source
        .metadata()
        .map_err(|_| CommandError::io("could not inspect editing copy"))?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut source)
        .take(entry::MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| CommandError::io("editing copy is busy; retry after saving"))?;
    let after = source
        .metadata()
        .map_err(|_| CommandError::io("could not verify editing copy"))?;
    if bytes.is_empty()
        || bytes.len() as u64 > entry::MAX_FILE_BYTES
        || before.len() != after.len()
        || after.len() != bytes.len() as u64
        || before.modified().ok() != after.modified().ok()
        || stamp(&directory, &session.filename)? != current_stamp
    {
        return Err(CommandError::conflict(
            "editing copy changed during read; retry after saving",
        ));
    }
    let hash = entry::digest(&bytes);
    if hash == file.sha256 {
        let recovered = session.baseline != hash;
        session.baseline = hash;
        session.stamp = current_stamp;
        write_session(&directory, &session)?;
        return Ok(if force || recovered { Some(note) } else { None });
    }
    if file.sha256 != session.baseline {
        return Err(CommandError::conflict(
            "both copies changed; editing copy retained",
        ));
    }
    let extension = file
        .original_name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if session.filename != format!("document.{extension}") {
        return Err(CommandError::validation(
            "editing session format does not match its entry",
        ));
    }
    let modern = matches!(
        session.filename.rsplit('.').next(),
        Some("docx" | "xlsx" | "pptx")
    );
    if (modern && !bytes.starts_with(b"PK"))
        || (!modern && !bytes.starts_with(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    {
        return Err(CommandError::validation(
            "saved Office file is invalid; previous entry retained",
        ));
    }
    if modern {
        let mut archive = zip::ZipArchive::new(Cursor::new(&bytes)).map_err(|_| {
            CommandError::validation("Office archive is incomplete; previous entry retained")
        })?;
        let part = match extension.as_str() {
            "docx" => "word/document.xml",
            "xlsx" => "xl/workbook.xml",
            _ => "ppt/presentation.xml",
        };
        archive.by_name(part).map_err(|_| {
            CommandError::validation("Office main part is missing; previous entry retained")
        })?;
    }
    // Each edited payload is immutable. Only the atomically published manifest switches to it.
    let owner = SafeDirectory::open(paths.root(), &["notes", &id.to_string()], false)?;
    let storage_name = format!("payload-{}.bin", NoteId::now_v7());
    let mut target = owner.create_new(&storage_name)?;
    target
        .write_all(&bytes)
        .map_err(|_| CommandError::io("could not save edited payload"))?;
    target
        .sync_all()
        .map_err(|_| CommandError::io("could not flush edited payload"))?;
    drop(target);
    owner.sync()?;
    let extension = session.filename.rsplit('.').next().unwrap_or("");
    let media_type = match extension {
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => file.media_type.as_str(),
    };
    let next = ManagedFile {
        storage_name,
        original_name: file.original_name.clone(),
        media_type: media_type.into(),
        size: bytes.len() as u64,
        sha256: hash.clone(),
    };
    let saved = repository.replace_managed_payload_locked(id, &session.baseline, next, &guard)?;
    session.baseline = hash;
    session.stamp = current_stamp;
    write_session(&directory, &session)?;
    Ok(Some(saved))
}
fn blank_office(extension: &str) -> Result<Vec<u8>, CommandError> {
    let (part, kind, xml) = match extension {
        "pptx" => (
            "ppt/presentation.xml",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
            r#"<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst/><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>"#,
        ),
        "docx" => (
            "word/document.xml",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
            r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:sectPr/></w:body></w:document>"#,
        ),
        "xlsx" => (
            "xl/workbook.xml",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
            r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
        ),
        _ => {
            return Err(CommandError::validation(
                "empty legacy Office files cannot be initialized",
            ))
        }
    };
    let mut parts = vec![
        (
            "[Content_Types].xml".to_owned(),
            format!(
                r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/{part}" ContentType="{kind}"/>{}</Types>"#,
                if extension == "xlsx" {
                    r#"<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>"#
                } else {
                    ""
                }
            ),
        ),
        (
            "_rels/.rels".into(),
            format!(
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="{part}"/></Relationships>"#
            ),
        ),
        (part.into(), xml.into()),
    ];
    if extension == "xlsx" {
        parts.push(("xl/_rels/workbook.xml.rels".into(),r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#.into()));
        parts.push(("xl/worksheets/sheet1.xml".into(),r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>"#.into()))
    }
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, text) in parts {
        archive
            .start_file(name, zip::write::SimpleFileOptions::default())
            .map_err(|_| CommandError::io("could not initialize Office file"))?;
        archive
            .write_all(text.as_bytes())
            .map_err(|_| CommandError::io("could not initialize Office file"))?;
    }
    Ok(archive
        .finish()
        .map_err(|_| CommandError::io("could not finish Office file"))?
        .into_inner())
}
