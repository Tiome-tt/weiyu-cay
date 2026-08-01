mod support;

use rusqlite::Connection;
use serde_json::json;
use simple_notes_lib::{
    domain::{FolderId, NoteDocument, NoteId, NoteKind},
    error::CommandError,
    storage::{
        atomic_file::{atomic_replace_contained, PublishResult},
        database::Database,
        rebuild::{rebuild_index, rebuild_index_with_hook},
        repository::NoteRepository,
    },
};
use std::{
    fs,
    path::Path,
    sync::{mpsc, Mutex, OnceLock},
    thread,
};
use support::TestStore;

const NOTE_ID: &str = "019c0000-0000-7000-8000-000000000211";
const BROKEN_ID: &str = "019c0000-0000-7000-8000-000000000212";
const TARGET_ID: &str = "019c0000-0000-7000-8000-000000000299";
const FOLDER_ID: &str = "019c0000-0000-7000-8000-000000000220";

type PauseHook = (mpsc::Sender<()>, mpsc::Receiver<()>);
static SAVE_PAUSE: OnceLock<Mutex<Option<PauseHook>>> = OnceLock::new();

fn pausing_writer(
    paths: &simple_notes_lib::storage::paths::StoragePaths,
    id: NoteId,
    kind: NoteKind,
    bytes: &[u8],
) -> PublishResult {
    let id_text = id.to_string();
    let result = atomic_replace_contained(
        paths.root(),
        &[
            if kind == NoteKind::Formal {
                "notes"
            } else {
                "temporary"
            },
            id_text.as_str(),
        ],
        "note.md",
        bytes,
    );
    if result.is_ok() {
        let hook = SAVE_PAUSE.get().unwrap().lock().unwrap().take().unwrap();
        hook.0.send(()).unwrap();
        hook.1.recv().unwrap();
    }
    result
}

#[test]
fn rebuild_serializes_a_save_after_its_scan_and_indexes_the_new_revision() {
    let mut store = TestStore::new();
    let repository = NoteRepository::new(
        store.paths.clone(),
        Database::open(store.paths.database()).unwrap(),
    );
    repository
        .create(NoteDocument {
            id: NoteId::parse_str(NOTE_ID).unwrap(),
            kind: NoteKind::Formal,
            title: "Concurrent".into(),
            folder_id: None,
            tags: vec![],
            markdown: "before rebuild".into(),
            revision: 0,
            created_at: "2026-07-30T00:00:00Z".into(),
            updated_at: "2026-07-30T00:00:00Z".into(),
        })
        .unwrap();
    drop(repository);
    store.close_database();

    let (scanned_tx, scanned_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let rebuild_paths = store.paths.clone();
    let rebuild = thread::spawn(move || {
        rebuild_index_with_hook(&rebuild_paths, |_| {
            scanned_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            Ok(())
        })
    });
    scanned_rx.recv().unwrap();

    let (saved_tx, saved_rx) = mpsc::channel();
    let save_paths = store.paths.clone();
    let save = thread::spawn(move || {
        let guard =
            simple_notes_lib::platform::IndexMutationLock::acquire(save_paths.root()).unwrap();
        let database = Database::open(save_paths.database()).unwrap();
        database.migrate().unwrap();
        let repository = NoteRepository::new(save_paths, database);
        let mut document = repository
            .load(NoteId::parse_str(NOTE_ID).unwrap())
            .unwrap();
        document.markdown = "after rebuild revision".into();
        let result = repository.save_locked(document, 0, &guard);
        saved_tx.send(()).unwrap();
        result
    });

    assert!(matches!(
        saved_rx.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    release_tx.send(()).unwrap();
    rebuild.join().unwrap().unwrap();
    saved_rx.recv().unwrap();
    save.join().unwrap().unwrap();
    let database = Connection::open(store.paths.database()).unwrap();
    assert_eq!(
        database
            .query_row(
                "SELECT plain_text FROM search_documents WHERE note_id = ?1",
                [uuid::Uuid::parse_str(NOTE_ID).unwrap().as_bytes().to_vec()],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "after rebuild revision",
    );
}

#[test]
fn failed_index_save_marker_survives_until_locked_rebuild_indexes_durable_content() {
    let mut store = TestStore::new();
    let repository = NoteRepository::new(
        store.paths.clone(),
        Database::open(store.paths.database()).unwrap(),
    );
    repository
        .create(NoteDocument {
            id: NoteId::parse_str(NOTE_ID).unwrap(),
            kind: NoteKind::Formal,
            title: "Marker race".into(),
            folder_id: None,
            tags: vec![],
            markdown: "old content".into(),
            revision: 0,
            created_at: "2026-07-30T00:00:00Z".into(),
            updated_at: "2026-07-30T00:00:00Z".into(),
        })
        .unwrap();
    drop(repository);
    let connection = Connection::open(store.paths.database()).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_search_race BEFORE INSERT ON search_documents BEGIN SELECT RAISE(ABORT, 'race failure'); END;").unwrap();
    drop(connection);
    store.close_database();

    let (durable_tx, durable_rx) = mpsc::channel();
    let (release_save_tx, release_save_rx) = mpsc::channel();
    *SAVE_PAUSE.get_or_init(|| Mutex::new(None)).lock().unwrap() =
        Some((durable_tx, release_save_rx));
    let save_paths = store.paths.clone();
    let save = thread::spawn(move || {
        let guard =
            simple_notes_lib::platform::IndexMutationLock::acquire(save_paths.root()).unwrap();
        let database = Database::open(save_paths.database()).unwrap();
        database.migrate().unwrap();
        let repository = NoteRepository::new_with_writer(save_paths, database, pausing_writer);
        let mut document = repository
            .load(NoteId::parse_str(NOTE_ID).unwrap())
            .unwrap();
        document.markdown = "durable marker race content".into();
        repository.save_locked(document, 0, &guard)
    });
    durable_rx.recv().unwrap();

    let (rebuilt_tx, rebuilt_rx) = mpsc::channel();
    let rebuild_paths = store.paths.clone();
    let rebuild = thread::spawn(move || {
        let result = rebuild_index(&rebuild_paths);
        rebuilt_tx.send(()).unwrap();
        result
    });
    assert!(matches!(
        rebuilt_rx.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    release_save_tx.send(()).unwrap();
    assert!(save.join().unwrap().is_err());
    assert!(store.paths.root().join("rebuild-needed.json").is_file());
    rebuilt_rx.recv().unwrap();
    rebuild.join().unwrap().unwrap();

    assert!(!store.paths.root().join("rebuild-needed.json").exists());
    let connection = Connection::open(store.paths.database()).unwrap();
    let plain: String = connection
        .query_row("SELECT plain_text FROM search_documents", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(plain, "durable marker race content");
}

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

#[test]
fn rebuild_replaces_a_database_with_missing_tables_and_keeps_a_recovery_copy() {
    let mut store = TestStore::new();
    let repository = NoteRepository::new(
        store.paths.clone(),
        Database::open(store.paths.database()).unwrap(),
    );
    persist_at_revision(&repository, note_without_folder());
    drop(repository);
    let damaged = Connection::open(store.paths.database()).unwrap();
    damaged.execute_batch("DROP TABLE note_tags;").unwrap();
    drop(damaged);
    store.close_database();

    let report = rebuild_index(&store.paths).unwrap();

    assert_eq!(report.notes_recovered, 1);
    assert!(rebuild_backups(&store).iter().any(|path| path.is_file()));
    let connection = Connection::open(store.paths.database()).unwrap();
    assert_eq!(query_count(&connection, "note_tags"), 2);
}

#[test]
fn rebuild_replaces_corrupt_database_bytes_and_keeps_a_recovery_copy() {
    let mut store = TestStore::new();
    let repository = NoteRepository::new(
        store.paths.clone(),
        Database::open(store.paths.database()).unwrap(),
    );
    persist_at_revision(&repository, note_without_folder());
    drop(repository);
    store.close_database();
    remove_sqlite_files(&store);
    fs::write(store.paths.database(), b"not a sqlite database").unwrap();

    let report = rebuild_index(&store.paths).unwrap();

    assert_eq!(report.notes_recovered, 1);
    assert!(rebuild_backups(&store)
        .iter()
        .any(|path| fs::read(path).unwrap() == b"not a sqlite database"));
    let connection = Connection::open(store.paths.database()).unwrap();
    assert_eq!(query_count(&connection, "notes"), 1);
}

#[cfg(windows)]
#[test]
fn rebuild_keeps_marker_when_the_old_database_cannot_be_replaced_then_recovers() {
    use std::os::windows::fs::OpenOptionsExt;
    let store = TestStore::new();
    let repository = NoteRepository::new(store.paths.clone(), store.db);
    persist_at_revision(&repository, note_without_folder());
    drop(repository);
    fs::write(store.paths.root().join("rebuild-needed.json"), b"{}").unwrap();
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(store.paths.database())
        .unwrap();

    assert!(rebuild_index(&store.paths).is_err());
    assert!(store.paths.root().join("rebuild-needed.json").is_file());
    drop(lock);
    assert_eq!(rebuild_index(&store.paths).unwrap().notes_recovered, 1);
    assert!(!store.paths.root().join("rebuild-needed.json").exists());
}

#[test]
fn revision_too_large_for_sqlite_isolated_while_valid_sibling_recovers() {
    let store = TestStore::new();
    let repository = NoteRepository::new(store.paths.clone(), store.db);
    persist_at_revision(&repository, note_without_folder());
    drop(repository);
    let oversized_id = "019c0000-0000-7000-8000-000000000213";
    let valid = fs::read_to_string(store.paths.notes().join(NOTE_ID).join("note.md")).unwrap();
    let oversized = valid
        .replace(NOTE_ID, oversized_id)
        .replace("revision: 4", &format!("revision: {}", u64::MAX));
    let oversized_dir = store.paths.notes().join(oversized_id);
    fs::create_dir(&oversized_dir).unwrap();
    fs::write(oversized_dir.join("note.md"), oversized).unwrap();

    let report = rebuild_index(&store.paths).unwrap();

    assert_eq!(report.notes_recovered, 1);
    assert_eq!(report.notes_failed, 1);
    assert!(report
        .failures
        .iter()
        .any(|failure| failure.item == oversized_id));
}

#[test]
#[cfg_attr(
    windows,
    ignore = "requires Windows Developer Mode file-symlink privilege; deterministic reparse rejection is covered by platform unit tests"
)]
fn rebuild_rejects_note_file_symlinks_without_reading_outside_content() {
    let store = TestStore::new();
    let repository = NoteRepository::new(store.paths.clone(), store.db);
    persist_at_revision(&repository, note_without_folder());
    drop(repository);
    let outside = tempfile::NamedTempFile::new().unwrap();
    fs::write(outside.path(), b"outside sentinel").unwrap();
    let note_path = store.paths.notes().join(NOTE_ID).join("note.md");
    fs::remove_file(&note_path).unwrap();
    create_file_symlink(outside.path(), &note_path).expect("file-symlink test prerequisite");

    let report = rebuild_index(&store.paths).unwrap();

    assert_eq!(report.notes_recovered, 0);
    assert_eq!(report.notes_failed, 1);
    assert_eq!(fs::read(outside.path()).unwrap(), b"outside sentinel");
}

#[test]
#[cfg_attr(
    windows,
    ignore = "requires Windows Developer Mode file-symlink privilege; deterministic reparse rejection is covered by platform unit tests"
)]
fn rebuild_rejects_a_folders_manifest_symlink() {
    let store = TestStore::new();
    let outside = tempfile::NamedTempFile::new().unwrap();
    fs::write(outside.path(), b"[]").unwrap();
    create_file_symlink(outside.path(), store.paths.folders_manifest())
        .expect("file-symlink test prerequisite");

    let error = rebuild_index(&store.paths).unwrap_err();

    assert_eq!(
        error.code(),
        simple_notes_lib::error::CommandErrorCode::Validation
    );
    assert_eq!(fs::read(outside.path()).unwrap(), b"[]");
}

#[test]
#[cfg_attr(
    windows,
    ignore = "requires Windows Developer Mode file-symlink privilege; deterministic reparse rejection is covered by platform unit tests"
)]
fn rebuild_rejects_a_live_database_symlink_without_reading_outside() {
    let mut store = TestStore::new();
    store.close_database();
    fs::remove_file(store.paths.database()).unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    fs::write(outside.path(), b"outside database sentinel").unwrap();
    create_file_symlink(outside.path(), store.paths.database())
        .expect("file-symlink test prerequisite");

    let error = rebuild_index(&store.paths).unwrap_err();

    assert_eq!(
        error.code(),
        simple_notes_lib::error::CommandErrorCode::Validation
    );
    assert_eq!(
        fs::read(outside.path()).unwrap(),
        b"outside database sentinel"
    );
}

#[test]
#[cfg_attr(
    windows,
    ignore = "requires Windows Developer Mode file-symlink privilege; deterministic reparse rejection is covered by platform unit tests"
)]
fn rebuild_rejects_a_sidecar_symlink_without_reading_outside() {
    let mut store = TestStore::new();
    store.close_database();
    let sidecar = store.paths.root().join("index.sqlite-wal");
    let outside = tempfile::NamedTempFile::new().unwrap();
    fs::write(outside.path(), b"outside sidecar sentinel").unwrap();
    create_file_symlink(outside.path(), &sidecar).expect("file-symlink test prerequisite");

    let error = rebuild_index(&store.paths).unwrap_err();

    assert_eq!(
        error.code(),
        simple_notes_lib::error::CommandErrorCode::Validation
    );
    assert_eq!(
        fs::read(outside.path()).unwrap(),
        b"outside sidecar sentinel"
    );
}

#[cfg(windows)]
#[test]
fn rebuild_rejects_a_live_database_junction_without_touching_outside() {
    let mut store = TestStore::new();
    store.close_database();
    fs::remove_file(store.paths.database()).unwrap();
    let outside = tempfile::tempdir().unwrap();
    create_directory_link(outside.path(), store.paths.database())
        .expect("junction fixture does not require Developer Mode");

    let error = rebuild_index(&store.paths).unwrap_err();

    assert_eq!(
        error.code(),
        simple_notes_lib::error::CommandErrorCode::Validation
    );
    assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
}

#[cfg(windows)]
#[test]
fn rebuild_rejects_a_sidecar_junction_without_touching_outside() {
    let mut store = TestStore::new();
    store.close_database();
    let outside = tempfile::tempdir().unwrap();
    create_directory_link(outside.path(), &store.paths.root().join("index.sqlite-wal"))
        .expect("junction fixture does not require Developer Mode");

    let error = rebuild_index(&store.paths).unwrap_err();

    assert_eq!(
        error.code(),
        simple_notes_lib::error::CommandErrorCode::Validation
    );
    assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
}

#[test]
fn rebuild_publication_root_exchange_never_writes_to_the_replacement_path() {
    let mut store = TestStore::new();
    store.close_database();
    let outside = tempfile::tempdir().unwrap();
    let original_root = store.paths.root().to_path_buf();
    let moved_root = original_root.with_file_name(format!(
        "{}.moved",
        original_root.file_name().unwrap().to_string_lossy()
    ));

    let result = rebuild_index_with_hook(&store.paths, |root| {
        if fs::rename(root, &moved_root).is_err() {
            return Ok(());
        }
        create_directory_link(outside.path(), root).map_err(|source| {
            CommandError::io(format!("could not install root exchange fixture: {source}"))
        })
    });

    assert!(result.is_ok());
    assert!(!outside.path().join("index.sqlite").exists());
    assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
}

fn rebuild_backups(store: &TestStore) -> Vec<std::path::PathBuf> {
    fs::read_dir(store.paths.root())
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .contains("rebuild-backup")
        })
        .collect()
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

#[cfg(unix)]
fn create_file_symlink(target: &std::path::Path, link: &std::path::Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(unix)]
fn create_directory_link(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn create_directory_link(target: &Path, link: &Path) -> std::io::Result<()> {
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other("mklink /J failed"))
    }
}

#[cfg(windows)]
fn create_file_symlink(target: &std::path::Path, link: &std::path::Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(target, link)
}
