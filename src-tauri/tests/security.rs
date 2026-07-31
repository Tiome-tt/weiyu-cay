mod support;

use image::{DynamicImage, ImageFormat};
use simple_notes_lib::{
    commands::assets::{save_image_to, validate_image},
    domain::{NoteDocument, NoteId, NoteKind, SaveImageInput},
    error::CommandErrorCode,
    storage::{database::Database, repository::NoteRepository},
};
use std::io::Cursor;
use support::TestStore;

const FORMAL_ID: &str = "019c0000-0000-7000-8000-000000000071";
const TEMPORARY_ID: &str = "019c0000-0000-7000-8000-000000000072";
const UNKNOWN_ID: &str = "019c0000-0000-7000-8000-000000000079";

#[test]
fn validates_png_jpeg_gif_and_webp_with_canonical_extensions_and_dimensions() {
    for (media_type, format, extension) in [
        ("image/png", ImageFormat::Png, "png"),
        ("image/jpeg", ImageFormat::Jpeg, "jpg"),
        ("image/gif", ImageFormat::Gif, "gif"),
        ("image/webp", ImageFormat::WebP, "webp"),
    ] {
        let validated = validate_image(media_type, &encoded(format, 2, 3)).unwrap();
        assert_eq!(validated.extension(), extension);
        assert_eq!(validated.dimensions(), (2, 3));
    }
}

#[test]
fn rejects_spoofed_malformed_unsupported_empty_and_oversized_payloads() {
    let png = encoded(ImageFormat::Png, 2, 3);
    for error in [
        validate_image("image/jpeg", &png).unwrap_err(),
        validate_image("image/png", &png[..12]).unwrap_err(),
        validate_image("image/bmp", &png).unwrap_err(),
        validate_image("image/png", &[]).unwrap_err(),
        validate_image("image/png", &vec![0; 20 * 1024 * 1024 + 1]).unwrap_err(),
    ] {
        assert_eq!(error.code(), CommandErrorCode::Validation);
        assert!(!error.message().contains(':'));
    }
}

#[test]
fn rejects_zero_and_oversized_dimensions_before_decoding_pixels() {
    assert_eq!(
        validate_image("image/png", &png_header(0, 2))
            .unwrap_err()
            .code(),
        CommandErrorCode::Validation
    );
    assert_eq!(
        validate_image("image/png", &png_header(16_385, 2))
            .unwrap_err()
            .code(),
        CommandErrorCode::Validation
    );
}

#[test]
fn persists_assets_for_formal_and_temporary_notes_without_overwrite_or_absolute_paths() {
    let store = TestStore::new();
    create_note(&store, FORMAL_ID, NoteKind::Formal);
    create_note(&store, TEMPORARY_ID, NoteKind::Temporary);
    let png = encoded(ImageFormat::Png, 2, 3);

    let formal = save_image_to(&store.paths, input(FORMAL_ID, "image/png", png.clone())).unwrap();
    let second = save_image_to(&store.paths, input(FORMAL_ID, "image/png", png.clone())).unwrap();
    let temporary = save_image_to(&store.paths, input(TEMPORARY_ID, "image/png", png)).unwrap();

    assert_ne!(formal.relative_path, second.relative_path);
    assert!(formal.relative_path.starts_with("assets/screenshot-"));
    assert!(formal.relative_path.ends_with(".png"));
    assert!(!formal.relative_path.contains('\\'));
    assert!(!formal.relative_path.contains(FORMAL_ID));
    assert_eq!((formal.width, formal.height), (2, 3));
    assert!(store
        .paths
        .note_dir(id(FORMAL_ID), NoteKind::Formal)
        .unwrap()
        .join(&formal.relative_path)
        .exists());
    assert!(store
        .paths
        .note_dir(id(TEMPORARY_ID), NoteKind::Temporary)
        .unwrap()
        .join(&temporary.relative_path)
        .exists());
}

#[test]
fn rejects_unknown_note_ids_without_leaking_the_storage_root() {
    let store = TestStore::new();
    let error = save_image_to(
        &store.paths,
        input(UNKNOWN_ID, "image/png", encoded(ImageFormat::Png, 2, 3)),
    )
    .unwrap_err();

    assert_eq!(error.code(), CommandErrorCode::NotFound);
    assert!(!error
        .message()
        .contains(&store.root.path().display().to_string()));
    assert!(error.diagnostic().is_some());
}

#[cfg(unix)]
#[test]
fn rejects_a_symlinked_assets_directory_escape() {
    use std::os::unix::fs::symlink;
    let store = TestStore::new();
    create_note(&store, FORMAL_ID, NoteKind::Formal);
    let note_dir = store
        .paths
        .note_dir(id(FORMAL_ID), NoteKind::Formal)
        .unwrap();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), note_dir.join("assets")).unwrap();

    let error = save_image_to(
        &store.paths,
        input(FORMAL_ID, "image/png", encoded(ImageFormat::Png, 2, 3)),
    )
    .unwrap_err();
    assert!(matches!(
        error.code(),
        CommandErrorCode::Io | CommandErrorCode::Validation
    ));
    assert_eq!(outside.path().read_dir().unwrap().count(), 0);
}

#[cfg(windows)]
#[test]
#[ignore = "creating a junction requires privileges unavailable in standard test sessions"]
fn rejects_a_junctioned_assets_directory_escape() {
    use std::os::windows::fs::symlink_dir;
    let store = TestStore::new();
    create_note(&store, FORMAL_ID, NoteKind::Formal);
    let note_dir = store
        .paths
        .note_dir(id(FORMAL_ID), NoteKind::Formal)
        .unwrap();
    let outside = tempfile::tempdir().unwrap();
    symlink_dir(outside.path(), note_dir.join("assets")).unwrap();

    let error = save_image_to(
        &store.paths,
        input(FORMAL_ID, "image/png", encoded(ImageFormat::Png, 2, 3)),
    )
    .unwrap_err();
    assert!(matches!(
        error.code(),
        CommandErrorCode::Io | CommandErrorCode::Validation
    ));
    assert_eq!(outside.path().read_dir().unwrap().count(), 0);
}

fn input(note_id: &str, media_type: &str, bytes: Vec<u8>) -> SaveImageInput {
    SaveImageInput {
        note_id: id(note_id),
        media_type: media_type.to_owned(),
        bytes,
    }
}

fn create_note(store: &TestStore, note_id: &str, kind: NoteKind) {
    let db = Database::open(store.paths.database()).unwrap();
    db.migrate().unwrap();
    NoteRepository::new(store.paths.clone(), db)
        .create(NoteDocument {
            id: id(note_id),
            kind,
            title: "image owner".to_owned(),
            folder_id: None,
            tags: vec![],
            markdown: String::new(),
            revision: 0,
            created_at: "2026-07-30T15:30:00+08:00".to_owned(),
            updated_at: "2026-07-30T15:30:00+08:00".to_owned(),
        })
        .unwrap();
}

fn id(value: &str) -> NoteId {
    NoteId::parse_str(value).unwrap()
}

fn encoded(format: ImageFormat, width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::new_rgba8(width, height)
        .write_to(&mut bytes, format)
        .unwrap();
    bytes.into_inner()
}

fn png_header(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = vec![137, 80, 78, 71, 13, 10, 26, 10];
    let mut ihdr = Vec::from(width.to_be_bytes());
    ihdr.extend(height.to_be_bytes());
    ihdr.extend([8, 6, 0, 0, 0]);
    append_png_chunk(&mut bytes, b"IHDR", &ihdr);
    append_png_chunk(&mut bytes, b"IEND", &[]);
    bytes
}

fn append_png_chunk(output: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    output.extend((data.len() as u32).to_be_bytes());
    output.extend(kind);
    output.extend(data);
    let mut crc_data = Vec::from(*kind);
    crc_data.extend(data);
    output.extend(crc32(&crc_data).to_be_bytes());
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}
