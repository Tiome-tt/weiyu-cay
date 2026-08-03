mod support;

use rusqlite::{params, Connection};
use simple_notes_lib::{
    domain::{FolderId, NoteDocument, NoteId, NoteKind},
    storage::{
        repository::NoteRepository,
        trash::{TrashFailurePoint, TrashService},
    },
};
use std::fs;
use support::{note_id, TestStore};
use uuid::Uuid;

const FORMAL_ID: &str = "019c0000-0000-7000-8000-000000000141";
const TEMPORARY_ID: &str = "019c0000-0000-7000-8000-000000000142";
const FOLDER_ID: &str = "019c0000-0000-7000-8000-000000000143";

fn folder_id(value: &str) -> FolderId {
    FolderId::parse_str(value).unwrap()
}

fn uuid_blob(value: &str) -> Vec<u8> {
    Uuid::parse_str(value).unwrap().as_bytes().to_vec()
}

fn seed_folder(store: &TestStore, id: &str, name: &str) {
    Connection::open(store.paths.database())
        .unwrap()
        .execute(
            "INSERT INTO folders (id, parent_id, name, sort_order, created_at, updated_at) \
             VALUES (?1, NULL, ?2, 0, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')",
            params![uuid_blob(id), name],
        )
        .unwrap();
}

fn create_document(
    store: &TestStore,
    id: NoteId,
    kind: NoteKind,
    folder_id: Option<FolderId>,
    title: &str,
) -> NoteDocument {
    NoteRepository::new(store.paths.clone())
        .create(NoteDocument {
            id,
            kind,
            title: title.to_owned(),
            folder_id,
            tags: vec!["recovery".to_owned()],
            markdown: format!("# {title}\n\nbody"),
            revision: 0,
            created_at: "2026-07-01T00:00:00Z".to_owned(),
            updated_at: "2026-07-01T00:00:00Z".to_owned(),
        })
        .unwrap()
}

#[test]
fn trash_manifest_restores_formal_note_assets_and_previous_folder() {
    let store = TestStore::new();
    let folder = folder_id(FOLDER_ID);
    seed_folder(&store, FOLDER_ID, "Project");
    let note = create_document(
        &store,
        note_id(FORMAL_ID),
        NoteKind::Formal,
        Some(folder),
        "Formal",
    );
    let assets = store.paths.assets_dir(note.id, note.kind).unwrap();
    fs::create_dir_all(&assets).unwrap();
    fs::write(assets.join("screen.png"), b"png bytes").unwrap();

    let service = TrashService::new(store.paths.clone());
    let deleted = service
        .trash(vec![note.id], "2026-07-02T00:00:00Z")
        .unwrap();
    assert_eq!(deleted.trashed, vec![note.id]);
    assert!(!store.paths.note_dir(note.id, note.kind).unwrap().exists());

    let entries = service.list().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].previous_folder_id, Some(folder));
    assert_eq!(
        entries[0].previous_relative_path,
        format!("notes/{}", note.id)
    );
    assert_eq!(entries[0].assets, vec!["assets/screen.png"]);

    let restored = service.restore(vec![note.id]).unwrap();
    assert_eq!(restored.restored[0].folder_id, Some(folder));
    assert_eq!(fs::read(assets.join("screen.png")).unwrap(), b"png bytes");
}

#[test]
fn restore_uses_one_stable_recovered_folder_when_previous_folder_is_missing() {
    let store = TestStore::new();
    let folder = folder_id(FOLDER_ID);
    seed_folder(&store, FOLDER_ID, "Removed");
    let first = create_document(
        &store,
        note_id(FORMAL_ID),
        NoteKind::Formal,
        Some(folder),
        "First",
    );
    let second = create_document(
        &store,
        note_id(TEMPORARY_ID),
        NoteKind::Formal,
        Some(folder),
        "Second",
    );
    let service = TrashService::new(store.paths.clone());
    service
        .trash(vec![first.id, second.id], "2026-07-02T00:00:00Z")
        .unwrap();
    let connection = Connection::open(store.paths.database()).unwrap();
    connection
        .execute(
            "UPDATE notes SET folder_id=NULL WHERE folder_id=?1",
            [uuid_blob(FOLDER_ID)],
        )
        .unwrap();
    connection
        .execute("DELETE FROM folders WHERE id=?1", [uuid_blob(FOLDER_ID)])
        .unwrap();

    let restored = service.restore(vec![first.id, second.id]).unwrap();
    let recovered = restored.restored[0].folder_id.unwrap();
    assert_eq!(restored.restored[1].folder_id, Some(recovered));
    let names: Vec<String> = connection
        .prepare("SELECT name FROM folders WHERE id=?1")
        .unwrap()
        .query_map([uuid_blob(&recovered.to_string())], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(names, vec!["已恢复"]);
}

#[test]
fn trash_and_immediate_undo_support_temporary_notes() {
    let store = TestStore::new();
    let note = create_document(
        &store,
        note_id(TEMPORARY_ID),
        NoteKind::Temporary,
        None,
        "Capture",
    );
    let service = TrashService::new(store.paths.clone());
    let deletion = service
        .trash(vec![note.id], "2026-07-02T00:00:00Z")
        .unwrap();

    let undone = service.undo(&deletion.operation_id).unwrap();
    assert_eq!(undone.restored[0].id, note.id);
    assert_eq!(undone.restored[0].kind, NoteKind::Temporary);
    assert!(service.list().unwrap().is_empty());
}

#[test]
fn purge_keeps_29_day_entries_and_removes_31_day_entries() {
    let store = TestStore::new();
    let young = create_document(&store, note_id(FORMAL_ID), NoteKind::Formal, None, "Young");
    let old = create_document(
        &store,
        note_id(TEMPORARY_ID),
        NoteKind::Temporary,
        None,
        "Old",
    );
    let service = TrashService::new(store.paths.clone());
    service
        .trash(vec![young.id], "2026-07-03T00:00:00Z")
        .unwrap();
    service.trash(vec![old.id], "2026-07-01T00:00:00Z").unwrap();

    let result = service.purge_expired("2026-08-01T00:00:00Z").unwrap();
    assert_eq!(result.purged, vec![old.id]);
    assert!(result.failed.is_empty());
    assert_eq!(service.list().unwrap()[0].note_id, young.id);
}

#[test]
fn purge_reports_one_failed_entry_and_continues_with_other_expired_entries() {
    let store = TestStore::new();
    let first = create_document(&store, note_id(FORMAL_ID), NoteKind::Formal, None, "First");
    let second = create_document(
        &store,
        note_id(TEMPORARY_ID),
        NoteKind::Temporary,
        None,
        "Second",
    );
    let service =
        TrashService::new_with_failure(store.paths.clone(), TrashFailurePoint::Purge(first.id));
    service
        .trash(vec![first.id, second.id], "2026-06-01T00:00:00Z")
        .unwrap();

    let result = service.purge_expired("2026-08-01T00:00:00Z").unwrap();
    assert_eq!(result.purged, vec![second.id]);
    assert_eq!(result.failed.len(), 1);
    assert_eq!(result.failed[0].note_id, first.id);
}

#[test]
fn recovery_rolls_back_a_crash_after_move_before_deleted_state_commits() {
    let store = TestStore::new();
    let note = create_document(&store, note_id(FORMAL_ID), NoteKind::Formal, None, "Crash");
    let crashing = TrashService::new_with_failure(
        store.paths.clone(),
        TrashFailurePoint::CrashAfterMove(note.id),
    );
    let result = crashing
        .trash(vec![note.id], "2026-07-02T00:00:00Z")
        .unwrap();
    assert_eq!(result.failed.len(), 1);

    TrashService::new(store.paths.clone())
        .recover_pending()
        .unwrap();
    assert_eq!(
        NoteRepository::new(store.paths.clone())
            .load(note.id)
            .unwrap(),
        note
    );
    assert!(TrashService::new(store.paths.clone())
        .list()
        .unwrap()
        .is_empty());
}

#[test]
fn recovery_finishes_a_delete_committed_before_its_final_state_publish() {
    let store = TestStore::new();
    let note = create_document(
        &store,
        note_id(FORMAL_ID),
        NoteKind::Formal,
        None,
        "Committed",
    );
    let crashing = TrashService::new_with_failure(
        store.paths.clone(),
        TrashFailurePoint::CrashAfterDatabase(note.id),
    );
    let result = crashing
        .trash(vec![note.id], "2026-07-02T00:00:00Z")
        .unwrap();
    assert_eq!(result.failed.len(), 1);

    let recovered = TrashService::new(store.paths.clone());
    recovered.recover_pending().unwrap();
    assert_eq!(recovered.list().unwrap()[0].note_id, note.id);
    assert!(!store
        .paths
        .note_dir(note.id, NoteKind::Formal)
        .unwrap()
        .is_dir());
}
