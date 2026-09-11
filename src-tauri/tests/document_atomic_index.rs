use serde_json::json;
use simple_notes_lib::{
    commands::assets::{read_image_asset_from, save_image_to},
    domain::{NoteContent, NoteDocument, NoteId, SaveImageInput},
    storage::{
        paths::StoragePaths, rebuild::rebuild_index_strict, recovery::recover_startup,
        repository::NoteRepository,
    },
};

fn document(content: serde_json::Value) -> NoteDocument {
    serde_json::from_value(json!({
        "id": NoteId::now_v7(), "kind": "formal", "title": "Durable",
        "folderId": null, "tags": [], "markdown": "", "revision": 0,
        "createdAt": "2026-09-08T00:00:00Z", "updatedAt": "2026-09-08T00:00:00Z",
        "content": content
    }))
    .unwrap()
}

#[test]
fn index_failure_keeps_the_new_text_payload_rebuildable_without_partial_metadata() {
    let root = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let repository = NoteRepository::new(paths.clone());
    let old = repository
        .create(document(json!({"type":"text","text":"old"})))
        .unwrap();
    let connection = rusqlite::Connection::open(paths.database()).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_search BEFORE INSERT ON search_documents BEGIN SELECT RAISE(ABORT, 'test failure'); END;").unwrap();
    let mut updated = old.clone();
    updated.content = Some(NoteContent::Text {
        text: "new durable 中文".into(),
    });
    assert!(repository.save(updated.clone(), 0).is_err());
    assert_eq!(
        connection
            .query_row("SELECT revision FROM notes", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(paths.root().join("rebuild-needed.json").exists());
    drop(connection);
    updated.revision = 1;
    assert_eq!(repository.load(old.id).unwrap(), updated);
    assert_eq!(rebuild_index_strict(&paths).unwrap().notes_recovered, 1);
    let connection = rusqlite::Connection::open(paths.database()).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT plain_text FROM search_documents", [], |row| row
                .get::<_, String>(
                0
            ))
            .unwrap(),
        "new durable 中文"
    );
}

#[test]
fn text_recovery_resolves_the_candidate_payload_before_publishing_its_manifest() {
    let root = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let repository = NoteRepository::new(paths.clone());
    let old = repository
        .create(document(json!({"type":"text","text":"old"})))
        .unwrap();
    let directory = paths.notes().join(old.id.to_string());
    let previous = std::fs::read(directory.join("entry.json")).unwrap();
    let mut updated = old.clone();
    updated.content = Some(NoteContent::Text {
        text: "candidate payload".into(),
    });
    let saved = repository.save(updated, 0).unwrap();
    std::fs::rename(
        directory.join("entry.json"),
        directory.join(format!(".entry.json.{}.tmp", NoteId::now_v7())),
    )
    .unwrap();
    std::fs::write(directory.join("entry.json"), previous).unwrap();
    let report = recover_startup(&paths).unwrap();
    assert!(report.failure.is_none());
    assert_eq!(repository.load(old.id).unwrap(), saved);
}

#[test]
fn structured_documents_share_the_validated_image_asset_boundary() {
    let root = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let repository = NoteRepository::new(paths.clone());
    let note = repository.create(document(json!({"type":"document","document":{"schemaVersion":1,"root":{"type":"doc","content":[{"type":"paragraph"}]}}}))).unwrap();
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(2, 2)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let bytes = png.into_inner();
    let saved = save_image_to(
        &paths,
        SaveImageInput {
            note_id: note.id,
            media_type: "image/png".into(),
            bytes: bytes.clone(),
        },
    )
    .unwrap();
    let read = read_image_asset_from(&paths, note.id, &saved.relative_path).unwrap();
    assert_eq!(read.bytes, bytes);
    assert!(read_image_asset_from(&paths, note.id, "assets/../entry.json").is_err());
    assert_eq!(repository.load(note.id).unwrap(), note);
}
