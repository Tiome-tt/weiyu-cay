use serde_json::json;
use simple_notes_lib::{
    commands::assets::save_image_to,
    domain::{NoteDocument, NoteId, SaveImageInput},
    storage::{export::export_library, paths::StoragePaths, repository::NoteRepository},
};

#[test]
fn native_document_export_counts_and_preserves_owned_images() {
    let root = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let note: NoteDocument = serde_json::from_value(json!({
        "id": NoteId::now_v7(), "kind": "formal", "title": "Document",
        "folderId": null, "tags": [], "markdown": "", "revision": 0,
        "createdAt": "2026-09-08T00:00:00Z", "updatedAt": "2026-09-08T00:00:00Z",
        "content": {"type":"document","document":{"schemaVersion":1,"root":{"type":"doc","content":[{"type":"paragraph"}]}}}
    })).unwrap();
    NoteRepository::new(paths.clone())
        .create(note.clone())
        .unwrap();
    let mut encoded = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(2, 2)
        .write_to(&mut encoded, image::ImageFormat::Png)
        .unwrap();
    let bytes = encoded.into_inner();
    let asset = save_image_to(
        &paths,
        SaveImageInput {
            note_id: note.id,
            media_type: "image/png".into(),
            bytes: bytes.clone(),
        },
    )
    .unwrap();
    let report =
        export_library(&paths, &destination.path().canonicalize().unwrap(), "1.1.0").unwrap();
    assert!(report.completed, "{report:?}");
    assert_eq!(report.assets_exported, 1);
    let output = std::path::Path::new(report.output_root.as_ref().unwrap());
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(output.join("export-manifest.json")).unwrap())
            .unwrap();
    let entry_path = output.join(manifest["notes"][note.id.to_string()].as_str().unwrap());
    assert_eq!(
        std::fs::read(entry_path.parent().unwrap().join(asset.relative_path)).unwrap(),
        bytes
    );
}
