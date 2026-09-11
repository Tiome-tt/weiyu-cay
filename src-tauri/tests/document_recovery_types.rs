use serde_json::json;
use simple_notes_lib::{
    domain::{NoteDocument, NoteId},
    storage::{paths::StoragePaths, recovery::recover_startup, repository::NoteRepository},
};

#[test]
fn a_file_candidate_cannot_change_a_text_entry_into_an_attachment() {
    let root = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let repository = NoteRepository::new(paths.clone());
    let note: NoteDocument = serde_json::from_value(json!({
        "id": NoteId::now_v7(), "kind": "formal", "title": "Text",
        "folderId": null, "tags": [], "markdown": "", "revision": 0,
        "createdAt": "2026-09-08T00:00:00Z", "updatedAt": "2026-09-08T00:00:00Z",
        "content": {"type": "text", "text": "original text"}
    }))
    .unwrap();
    repository.create(note.clone()).unwrap();
    let directory = paths.notes().join(note.id.to_string());
    let original = std::fs::read(directory.join("entry.json")).unwrap();
    let mut candidate: serde_json::Value = serde_json::from_slice(&original).unwrap();
    let payload = candidate
        .as_object_mut()
        .unwrap()
        .remove("payload")
        .unwrap();
    candidate["contentType"] = json!("file");
    candidate["note"]["content"] = json!({"type": "file", "file": payload});
    candidate["note"]["revision"] = json!(10);
    std::fs::write(
        directory.join(format!(".entry.json.{}.tmp", NoteId::now_v7())),
        serde_json::to_vec(&candidate).unwrap(),
    )
    .unwrap();
    let _ = recover_startup(&paths);
    assert_eq!(
        std::fs::read(directory.join("entry.json")).unwrap(),
        original
    );
    assert_eq!(repository.load(note.id).unwrap(), note);
}
