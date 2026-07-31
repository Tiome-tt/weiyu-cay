mod support;

use rusqlite::Connection;
use serde_json::json;
use simple_notes_lib::{
    domain::{FolderId, NoteDocument, NoteId, NoteKind},
    storage::{database::Database, rebuild::rebuild_index, repository::NoteRepository},
};
use std::fs;
use support::TestStore;

const NOTE_ID: &str = "019c0000-0000-7000-8000-000000000211";
const BROKEN_ID: &str = "019c0000-0000-7000-8000-000000000212";
const TARGET_ID: &str = "019c0000-0000-7000-8000-000000000299";
const FOLDER_ID: &str = "019c0000-0000-7000-8000-000000000220";

fn note() -> NoteDocument {
    NoteDocument {
        id: NoteId::parse_str(NOTE_ID).unwrap(),
        kind: NoteKind::Formal,
        title: "Recovered note".to_owned(),
        folder_id: Some(FolderId::parse_str(FOLDER_ID).unwrap()),
        tags: vec!["backend".to_owned(), "Rust".to_owned()],
        markdown: format!(
            "# Hello\n\n[[Missing|{TARGET_ID}]]\n\nUnsupported <custom>body</custom>"
        ),
        revision: 4,
        created_at: "2026-07-30T00:00:00Z".to_owned(),
        updated_at: "2026-07-30T00:04:00Z".to_owned(),
    }
}

#[test]
fn rebuild_recovers_folders_note_tags_search_and_unresolved_links_after_db_deletion() {
    let mut store = TestStore::new();
    fs::write(
        store.paths.folders_manifest(),
        serde_json::to_vec_pretty(&json!([{
            "id": FOLDER_ID,
            "parentId": null,
            "name": "Work",
            "sortOrder": 0,
            "createdAt": "2026-07-30T00:00:00Z",
            "updatedAt": "2026-07-30T00:00:00Z"
        }]))
        .unwrap(),
    )
    .unwrap();
    let folder_connection = Connection::open(store.paths.database()).unwrap();
    folder_connection
        .execute(
            "INSERT INTO folders (id, parent_id, name, sort_order, created_at, updated_at) \
             VALUES (?1, NULL, 'Work', 0, '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z')",
            [uuid::Uuid::parse_str(FOLDER_ID)
                .unwrap()
                .as_bytes()
                .as_slice()],
        )
        .unwrap();
    drop(folder_connection);
    let repository = NoteRepository::new(
        store.paths.clone(),
        Database::open(store.paths.database()).unwrap(),
    );
    persist_at_revision(&repository, note());
    drop(repository);
    store.close_database();
    remove_sqlite_files(&store);

    let report = rebuild_index(&store.paths).unwrap();

    assert_eq!(report.notes_recovered, 1);
    assert_eq!(report.folders_recovered, 1);
    assert_eq!(report.notes_failed, 0);
    let connection = Connection::open(store.paths.database()).unwrap();
    assert_eq!(query_count(&connection, "notes"), 1);
    assert_eq!(query_count(&connection, "folders"), 1);
    assert_eq!(query_count(&connection, "note_tags"), 2);
    assert_eq!(query_count(&connection, "search_documents"), 1);
    let unresolved: Vec<u8> = connection
        .query_row("SELECT target_note_id FROM note_links", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(
        uuid::Uuid::from_slice(&unresolved)
            .unwrap()
            .hyphenated()
            .to_string(),
        TARGET_ID
    );
}

#[test]
fn malformed_frontmatter_is_isolated_without_blocking_valid_notes_or_rewriting_files() {
    let store = TestStore::new();
    let repository = NoteRepository::new(store.paths.clone(), store.db);
    persist_at_revision(&repository, note_without_folder());
    drop(repository);
    let broken_dir = store.paths.notes().join(BROKEN_ID);
    fs::create_dir_all(&broken_dir).unwrap();
    let broken = b"---\nid: not-a-uuid\ntitle: Broken\n---\nbody stays byte-identical\n";
    fs::write(broken_dir.join("note.md"), broken).unwrap();

    let report = rebuild_index(&store.paths).unwrap();

    assert_eq!(report.notes_recovered, 1);
    assert_eq!(report.notes_failed, 1);
    assert_eq!(fs::read(broken_dir.join("note.md")).unwrap(), broken);
    assert!(report.failures.iter().all(|failure| !failure
        .message
        .contains(store.root.path().to_string_lossy().as_ref())));
}

#[test]
fn a_second_rebuild_is_idempotent_and_does_not_change_markdown_bytes() {
    let store = TestStore::new();
    let repository = NoteRepository::new(store.paths.clone(), store.db);
    persist_at_revision(&repository, note_without_folder());
    drop(repository);
    let path = store.paths.notes().join(NOTE_ID).join("note.md");
    let before = fs::read(&path).unwrap();

    let first = rebuild_index(&store.paths).unwrap();
    let second = rebuild_index(&store.paths).unwrap();

    assert_eq!(first.notes_recovered, 1);
    assert_eq!(second.notes_recovered, 1);
    assert_eq!(fs::read(path).unwrap(), before);
    let connection = Connection::open(store.paths.database()).unwrap();
    assert_eq!(query_count(&connection, "notes"), 1);
    assert_eq!(query_count(&connection, "note_links"), 1);
}

fn note_without_folder() -> NoteDocument {
    let mut document = note();
    document.folder_id = None;
    document
}

fn persist_at_revision(repository: &NoteRepository, desired: NoteDocument) {
    let target_revision = desired.revision;
    let mut current = desired.clone();
    current.revision = 0;
    repository.create(current.clone()).unwrap();
    for expected_revision in 0..target_revision {
        current.revision = expected_revision;
        current = repository.save(current, expected_revision).unwrap();
    }
}

fn query_count(connection: &Connection, table: &str) -> i64 {
    connection
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
}

fn remove_sqlite_files(store: &TestStore) {
    for path in [
        store.paths.database().to_path_buf(),
        store.paths.root().join("index.sqlite-wal"),
        store.paths.root().join("index.sqlite-shm"),
    ] {
        if path.exists() {
            fs::remove_file(path).unwrap();
        }
    }
}
