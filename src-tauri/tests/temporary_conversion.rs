mod support;

use rusqlite::Connection;
use simple_notes_lib::{
    domain::{NoteKind, TemporaryWindowState},
    error::CommandErrorCode,
    storage::{
        atomic_file::{PublishFailure, PublishResult},
        rebuild::rebuild_index,
        repository::NoteRepository,
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
        authorize_temporary_caller("main", TemporaryCommandOperation::Save, Some(note)).is_err()
    );
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
            "allow-show-temporary-window",
            "allow-get-capture-shortcut",
            "allow-rebind-capture-shortcut"
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
            "allow-save-image"
        ])
    );
}
