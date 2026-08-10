mod support;

use rusqlite::Connection;
use simple_notes_lib::{
    commands::folders::FolderRepository,
    domain::{ConvertTemporaryInput, CreateFolderInput, NoteKind, TemporaryWindowState},
    error::CommandErrorCode,
    storage::{
        atomic_file::{PublishFailure, PublishResult},
        rebuild::rebuild_index,
        repository::NoteRepository,
        temporary_ops::{derive_temporary_title, TemporaryFailurePoint, TemporaryInboxService},
        trash::{TrashFailurePoint, TrashService},
    },
    windows::sticky::{
        authorize_asset_caller, authorize_temporary_caller, clamp_to_available_monitors,
        close_event_target, physical_bounds_for_restore, reduce_shutdown_lifecycle,
        AppLifecycleEvent, InMemoryTemporaryWindowBackend, MonitorGeometry, PhysicalWindowBounds,
        TemporaryCommandOperation, TemporaryRepository, TemporaryWindowService,
        DEFAULT_WINDOW_STATE,
    },
};
use std::fs;
use support::TestStore;

#[test]
fn derives_conversion_titles_with_explicit_unicode_scalar_rules() {
    let timestamp = "2026-08-02T12:34:56+08:00";
    assert_eq!(
        derive_temporary_title("\n  ###  发布检查  \nbody", timestamp).unwrap(),
        "发布检查"
    );
    assert_eq!(
        derive_temporary_title("#urgent keep", timestamp).unwrap(),
        "#urgent keep"
    );
    assert_eq!(
        derive_temporary_title("\u{3000}\t\n", timestamp).unwrap(),
        "未命名笔记 2026-08-02 12-34"
    );
    assert_eq!(
        derive_temporary_title("  中 文\t😀  ", timestamp).unwrap(),
        "中 文 😀"
    );
    let long = format!("{}尾", "界".repeat(80));
    assert_eq!(
        derive_temporary_title(&long, timestamp).unwrap(),
        "界".repeat(80)
    );
}

#[test]
fn batch_conversion_preserves_uuid_body_assets_and_reports_partial_results() {
    let store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let folder = FolderRepository::new(store.paths.clone())
        .create(CreateFolderInput {
            parent_id: None,
            name: "项目 B".into(),
        })
        .unwrap();
    let mut first = temporary.create().unwrap();
    first.markdown = "# 发布检查\n\n[[目标|019c0000-0000-7000-8000-000000000099]]".into();
    first.tags = vec!["urgent".into()];
    let first = temporary.save(first, 0).unwrap();
    let first_assets = store
        .paths
        .assets_dir(first.id, NoteKind::Temporary)
        .unwrap();
    fs::create_dir(&first_assets).unwrap();
    fs::write(first_assets.join("shot.png"), b"asset").unwrap();
    let missing = support::note_id("019c0000-0000-7000-8000-000000000077");

    let result = TemporaryInboxService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    )
    .convert(
        ConvertTemporaryInput {
            ids: vec![first.id, missing, first.id],
            folder_id: folder.id,
        },
        "2026-08-02T12:34:56+08:00",
    );

    assert_eq!(result.converted.len(), 1);
    assert_eq!(result.converted[0].temporary_id, first.id);
    assert_eq!(result.converted[0].note_id, first.id);
    assert_eq!(result.failed.len(), 1);
    assert_eq!(result.failed[0].temporary_id, missing);
    let formal = NoteRepository::new(store.paths.clone())
        .load(first.id)
        .unwrap();
    assert_eq!(formal.kind, NoteKind::Formal);
    assert_eq!(formal.folder_id, Some(folder.id));
    assert_eq!(formal.title, "发布检查");
    assert_eq!(formal.markdown, first.markdown);
    assert_eq!(formal.tags, vec!["urgent"]);
    assert!(store
        .paths
        .assets_dir(first.id, NoteKind::Formal)
        .unwrap()
        .join("shot.png")
        .is_file());
    assert!(!store
        .paths
        .note_dir(first.id, NoteKind::Temporary)
        .unwrap()
        .exists());
}

#[test]
fn recoverable_delete_moves_whole_capture_and_undo_is_idempotent() {
    let store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let capture = temporary.create().unwrap();
    let capture_assets = store
        .paths
        .assets_dir(capture.id, NoteKind::Temporary)
        .unwrap();
    fs::create_dir(&capture_assets).unwrap();
    fs::write(capture_assets.join("shot.png"), b"asset").unwrap();
    let backend = InMemoryTemporaryWindowBackend::default();
    let service = TemporaryInboxService::new(store.paths.clone(), backend);

    let deleted = service.delete(vec![capture.id, capture.id]);
    assert_eq!(deleted.deleted, vec![capture.id]);
    assert!(deleted.failed.is_empty());
    assert!(!store
        .paths
        .note_dir(capture.id, NoteKind::Temporary)
        .unwrap()
        .exists());
    let operation = store.paths.trash().join(&deleted.operation_id);
    assert!(operation.join("descriptor.json").is_file());
    assert!(operation
        .join(capture.id.to_string())
        .join("assets/shot.png")
        .is_file());
    let catalog = TrashService::new(store.paths.clone()).list().unwrap();
    assert_eq!(catalog.len(), 1);
    assert_eq!(catalog[0].note_id, capture.id);
    assert_eq!(catalog[0].assets, vec!["assets/shot.png"]);

    let restored = service.undo_delete(&deleted.operation_id).unwrap();
    assert_eq!(restored.restored, vec![capture.id]);
    assert!(restored.failed.is_empty());
    assert!(store
        .paths
        .note_dir(capture.id, NoteKind::Temporary)
        .unwrap()
        .exists());
    assert!(TrashService::new(store.paths.clone())
        .list()
        .unwrap()
        .is_empty());
    let again = service.undo_delete(&deleted.operation_id).unwrap();
    assert_eq!(again.restored, vec![capture.id]);
    assert!(again.failed.is_empty());
}

#[test]
fn purging_a_temporary_capture_removes_its_task13_delete_descriptor_item() {
    let store = TestStore::new();
    let capture = TemporaryRepository::new(store.paths.clone())
        .create()
        .unwrap();
    let backend = InMemoryTemporaryWindowBackend::default();
    let inbox = TemporaryInboxService::new(store.paths.clone(), backend.clone());
    let deletion = inbox.delete(vec![capture.id]);
    assert_eq!(deletion.deleted, vec![capture.id]);
    let operation = store.paths.trash().join(&deletion.operation_id);
    let manifest_path = operation.join(format!("{}.trash.json", capture.id));
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["deletedAt"] = serde_json::json!("2026-06-01T00:00:00Z");
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();

    let purged = TrashService::new(store.paths.clone())
        .purge_expired("2026-08-01T00:00:00Z")
        .unwrap();
    assert_eq!(purged.purged, vec![capture.id]);
    assert!(!operation.join("descriptor.json").exists());
    TemporaryInboxService::new(store.paths.clone(), backend)
        .recover_pending()
        .unwrap();
}

#[test]
fn purge_recovery_finalizes_task13_descriptor_after_content_was_removed() {
    let store = TestStore::new();
    let capture = TemporaryRepository::new(store.paths.clone())
        .create()
        .unwrap();
    let backend = InMemoryTemporaryWindowBackend::default();
    let inbox = TemporaryInboxService::new(store.paths.clone(), backend.clone());
    let deletion = inbox.delete(vec![capture.id]);
    let operation = store.paths.trash().join(&deletion.operation_id);
    let manifest_path = operation.join(format!("{}.trash.json", capture.id));
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["deletedAt"] = serde_json::json!("2026-06-01T00:00:00Z");
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();

    let crashing = TrashService::new_with_failure(
        store.paths.clone(),
        TrashFailurePoint::CrashPurgeAfterRemove(capture.id),
    );
    let failed = crashing.purge_expired("2026-08-01T00:00:00Z").unwrap();
    assert_eq!(failed.failed[0].note_id, capture.id);
    assert!(!operation.join(capture.id.to_string()).exists());
    assert!(operation.join("descriptor.json").is_file());

    TrashService::new(store.paths.clone())
        .recover_pending()
        .unwrap();

    assert!(!operation.join("descriptor.json").exists());
    assert!(!manifest_path.exists());
    TemporaryInboxService::new(store.paths.clone(), backend)
        .recover_pending()
        .unwrap();
}

#[test]
fn restoring_from_application_trash_consumes_the_task13_descriptor() {
    let store = TestStore::new();
    let capture = TemporaryRepository::new(store.paths.clone())
        .create()
        .unwrap();
    let backend = InMemoryTemporaryWindowBackend::default();
    let inbox = TemporaryInboxService::new(store.paths.clone(), backend);
    let deletion = inbox.delete(vec![capture.id]);
    let operation = store.paths.trash().join(&deletion.operation_id);

    let restored = TrashService::new(store.paths.clone())
        .restore(vec![capture.id])
        .unwrap();

    assert_eq!(restored.restored[0].id, capture.id);
    assert!(!operation.join("descriptor.json").exists());
    assert_eq!(
        TemporaryRepository::new(store.paths.clone())
            .load(capture.id)
            .unwrap()
            .id,
        capture.id
    );
}

#[test]
fn conversion_db_failure_rolls_back_and_stale_save_after_success_cannot_recreate_temporary() {
    let store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let folder = FolderRepository::new(store.paths.clone())
        .create(CreateFolderInput {
            parent_id: None,
            name: "目标".into(),
        })
        .unwrap();
    let mut capture = temporary.create().unwrap();
    capture.markdown = "durable body".into();
    let capture = temporary.save(capture, 0).unwrap();
    let backend = InMemoryTemporaryWindowBackend::default();
    TemporaryWindowService::new(store.paths.clone(), backend.clone())
        .show(capture.id)
        .unwrap();
    assert_eq!(
        backend.created_labels(),
        vec![format!("temporary-{}", capture.id)]
    );
    let failed = TemporaryInboxService::new_with_failure(
        store.paths.clone(),
        backend.clone(),
        TemporaryFailurePoint::BeforeDatabase,
    )
    .convert(
        ConvertTemporaryInput {
            ids: vec![capture.id],
            folder_id: folder.id,
        },
        "2026-08-02T12:34:56+08:00",
    );
    assert!(failed.converted.is_empty());
    assert_eq!(failed.failed.len(), 1);
    assert_eq!(temporary.load(capture.id).unwrap().markdown, "durable body");
    assert!(backend.retired_labels().is_empty());

    let converted = TemporaryInboxService::new(store.paths.clone(), backend.clone()).convert(
        ConvertTemporaryInput {
            ids: vec![capture.id],
            folder_id: folder.id,
        },
        "2026-08-02T12:34:56+08:00",
    );
    assert_eq!(converted.converted.len(), 1);
    assert_eq!(
        backend.retired_labels(),
        vec![format!("temporary-{}", capture.id)]
    );
    let capture_id = capture.id;
    assert!(temporary.save(capture, 1).is_err());
    assert!(!backend
        .created_labels()
        .iter()
        .any(|label| label == &format!("temporary-{capture_id}")));
    assert!(!store
        .paths
        .note_dir(converted.converted[0].note_id, NoteKind::Temporary)
        .unwrap()
        .exists());
}

#[test]
fn restart_recovery_rolls_back_a_crash_before_commit_intent_without_losing_content() {
    let store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let folder = FolderRepository::new(store.paths.clone())
        .create(CreateFolderInput {
            parent_id: None,
            name: "恢复".into(),
        })
        .unwrap();
    let mut capture = temporary.create().unwrap();
    capture.markdown = "recover me".into();
    let capture = temporary.save(capture, 0).unwrap();
    let crashed = TemporaryInboxService::new_with_failure(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
        TemporaryFailurePoint::CrashAfterMove,
    )
    .convert(
        ConvertTemporaryInput {
            ids: vec![capture.id],
            folder_id: folder.id,
        },
        "2026-08-02T12:34:56+08:00",
    );
    assert!(crashed.converted.is_empty());
    assert!(!store
        .paths
        .note_dir(capture.id, NoteKind::Temporary)
        .unwrap()
        .exists());
    assert!(store
        .paths
        .note_dir(capture.id, NoteKind::Formal)
        .unwrap()
        .exists());

    TemporaryInboxService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    )
    .recover_pending()
    .unwrap();
    let recovered = NoteRepository::new(store.paths.clone())
        .load(capture.id)
        .unwrap();
    assert_eq!(recovered.kind, NoteKind::Temporary);
    assert_eq!(recovered.markdown, "recover me");
    assert_eq!(recovered.folder_id, None);
}

#[test]
fn journal_failure_never_moves_content_and_rollback_failure_is_restart_recoverable() {
    let store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let folder = FolderRepository::new(store.paths.clone())
        .create(CreateFolderInput {
            parent_id: None,
            name: "故障恢复".into(),
        })
        .unwrap();
    let first = temporary.create().unwrap();
    let before_journal = TemporaryInboxService::new_with_failure(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
        TemporaryFailurePoint::BeforeJournal,
    )
    .convert(
        ConvertTemporaryInput {
            ids: vec![first.id],
            folder_id: folder.id,
        },
        "2026-08-02T12:34:56+08:00",
    );
    assert_eq!(before_journal.failed.len(), 1);
    assert!(temporary.load(first.id).is_ok());
    assert!(!store
        .paths
        .note_dir(first.id, NoteKind::Formal)
        .unwrap()
        .exists());

    let second = temporary.create().unwrap();
    let rollback_failed = TemporaryInboxService::new_with_failures(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
        [
            TemporaryFailurePoint::AfterMove,
            TemporaryFailurePoint::BeforeRollback,
        ],
    )
    .convert(
        ConvertTemporaryInput {
            ids: vec![second.id],
            folder_id: folder.id,
        },
        "2026-08-02T12:34:56+08:00",
    );
    assert_eq!(rollback_failed.failed.len(), 1);
    assert!(!store
        .paths
        .note_dir(second.id, NoteKind::Temporary)
        .unwrap()
        .exists());
    assert!(store
        .paths
        .note_dir(second.id, NoteKind::Formal)
        .unwrap()
        .exists());
    TemporaryInboxService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    )
    .recover_pending()
    .unwrap();
    assert_eq!(
        NoteRepository::new(store.paths.clone())
            .load(second.id)
            .unwrap()
            .kind,
        NoteKind::Temporary
    );
}

#[test]
fn destination_collision_and_partial_delete_never_overwrite_or_retire_failures() {
    let store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let folder = FolderRepository::new(store.paths.clone())
        .create(CreateFolderInput {
            parent_id: None,
            name: "安全".into(),
        })
        .unwrap();
    let capture = temporary.create().unwrap();
    fs::create_dir(store.paths.note_dir(capture.id, NoteKind::Formal).unwrap()).unwrap();
    let backend = InMemoryTemporaryWindowBackend::default();
    let conversion = TemporaryInboxService::new(store.paths.clone(), backend.clone()).convert(
        ConvertTemporaryInput {
            ids: vec![capture.id],
            folder_id: folder.id,
        },
        "2026-08-02T12:34:56+08:00",
    );
    assert_eq!(conversion.failed.len(), 1);
    assert!(temporary.load(capture.id).is_ok());
    assert!(backend.retired_labels().is_empty());

    fs::remove_dir(store.paths.note_dir(capture.id, NoteKind::Formal).unwrap()).unwrap();
    let missing = support::note_id("019c0000-0000-7000-8000-000000000078");
    let deletion = TemporaryInboxService::new(store.paths.clone(), backend.clone())
        .delete(vec![capture.id, missing]);
    assert_eq!(deletion.deleted, vec![capture.id]);
    assert_eq!(deletion.failed.len(), 1);
    assert_eq!(deletion.failed[0].temporary_id, missing);
    assert_eq!(
        backend.retired_labels(),
        vec![format!("temporary-{}", capture.id)]
    );
}

#[test]
fn partial_delete_descriptor_does_not_poison_restart_recovery() {
    let store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let capture = temporary.create().unwrap();
    let missing = support::note_id("019c0000-0000-7000-8000-000000000179");

    let deletion = TemporaryInboxService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    )
    .delete(vec![capture.id, missing]);

    assert_eq!(deletion.deleted, vec![capture.id]);
    assert_eq!(deletion.failed.len(), 1);
    let restarted = TemporaryInboxService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    );
    restarted.recover_pending().unwrap();
    assert!(temporary.list().unwrap().is_empty());
    let undo = restarted.undo_delete(&deletion.operation_id).unwrap();
    assert_eq!(undo.restored, vec![capture.id]);
    assert_eq!(
        temporary.load(capture.id).unwrap().kind,
        NoteKind::Temporary
    );
}

#[test]
fn conversion_recovery_finishes_every_durable_rollback_boundary() {
    for crash_point in [
        TemporaryFailurePoint::CrashAfterRollbackIntent,
        TemporaryFailurePoint::CrashAfterRollbackMove,
        TemporaryFailurePoint::CrashAfterRollbackDocument,
    ] {
        let store = TestStore::new();
        let temporary = TemporaryRepository::new(store.paths.clone());
        let folder = FolderRepository::new(store.paths.clone())
            .create(CreateFolderInput {
                parent_id: None,
                name: format!("rollback-{crash_point:?}"),
            })
            .unwrap();
        let mut capture = temporary.create().unwrap();
        capture.markdown = "original rollback body".into();
        let capture = temporary.save(capture, 0).unwrap();

        let failed = TemporaryInboxService::new_with_failures(
            store.paths.clone(),
            InMemoryTemporaryWindowBackend::default(),
            [TemporaryFailurePoint::AfterMove, crash_point],
        )
        .convert(
            ConvertTemporaryInput {
                ids: vec![capture.id],
                folder_id: folder.id,
            },
            "2026-08-02T12:34:56+08:00",
        );
        assert_eq!(failed.failed.len(), 1);

        TemporaryInboxService::new(
            store.paths.clone(),
            InMemoryTemporaryWindowBackend::default(),
        )
        .recover_pending()
        .unwrap();
        let recovered = temporary.load(capture.id).unwrap();
        assert_eq!(recovered.kind, NoteKind::Temporary);
        assert_eq!(recovered.folder_id, None);
        assert_eq!(recovered.markdown, "original rollback body");
    }
}

#[test]
fn failed_restore_and_failed_move_rollback_is_replayed_with_metadata_and_window_state() {
    let store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let capture = temporary.create().unwrap();
    Connection::open(store.paths.database())
        .unwrap()
        .execute(
            "INSERT INTO temporary_windows (note_id, visible, x, y, width, height, always_on_top) VALUES (?1, 1, 42, 43, 444, 333, 1)",
            [uuid::Uuid::parse_str(&capture.id.to_string())
                .unwrap()
                .as_bytes()
                .to_vec()],
        )
        .unwrap();
    let deletion = TemporaryInboxService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    )
    .delete(vec![capture.id]);

    let failed = TemporaryInboxService::new_with_failures(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
        [
            TemporaryFailurePoint::RestoreBeforeDatabase,
            TemporaryFailurePoint::RestoreBeforeRollback,
        ],
    )
    .undo_delete(&deletion.operation_id)
    .unwrap();
    assert_eq!(failed.failed.len(), 1);
    assert!(store
        .paths
        .note_dir(capture.id, NoteKind::Temporary)
        .unwrap()
        .exists());

    let restarted = TemporaryInboxService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    );
    restarted.recover_pending().unwrap();
    let retry = restarted.undo_delete(&deletion.operation_id).unwrap();
    assert_eq!(retry.restored, vec![capture.id]);
    let row: (Option<String>, i64, f64, bool) = Connection::open(store.paths.database())
        .unwrap()
        .query_row(
            "SELECT n.deleted_at, w.visible, w.x, w.always_on_top FROM notes n JOIN temporary_windows w ON w.note_id=n.id WHERE n.id=?1",
            [uuid::Uuid::parse_str(&capture.id.to_string())
                .unwrap()
                .as_bytes()
                .to_vec()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(row, (None, 1, 42.0, true));
}

#[test]
fn corrupt_conversion_journal_is_quarantined_without_blocking_valid_recovery() {
    let store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let folder = FolderRepository::new(store.paths.clone())
        .create(CreateFolderInput {
            parent_id: None,
            name: "valid recovery".into(),
        })
        .unwrap();
    let capture = temporary.create().unwrap();
    let crashed = TemporaryInboxService::new_with_failure(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
        TemporaryFailurePoint::CrashAfterMove,
    )
    .convert(
        ConvertTemporaryInput {
            ids: vec![capture.id],
            folder_id: folder.id,
        },
        "2026-08-02T12:34:56+08:00",
    );
    assert_eq!(crashed.failed.len(), 1);
    fs::write(
        store
            .paths
            .root()
            .join(".temporary-conversion-00000000-0000-7000-8000-000000000000.json"),
        br#"{"version":255,"document":{}}"#,
    )
    .unwrap();

    TemporaryInboxService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    )
    .recover_pending()
    .unwrap();
    assert_eq!(
        NoteRepository::new(store.paths.clone())
            .load(capture.id)
            .unwrap()
            .kind,
        NoteKind::Temporary
    );
    assert!(fs::read_dir(store.paths.root()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("quarantined-.temporary-conversion")
    }));
}

#[test]
fn transient_conversion_recovery_failure_keeps_valid_journal_retryable() {
    let mut store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let folder = FolderRepository::new(store.paths.clone())
        .create(CreateFolderInput {
            parent_id: None,
            name: "retry recovery".into(),
        })
        .unwrap();
    let capture = temporary.create().unwrap();
    TemporaryInboxService::new_with_failure(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
        TemporaryFailurePoint::CrashAfterMove,
    )
    .convert(
        ConvertTemporaryInput {
            ids: vec![capture.id],
            folder_id: folder.id,
        },
        "2026-08-02T12:34:56+08:00",
    );
    let journal_prefix = format!(".temporary-conversion-{}", capture.id);

    store.close_database();
    fs::remove_file(store.paths.database()).unwrap();
    fs::create_dir(store.paths.database()).unwrap();
    let recovery = TemporaryInboxService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    )
    .recover_pending();

    assert!(recovery.is_err());
    assert!(fs::read_dir(store.paths.root()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(&journal_prefix)
    }));
    assert!(!fs::read_dir(store.paths.root()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("quarantined-.temporary-conversion")
    }));
}

#[test]
fn non_regular_journal_entry_does_not_block_valid_recovery() {
    let store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let folder = FolderRepository::new(store.paths.clone())
        .create(CreateFolderInput {
            parent_id: None,
            name: "safe recovery".into(),
        })
        .unwrap();
    let capture = temporary.create().unwrap();
    TemporaryInboxService::new_with_failure(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
        TemporaryFailurePoint::CrashAfterMove,
    )
    .convert(
        ConvertTemporaryInput {
            ids: vec![capture.id],
            folder_id: folder.id,
        },
        "2026-08-02T12:34:56+08:00",
    );
    fs::create_dir(
        store
            .paths
            .root()
            .join(".temporary-conversion-019c0000-0000-7000-8000-000000000099.json"),
    )
    .unwrap();

    TemporaryInboxService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    )
    .recover_pending()
    .unwrap();

    assert_eq!(
        temporary.load(capture.id).unwrap().kind,
        NoteKind::Temporary
    );
}

#[test]
fn one_invalid_delete_item_does_not_block_valid_sibling_recovery() {
    let store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let first = temporary.create().unwrap();
    let second = temporary.create().unwrap();
    let deletion = TemporaryInboxService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    )
    .delete(vec![first.id, second.id]);
    assert_eq!(deletion.deleted.len(), 2);
    fs::write(
        store
            .paths
            .child(&[
                "trash",
                &deletion.operation_id,
                &first.id.to_string(),
                "note.md",
            ])
            .unwrap(),
        b"not frontmatter",
    )
    .unwrap();
    Connection::open(store.paths.database())
        .unwrap()
        .execute(
            "UPDATE notes SET deleted_at = NULL WHERE id = ?1",
            [uuid::Uuid::parse_str(&second.id.to_string())
                .unwrap()
                .as_bytes()
                .to_vec()],
        )
        .unwrap();

    TemporaryInboxService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    )
    .recover_pending()
    .unwrap();

    let second_deleted: bool = Connection::open(store.paths.database())
        .unwrap()
        .query_row(
            "SELECT deleted_at IS NOT NULL FROM notes WHERE id = ?1",
            [uuid::Uuid::parse_str(&second.id.to_string())
                .unwrap()
                .as_bytes()
                .to_vec()],
            |row| row.get(0),
        )
        .unwrap();
    assert!(second_deleted);
    assert!(store
        .paths
        .child(&["trash", &deletion.operation_id, "descriptor.json"])
        .unwrap()
        .is_file());
}

#[cfg(windows)]
#[test]
fn transient_delete_descriptor_read_failure_keeps_descriptor_retryable() {
    use std::os::windows::fs::OpenOptionsExt;

    let store = TestStore::new();
    let capture = TemporaryRepository::new(store.paths.clone())
        .create()
        .unwrap();
    let deletion = TemporaryInboxService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    )
    .delete(vec![capture.id]);
    let descriptor = store
        .paths
        .child(&["trash", &deletion.operation_id, "descriptor.json"])
        .unwrap();
    let exclusive = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(&descriptor)
        .unwrap();

    let recovery = TemporaryInboxService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    )
    .recover_pending();

    assert!(recovery.is_err());
    assert!(descriptor.is_file());
    drop(exclusive);
}

#[test]
fn committed_conversion_survives_native_retire_failure_and_retries_retirement_from_journal() {
    let store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let folder = FolderRepository::new(store.paths.clone())
        .create(CreateFolderInput {
            parent_id: None,
            name: "窗口恢复".into(),
        })
        .unwrap();
    let capture = temporary.create().unwrap();
    let failing_backend = InMemoryTemporaryWindowBackend::default();
    failing_backend.fail_next();
    let result = TemporaryInboxService::new(store.paths.clone(), failing_backend).convert(
        ConvertTemporaryInput {
            ids: vec![capture.id],
            folder_id: folder.id,
        },
        "2026-08-02T12:34:56+08:00",
    );
    assert_eq!(result.converted.len(), 1);
    assert!(result.failed.is_empty());
    assert_eq!(
        NoteRepository::new(store.paths.clone())
            .load(capture.id)
            .unwrap()
            .kind,
        NoteKind::Formal
    );
    assert!(
        simple_notes_lib::platform::SafeDirectory::open(store.paths.root(), &[], false)
            .unwrap()
            .entry_names()
            .unwrap()
            .iter()
            .any(|name| name.contains(&capture.id.to_string()))
    );

    let recovered_backend = InMemoryTemporaryWindowBackend::default();
    TemporaryInboxService::new(store.paths.clone(), recovered_backend.clone())
        .recover_pending()
        .unwrap();
    assert_eq!(
        recovered_backend.retired_labels(),
        vec![format!("temporary-{}", capture.id)]
    );
}

#[test]
fn delete_crash_recovery_uses_durable_location_and_undo_reports_conflicts_per_item() {
    let store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let first = temporary.create().unwrap();
    let second = temporary.create().unwrap();
    let crashed = TemporaryInboxService::new_with_failure(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
        TemporaryFailurePoint::CrashAfterMove,
    )
    .delete(vec![first.id]);
    assert!(crashed.deleted.is_empty());
    assert_eq!(crashed.failed.len(), 1);
    assert!(!store
        .paths
        .note_dir(first.id, NoteKind::Temporary)
        .unwrap()
        .exists());
    TemporaryInboxService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    )
    .recover_pending()
    .unwrap();
    assert!(temporary
        .list()
        .unwrap()
        .iter()
        .any(|item| item.id == first.id));

    let deletion = TemporaryInboxService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    )
    .delete(vec![second.id]);
    let destination = store
        .paths
        .note_dir(second.id, NoteKind::Temporary)
        .unwrap();
    fs::create_dir(&destination).unwrap();
    let undo = TemporaryInboxService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    )
    .undo_delete(&deletion.operation_id)
    .unwrap();
    assert!(undo.restored.is_empty());
    assert_eq!(undo.failed.len(), 1);
    assert!(store
        .paths
        .child(&["trash", &deletion.operation_id, &second.id.to_string()])
        .unwrap()
        .exists());
    fs::remove_dir(destination).unwrap();
    let retry = TemporaryInboxService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    )
    .undo_delete(&deletion.operation_id)
    .unwrap();
    assert_eq!(retry.restored, vec![second.id]);
}

#[test]
fn rebuild_indexes_converted_notes_and_excludes_trashed_captures() {
    let mut store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let folder = FolderRepository::new(store.paths.clone())
        .create(CreateFolderInput {
            parent_id: None,
            name: "重建".into(),
        })
        .unwrap();
    let mut capture = temporary.create().unwrap();
    capture.markdown = "# 可检索标题\nunique-body-token".into();
    let capture = temporary.save(capture, 0).unwrap();
    TemporaryInboxService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    )
    .convert(
        ConvertTemporaryInput {
            ids: vec![capture.id],
            folder_id: folder.id,
        },
        "2026-08-02T12:34:56+08:00",
    );
    store.close_database();
    rebuild_index(&store.paths).unwrap();
    let connection = Connection::open(store.paths.database()).unwrap();
    let row: (String, String) = connection.query_row(
        "SELECT n.kind, s.plain_text FROM notes n JOIN search_documents s ON s.note_id=n.id WHERE n.title='可检索标题'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert_eq!(row.0, "formal");
    assert!(row.1.contains("unique-body-token"));
}

#[test]
fn recovery_quarantines_a_conversion_journal_whose_path_identity_does_not_match() {
    let store = TestStore::new();
    let target = support::create_note(
        &store,
        support::note_id("019c0000-0000-7000-8000-000000000081"),
        "Original",
        "untouched",
        "2026-08-02T12:34:56+08:00",
    );
    let path_id = support::note_id("019c0000-0000-7000-8000-000000000082");
    let mut forged = target.clone();
    forged.markdown = "tampered".into();
    let journal = serde_json::json!({ "version": 1, "document": forged });
    fs::write(
        store
            .paths
            .root()
            .join(format!(".temporary-conversion-{path_id}.json")),
        serde_json::to_vec(&journal).unwrap(),
    )
    .unwrap();

    TemporaryInboxService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    )
    .recover_pending()
    .unwrap();
    assert_eq!(
        NoteRepository::new(store.paths.clone())
            .load(target.id)
            .unwrap()
            .markdown,
        "untouched"
    );
}

#[test]
fn conversion_and_rebuild_are_serialized_by_the_shared_mutation_lock() {
    let mut store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let folder = FolderRepository::new(store.paths.clone())
        .create(CreateFolderInput {
            parent_id: None,
            name: "并发".into(),
        })
        .unwrap();
    let capture = temporary.create().unwrap();
    store.close_database();
    let guard = simple_notes_lib::platform::IndexMutationLock::acquire(store.paths.root()).unwrap();
    let convert_paths = store.paths.clone();
    let rebuild_paths = store.paths.clone();
    let converter = std::thread::spawn(move || {
        TemporaryInboxService::new(convert_paths, InMemoryTemporaryWindowBackend::default())
            .convert(
                ConvertTemporaryInput {
                    ids: vec![capture.id],
                    folder_id: folder.id,
                },
                "2026-08-02T12:34:56+08:00",
            )
    });
    let rebuilder = std::thread::spawn(move || rebuild_index(&rebuild_paths));
    std::thread::sleep(std::time::Duration::from_millis(30));
    drop(guard);
    let result = converter.join().unwrap();
    rebuilder.join().unwrap().unwrap();
    assert_eq!(result.converted.len(), 1);
    assert_eq!(
        NoteRepository::new(store.paths.clone())
            .load(capture.id)
            .unwrap()
            .kind,
        NoteKind::Formal
    );
}

#[cfg(windows)]
#[test]
fn conversion_rejects_a_junction_inside_capture_tree_without_special_privileges() {
    let store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let folder = FolderRepository::new(store.paths.clone())
        .create(CreateFolderInput {
            parent_id: None,
            name: "安全".into(),
        })
        .unwrap();
    let capture = temporary.create().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let link = store
        .paths
        .note_dir(capture.id, NoteKind::Temporary)
        .unwrap()
        .join("escape");
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(outside.path())
        .status()
        .expect("launch junction fixture command");
    assert!(
        status.success(),
        "junction fixture does not require Developer Mode"
    );
    let result = TemporaryInboxService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    )
    .convert(
        ConvertTemporaryInput {
            ids: vec![capture.id],
            folder_id: folder.id,
        },
        "2026-08-02T12:34:56+08:00",
    );
    assert_eq!(result.failed.len(), 1);
    assert!(store
        .paths
        .note_dir(capture.id, NoteKind::Temporary)
        .unwrap()
        .exists());
}

#[cfg(unix)]
#[test]
fn conversion_rejects_symlinks_inside_capture_tree() {
    use std::os::unix::fs::symlink;
    let store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let folder = FolderRepository::new(store.paths.clone())
        .create(CreateFolderInput {
            parent_id: None,
            name: "安全".into(),
        })
        .unwrap();
    let capture = temporary.create().unwrap();
    symlink(
        store.paths.root().join("outside"),
        store
            .paths
            .note_dir(capture.id, NoteKind::Temporary)
            .unwrap()
            .join("escape"),
    )
    .unwrap();
    let result = TemporaryInboxService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    )
    .convert(
        ConvertTemporaryInput {
            ids: vec![capture.id],
            folder_id: folder.id,
        },
        "2026-08-02T12:34:56+08:00",
    );
    assert_eq!(result.failed.len(), 1);
    assert!(store
        .paths
        .note_dir(capture.id, NoteKind::Temporary)
        .unwrap()
        .exists());
}

#[test]
fn creates_distinct_uuidv7_temporary_documents_and_lists_durable_newest_first() {
    let store = TestStore::new();
    let repository = TemporaryRepository::new(store.paths.clone());
    let first = repository.create().unwrap();
    let second = repository.create().unwrap();

    assert_ne!(first.id, second.id);
    assert_eq!(first.kind, NoteKind::Temporary);
    assert_eq!(first.revision, 0);
    assert!(store
        .paths
        .temporary()
        .join(first.id.to_string())
        .join("note.md")
        .is_file());
    let listed = repository.list().unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].id, second.id);
    assert_eq!(listed[1].id, first.id);
}

#[test]
fn save_rejects_formal_documents_and_preserves_optimistic_revisions() {
    let store = TestStore::new();
    let repository = TemporaryRepository::new(store.paths.clone());
    let mut capture = repository.create().unwrap();
    capture.markdown = "durable".into();
    let saved = repository.save(capture.clone(), 0).unwrap();
    assert_eq!(saved.revision, 1);
    assert_eq!(
        repository.save(capture, 0).unwrap_err().code(),
        CommandErrorCode::Conflict
    );

    let mut formal = saved;
    formal.kind = NoteKind::Formal;
    assert!(repository.save(formal, 1).is_err());
}

#[test]
fn show_reuses_a_canonical_window_and_publishes_visibility_after_native_success() {
    let store = TestStore::new();
    let repository = TemporaryRepository::new(store.paths.clone());
    let capture = repository.create().unwrap();
    let backend = InMemoryTemporaryWindowBackend::default();
    let service = TemporaryWindowService::new(store.paths.clone(), backend.clone());

    service.show(capture.id).unwrap();
    service.show(capture.id).unwrap();

    assert_eq!(
        backend.created_labels(),
        vec![format!("temporary-{}", capture.id)]
    );
    assert_eq!(backend.show_count(), 2);
    assert!(service.load_state(capture.id).unwrap().visible);

    backend.fail_next();
    service.hide(capture.id).unwrap_err();
    assert!(service.load_state(capture.id).unwrap().visible);
    assert_eq!(
        NoteRepository::new(store.paths.clone())
            .load(capture.id)
            .unwrap()
            .markdown,
        ""
    );
}

#[test]
fn show_failure_after_window_creation_does_not_publish_visible_state() {
    let store = TestStore::new();
    let repository = TemporaryRepository::new(store.paths.clone());
    let capture = repository.create().unwrap();
    let backend = InMemoryTemporaryWindowBackend::default();
    backend.fail_on_operation(3);
    let service = TemporaryWindowService::new(store.paths.clone(), backend);

    assert!(service.show(capture.id).is_err());
    assert!(!service.load_state(capture.id).unwrap().visible);
}

#[test]
fn window_state_clamps_bounds_round_trips_and_survives_index_rebuild() {
    let mut store = TestStore::new();
    let repository = TemporaryRepository::new(store.paths.clone());
    let capture = repository.create().unwrap();
    let service = TemporaryWindowService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    );
    let persisted = service
        .set_state(TemporaryWindowState {
            note_id: capture.id,
            visible: true,
            x: 12.5,
            y: -24.0,
            width: 1.0,
            height: 100_000.0,
            always_on_top: false,
        })
        .unwrap();
    assert_eq!(persisted.width, 240.0);
    assert_eq!(persisted.height, 1600.0);
    assert_eq!(service.load_state(capture.id).unwrap(), persisted);

    store.close_database();
    rebuild_index(&store.paths).unwrap();
    assert_eq!(service.load_state(capture.id).unwrap(), persisted);

    let mut invalid = DEFAULT_WINDOW_STATE.with_note_id(capture.id);
    invalid.x = f64::NAN;
    assert!(service.set_state(invalid).is_err());
}

#[test]
fn close_interception_keeps_retry_path_visible_but_shutdown_allows_native_close() {
    let store = TestStore::new();
    let repository = TemporaryRepository::new(store.paths.clone());
    let capture = repository.create().unwrap();
    let backend = InMemoryTemporaryWindowBackend::default();
    let service = TemporaryWindowService::new(store.paths.clone(), backend.clone());
    service.show(capture.id).unwrap();

    assert!(service.handle_close(capture.id, false).unwrap());
    // The renderer flushes before calling hide; interception itself keeps the retry path visible.
    assert!(service.load_state(capture.id).unwrap().visible);
    assert!(!service.handle_close(capture.id, true).unwrap());
}

fn fail_before_publish(
    _paths: &simple_notes_lib::storage::paths::StoragePaths,
    _id: simple_notes_lib::domain::NoteId,
    _kind: NoteKind,
    _bytes: &[u8],
) -> PublishResult {
    Err(PublishFailure::not_published(
        simple_notes_lib::error::CommandError::io("injected temporary write failure"),
    ))
}

#[test]
fn failed_temporary_write_preserves_the_previous_durable_document() {
    let store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let mut capture = temporary.create().unwrap();
    capture.markdown = "previous valid body".into();
    let saved = temporary.save(capture, 0).unwrap();
    let before = fs::read(
        store
            .paths
            .temporary()
            .join(saved.id.to_string())
            .join("note.md"),
    )
    .unwrap();
    let mut changed = saved.clone();
    changed.markdown = "must not publish".into();

    let error = NoteRepository::new_with_writer(store.paths.clone(), fail_before_publish)
        .save(changed, saved.revision)
        .unwrap_err();

    assert_eq!(error.code(), CommandErrorCode::Io);
    assert_eq!(
        fs::read(
            store
                .paths
                .temporary()
                .join(saved.id.to_string())
                .join("note.md")
        )
        .unwrap(),
        before
    );
}

#[test]
fn temporary_index_failure_keeps_new_durable_content_and_rebuild_evidence() {
    let store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let mut capture = temporary.create().unwrap();
    let sabotage = Connection::open(store.paths.database()).unwrap();
    sabotage.execute_batch("DROP TABLE note_tags;").unwrap();
    drop(sabotage);
    capture.markdown = "durable despite index failure".into();

    assert_eq!(
        temporary.save(capture.clone(), 0).unwrap_err().code(),
        CommandErrorCode::Database
    );
    assert!(fs::read_to_string(
        store
            .paths
            .temporary()
            .join(capture.id.to_string())
            .join("note.md")
    )
    .unwrap()
    .contains("durable despite index failure"));
    assert!(store.paths.root().join("rebuild-needed.json").is_file());
}

#[test]
fn list_reports_a_missing_durable_temporary_document_instead_of_synthesizing_it() {
    let store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let capture = temporary.create().unwrap();
    fs::remove_file(
        store
            .paths
            .temporary()
            .join(capture.id.to_string())
            .join("note.md"),
    )
    .unwrap();

    assert_eq!(
        temporary.list().unwrap_err().code(),
        CommandErrorCode::NotFound
    );
}

#[test]
fn native_state_failures_leave_the_previous_authoritative_state() {
    let store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let capture = temporary.create().unwrap();
    let backend = InMemoryTemporaryWindowBackend::default();
    let service = TemporaryWindowService::new(store.paths.clone(), backend.clone());
    service.show(capture.id).unwrap();
    let before = service.load_state(capture.id).unwrap();
    backend.fail_next();

    assert!(service
        .set_state(TemporaryWindowState {
            always_on_top: false,
            ..before
        })
        .is_err());
    assert_eq!(service.load_state(capture.id).unwrap(), before);
}

#[test]
fn successful_hide_keeps_content_loadable_and_show_reopens_it() {
    let store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let mut capture = temporary.create().unwrap();
    capture.markdown = "reopen me".into();
    let saved = temporary.save(capture, 0).unwrap();
    let backend = InMemoryTemporaryWindowBackend::default();
    let service = TemporaryWindowService::new(store.paths.clone(), backend);
    service.show(saved.id).unwrap();
    service.hide(saved.id).unwrap();
    assert!(!service.load_state(saved.id).unwrap().visible);
    assert_eq!(temporary.list().unwrap()[0].markdown, "reopen me");
    service.show(saved.id).unwrap();
    assert!(service.load_state(saved.id).unwrap().visible);
}

#[test]
fn stale_window_rows_are_dropped_without_deleting_temporary_content() {
    let mut store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let capture = temporary.create().unwrap();
    let stale = uuid::Uuid::parse_str("019c0000-0000-7000-8000-000000000099").unwrap();
    let connection = Connection::open(store.paths.database()).unwrap();
    connection
        .execute_batch("PRAGMA foreign_keys = OFF;")
        .unwrap();
    connection.execute(
        "INSERT INTO temporary_windows (note_id, visible, x, y, width, height, always_on_top) VALUES (?1, 1, 0, 0, 300, 300, 1)",
        [stale.as_bytes().as_slice()],
    ).unwrap();
    drop(connection);
    store.close_database();

    rebuild_index(&store.paths).unwrap();

    assert_eq!(temporary.list().unwrap().len(), 1);
    assert_eq!(temporary.list().unwrap()[0].id, capture.id);
    let connection = Connection::open(store.paths.database()).unwrap();
    let rows: i64 = connection
        .query_row("SELECT count(*) FROM temporary_windows", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(rows, 0);
}

#[test]
fn labels_and_non_finite_or_non_positive_bounds_are_rejected() {
    use simple_notes_lib::windows::sticky::parse_temporary_window_label;
    assert!(parse_temporary_window_label("main").is_err());
    assert!(parse_temporary_window_label("temporary-not-a-uuid").is_err());
    let store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let capture = temporary.create().unwrap();
    let service = TemporaryWindowService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    );
    for (x, width) in [(f64::INFINITY, 300.0), (0.0, 0.0), (0.0, -1.0)] {
        let mut invalid = DEFAULT_WINDOW_STATE.with_note_id(capture.id);
        invalid.x = x;
        invalid.width = width;
        assert_eq!(
            service.set_state(invalid).unwrap_err().code(),
            CommandErrorCode::Validation
        );
    }
}

fn close_store_for_rebuild(store: &mut TestStore) {
    store.close_database();
    for suffix in ["-wal", "-shm"] {
        let sidecar = store.paths.root().join(format!("index.sqlite{suffix}"));
        if sidecar.exists() {
            fs::remove_file(sidecar).unwrap();
        }
    }
}

#[test]
fn corrupt_old_index_does_not_block_temporary_markdown_rebuild() {
    let mut store = TestStore::new();
    let capture = TemporaryRepository::new(store.paths.clone())
        .create()
        .unwrap();
    close_store_for_rebuild(&mut store);
    fs::write(store.paths.database(), b"not sqlite").unwrap();

    let report = rebuild_index(&store.paths).unwrap();

    assert_eq!(report.notes_recovered, 1);
    assert_eq!(
        TemporaryRepository::new(store.paths.clone())
            .list()
            .unwrap()[0]
            .id,
        capture.id
    );
}

#[test]
fn missing_window_table_does_not_block_temporary_markdown_rebuild() {
    let mut store = TestStore::new();
    TemporaryRepository::new(store.paths.clone())
        .create()
        .unwrap();
    let connection = Connection::open(store.paths.database()).unwrap();
    connection
        .execute_batch("DROP TABLE temporary_windows;")
        .unwrap();
    drop(connection);
    close_store_for_rebuild(&mut store);

    assert_eq!(rebuild_index(&store.paths).unwrap().notes_recovered, 1);
}

#[test]
fn rebuild_skips_invalid_window_rows_but_preserves_valid_rows() {
    let mut store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let valid = temporary.create().unwrap();
    let invalid = temporary.create().unwrap();
    let connection = Connection::open(store.paths.database()).unwrap();
    connection.execute_batch("PRAGMA foreign_keys=OFF; DROP TABLE temporary_windows; CREATE TABLE temporary_windows (note_id BLOB, visible INTEGER, x REAL, y REAL, width REAL, height REAL, always_on_top INTEGER);").unwrap();
    connection
        .execute(
            "INSERT INTO temporary_windows VALUES (?1, 1, 12, 18, 320, 410, 0)",
            [uuid::Uuid::parse_str(&valid.id.to_string())
                .unwrap()
                .as_bytes()
                .as_slice()],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO temporary_windows VALUES (?1, 1, 'bad', 18, -1, 410, 0)",
            [uuid::Uuid::parse_str(&invalid.id.to_string())
                .unwrap()
                .as_bytes()
                .as_slice()],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO temporary_windows VALUES (x'01', 1, 0, 0, 300, 300, 1)",
            [],
        )
        .unwrap();
    drop(connection);
    close_store_for_rebuild(&mut store);

    rebuild_index(&store.paths).unwrap();

    let service = TemporaryWindowService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    );
    assert_eq!(service.load_state(valid.id).unwrap().x, 12.0);
    assert_eq!(service.load_state(invalid.id).unwrap().width, 360.0);
}

#[test]
fn pin_patch_uses_latest_native_bounds_and_preserves_visibility() {
    let store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let capture = temporary.create().unwrap();
    let backend = InMemoryTemporaryWindowBackend::default();
    let service = TemporaryWindowService::new(store.paths.clone(), backend.clone());
    service.show(capture.id).unwrap();
    service
        .persist_observed_bounds(capture.id, 720.0, 180.0, 640.0, 510.0)
        .unwrap();

    let pinned = service.set_always_on_top(capture.id, false).unwrap();

    assert_eq!(
        (pinned.x, pinned.y, pinned.width, pinned.height),
        (720.0, 180.0, 640.0, 510.0)
    );
    assert!(pinned.visible);
    assert!(!pinned.always_on_top);
    assert_eq!(backend.pin_update_count(), 1);
    assert_eq!(backend.state_apply_count(), 1);
}

#[test]
fn general_state_update_cannot_forge_visibility() {
    let store = TestStore::new();
    let temporary = TemporaryRepository::new(store.paths.clone());
    let capture = temporary.create().unwrap();
    let service = TemporaryWindowService::new(
        store.paths.clone(),
        InMemoryTemporaryWindowBackend::default(),
    );
    service.show(capture.id).unwrap();
    let current = service.load_state(capture.id).unwrap();

    let updated = service
        .set_state(TemporaryWindowState {
            visible: false,
            x: 90.0,
            ..current
        })
        .unwrap();

    assert!(updated.visible);
    assert!(service.load_state(capture.id).unwrap().visible);
}

#[test]
fn close_events_have_one_canonical_window_target() {
    let first = simple_notes_lib::domain::NoteId::parse_str("019c0000-0000-7000-8000-000000000071")
        .unwrap();
    let second =
        simple_notes_lib::domain::NoteId::parse_str("019c0000-0000-7000-8000-000000000072")
            .unwrap();
    assert_eq!(
        close_event_target(first, &format!("temporary-{first}")).unwrap(),
        format!("temporary-{first}")
    );
    assert!(close_event_target(first, &format!("temporary-{second}")).is_err());
}

#[test]
fn command_authorization_is_scoped_to_main_or_the_matching_sticky() {
    let note = simple_notes_lib::domain::NoteId::parse_str("019c0000-0000-7000-8000-000000000073")
        .unwrap();
    let other = simple_notes_lib::domain::NoteId::parse_str("019c0000-0000-7000-8000-000000000074")
        .unwrap();
    assert!(authorize_temporary_caller("main", TemporaryCommandOperation::Create, None).is_ok());
    assert!(authorize_temporary_caller(
        "temporary-ignored",
        TemporaryCommandOperation::Create,
        None
    )
    .is_err());
    assert!(authorize_temporary_caller(
        &format!("temporary-{note}"),
        TemporaryCommandOperation::Load,
        Some(note)
    )
    .is_ok());
    assert!(authorize_temporary_caller(
        &format!("temporary-{note}"),
        TemporaryCommandOperation::Save,
        Some(other)
    )
    .is_err());
    assert!(
        authorize_temporary_caller("main", TemporaryCommandOperation::Load, Some(note)).is_ok()
    );
    assert!(
        authorize_temporary_caller("main", TemporaryCommandOperation::Save, Some(note)).is_ok()
    );
    for operation in [
        TemporaryCommandOperation::Delete,
        TemporaryCommandOperation::UndoDelete,
        TemporaryCommandOperation::Convert,
    ] {
        assert!(authorize_temporary_caller("main", operation, None).is_ok());
        assert!(authorize_temporary_caller(&format!("temporary-{note}"), operation, None).is_err());
    }
    assert!(authorize_asset_caller("main", note).is_ok());
    assert!(authorize_asset_caller(&format!("temporary-{note}"), note).is_ok());
    assert!(authorize_asset_caller(&format!("temporary-{note}"), other).is_err());
}

#[test]
fn only_app_exit_events_begin_shutdown() {
    assert!(!reduce_shutdown_lifecycle(
        false,
        AppLifecycleEvent::MainWindowCloseRequested
    ));
    assert!(reduce_shutdown_lifecycle(
        false,
        AppLifecycleEvent::ExitRequested
    ));
    assert!(reduce_shutdown_lifecycle(false, AppLifecycleEvent::Exit));
}

#[test]
fn geometry_preserves_secondary_monitor_bounds_and_clamps_removed_monitor() {
    let monitors = [
        MonitorGeometry {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
            scale_factor: 1.0,
        },
        MonitorGeometry {
            x: 1920.0,
            y: 0.0,
            width: 2560.0,
            height: 1440.0,
            scale_factor: 2.0,
        },
    ];
    let secondary = PhysicalWindowBounds {
        x: 2200.0,
        y: 160.0,
        width: 720.0,
        height: 840.0,
    };
    assert_eq!(clamp_to_available_monitors(secondary, &monitors), secondary);

    let removed = PhysicalWindowBounds {
        x: 7000.0,
        y: 200.0,
        width: 600.0,
        height: 500.0,
    };
    let restored = clamp_to_available_monitors(removed, &monitors[..1]);
    assert!(restored.x >= 0.0 && restored.x + restored.width <= 1920.0);
    assert!(restored.y >= 0.0 && restored.y + restored.height <= 1080.0);
}

#[test]
fn geometry_scale_round_trip_uses_current_monitor_dpi() {
    let logical = PhysicalWindowBounds {
        x: 100.0,
        y: 80.0,
        width: 360.0,
        height: 420.0,
    };
    let physical = logical.to_physical(2.0);
    assert_eq!(
        physical,
        PhysicalWindowBounds {
            x: 200.0,
            y: 160.0,
            width: 720.0,
            height: 840.0
        }
    );
    assert_eq!(physical.to_logical(2.0), logical);

    let monitors = [MonitorGeometry {
        x: 1920.0,
        y: 0.0,
        width: 2560.0,
        height: 1440.0,
        scale_factor: 2.0,
    }];
    let restored = physical_bounds_for_restore(
        PhysicalWindowBounds {
            x: 2200.0,
            y: 160.0,
            width: 360.0,
            height: 420.0,
        },
        &monitors,
        1.0,
    );
    assert_eq!(restored.x, 2200.0);
    assert_eq!(restored.width, 720.0);
}

#[test]
fn sticky_capability_is_separate_and_minimal() {
    let default: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
    let desktop: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/desktop.json")).unwrap();
    let sticky: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/temporary.json")).unwrap();
    assert_eq!(default["windows"], serde_json::json!(["main"]));
    assert_eq!(desktop["windows"], serde_json::json!(["main"]));
    assert_eq!(sticky["windows"], serde_json::json!(["temporary-*"]));
    assert_eq!(
        default["permissions"],
        serde_json::json!([
            "core:default",
            "opener:default",
            "allow-create-note",
            "allow-load-note",
            "allow-save-note",
            "allow-list-notes",
            "allow-move-note",
            "allow-trash-notes",
            "allow-list-trash",
            "allow-restore-trash",
            "allow-undo-trash",
            "allow-purge-expired-trash",
            "allow-resolve-link",
            "allow-backlinks",
            "allow-rename-target-labels",
            "allow-save-image",
            "allow-list-folders",
            "allow-create-folder",
            "allow-rename-folder",
            "allow-move-folder",
            "allow-delete-empty-folder",
            "allow-search-notes",
            "allow-update-note-tags",
            "allow-create-temporary",
            "allow-list-temporary",
            "allow-convert-temporary",
            "allow-delete-temporary",
            "allow-undo-delete",
            "allow-show-temporary-window",
            "allow-get-capture-shortcut",
            "allow-rebind-capture-shortcut",
            "allow-load-sticky-settings",
            "allow-load-settings",
            "allow-update-settings",
            "allow-reset-settings",
            "allow-get-storage-info",
            "allow-move-storage-root",
            "allow-restart-application"
        ])
    );
    assert_eq!(
        sticky["permissions"],
        serde_json::json!([
            "core:event:allow-listen",
            "core:event:allow-unlisten",
            "core:window:allow-start-dragging",
            "allow-load-temporary",
            "allow-save-temporary",
            "allow-hide-temporary-window",
            "allow-set-temporary-always-on-top",
            "allow-save-image",
            "allow-load-sticky-settings"
        ])
    );
}
