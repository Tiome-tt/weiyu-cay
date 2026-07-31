mod support;

use rusqlite::{params, Connection};
use simple_notes_lib::{
    domain::{FolderId, NoteDocument, NoteId, NoteKind},
    error::CommandErrorCode,
    storage::{
        atomic_file::{
            atomic_replace, atomic_replace_contained_with_hook, atomic_replace_with_hook,
            PublishFailure, PublishState,
        },
        database::Database,
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
        Err(PublishFailure::not_published(
            simple_notes_lib::error::CommandError::io("injected failure before replace"),
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
fn failed_publish_does_not_delete_a_replaced_temp_path_it_no_longer_owns() {
    let root = tempfile::tempdir().unwrap();
    let document = root.path().join("note.md");
    fs::write(&document, b"old").unwrap();
    let mut swapped = None;

    let error = atomic_replace_with_hook(&document, b"new", |source, _destination| {
        fs::remove_file(source).unwrap();
        fs::write(source, b"unrelated replacement").unwrap();
        swapped = Some(source.to_path_buf());
        Err(PublishFailure::not_published(
            simple_notes_lib::error::CommandError::io("injected failure after source swap"),
        ))
    })
    .unwrap_err();

    assert_eq!(error.state(), PublishState::NotPublished);
    assert_eq!(fs::read(&document).unwrap(), b"old");
    assert_eq!(
        fs::read(swapped.unwrap()).unwrap(),
        b"unrelated replacement"
    );
}

#[test]
fn published_sync_failure_reports_published_content_and_does_not_delete_it() {
    let root = tempfile::tempdir().unwrap();
    let document = root.path().join("note.md");
    fs::write(&document, b"old").unwrap();

    let error = atomic_replace_with_hook(&document, b"new", |source, destination| {
        fs::rename(source, destination).unwrap();
        Err(PublishFailure::published_but_sync_failed(
            simple_notes_lib::error::CommandError::io("injected parent sync failure"),
        ))
    })
    .unwrap_err();

    assert_eq!(error.state(), PublishState::PublishedButSyncFailed);
    assert_eq!(fs::read(&document).unwrap(), b"new");
    assert_eq!(owned_temp_count(root.path()), 0);
}

#[test]
fn parent_directory_exchange_never_publishes_outside_the_root() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let note_dir = root.path().join("notes").join(NOTE_ID);
    fs::create_dir_all(&note_dir).unwrap();
    fs::write(note_dir.join("note.md"), b"old").unwrap();
    let moved = root.path().join("moved-note");

    let result = atomic_replace_contained_with_hook(
        root.path(),
        &["notes", NOTE_ID],
        "note.md",
        b"new",
        |parent| {
            if fs::rename(parent, &moved).is_err() {
                return Err(simple_notes_lib::error::CommandError::io(
                    "pinned parent rejected exchange",
                ));
            }
            create_directory_symlink(outside.path(), parent).map_err(|source| {
                simple_notes_lib::error::CommandError::io(format!(
                    "could not install exchange symlink: {source}"
                ))
            })
        },
    );

    assert!(!outside.path().join("note.md").exists());
    if result.is_ok() {
        assert_eq!(fs::read(moved.join("note.md")).unwrap(), b"new");
    } else {
        assert_eq!(fs::read(note_dir.join("note.md")).unwrap(), b"old");
    }
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
fn save_rejects_folder_changes_before_writing_or_advancing_the_index() {
    let store = TestStore::new();
    let database_path = store.paths.database().to_path_buf();
    let repository = NoteRepository::new(store.paths.clone(), store.db);
    repository.create(note("old body", 0)).unwrap();
    let before = fs::read(document_path_from_root(store.root.path())).unwrap();
    let mut changed = note("new body", 0);
    changed.folder_id = Some(FolderId::parse_str(FOLDER_ID).unwrap());

    let error = repository.save(changed, 0).unwrap_err();

    assert_eq!(error.code(), CommandErrorCode::Validation);
    assert_eq!(
        fs::read(document_path_from_root(store.root.path())).unwrap(),
        before
    );
    let connection = Connection::open(database_path).unwrap();
    let revision: i64 = connection
        .query_row("SELECT revision FROM notes", [], |row| row.get(0))
        .unwrap();
    assert_eq!(revision, 0);
}

#[test]
fn create_and_move_reject_missing_folders_before_durable_changes() {
    let store = TestStore::new();
    let database_path = store.paths.database().to_path_buf();
    let repository = NoteRepository::new(store.paths.clone(), store.db);
    let mut create = note("never written", 0);
    create.folder_id = Some(FolderId::parse_str(FOLDER_ID).unwrap());
    assert_eq!(
        repository.create(create).unwrap_err().code(),
        CommandErrorCode::NotFound
    );
    assert!(!document_path_from_root(store.root.path()).exists());

    repository.create(note("old body", 0)).unwrap();
    let before = fs::read(document_path_from_root(store.root.path())).unwrap();
    assert_eq!(
        repository
            .move_note(
                NoteId::parse_str(NOTE_ID).unwrap(),
                Some(FolderId::parse_str(FOLDER_ID).unwrap()),
            )
            .unwrap_err()
            .code(),
        CommandErrorCode::NotFound
    );
    assert_eq!(
        fs::read(document_path_from_root(store.root.path())).unwrap(),
        before
    );
    let connection = Connection::open(database_path).unwrap();
    let (revision, folder): (i64, Option<Vec<u8>>) = connection
        .query_row("SELECT revision, folder_id FROM notes", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert_eq!((revision, folder), (0, None));
}

fn publish_then_fail_sync(
    paths: &simple_notes_lib::storage::paths::StoragePaths,
    id: NoteId,
    kind: NoteKind,
    bytes: &[u8],
) -> Result<PublishState, PublishFailure> {
    let directory = paths.note_dir(id, kind).unwrap();
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("note.md"), bytes).unwrap();
    Err(PublishFailure::published_but_sync_failed(
        simple_notes_lib::error::CommandError::io("injected parent sync failure"),
    ))
}

#[test]
fn repository_marks_rebuild_and_keeps_old_index_when_publish_sync_fails() {
    let store = TestStore::new();
    let database_path = store.paths.database().to_path_buf();
    let repository = NoteRepository::new(store.paths.clone(), store.db);
    repository.create(note("old body", 0)).unwrap();
    let repository = NoteRepository::new_with_writer(
        store.paths.clone(),
        Database::open(&database_path).unwrap(),
        publish_then_fail_sync,
    );

    let error = repository.save(note("published body", 0), 0).unwrap_err();

    assert_eq!(error.code(), CommandErrorCode::Io);
    assert!(
        fs::read_to_string(document_path_from_root(store.root.path()))
            .unwrap()
            .contains("published body")
    );
    assert!(store.paths.root().join("rebuild-needed.json").is_file());
    let connection = Connection::open(database_path).unwrap();
    let revision: i64 = connection
        .query_row("SELECT revision FROM notes", [], |row| row.get(0))
        .unwrap();
    assert_eq!(revision, 0);
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

#[cfg(unix)]
fn create_directory_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn create_directory_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(target, link)
}
