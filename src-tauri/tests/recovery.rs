mod support;

use simple_notes_lib::storage::recovery::recover_startup;
use std::fs;
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
        fs::read(fixture.store.paths.root().join(quarantine.database)).unwrap(),
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
