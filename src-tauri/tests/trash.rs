mod support;

use rusqlite::{params, Connection};
use simple_notes_lib::{
    commands::folders::FolderRepository,
    domain::{FolderId, NoteDocument, NoteId, NoteKind},
    storage::{
        atomic_file::PublishState,
        repository::NoteRepository,
        trash::{run_startup_trash_maintenance, TrashFailurePoint, TrashService},
    },
};
use std::fs;
use support::{note_id, TestStore};
use uuid::Uuid;

const FORMAL_ID: &str = "019c0000-0000-7000-8000-000000000141";
const TEMPORARY_ID: &str = "019c0000-0000-7000-8000-000000000142";
const FOLDER_ID: &str = "019c0000-0000-7000-8000-000000000143";
const THIRD_ID: &str = "019c0000-0000-7000-8000-000000000144";
const RECOVERED_FOLDER_ID: &str = "019c0000-0000-7000-8000-00000000fffe";
const FOURTH_ID: &str = "019c0000-0000-7000-8000-000000000145";
const FIFTH_ID: &str = "019c0000-0000-7000-8000-000000000146";
const SIXTH_ID: &str = "019c0000-0000-7000-8000-000000000147";
const SEVENTH_ID: &str = "019c0000-0000-7000-8000-000000000148";

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
    FolderRepository::new(store.paths.clone())
        .delete_empty(folder)
        .unwrap();

    let restored = service.restore(vec![first.id, second.id]).unwrap();
    let recovered = restored.restored[0].folder_id.unwrap();
    assert_eq!(restored.restored[1].folder_id, Some(recovered));
    let names: Vec<String> = Connection::open(store.paths.database())
        .unwrap()
        .prepare("SELECT name FROM folders WHERE id=?1")
        .unwrap()
        .query_map([uuid_blob(&recovered.to_string())], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(names, vec!["已恢复"]);
}

#[test]
fn generic_trash_rejects_temporary_notes_without_moving_the_capture() {
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
    assert!(deletion.trashed.is_empty());
    assert_eq!(deletion.failed[0].note_id, note.id);
    assert_eq!(
        NoteRepository::new(store.paths.clone())
            .load(note.id)
            .unwrap(),
        note
    );
    assert!(service.list().unwrap().is_empty());
}

#[test]
fn purge_keeps_29_day_entries_and_removes_31_day_entries() {
    let store = TestStore::new();
    let young = create_document(&store, note_id(FORMAL_ID), NoteKind::Formal, None, "Young");
    let old = create_document(&store, note_id(TEMPORARY_ID), NoteKind::Formal, None, "Old");
    let boundary = create_document(
        &store,
        note_id(THIRD_ID),
        NoteKind::Formal,
        None,
        "Boundary",
    );
    let service = TrashService::new(store.paths.clone());
    service
        .trash(vec![young.id], "2026-07-03T00:00:00Z")
        .unwrap();
    service
        .trash(vec![boundary.id], "2026-07-02T00:00:00Z")
        .unwrap();
    service.trash(vec![old.id], "2026-07-01T00:00:00Z").unwrap();

    let result = service.purge_expired("2026-08-01T00:00:00Z").unwrap();
    assert_eq!(result.purged, vec![old.id]);
    assert!(result.failed.is_empty());
    let retained: Vec<_> = service
        .list()
        .unwrap()
        .into_iter()
        .map(|entry| entry.note_id)
        .collect();
    assert!(retained.contains(&young.id));
    assert!(retained.contains(&boundary.id));
}

#[test]
fn purge_reports_one_failed_entry_and_continues_with_other_expired_entries() {
    let store = TestStore::new();
    let first = create_document(&store, note_id(FORMAL_ID), NoteKind::Formal, None, "First");
    let second = create_document(
        &store,
        note_id(TEMPORARY_ID),
        NoteKind::Formal,
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
fn failed_delete_keeps_a_recovery_manifest_until_rollback_is_trusted() {
    for (index, rollback_state) in [
        PublishState::Published,
        PublishState::NotPublished,
        PublishState::PublishedButSyncFailed,
        PublishState::RecoveryRequired,
    ]
    .into_iter()
    .enumerate()
    {
        let store = TestStore::new();
        let id =
            NoteId::parse_str(&format!("019c0000-0000-7000-8000-{:012x}", 0x160 + index)).unwrap();
        let note = create_document(&store, id, NoteKind::Formal, None, "Rollback");
        let failing = TrashService::new_with_failure(
            store.paths.clone(),
            TrashFailurePoint::DeleteDatabaseThenRollback(note.id, rollback_state),
        );

        let result = failing
            .trash(vec![note.id], "2026-07-02T00:00:00Z")
            .unwrap();

        assert_eq!(result.failed[0].note_id, note.id);
        let manifest_count = fs::read_dir(store.paths.trash())
            .unwrap()
            .flat_map(|operation| fs::read_dir(operation.unwrap().path()).unwrap())
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".trash.json")
            })
            .count();
        assert_eq!(
            manifest_count,
            usize::from(rollback_state != PublishState::Published)
        );

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

#[test]
fn malformed_manifest_is_quarantined_without_blocking_a_valid_sibling() {
    let store = TestStore::new();
    let bad = create_document(&store, note_id(FORMAL_ID), NoteKind::Formal, None, "Bad");
    let good = create_document(
        &store,
        note_id(TEMPORARY_ID),
        NoteKind::Formal,
        None,
        "Good",
    );
    let identity = create_document(
        &store,
        note_id(FOURTH_ID),
        NoteKind::Formal,
        None,
        "Identity",
    );
    let version = create_document(&store, note_id(FIFTH_ID), NoteKind::Formal, None, "Version");
    let state = create_document(&store, note_id(SIXTH_ID), NoteKind::Formal, None, "State");
    let timestamp = create_document(
        &store,
        note_id(SEVENTH_ID),
        NoteKind::Formal,
        None,
        "Timestamp",
    );
    let service = TrashService::new(store.paths.clone());
    let deletion = service
        .trash(
            vec![
                bad.id,
                good.id,
                identity.id,
                version.id,
                state.id,
                timestamp.id,
            ],
            "2026-07-02T00:00:00Z",
        )
        .unwrap();
    let operation = store.paths.trash().join(&deletion.operation_id);
    fs::write(operation.join(format!("{}.trash.json", bad.id)), b"{broken").unwrap();
    mutate_manifest(&operation, identity.id, |manifest| {
        manifest["noteId"] = serde_json::json!(bad.id.to_string());
    });
    mutate_manifest(&operation, version.id, |manifest| {
        manifest["version"] = serde_json::json!(255);
    });
    mutate_manifest(&operation, state.id, |manifest| {
        manifest["state"] = serde_json::json!("unknown");
    });
    mutate_manifest(&operation, timestamp.id, |manifest| {
        manifest["deletedAt"] = serde_json::json!("not-a-timestamp");
    });

    service.recover_pending().unwrap();
    let listed = service.list().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].note_id, good.id);
    let quarantined = fs::read_dir(operation)
        .unwrap()
        .filter(|entry| {
            entry
                .as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("quarantined-")
        })
        .count();
    assert_eq!(quarantined, 5);
}

#[test]
fn quarantine_uses_a_bounded_name_for_a_maximum_length_bad_manifest() {
    let store = TestStore::new();
    let operation_id = Uuid::now_v7().hyphenated().to_string();
    let operation = store.paths.trash().join(operation_id);
    fs::create_dir(&operation).unwrap();
    let suffix = ".trash.json";
    let original_name = format!("{}{}", "x".repeat(255 - suffix.len()), suffix);
    fs::write(operation.join(&original_name), b"{broken").unwrap();

    let service = TrashService::new(store.paths.clone());
    service.recover_pending().unwrap();
    let first_quarantine: Vec<_> = fs::read_dir(&operation)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    service.recover_pending().unwrap();

    let entries: Vec<_> = fs::read_dir(&operation)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        !operation.join(&original_name).exists(),
        "remaining entries: {entries:?}"
    );
    let quarantined: Vec<_> = entries
        .into_iter()
        .filter(|name| name.starts_with("quarantined-"))
        .collect();
    assert_eq!(quarantined.len(), 1);
    assert!(quarantined[0].len() < 100);
    assert_eq!(quarantined, first_quarantine);
}

#[test]
fn one_abnormal_recovery_item_remains_retryable_without_blocking_a_valid_sibling() {
    let store = TestStore::new();
    let bad = create_document(&store, note_id(FORMAL_ID), NoteKind::Formal, None, "Bad");
    let good = create_document(
        &store,
        note_id(TEMPORARY_ID),
        NoteKind::Formal,
        None,
        "Good",
    );
    let bad_delete = TrashService::new_with_failure(
        store.paths.clone(),
        TrashFailurePoint::CrashAfterMove(bad.id),
    )
    .trash(vec![bad.id], "2026-07-02T00:00:00Z")
    .unwrap();
    let good_delete = TrashService::new_with_failure(
        store.paths.clone(),
        TrashFailurePoint::CrashAfterMove(good.id),
    )
    .trash(vec![good.id], "2026-07-02T00:00:00Z")
    .unwrap();

    let bad_trash = store
        .paths
        .trash()
        .join(&bad_delete.operation_id)
        .join(bad.id.to_string());
    let bad_active = store.paths.note_dir(bad.id, NoteKind::Formal).unwrap();
    copy_directory(&bad_trash, &bad_active);

    TrashService::new(store.paths.clone())
        .recover_pending()
        .unwrap();

    assert!(bad_trash.is_dir());
    assert!(bad_active.is_dir());
    assert!(store
        .paths
        .trash()
        .join(&bad_delete.operation_id)
        .join(format!("{}.trash.json", bad.id))
        .is_file());
    assert_eq!(
        NoteRepository::new(store.paths.clone())
            .load(good.id)
            .unwrap(),
        good
    );
    assert!(!store
        .paths
        .trash()
        .join(&good_delete.operation_id)
        .join(format!("{}.trash.json", good.id))
        .exists());
}

fn copy_directory(source: &std::path::Path, destination: &std::path::Path) {
    fs::create_dir_all(destination).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let target = destination.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_directory(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn mutate_manifest(
    operation: &std::path::Path,
    id: NoteId,
    mutation: impl FnOnce(&mut serde_json::Value),
) {
    let path = operation.join(format!("{id}.trash.json"));
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    mutation(&mut manifest);
    fs::write(path, serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
}

#[test]
fn restore_indexes_durable_markdown_instead_of_a_divergent_catalog_snapshot() {
    let store = TestStore::new();
    let note = create_document(
        &store,
        note_id(FORMAL_ID),
        NoteKind::Formal,
        None,
        "Durable",
    );
    let service = TrashService::new(store.paths.clone());
    let deletion = service
        .trash(vec![note.id], "2026-07-02T00:00:00Z")
        .unwrap();
    let manifest_path = store
        .paths
        .trash()
        .join(&deletion.operation_id)
        .join(format!("{}.trash.json", note.id));
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["original"]["markdown"] = serde_json::json!("catalog injection");
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();

    let restored = service.restore(vec![note.id]).unwrap();
    assert_eq!(restored.restored[0].markdown, note.markdown);
    assert_eq!(
        NoteRepository::new(store.paths.clone())
            .load(note.id)
            .unwrap()
            .markdown,
        note.markdown
    );
}

#[test]
fn restore_uses_durable_folder_instead_of_a_self_consistent_catalog_override() {
    let store = TestStore::new();
    let trusted = folder_id(FOLDER_ID);
    let attacker = folder_id(THIRD_ID);
    seed_folder(&store, FOLDER_ID, "Trusted");
    seed_folder(&store, THIRD_ID, "Attacker");
    let note = create_document(
        &store,
        note_id(FORMAL_ID),
        NoteKind::Formal,
        Some(trusted),
        "Durable folder",
    );
    let service = TrashService::new(store.paths.clone());
    let deletion = service
        .trash(vec![note.id], "2026-07-02T00:00:00Z")
        .unwrap();
    let operation = store.paths.trash().join(&deletion.operation_id);
    mutate_manifest(&operation, note.id, |manifest| {
        manifest["previousFolderId"] = serde_json::json!(attacker.to_string());
        manifest["original"]["folderId"] = serde_json::json!(attacker.to_string());
    });

    let restored = service.restore(vec![note.id]).unwrap();

    assert!(restored.failed.is_empty());
    assert_eq!(restored.restored[0].folder_id, Some(trusted));
}

#[test]
fn prepared_recovery_reindexes_active_durable_content_not_catalog_fields() {
    let store = TestStore::new();
    let trusted = folder_id(FOLDER_ID);
    let attacker = folder_id(THIRD_ID);
    seed_folder(&store, FOLDER_ID, "Trusted");
    seed_folder(&store, THIRD_ID, "Attacker");
    let note = create_document(
        &store,
        note_id(FORMAL_ID),
        NoteKind::Formal,
        Some(trusted),
        "Durable title",
    );
    let deletion = TrashService::new_with_failure(
        store.paths.clone(),
        TrashFailurePoint::CrashAfterDatabase(note.id),
    )
    .trash(vec![note.id], "2026-07-02T00:00:00Z")
    .unwrap();
    let operation = store.paths.trash().join(&deletion.operation_id);
    fs::rename(
        operation.join(note.id.to_string()),
        store.paths.note_dir(note.id, NoteKind::Formal).unwrap(),
    )
    .unwrap();
    mutate_manifest(&operation, note.id, |manifest| {
        manifest["title"] = serde_json::json!("Injected title");
        manifest["previousFolderId"] = serde_json::json!(attacker.to_string());
        manifest["original"]["title"] = serde_json::json!("Injected title");
        manifest["original"]["folderId"] = serde_json::json!(attacker.to_string());
        manifest["original"]["markdown"] = serde_json::json!("injected catalog body");
    });

    TrashService::new(store.paths.clone())
        .recover_pending()
        .unwrap();

    let database = Connection::open(store.paths.database()).unwrap();
    let (title, folder, plain_text): (String, Vec<u8>, String) = database
        .query_row(
            "SELECT notes.title, notes.folder_id, search_documents.plain_text \
             FROM notes JOIN search_documents ON search_documents.note_id=notes.id \
             WHERE notes.id=?1",
            [uuid_blob(FORMAL_ID)],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(title, note.title);
    assert_eq!(folder, uuid_blob(FOLDER_ID));
    assert_eq!(plain_text, "Durable title body");
    assert!(!operation.join(format!("{}.trash.json", note.id)).exists());
}

#[test]
fn recovery_finishes_missing_folder_restore_after_move_before_document_rewrite() {
    let store = TestStore::new();
    let folder = folder_id(FOLDER_ID);
    seed_folder(&store, FOLDER_ID, "Removed");
    let note = create_document(
        &store,
        note_id(FORMAL_ID),
        NoteKind::Formal,
        Some(folder),
        "Crash restore",
    );
    let service = TrashService::new(store.paths.clone());
    service
        .trash(vec![note.id], "2026-07-02T00:00:00Z")
        .unwrap();
    FolderRepository::new(store.paths.clone())
        .delete_empty(folder)
        .unwrap();

    let crashing = TrashService::new_with_failure(
        store.paths.clone(),
        TrashFailurePoint::CrashRestoreAfterMove(note.id),
    );
    assert_eq!(crashing.restore(vec![note.id]).unwrap().failed.len(), 1);

    let recovered = TrashService::new(store.paths.clone());
    recovered.recover_pending().unwrap();
    let restored = NoteRepository::new(store.paths.clone())
        .load(note.id)
        .unwrap();
    assert_ne!(restored.folder_id, Some(folder));
    assert!(restored.folder_id.is_some());
    assert!(recovered.list().unwrap().is_empty());
}

#[test]
fn recovery_finishes_missing_folder_restore_after_frontmatter_before_database() {
    let store = TestStore::new();
    let folder = folder_id(FOLDER_ID);
    seed_folder(&store, FOLDER_ID, "Removed");
    let note = create_document(
        &store,
        note_id(FORMAL_ID),
        NoteKind::Formal,
        Some(folder),
        "Crash database",
    );
    let service = TrashService::new(store.paths.clone());
    service
        .trash(vec![note.id], "2026-07-02T00:00:00Z")
        .unwrap();
    FolderRepository::new(store.paths.clone())
        .delete_empty(folder)
        .unwrap();

    let crashing = TrashService::new_with_failure(
        store.paths.clone(),
        TrashFailurePoint::CrashRestoreAfterDocument(note.id),
    );
    assert_eq!(crashing.restore(vec![note.id]).unwrap().failed.len(), 1);

    let recovered = TrashService::new(store.paths.clone());
    recovered.recover_pending().unwrap();
    let restored = NoteRepository::new(store.paths.clone())
        .load(note.id)
        .unwrap();
    assert_eq!(restored.folder_id.unwrap().to_string(), RECOVERED_FOLDER_ID);
    assert!(recovered.list().unwrap().is_empty());
}

#[test]
fn purge_rejects_a_link_added_inside_trashed_content_without_touching_its_target() {
    let store = TestStore::new();
    let note = create_document(&store, note_id(FORMAL_ID), NoteKind::Formal, None, "Linked");
    let service = TrashService::new(store.paths.clone());
    let deletion = service
        .trash(vec![note.id], "2026-06-01T00:00:00Z")
        .unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("sentinel"), b"keep").unwrap();
    let link = store
        .paths
        .trash()
        .join(&deletion.operation_id)
        .join(note.id.to_string())
        .join("escape");
    create_directory_link(outside.path(), &link).unwrap();

    let purged = service.purge_expired("2026-08-01T00:00:00Z").unwrap();
    assert!(purged.purged.is_empty());
    assert_eq!(purged.failed[0].note_id, note.id);
    assert_eq!(fs::read(outside.path().join("sentinel")).unwrap(), b"keep");
}

#[test]
fn startup_cleanup_purges_valid_expired_siblings_and_never_fails_for_one_unsafe_entry() {
    let store = TestStore::new();
    let bad = create_document(&store, note_id(FORMAL_ID), NoteKind::Formal, None, "Bad");
    let good = create_document(
        &store,
        note_id(TEMPORARY_ID),
        NoteKind::Formal,
        None,
        "Good",
    );
    let service = TrashService::new(store.paths.clone());
    let deletion = service
        .trash(vec![bad.id, good.id], "2026-06-01T00:00:00Z")
        .unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("sentinel"), b"keep").unwrap();
    let link = store
        .paths
        .trash()
        .join(&deletion.operation_id)
        .join(bad.id.to_string())
        .join("escape");
    create_directory_link(outside.path(), &link).unwrap();

    run_startup_trash_maintenance(store.paths.clone(), "2026-08-01T00:00:00Z").unwrap();

    assert_eq!(fs::read(outside.path().join("sentinel")).unwrap(), b"keep");
    assert!(!store
        .paths
        .trash()
        .join(&deletion.operation_id)
        .join(good.id.to_string())
        .exists());
}

#[test]
fn recovered_system_folder_uses_stable_identity_when_display_name_is_taken() {
    let store = TestStore::new();
    let original = folder_id(FOLDER_ID);
    seed_folder(&store, FOLDER_ID, "Original");
    seed_folder(&store, THIRD_ID, "已恢复");
    let note = create_document(
        &store,
        note_id(FORMAL_ID),
        NoteKind::Formal,
        Some(original),
        "Restore",
    );
    let service = TrashService::new(store.paths.clone());
    service
        .trash(vec![note.id], "2026-07-02T00:00:00Z")
        .unwrap();
    FolderRepository::new(store.paths.clone())
        .delete_empty(original)
        .unwrap();

    let restored = service.restore(vec![note.id]).unwrap();
    assert_eq!(
        restored.restored[0].folder_id.unwrap().to_string(),
        RECOVERED_FOLDER_ID
    );
}

#[test]
fn recovered_system_folder_reuses_its_stable_identity_after_user_rename() {
    let store = TestStore::new();
    let original = folder_id(FOLDER_ID);
    seed_folder(&store, FOLDER_ID, "Original");
    seed_folder(&store, RECOVERED_FOLDER_ID, "我的恢复笔记");
    let note = create_document(
        &store,
        note_id(FORMAL_ID),
        NoteKind::Formal,
        Some(original),
        "Restore",
    );
    let service = TrashService::new(store.paths.clone());
    service
        .trash(vec![note.id], "2026-07-02T00:00:00Z")
        .unwrap();
    FolderRepository::new(store.paths.clone())
        .delete_empty(original)
        .unwrap();

    let restored = service.restore(vec![note.id]).unwrap();
    assert_eq!(
        restored.restored[0].folder_id.unwrap().to_string(),
        RECOVERED_FOLDER_ID
    );
}

#[cfg(windows)]
fn create_directory_link(target: &std::path::Path, link: &std::path::Path) -> std::io::Result<()> {
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

#[cfg(unix)]
fn create_directory_link(target: &std::path::Path, link: &std::path::Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}
