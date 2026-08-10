mod support;

use simple_notes_lib::{
    commands::{
        notes::prepare_startup_repository,
        storage::{StorageCommandState, StorageConsumer},
    },
    domain::{NoteDocument, NoteId, NoteKind},
    error::CommandError,
    storage::{
        rebuild::rebuild_index_with_hook,
        recovery::{
            recover_startup, recover_startup_with_candidate_hook, StartupRecoveryReadiness,
            StartupRecoveryState,
        },
        repository::NoteRepository,
    },
};
use std::{
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
};
use support::RecoveryFixture;

#[test]
fn startup_promotes_the_unique_highest_valid_revision_and_quarantines_the_rest() {
    let mut fixture = RecoveryFixture::with_document(1, "durable revision one");
    fixture.add_candidate(2, "valid revision two");
    fixture.add_candidate(3, "valid highest revision");
    fixture.store.close_database();

    let report = recover_startup(&fixture.store.paths).unwrap();

    assert_eq!(fixture.loaded_markdown(), "valid highest revision");
    assert_eq!(report.recovered.len(), 1);
    assert_eq!(report.quarantined.len(), 1);
    assert!(fixture.candidate_names().is_empty());
}

#[test]
fn startup_never_guesses_when_the_highest_revision_is_ambiguous() {
    let mut fixture = RecoveryFixture::with_document(1, "durable revision one");
    fixture.add_candidate(3, "first revision three");
    fixture.add_candidate(3, "second revision three");

    let report = recover_startup(&fixture.store.paths).unwrap();

    assert_eq!(fixture.loaded_markdown(), "durable revision one");
    assert_eq!(report.recovered.len(), 0);
    assert_eq!(report.ambiguous.len(), 1);
    assert_eq!(report.quarantined.len(), 2);
    assert!(fixture.candidate_names().is_empty());
}

#[test]
fn startup_quarantines_candidates_whose_frontmatter_identity_does_not_match_the_owner() {
    let mut fixture = RecoveryFixture::with_document(1, "durable revision one");
    fixture.add_candidate_with_id("019c0000-0000-7000-8000-000000000612", 9, "foreign content");

    let report = recover_startup(&fixture.store.paths).unwrap();

    assert_eq!(fixture.loaded_markdown(), "durable revision one");
    assert_eq!(report.recovered.len(), 0);
    assert_eq!(report.quarantined.len(), 1);
    assert!(fixture.candidate_names().is_empty());
}

#[test]
fn startup_quarantines_a_corrupt_index_with_its_sidecars_and_rebuilds_without_touching_content() {
    let mut fixture = RecoveryFixture::with_document(1, "durable body");
    let note_path = fixture.note_path();
    let before = fs::read(&note_path).unwrap();
    fixture.store.close_database();
    fs::write(fixture.store.paths.database(), b"corrupt sqlite bytes").unwrap();
    fs::write(
        fixture.store.paths.root().join("index.sqlite-wal"),
        b"wal evidence",
    )
    .unwrap();
    fs::write(
        fixture.store.paths.root().join("index.sqlite-shm"),
        b"shm evidence",
    )
    .unwrap();

    let report = recover_startup(&fixture.store.paths).unwrap();

    assert!(report.index_rebuilt);
    let quarantine = report.index_quarantine.expect("corrupt index quarantine");
    assert_eq!(
        fs::read(
            fixture
                .store
                .paths
                .root()
                .join(quarantine.database.unwrap())
        )
        .unwrap(),
        b"corrupt sqlite bytes"
    );
    assert_eq!(quarantine.sidecars.len(), 2);
    assert_eq!(fs::read(note_path).unwrap(), before);
    assert_eq!(fixture.loaded_markdown(), "durable body");
}

#[test]
fn startup_rejects_a_partial_rebuild_and_keeps_the_corrupt_index_retryable() {
    let mut fixture = RecoveryFixture::with_document(1, "durable body");
    fixture.store.close_database();
    fs::write(fixture.store.paths.database(), b"corrupt sqlite bytes").unwrap();
    let broken_id = "019c0000-0000-7000-8000-000000000613";
    let broken_dir = fixture.store.paths.notes().join(broken_id);
    fs::create_dir(&broken_dir).unwrap();
    fs::write(broken_dir.join("note.md"), b"---\nid: invalid\n---\nbody").unwrap();

    assert!(recover_startup(&fixture.store.paths).is_err());

    let quarantine = fs::read_dir(fixture.store.paths.root())
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .ends_with(".quarantine")
        })
        .expect("retryable corrupt index quarantine");
    assert_eq!(fs::read(quarantine).unwrap(), b"corrupt sqlite bytes");
    assert_eq!(
        fs::read(broken_dir.join("note.md")).unwrap(),
        b"---\nid: invalid\n---\nbody"
    );
}

#[test]
fn startup_publishes_the_bytes_that_were_validated_even_if_the_candidate_name_is_replaced() {
    let mut fixture = RecoveryFixture::with_document(1, "durable revision one");
    fixture.add_candidate(2, "validated revision two");
    fixture.store.close_database();

    let report = recover_startup_with_candidate_hook(&fixture.store.paths, |candidate| {
        fs::write(candidate, b"unvalidated replacement bytes").unwrap();
    })
    .unwrap();

    assert_eq!(report.recovered.len(), 1);
    assert_eq!(fixture.loaded_markdown(), "validated revision two");
}

#[test]
fn startup_never_mutates_canonical_content_when_rebuild_intent_cannot_be_persisted() {
    let mut fixture = RecoveryFixture::with_document(1, "durable revision one");
    fixture.add_candidate(2, "candidate revision two");
    fixture.store.close_database();
    fs::create_dir(fixture.store.paths.root().join("rebuild-needed.json")).unwrap();

    assert!(recover_startup(&fixture.store.paths).is_err());

    assert_eq!(fixture.loaded_markdown(), "durable revision one");
    assert_eq!(fixture.candidate_names().len(), 1);
}

#[test]
fn failed_corrupt_index_rebuild_keeps_durable_retry_intent_and_retries_all_documents() {
    let mut fixture = RecoveryFixture::with_document(1, "durable formal body");
    NoteRepository::new(fixture.store.paths.clone())
        .create(NoteDocument {
            id: NoteId::parse_str("019c0000-0000-7000-8000-000000000614").unwrap(),
            kind: NoteKind::Temporary,
            title: "Temporary".to_owned(),
            folder_id: None,
            tags: Vec::new(),
            markdown: "durable temporary body".to_owned(),
            revision: 0,
            created_at: "2026-07-30T00:00:00Z".to_owned(),
            updated_at: "2026-07-30T00:00:00Z".to_owned(),
        })
        .unwrap();
    fixture.store.close_database();
    fs::write(fixture.store.paths.database(), b"corrupt sqlite bytes").unwrap();
    let broken_id = "019c0000-0000-7000-8000-000000000615";
    let broken_dir = fixture.store.paths.notes().join(broken_id);
    fs::create_dir(&broken_dir).unwrap();
    fs::write(broken_dir.join("note.md"), b"---\nid: invalid\n---\nbody").unwrap();

    assert!(recover_startup(&fixture.store.paths).is_err());
    assert!(fixture
        .store
        .paths
        .root()
        .join("rebuild-needed.json")
        .is_file());
    assert!(
        !fixture.store.paths.database().exists(),
        "failed rebuild must not create an empty live index"
    );

    fs::remove_dir_all(broken_dir).unwrap();
    let report = recover_startup(&fixture.store.paths).unwrap();
    assert!(report.index_rebuilt);
    assert_eq!(fixture.loaded_markdown(), "durable formal body");
}

#[test]
fn failed_startup_recovery_is_reportable_and_retryable_without_aborting_state_creation() {
    let mut fixture = RecoveryFixture::with_document(1, "durable body");
    fixture.store.close_database();
    fs::write(fixture.store.paths.database(), b"corrupt sqlite bytes").unwrap();
    let broken_dir = fixture
        .store
        .paths
        .notes()
        .join("019c0000-0000-7000-8000-000000000616");
    fs::create_dir(&broken_dir).unwrap();
    fs::write(broken_dir.join("note.md"), b"invalid frontmatter").unwrap();

    let readiness = StartupRecoveryReadiness::new();
    let storage = StorageCommandState::new(fixture.store.paths.clone(), readiness.clone());
    let state = StartupRecoveryState::initialize(fixture.store.paths.clone(), readiness);
    assert!(state.report().failure.is_some());
    assert!(storage.paths_for(StorageConsumer::Notes).is_err());
    assert!(storage.paths_for(StorageConsumer::Folders).is_err());
    assert!(storage.paths_for(StorageConsumer::Temporary).is_err());
    assert!(
        !fixture.store.paths.database().exists(),
        "ordinary repository access must not create an empty live index while recovery is incomplete"
    );

    assert!(state
        .retry_with(|| Err(CommandError::io("injected post-recovery setup failure")))
        .is_err());
    assert!(storage.paths_for(StorageConsumer::Notes).is_err());

    fs::remove_dir_all(broken_dir).unwrap();
    assert!(state
        .retry_with(|| Err(CommandError::io("injected post-recovery setup failure")))
        .is_err());
    assert!(storage.paths_for(StorageConsumer::Temporary).is_err());

    let report = state.retry_with(|| Ok(())).unwrap();
    assert!(report.failure.is_none());
    assert!(storage.paths_for(StorageConsumer::Notes).is_ok());
    assert_eq!(
        NoteRepository::new(fixture.store.paths.clone())
            .list_in_folder(None)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn marker_failure_keeps_corrupt_live_index_untouched_and_all_repository_consumers_degraded() {
    let mut fixture = RecoveryFixture::with_document(1, "durable body");
    fixture.store.close_database();
    fs::write(fixture.store.paths.database(), b"corrupt sqlite bytes").unwrap();
    fs::create_dir(fixture.store.paths.root().join("rebuild-needed.json")).unwrap();
    let before = fs::read(fixture.store.paths.database()).unwrap();

    let readiness = StartupRecoveryReadiness::new();
    let storage = StorageCommandState::new(fixture.store.paths.clone(), readiness.clone());
    let recovery = StartupRecoveryState::initialize(fixture.store.paths.clone(), readiness);

    assert!(recovery.report().failure.is_some());
    prepare_startup_repository(&storage).expect("degraded startup must remain nonfatal");
    for consumer in [
        StorageConsumer::Folders,
        StorageConsumer::Notes,
        StorageConsumer::Temporary,
        StorageConsumer::Assets,
        StorageConsumer::Search,
        StorageConsumer::Links,
        StorageConsumer::Trash,
        StorageConsumer::StickyWindows,
        StorageConsumer::Export,
    ] {
        assert!(storage.paths_for(consumer).is_err());
    }
    assert_eq!(fs::read(fixture.store.paths.database()).unwrap(), before);
}

#[test]
fn overlapping_retries_are_single_flight_and_never_run_a_second_finalizer() {
    let fixture = RecoveryFixture::with_document(1, "durable body");
    let readiness = StartupRecoveryReadiness::new();
    let state = Arc::new(StartupRecoveryState::initialize(
        fixture.store.paths.clone(),
        readiness,
    ));
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let first_state = state.clone();
    let first = thread::spawn(move || {
        first_state.retry_with(|| {
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            Ok(())
        })
    });
    entered_rx.recv().unwrap();

    let second_finalizer_ran = Arc::new(AtomicBool::new(false));
    let second_probe = second_finalizer_ran.clone();
    let second = state.retry_with(|| {
        second_probe.store(true, Ordering::SeqCst);
        Err(CommandError::io("overlapping retry finalizer must not run"))
    });
    release_tx.send(()).unwrap();
    let first = first.join().unwrap();

    assert!(first.is_ok());
    assert_eq!(
        second.unwrap_err().code(),
        simple_notes_lib::error::CommandErrorCode::Conflict
    );
    assert!(!second_finalizer_ran.load(Ordering::SeqCst));
    assert!(state.ensure_ready().is_ok());
    assert!(state.report().failure.is_none());
}

#[test]
fn startup_quarantines_and_reports_sidecars_when_the_live_database_is_missing() {
    let mut fixture = RecoveryFixture::with_document(1, "durable body");
    fixture.store.close_database();
    fs::remove_file(fixture.store.paths.database()).unwrap();
    fs::write(fixture.store.paths.root().join("index.sqlite-wal"), b"wal").unwrap();
    fs::write(fixture.store.paths.root().join("index.sqlite-shm"), b"shm").unwrap();

    let report = recover_startup(&fixture.store.paths).unwrap();

    assert!(report.index_rebuilt);
    let quarantine = report.index_quarantine.unwrap();
    assert!(quarantine.database.is_none());
    assert_eq!(quarantine.sidecars.len(), 2);
}

#[test]
fn failed_rebuild_never_creates_an_empty_live_database_while_reading_window_state() {
    let mut fixture = RecoveryFixture::with_document(1, "durable formal body");
    NoteRepository::new(fixture.store.paths.clone())
        .create(NoteDocument {
            id: NoteId::parse_str("019c0000-0000-7000-8000-000000000617").unwrap(),
            kind: NoteKind::Temporary,
            title: "Temporary".to_owned(),
            folder_id: None,
            tags: Vec::new(),
            markdown: "temporary body".to_owned(),
            revision: 0,
            created_at: "2026-07-30T00:00:00Z".to_owned(),
            updated_at: "2026-07-30T00:00:00Z".to_owned(),
        })
        .unwrap();
    fixture.store.close_database();
    fs::remove_file(fixture.store.paths.database()).unwrap();

    let result = rebuild_index_with_hook(&fixture.store.paths, |_| {
        Err(simple_notes_lib::error::CommandError::io(
            "injected publication failure",
        ))
    });

    assert!(result.is_err());
    assert!(!fixture.store.paths.database().exists());
}
