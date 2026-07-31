mod support;

use rusqlite::{params, Connection};
use simple_notes_lib::{
    domain::{FolderId, NoteDocument, NoteId, NoteKind},
    error::CommandErrorCode,
    storage::{
        atomic_file::{atomic_replace, atomic_replace_with_hook},
        repository::NoteRepository,
    },
};
use std::{fs, path::Path};
use support::TestStore;

const NOTE_ID: &str = "019c0000-0000-7000-8000-000000000111";
const FOLDER_ID: &str = "019c0000-0000-7000-8000-000000000112";

fn note(markdown: &str, revision: u64) -> NoteDocument {
    NoteDocument {
        id: NoteId::parse_str(NOTE_ID).unwrap(),
        kind: NoteKind::Formal,
        title: "Atomic save".to_owned(),
        folder_id: None,
        tags: vec!["rust".to_owned(), "storage".to_owned()],
        markdown: markdown.to_owned(),
        revision,
        created_at: "2026-07-30T00:00:00Z".to_owned(),
        updated_at: "2026-07-30T00:01:00Z".to_owned(),
    }
}

fn document_path(store: &TestStore) -> std::path::PathBuf {
    store
        .paths
        .note_dir(NoteId::parse_str(NOTE_ID).unwrap(), NoteKind::Formal)
        .unwrap()
        .join("note.md")
}

#[test]
fn failed_replace_preserves_the_previous_document_and_cleans_only_its_temp() {
    let root = tempfile::tempdir().unwrap();
    let document = root.path().join("note.md");
    fs::write(&document, b"old").unwrap();
    let unrelated = root.path().join(".note.md.unrelated.tmp");
    fs::write(&unrelated, b"crash-leftover").unwrap();

    let error = atomic_replace_with_hook(&document, b"new", |_source, _destination| {
        Err(simple_notes_lib::error::CommandError::io(
            "injected failure before replace",
        ))
    })
    .unwrap_err();

    assert_eq!(error.code(), CommandErrorCode::Io);
    assert_eq!(fs::read(&document).unwrap(), b"old");
    assert_eq!(fs::read(&unrelated).unwrap(), b"crash-leftover");
    let owned_leftovers = fs::read_dir(root.path())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.starts_with(".note.md.") && name.ends_with(".tmp") && entry.path() != unrelated
        })
        .count();
    assert_eq!(owned_leftovers, 0);
}

#[test]
fn successful_replace_publishes_all_new_bytes_and_leaves_no_owned_temp() {
    let root = tempfile::tempdir().unwrap();
    let document = root.path().join("note.md");
    fs::write(&document, b"old").unwrap();

    atomic_replace(&document, b"complete new document").unwrap();

    assert_eq!(fs::read(&document).unwrap(), b"complete new document");
    assert_eq!(owned_temp_count(root.path()), 0);
}

#[test]
fn stale_revision_does_not_change_markdown_or_index_state() {
    let store = TestStore::new();
    let repository = NoteRepository::new(store.paths.clone(), store.db);
    let created = repository.create(note("old body", 0)).unwrap();
    assert_eq!(created.revision, 0);
    let saved = repository.save(note("current body", 0), 0).unwrap();
    assert_eq!(saved.revision, 1);
    let before = fs::read(document_path_from_root(store.root.path())).unwrap();

    let error = repository.save(note("stale body", 1), 0).unwrap_err();

    assert_eq!(error.code(), CommandErrorCode::Conflict);
    assert_eq!(
        fs::read(document_path_from_root(store.root.path())).unwrap(),
        before
    );
    assert_eq!(
        repository
            .load(NoteId::parse_str(NOTE_ID).unwrap())
            .unwrap()
            .revision,
        1
    );
}

#[test]
fn database_failure_after_durable_content_keeps_markdown_and_marks_rebuild() {
    let store = TestStore::new();
    let path = document_path(&store);
    let database_path = store.paths.database().to_path_buf();
    let repository = NoteRepository::new(store.paths.clone(), store.db);
    repository.create(note("old body", 0)).unwrap();
    let sabotage = Connection::open(&database_path).unwrap();
    sabotage.execute_batch("DROP TABLE note_tags;").unwrap();
    drop(sabotage);

    let error = repository.save(note("durable new body", 0), 0).unwrap_err();

    assert_eq!(error.code(), CommandErrorCode::Database);
    let durable = fs::read_to_string(path).unwrap();
    assert!(durable.contains("durable new body"));
    assert!(store.paths.root().join("rebuild-needed.json").is_file());
}

#[test]
fn failed_metadata_transaction_does_not_publish_partial_rows() {
    let store = TestStore::new();
    let database_path = store.paths.database().to_path_buf();
    let sabotage = Connection::open(&database_path).unwrap();
    sabotage
        .execute_batch(
            "CREATE TRIGGER reject_search BEFORE INSERT ON search_documents BEGIN SELECT RAISE(ABORT, 'injected'); END;",
        )
        .unwrap();
    drop(sabotage);
    let repository = NoteRepository::new(store.paths.clone(), store.db);

    assert_eq!(
        repository
            .create(note("durable body", 0))
            .unwrap_err()
            .code(),
        CommandErrorCode::Database
    );

    let connection = Connection::open(&database_path).unwrap();
    let note_rows: i64 = connection
        .query_row("SELECT count(*) FROM notes", [], |row| row.get(0))
        .unwrap();
    let tag_rows: i64 = connection
        .query_row("SELECT count(*) FROM tags", [], |row| row.get(0))
        .unwrap();
    assert_eq!((note_rows, tag_rows), (0, 0));
    assert!(
        fs::read_to_string(document_path_from_root(store.root.path()))
            .unwrap()
            .contains("durable body")
    );
}

#[test]
fn repository_create_load_list_and_move_preserve_identity_and_markdown() {
    let store = TestStore::new();
    let connection = Connection::open(store.paths.database()).unwrap();
    connection
        .execute(
            "INSERT INTO folders (id, name, sort_order, created_at, updated_at) \
             VALUES (?1, 'Moved', 0, '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z')",
            params![uuid::Uuid::parse_str(FOLDER_ID)
                .unwrap()
                .as_bytes()
                .as_slice()],
        )
        .unwrap();
    drop(connection);
    let repository = NoteRepository::new(store.paths.clone(), store.db);
    let markdown = "# Exact body\n\n<custom keep=\"yes\">value</custom>\n";

    repository.create(note(markdown, 0)).unwrap();
    assert_eq!(
        repository
            .load(NoteId::parse_str(NOTE_ID).unwrap())
            .unwrap()
            .markdown,
        markdown
    );
    let summaries = repository.list().unwrap();
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].id.to_string(), NOTE_ID);
    assert!(summaries[0].excerpt.contains("Exact body"));

    let moved = repository
        .move_note(
            NoteId::parse_str(NOTE_ID).unwrap(),
            Some(FolderId::parse_str(FOLDER_ID).unwrap()),
        )
        .unwrap();
    assert_eq!(moved.id.to_string(), NOTE_ID);
    assert_eq!(moved.revision, 1);
    assert_eq!(moved.markdown, markdown);
    assert_eq!(moved.folder_id.unwrap().to_string(), FOLDER_ID);
}

fn owned_temp_count(parent: &Path) -> usize {
    fs::read_dir(parent)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.starts_with(".note.md.") && name.ends_with(".tmp")
        })
        .count()
}

fn document_path_from_root(root: &Path) -> std::path::PathBuf {
    root.join("notes").join(NOTE_ID).join("note.md")
}
