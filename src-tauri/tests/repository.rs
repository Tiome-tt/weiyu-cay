mod support;

use rusqlite::{params, Connection, ErrorCode};
use simple_notes_lib::{
    domain::{NoteId, NoteKind},
    error::CommandErrorCode,
    storage::{database::Database, paths::StoragePaths},
};
use std::{path::Path, time::Duration};
use support::TestStore;

const NOTE_ID: &str = "019c0000-0000-7000-8000-000000000002";
const FOLDER_ID: &[u8; 16] = b"0123456789abcdef";
const NOTE_UUID: &[u8; 16] = b"fedcba9876543210";
const OTHER_NOTE_UUID: &[u8; 16] = b"abcdef0123456789";

#[test]
fn index_mutation_lock_reports_busy_and_releases_with_handle_lifetime() {
    let root = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let first = simple_notes_lib::platform::IndexMutationLock::acquire(paths.root()).unwrap();
    let busy = simple_notes_lib::platform::IndexMutationLock::acquire_with_timeout(
        paths.root(),
        Duration::ZERO,
    )
    .unwrap_err();
    assert_eq!(busy.code(), CommandErrorCode::Conflict);
    drop(first);
    simple_notes_lib::platform::IndexMutationLock::acquire_with_timeout(
        paths.root(),
        Duration::ZERO,
    )
    .unwrap();
}

#[test]
fn storage_paths_create_the_expected_contained_layout() {
    let root = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let note_id = NoteId::parse_str(NOTE_ID).unwrap();

    for directory in [paths.notes(), paths.temporary(), paths.trash()] {
        assert!(directory.is_dir());
        assert!(directory.starts_with(paths.root()));
    }

    for path in [
        paths.note_dir(note_id, NoteKind::Formal).unwrap(),
        paths.note_dir(note_id, NoteKind::Temporary).unwrap(),
        paths.folders_manifest().to_path_buf(),
        paths.database().to_path_buf(),
    ] {
        assert!(path.starts_with(paths.root()));
    }

    assert_eq!(
        paths.note_dir(note_id, NoteKind::Formal).unwrap(),
        paths.root().join("notes").join(NOTE_ID)
    );
    assert_eq!(
        paths.assets_dir(note_id, NoteKind::Temporary).unwrap(),
        paths.root().join("temporary").join(NOTE_ID).join("assets")
    );
}

#[test]
fn child_paths_reject_traversal_separators_and_rooted_segments() {
    let root = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();

    for invalid in ["", ".", "..", "folder/file", "folder\\file", "/rooted"] {
        let error = paths.child(&[invalid]).unwrap_err();
        assert_eq!(error.code(), CommandErrorCode::Validation, "{invalid:?}");
        assert!(!error
            .message()
            .contains(root.path().to_string_lossy().as_ref()));
    }

    #[cfg(windows)]
    for invalid in [r"C:\rooted", r"\\server\share"] {
        assert_eq!(
            paths.child(&[invalid]).unwrap_err().code(),
            CommandErrorCode::Validation
        );
    }
}

#[test]
fn storage_open_rejects_an_existing_layout_directory_link_escape() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let notes = root.path().join("notes");

    create_directory_symlink(outside.path(), &notes).expect("directory-link test prerequisite");

    let error = StoragePaths::open(root.path()).unwrap_err();
    assert_eq!(error.code(), CommandErrorCode::Validation);
    assert!(!error
        .message()
        .contains(root.path().to_string_lossy().as_ref()));
    assert!(!error
        .message()
        .contains(outside.path().to_string_lossy().as_ref()));
}

#[test]
fn note_dir_rejects_an_existing_uuid_directory_link_escape() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let note_id = NoteId::parse_str(NOTE_ID).unwrap();
    let note_path = paths.notes().join(NOTE_ID);

    create_directory_symlink(outside.path(), &note_path).expect("directory-link test prerequisite");

    let error = paths.note_dir(note_id, NoteKind::Formal).unwrap_err();
    assert_eq!(error.code(), CommandErrorCode::Validation);
}

#[test]
fn migration_creates_only_the_required_initial_tables_and_is_idempotent() {
    let db = Database::memory().unwrap();
    db.migrate().unwrap();
    db.migrate().unwrap();

    let required_tables = [
        "notes",
        "folders",
        "tags",
        "note_tags",
        "note_links",
        "temporary_windows",
        "search_documents",
        "search_documents_fts",
        "search_index_state",
        "schema_migrations",
    ];
    for table in required_tables {
        assert!(db.table_exists(table).unwrap(), "missing table {table}");
    }
    assert_eq!(db.applied_migration_versions().unwrap(), vec![1, 2]);

    let store = TestStore::new();
    let connection = Connection::open(store.paths.database()).unwrap();
    let actual_tables = user_table_names(&connection);
    for table in required_tables {
        assert!(
            actual_tables.contains(&table.to_owned()),
            "missing table {table}"
        );
    }
}

#[test]
fn failed_migration_rolls_back_every_new_schema_object_and_version_record() {
    let root = tempfile::tempdir().unwrap();
    let database_path = root.path().join("index.sqlite");
    let connection = Connection::open(&database_path).unwrap();
    connection
        .execute(
            "CREATE TABLE search_documents (preexisting INTEGER NOT NULL)",
            [],
        )
        .unwrap();
    drop(connection);

    let db = Database::open(&database_path).unwrap();
    let error = db.migrate().unwrap_err();
    assert_eq!(error.code(), CommandErrorCode::Database);
    assert!(!error
        .message()
        .contains(root.path().to_string_lossy().as_ref()));
    drop(db);

    let connection = Connection::open(&database_path).unwrap();
    assert_eq!(user_table_names(&connection), vec!["search_documents"]);
}

#[test]
fn persistent_database_enables_required_pragmas() {
    let root = tempfile::tempdir().unwrap();
    let database_path = root.path().join("index.sqlite");
    let db = Database::open(&database_path).unwrap();

    assert!(db.foreign_keys_enabled().unwrap());
    assert_eq!(db.journal_mode().unwrap().to_ascii_lowercase(), "wal");
    assert!(db.busy_timeout_ms().unwrap() > 0);
    assert!(db.busy_timeout_ms().unwrap() <= 30_000);
}

#[test]
fn uuid_identity_columns_are_blobs_and_enforce_uniqueness() {
    let store = TestStore::new();
    assert!(store.root.path().exists());
    assert!(store.db.foreign_keys_enabled().unwrap());
    let connection = Connection::open(store.paths.database()).unwrap();
    connection.execute("PRAGMA foreign_keys = ON", []).unwrap();

    connection
        .execute(
            "INSERT INTO folders (id, parent_id, name, sort_order, created_at, updated_at)\
             VALUES (?1, NULL, 'Work', 0, '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z')",
            params![FOLDER_ID.as_slice()],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO notes (id, kind, title, folder_id, relative_path, created_at, updated_at, revision, deleted_at)\
             VALUES (?1, 'formal', 'First', ?2, 'notes/one', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z', 0, NULL)",
            params![NOTE_UUID.as_slice(), FOLDER_ID.as_slice()],
        )
        .unwrap();

    let stored_type: String = connection
        .query_row("SELECT typeof(id) FROM notes", [], |row| row.get(0))
        .unwrap();
    assert_eq!(stored_type, "blob");

    let duplicate = connection
        .execute(
            "INSERT INTO notes (id, kind, title, folder_id, relative_path, created_at, updated_at, revision, deleted_at)\
             VALUES (?1, 'formal', 'Duplicate', ?2, 'notes/two', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z', 0, NULL)",
            params![NOTE_UUID.as_slice(), FOLDER_ID.as_slice()],
        )
        .unwrap_err();
    assert_eq!(
        duplicate.sqlite_error_code(),
        Some(ErrorCode::ConstraintViolation)
    );
}

#[test]
fn relationships_have_explicit_restrict_or_cascade_behavior() {
    let store = TestStore::new();
    let connection = Connection::open(store.paths.database()).unwrap();
    connection.execute("PRAGMA foreign_keys = ON", []).unwrap();
    seed_two_notes_and_tag(&connection);

    let protected_folder = connection
        .execute(
            "DELETE FROM folders WHERE id = ?1",
            params![FOLDER_ID.as_slice()],
        )
        .unwrap_err();
    assert_eq!(
        protected_folder.sqlite_error_code(),
        Some(ErrorCode::ConstraintViolation)
    );

    connection
        .execute(
            "DELETE FROM notes WHERE id = ?1",
            params![NOTE_UUID.as_slice()],
        )
        .unwrap();
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM note_tags", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM note_links", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn note_links_accept_a_missing_target_and_keep_its_uuid() {
    let store = TestStore::new();
    let connection = Connection::open(store.paths.database()).unwrap();
    connection.execute("PRAGMA foreign_keys = ON", []).unwrap();
    insert_note(&connection, NOTE_UUID, "Source", "notes/source");

    connection
        .execute(
            "INSERT INTO note_links (source_note_id, target_note_id, visible_label, source_start, source_end)\
             VALUES (?1, ?2, 'Missing', 0, 9)",
            params![NOTE_UUID.as_slice(), OTHER_NOTE_UUID.as_slice()],
        )
        .unwrap();

    let stored_target: Vec<u8> = connection
        .query_row("SELECT target_note_id FROM note_links", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(stored_target, OTHER_NOTE_UUID);
}

#[test]
fn deleting_a_link_target_preserves_the_referring_row_and_target_uuid() {
    let store = TestStore::new();
    let connection = Connection::open(store.paths.database()).unwrap();
    connection.execute("PRAGMA foreign_keys = ON", []).unwrap();
    insert_note(&connection, NOTE_UUID, "Source", "notes/source");
    insert_note(&connection, OTHER_NOTE_UUID, "Target", "notes/target");
    connection
        .execute(
            "INSERT INTO note_links (source_note_id, target_note_id, visible_label, source_start, source_end)\
             VALUES (?1, ?2, 'Target', 0, 8)",
            params![NOTE_UUID.as_slice(), OTHER_NOTE_UUID.as_slice()],
        )
        .unwrap();

    connection
        .execute(
            "DELETE FROM notes WHERE id = ?1",
            params![OTHER_NOTE_UUID.as_slice()],
        )
        .unwrap();

    let (count, stored_target): (i64, Vec<u8>) = connection
        .query_row(
            "SELECT count(*), target_note_id FROM note_links",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(count, 1);
    assert_eq!(stored_target, OTHER_NOTE_UUID);
}

#[test]
fn every_uuid_column_rejects_sixteen_character_text_values() {
    let store = TestStore::new();
    let connection = Connection::open(store.paths.database()).unwrap();
    connection.execute("PRAGMA foreign_keys = OFF", []).unwrap();

    let invalid_inserts = [
        "INSERT INTO folders (id, name, sort_order, created_at, updated_at) VALUES ('1234567890abcdef', 'Bad id', 0, 'now', 'now')",
        "INSERT INTO folders (id, parent_id, name, sort_order, created_at, updated_at) VALUES (X'00000000000000000000000000000001', '1234567890abcdef', 'Bad parent', 0, 'now', 'now')",
        "INSERT INTO notes (id, kind, title, relative_path, created_at, updated_at, revision) VALUES ('1234567890abcdef', 'formal', 'Bad id', 'notes/bad-id', 'now', 'now', 0)",
        "INSERT INTO notes (id, kind, title, folder_id, relative_path, created_at, updated_at, revision) VALUES (X'00000000000000000000000000000002', 'formal', 'Bad folder', '1234567890abcdef', 'notes/bad-folder', 'now', 'now', 0)",
        "INSERT INTO tags (id, display_name, normalized_name) VALUES ('1234567890abcdef', 'Bad tag', 'bad-tag')",
        "INSERT INTO note_tags (note_id, tag_id) VALUES ('1234567890abcdef', X'00000000000000000000000000000003')",
        "INSERT INTO note_tags (note_id, tag_id) VALUES (X'00000000000000000000000000000004', '1234567890abcdef')",
        "INSERT INTO note_links (source_note_id, target_note_id, visible_label, source_start, source_end) VALUES ('1234567890abcdef', X'00000000000000000000000000000005', 'Bad source', 0, 1)",
        "INSERT INTO note_links (source_note_id, target_note_id, visible_label, source_start, source_end) VALUES (X'00000000000000000000000000000006', '1234567890abcdef', 'Bad target', 0, 1)",
        "INSERT INTO temporary_windows (note_id, visible, x, y, width, height, always_on_top) VALUES ('1234567890abcdef', 1, 0, 0, 300, 400, 1)",
        "INSERT INTO search_documents (note_id, title, plain_text) VALUES ('1234567890abcdef', 'Bad id', '')",
    ];

    for statement in invalid_inserts {
        let error = connection.execute(statement, []).unwrap_err();
        assert_eq!(
            error.sqlite_error_code(),
            Some(ErrorCode::ConstraintViolation),
            "statement unexpectedly accepted TEXT UUID: {statement}"
        );
    }
}

#[test]
fn schema_rejects_invalid_uuid_lengths_note_kinds_and_window_dimensions() {
    let store = TestStore::new();
    let connection = Connection::open(store.paths.database()).unwrap();
    connection.execute("PRAGMA foreign_keys = ON", []).unwrap();

    for (id, kind) in [
        (b"short".as_slice(), "formal"),
        (NOTE_UUID.as_slice(), "other"),
    ] {
        let error = connection
            .execute(
                "INSERT INTO notes (id, kind, title, relative_path, created_at, updated_at, revision)\
                 VALUES (?1, ?2, 'Invalid', 'notes/invalid', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z', 0)",
                params![id, kind],
            )
            .unwrap_err();
        assert_eq!(
            error.sqlite_error_code(),
            Some(ErrorCode::ConstraintViolation)
        );
    }

    connection
        .execute(
            "INSERT INTO notes (id, kind, title, relative_path, created_at, updated_at, revision)\
             VALUES (?1, 'temporary', 'Capture', 'temporary/capture', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z', 0)",
            params![NOTE_UUID.as_slice()],
        )
        .unwrap();
    let error = connection
        .execute(
            "INSERT INTO temporary_windows (note_id, visible, x, y, width, height, always_on_top)\
             VALUES (?1, 1, 0, 0, 0, 400, 1)",
            params![NOTE_UUID.as_slice()],
        )
        .unwrap_err();
    assert_eq!(
        error.sqlite_error_code(),
        Some(ErrorCode::ConstraintViolation)
    );
}

fn seed_two_notes_and_tag(connection: &Connection) {
    connection
        .execute(
            "INSERT INTO folders (id, parent_id, name, sort_order, created_at, updated_at)\
             VALUES (?1, NULL, 'Work', 0, '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z')",
            params![FOLDER_ID.as_slice()],
        )
        .unwrap();
    for (id, title, path) in [
        (NOTE_UUID.as_slice(), "First", "notes/first"),
        (OTHER_NOTE_UUID.as_slice(), "Second", "notes/second"),
    ] {
        connection
            .execute(
                "INSERT INTO notes (id, kind, title, folder_id, relative_path, created_at, updated_at, revision)\
                 VALUES (?1, 'formal', ?2, ?3, ?4, '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z', 0)",
                params![id, title, FOLDER_ID.as_slice(), path],
            )
            .unwrap();
    }
    connection
        .execute(
            "INSERT INTO tags (id, display_name, normalized_name) VALUES (?1, 'Rust', 'rust')",
            params![b"tag-uuid-16-byte".as_slice()],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO note_tags (note_id, tag_id) VALUES (?1, ?2)",
            params![NOTE_UUID.as_slice(), b"tag-uuid-16-byte".as_slice()],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO note_links (source_note_id, target_note_id, visible_label, source_start, source_end)\
             VALUES (?1, ?2, 'Second', 0, 8)",
            params![NOTE_UUID.as_slice(), OTHER_NOTE_UUID.as_slice()],
        )
        .unwrap();
}

fn insert_note(connection: &Connection, id: &[u8; 16], title: &str, path: &str) {
    connection
        .execute(
            "INSERT INTO notes (id, kind, title, relative_path, created_at, updated_at, revision)\
             VALUES (?1, 'formal', ?2, ?3, '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z', 0)",
            params![id.as_slice(), title, path],
        )
        .unwrap();
}

fn user_table_names(connection: &Connection) -> Vec<String> {
    let mut statement = connection
        .prepare(
            "SELECT name FROM sqlite_master \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .unwrap();
    statement
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

#[cfg(unix)]
fn create_directory_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn create_directory_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
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
