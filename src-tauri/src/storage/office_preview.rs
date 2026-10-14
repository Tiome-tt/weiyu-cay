use crate::{
    domain::{NoteContent, NoteId},
    error::CommandError,
    platform::{IndexMutationLock, SafeDirectory},
    storage::{entry, paths::StoragePaths, repository::NoteRepository},
};
use base64::Engine;
use serde::Serialize;
use std::io::{Cursor, Read};
#[derive(Serialize)]
pub struct OfficeXmlPart {
    name: String,
    text: String,
}
pub fn read_parts(paths: &StoragePaths, id: NoteId) -> Result<Vec<OfficeXmlPart>, CommandError> {
    const LIMIT: u64 = 32 * 1024 * 1024;
    let guard = IndexMutationLock::acquire(paths.root())?;
    let note = NoteRepository::new(paths.clone()).load_locked(id, &guard)?;
    let Some(NoteContent::File { file }) = note.content else {
        return Err(CommandError::validation("entry is not a managed file"));
    };
    if file.size > LIMIT {
        return Err(CommandError::validation(
            "Office preview file exceeds its size limit",
        ));
    }
    let directory = SafeDirectory::open(paths.root(), &["notes", &id.to_string()], false)?;
    let source = directory.open_regular(&file.storage_name, LIMIT)?;
    let mut bytes = Vec::new();
    source
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| CommandError::io("could not read Office preview"))?;
    if bytes.len() as u64 != file.size || entry::digest(&bytes) != file.sha256 {
        return Err(CommandError::validation("Office preview payload changed"));
    }
    extract(&bytes)
}
fn extract(bytes: &[u8]) -> Result<Vec<OfficeXmlPart>, CommandError> {
    if bytes.is_empty() {
        return Ok(vec![]);
    }
    if bytes.len() > 32 * 1024 * 1024 {
        return Err(CommandError::validation(
            "Office preview file exceeds its size limit",
        ));
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| CommandError::validation("Office preview requires an Open XML file"))?;
    if archive.len() > 10000 {
        return Err(CommandError::validation(
            "Office preview has too many entries",
        ));
    }
    let mut parts = vec![];
    let mut total = 0;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|_| CommandError::validation("Office part is unreadable"))?;
        let name = file.name().to_owned();
        let numbered = |prefix: &str| {
            name.strip_prefix(prefix)
                .and_then(|suffix| suffix.strip_suffix(".xml"))
                .is_some_and(|number| {
                    !number.is_empty() && number.chars().all(|c| c.is_ascii_digit())
                })
        };
        if !(name == "ppt/presentation.xml"
            || name == "ppt/_rels/presentation.xml.rels"
            || name == "word/document.xml"
            || name == "xl/sharedStrings.xml"
            || name == "xl/workbook.xml"
            || name == "xl/_rels/workbook.xml.rels"
            || numbered("xl/worksheets/sheet")
            || numbered("ppt/slides/slide")
            || (name.starts_with("ppt/slides/_rels/slide") && name.ends_with(".xml.rels"))
            || (name.starts_with("ppt/media/")
                && [".png", ".jpg", ".jpeg", ".webp"]
                    .iter()
                    .any(|ext| name.to_ascii_lowercase().ends_with(ext))))
        {
            continue;
        }
        if file.size() > 4 * 1024 * 1024
            || parts.len() >= 100
            || total + file.size() > 8 * 1024 * 1024
        {
            return Err(CommandError::validation(
                "Office preview content exceeds its size limit",
            ));
        }
        if name.starts_with("ppt/media/") {
            let mut bytes = Vec::new();
            file.by_ref()
                .take(4 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| CommandError::validation("Office picture is unreadable"))?;
            let media = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                "image/png"
            } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
                "image/jpeg"
            } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
                "image/webp"
            } else {
                continue;
            };
            if bytes.len() > 4 * 1024 * 1024 {
                return Err(CommandError::validation(
                    "Office picture exceeds its size limit",
                ));
            }
            crate::commands::assets::validate_image(media, &bytes)?;
            let text = format!(
                "data:{media};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            );
            total += text.len() as u64;
            if total > 8 * 1024 * 1024 {
                return Err(CommandError::validation(
                    "Office preview content exceeds its size limit",
                ));
            }
            parts.push(OfficeXmlPart { name, text });
            continue;
        }
        let mut text = String::new();
        file.by_ref()
            .take(4 * 1024 * 1024 + 1)
            .read_to_string(&mut text)
            .map_err(|_| CommandError::validation("Office preview is not UTF-8 XML"))?;
        if text.len() > 4 * 1024 * 1024
            || text.to_ascii_uppercase().contains("<!DOCTYPE")
            || text.to_ascii_uppercase().contains("<!ENTITY")
        {
            return Err(CommandError::validation(
                "Office preview XML is unsafe or oversized",
            ));
        }
        total += text.len() as u64;
        if total > 8 * 1024 * 1024 {
            return Err(CommandError::validation(
                "Office preview content exceeds its size limit",
            ));
        }
        parts.push(OfficeXmlPart { name, text });
    }
    Ok(parts)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn office_parts_are_bounded_and_never_include_macros_or_external_resources() {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for name in [
            "word/document.xml",
            "word/vbaProject.bin",
            "../../secret.xml",
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"<doc/>").unwrap();
        }
        let result = extract(&zip.finish().unwrap().into_inner()).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "word/document.xml");
        assert!(extract(b"bad").is_err());
        assert!(extract(&[]).unwrap().is_empty());
    }
    #[test]
    fn slide_pictures_are_local_validated_rasters() {
        let mut image_bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut image_bytes, image::ImageFormat::Png)
            .unwrap();
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in [
            (
                "ppt/slides/_rels/slide1.xml.rels",
                b"<Relationships/>".as_slice(),
            ),
            ("ppt/media/image1.png", image_bytes.get_ref().as_slice()),
            ("ppt/media/image2.svg", b"<svg/>".as_slice()),
        ] {
            archive
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            archive.write_all(bytes).unwrap();
        }
        let parts = extract(&archive.finish().unwrap().into_inner()).unwrap();
        assert_eq!(parts.len(), 2);
        assert!(parts.iter().any(|part| part.name == "ppt/media/image1.png"
            && part.text.starts_with("data:image/png;base64,")));
    }
    #[test]
    fn office_parts_reject_entities_and_oversized_xml() {
        for content in [
            "<!DOCTYPE doc [<!ENTITY x 'bad'>]><doc/>".to_owned(),
            "x".repeat(4 * 1024 * 1024 + 1),
        ] {
            let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
            zip.start_file(
                "word/document.xml",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            zip.write_all(content.as_bytes()).unwrap();
            assert!(extract(&zip.finish().unwrap().into_inner()).is_err());
        }
    }
    #[test]
    fn managed_office_preview_preserves_original_payload() {
        use crate::storage::managed_files::{import_files, read_file_bytes, ImportFilesInput};
        let directory = tempfile::tempdir().unwrap();
        let paths = StoragePaths::open(directory.path().join("library")).unwrap();
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file(
            "word/document.xml",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(b"<document><body/></document>").unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        let source = directory.path().join("example.docx");
        std::fs::write(&source, &bytes).unwrap();
        let imported = import_files(
            &paths,
            ImportFilesInput {
                paths: vec![source.to_string_lossy().into_owned()],
                folder_id: None,
            },
        )
        .unwrap();
        assert_eq!(imported.imported.len(), 1, "{:?}", imported.failed);
        let id = imported.imported[0].id;
        assert_eq!(read_parts(&paths, id).unwrap()[0].name, "word/document.xml");
        crate::storage::managed_files::save_pdf_export(
            &paths,
            id,
            &directory.path().join("copy.pdf"),
            b"%PDF-1.7\n%%EOF",
        )
        .unwrap();
        crate::storage::managed_files::save_note_text_export(
            &paths,
            id,
            &directory.path().join("copy.txt"),
            "body",
            crate::storage::managed_files::NoteTextExportFormat::Text,
        )
        .unwrap();
        assert!(crate::storage::managed_files::save_pdf_export(
            &paths,
            id,
            &paths.root().join("internal.pdf"),
            b"%PDF-1.7\n%%EOF"
        )
        .is_err());
        assert_eq!(read_file_bytes(&paths, id).unwrap(), bytes);
    }
}
