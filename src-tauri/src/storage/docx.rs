use crate::error::CommandError;
use quick_xml::{events::Event, Reader};
use std::{
    collections::HashSet,
    io::{Cursor, Read},
};
fn invalid() -> CommandError {
    CommandError::validation("invalid or unsupported DOCX package")
}
pub(crate) fn validate(bytes: &[u8]) -> Result<(), CommandError> {
    if bytes.len() > 64 * 1024 * 1024 {
        return Err(invalid());
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| invalid())?;
    if archive.len() > 4096 {
        return Err(invalid());
    }
    let mut names = HashSet::new();
    let mut total = 0u64;
    let mut document = false;
    let mut content_types = false;
    let mut relationships = false;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|_| invalid())?;
        let name = file.name().to_owned();
        if file.enclosed_name().is_none()
            || name.contains('\\')
            || !names.insert(name.clone())
            || file.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
            || name.to_ascii_lowercase().contains("vbaproject")
        {
            return Err(invalid());
        }
        total = total
            .checked_add(file.size())
            .filter(|v| *v <= 128 * 1024 * 1024)
            .ok_or_else(invalid)?;
        if file.is_dir() {
            continue;
        }
        // Read every entry to validate compression and CRC, bounding both declared and actual size.
        let mut data = Vec::new();
        file.by_ref()
            .take(64 * 1024 * 1024 + 1)
            .read_to_end(&mut data)
            .map_err(|_| invalid())?;
        if data.len() as u64 != file.size() || data.len() > 64 * 1024 * 1024 {
            return Err(invalid());
        }
        match name.as_str() {
            "word/document.xml" => {
                validate_xml(&data, b"document", Some(b"body"))?;
                document = true;
            }
            "[Content_Types].xml" => {
                validate_xml(&data, b"Types", None)?;
                content_types = true;
            }
            "_rels/.rels" => {
                validate_xml(&data, b"Relationships", None)?;
                relationships = true;
            }
            _ => {}
        }
    }
    if !document || !content_types || !relationships {
        return Err(invalid());
    }
    Ok(())
}
fn validate_xml(bytes: &[u8], root: &[u8], required: Option<&[u8]>) -> Result<(), CommandError> {
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().check_end_names = true;
    let mut depth = 0usize;
    let mut roots = 0usize;
    let mut found = false;
    loop {
        match reader.read_event().map_err(|_| invalid())? {
            Event::Start(start) => {
                if depth == 0 {
                    roots += 1;
                    if start.local_name().as_ref() != root {
                        return Err(invalid());
                    }
                }
                if required == Some(start.local_name().as_ref()) {
                    found = true;
                }
                depth += 1;
                if depth > 128 {
                    return Err(invalid());
                }
            }
            Event::Empty(start) => {
                if depth == 0 {
                    roots += 1;
                    if start.local_name().as_ref() != root {
                        return Err(invalid());
                    }
                }
                if required == Some(start.local_name().as_ref()) {
                    found = true;
                }
            }
            Event::End(_) => depth = depth.checked_sub(1).ok_or_else(invalid)?,
            Event::DocType(_) => return Err(invalid()),
            Event::Eof => break,
            _ => {}
        }
    }
    if roots != 1 || depth != 0 || (required.is_some() && !found) {
        return Err(invalid());
    }
    Ok(())
}
