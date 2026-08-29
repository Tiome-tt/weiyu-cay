mod support;

use rusqlite::{params, Connection};
use simple_notes_lib::{
    commands::notes::{rename_note_in_storage, rename_note_in_storage_with_repair},
    domain::{NoteDocument, NoteId, NoteKind},
    error::{CommandError, CommandErrorCode},
    storage::{
        atomic_file::{atomic_replace_contained, PublishFailure, PublishResult},
        markdown::commonmark_prose_ranges,
        rebuild::rebuild_index,
        repository::{DocumentWriter, LinkRepository, NoteRepository},
    },
};
use std::{fs, sync::mpsc, thread, time::Duration};
use support::{create_note, note_id, LinkFixture, TestStore};

const TARGET: &str = "019c0000-0000-7000-8000-000000000022";
const SOURCE_A: &str = "019c0000-0000-7000-8000-000000000021";
const SOURCE_B: &str = "019c0000-0000-7000-8000-000000000023";
const TEMP: &str = "019c0000-0000-7000-8000-000000000024";
const MISSING: &str = "019c0000-0000-7000-8000-000000000025";

#[test]
fn shared_contextual_vectors_match_rust_commonmark_prose_ranges() {
    let contract: serde_json::Value =
        serde_json::from_str(include_str!("../../src/shared/internal-link-contract.json")).unwrap();
    for vector in contract["contextual"].as_array().unwrap() {
        let markdown = vector["markdown"].as_str().unwrap();
        let from = markdown.find("[[").unwrap();
        let to = markdown.rfind("]]").unwrap() + 2;
        let covered = commonmark_prose_ranges(markdown)
            .iter()
            .any(|range| range.start <= from && range.end >= to);
        assert_eq!(
            covered,
            vector["allowed"].as_bool().unwrap(),
            "contextual vector {}",
            vector["name"].as_str().unwrap()
        );
    }
}

#[test]
fn save_indexes_only_exact_valid_links_with_byte_safe_unicode_ranges() {
    let store = TestStore::new();
    create_note(
        &store,
        note_id(TARGET),
        "Target",
        "target",
        "2026-07-30T08:00:00Z",
    );
    let markdown = format!(
        "😀 [[用户认证|{TARGET}]][[missing|{MISSING}]] [[ordinary]] [[bad|not-a-uuid]] [[nested [x]|{TARGET}]]"
    );
    create_note(
        &store,
        note_id(SOURCE_A),
        "Source",
        &markdown,
        "2026-07-30T08:01:00Z",
    );

    let connection = Connection::open(store.paths.database()).unwrap();
    let mut statement = connection.prepare(
        "SELECT target_note_id, visible_label, source_start, source_end FROM note_links WHERE source_note_id=?1 ORDER BY source_start",
    ).unwrap();
    let rows = statement
        .query_map([blob(SOURCE_A)], |row| {
            Ok((
                row.get::<_, Vec<u8>>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].1, "用户认证");
    assert_eq!(
        &markdown.as_bytes()[rows[0].2 as usize..rows[0].3 as usize],
        format!("[[用户认证|{TARGET}]]").as_bytes()
    );
    assert_eq!(
        rows[1].0,
        blob(MISSING),
        "valid missing targets remain indexable and unresolved"
    );
}

#[test]
fn index_and_rename_touch_only_commonmark_prose_links() {
    let store = TestStore::new();
    create_note(
        &store,
        note_id(TARGET),
        "Target",
        "target",
        "2026-07-30T08:00:00Z",
    );
    let raw = format!("[[Old|{TARGET}]]");
    let markdown = format!(
        "prose {raw}\ninline `{raw}` code\n\n    {raw}\n\n```md\n{raw}\n```\n\n[outer {raw}](https://example.invalid)\n![alt {raw}](assets/example.png)\n<span>{raw}</span>"
    );
    create_note(
        &store,
        note_id(SOURCE_A),
        "Source",
        &markdown,
        "2026-07-30T08:01:00Z",
    );

    let indexed: i64 = Connection::open(store.paths.database())
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM note_links WHERE source_note_id=?1 AND target_note_id=?2",
            params![blob(SOURCE_A), blob(TARGET)],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(indexed, 1);

    let result = LinkRepository::new(store.paths.clone())
        .rename_target_labels(note_id(TARGET), "New")
        .unwrap();
    assert_eq!(result.updated, 1);
    let expected = markdown.replacen(&raw, &format!("[[New|{TARGET}]]"), 1);
    assert_eq!(
        NoteRepository::new(store.paths.clone())
            .load(note_id(SOURCE_A))
            .unwrap()
            .markdown,
        expected
    );
}

#[test]
fn index_and_repair_recognize_emphasis_and_strong_titles_as_prose_links() {
    let store = TestStore::new();
    create_note(
        &store,
        note_id(TARGET),
        "**Bold**",
        "target",
        "2026-07-30T08:00:00Z",
    );
    let markdown = format!("strong [[**Bold**|{TARGET}]] and emphasis [[*Italic*|{TARGET}]]");
    create_note(
        &store,
        note_id(SOURCE_A),
        "Source",
        &markdown,
        "2026-07-30T08:01:00Z",
    );

    let connection = Connection::open(store.paths.database()).unwrap();
    let labels = connection
        .prepare(
            "SELECT visible_label FROM note_links WHERE source_note_id=?1 ORDER BY source_start",
        )
        .unwrap()
        .query_map([blob(SOURCE_A)], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(labels, vec!["**Bold**", "*Italic*"]);

    let repair = LinkRepository::new(store.paths.clone())
        .rename_target_labels(note_id(TARGET), "**Fresh**")
        .unwrap();
    assert_eq!(repair.updated, 1);
    assert!(repair.failed_source_ids.is_empty());
    assert_eq!(
        NoteRepository::new(store.paths.clone())
            .load(note_id(SOURCE_A))
            .unwrap()
            .markdown,
        format!("strong [[**Fresh**|{TARGET}]] and emphasis [[**Fresh**|{TARGET}]]")
    );
    let repaired_labels = connection
        .prepare(
            "SELECT visible_label FROM note_links WHERE source_note_id=?1 ORDER BY source_start",
        )
        .unwrap()
        .query_map([blob(SOURCE_A)], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(repaired_labels, vec!["**Fresh**", "**Fresh**"]);
}

#[test]
fn rename_note_returns_the_authoritative_revision_after_atomic_link_repair() {
    let store = TestStore::new();
    let self_link = format!("self [[Old|{TARGET}]]");
    create_note(
        &store,
        note_id(TARGET),
        "Old",
        &self_link,
        "2026-07-30T08:00:00Z",
    );
    create_note(
        &store,
        note_id(SOURCE_A),
        "Source",
        &format!("source [[Old|{TARGET}]]"),
        "2026-07-30T08:01:00Z",
    );

    let result = rename_note_in_storage(&store.paths, note_id(TARGET), "New").unwrap();

    assert_eq!(result.document.id, note_id(TARGET));
    assert_eq!(result.document.title, "New");
    assert_eq!(
        result.document.revision, 2,
        "title update plus self-link repair"
    );
    assert_eq!(result.document.markdown, format!("self [[New|{TARGET}]]"));
    assert_eq!(result.link_repair.updated, 2);
    assert!(result.link_repair.failed_source_ids.is_empty());
    assert_eq!(
        NoteRepository::new(store.paths.clone())
            .load(note_id(SOURCE_A))
            .unwrap()
            .markdown,
        format!("source [[New|{TARGET}]]")
    );
}

#[test]
fn rename_returns_the_authoritative_self_link_revision_when_repair_indexing_fails() {
    let store = TestStore::new();
    create_note(
        &store,
        note_id(TARGET),
        "Old",
        &format!("self [[Old|{TARGET}]]"),
        "2026-07-30T08:00:00Z",
    );
    Connection::open(store.paths.database())
        .unwrap()
        .execute_batch(&format!(
            "CREATE TRIGGER fail_new_self_link BEFORE INSERT ON note_links \
             WHEN hex(NEW.source_note_id)=upper('{}') AND NEW.visible_label='New' \
             BEGIN SELECT RAISE(ABORT, 'injected'); END;",
            TARGET.replace('-', "")
        ))
        .unwrap();

    let result = rename_note_in_storage(&store.paths, note_id(TARGET), "New").unwrap();

    assert_eq!(result.document.title, "New");
    assert_eq!(result.document.revision, 2);
    assert_eq!(result.document.markdown, format!("self [[New|{TARGET}]]"));
    assert_eq!(result.link_repair.failed_source_ids, vec![note_id(TARGET)]);
    assert!(result.link_repair.failure.is_none());
    Connection::open(store.paths.database())
        .unwrap()
        .execute("DROP TRIGGER fail_new_self_link", [])
        .unwrap();
    let mut edited = result.document;
    edited.markdown.push_str(" edited");
    let saved = NoteRepository::new(store.paths.clone())
        .save(edited, 2)
        .unwrap();
    assert_eq!(saved.revision, 3);
}

#[test]
fn rename_returns_the_committed_document_when_link_source_enumeration_fails() {
    let store = TestStore::new();
    create_note(
        &store,
        note_id(TARGET),
        "Old",
        "body",
        "2026-07-30T08:00:00Z",
    );

    let result = rename_note_in_storage_with_repair(
        &store.paths,
        note_id(TARGET),
        "New",
        |_links, _target_id, _title, _guard| {
            Err(CommandError::io(
                "injected formal note collection enumeration failure",
            ))
        },
    )
    .unwrap();

    assert_eq!(result.document.title, "New");
    assert_eq!(result.document.revision, 1);
    assert_eq!(
        result.link_repair.failure.as_ref().unwrap().code,
        CommandErrorCode::Io
    );
    let notes = NoteRepository::new(store.paths.clone());
    let mut edited = result.document;
    edited.markdown = "edited after partial repair".into();
    let saved = notes.save(edited, 1).unwrap();
    assert_eq!(saved.revision, 2);
    assert_eq!(saved.markdown, "edited after partial repair");
}

#[test]
fn rebuild_recreates_link_rows_from_durable_markdown_after_database_deletion() {
    let mut fixture = LinkFixture::linked_notes("Old title");
    fixture.store.close_database();
    fs::remove_file(fixture.store.paths.database()).unwrap();

    rebuild_index(&fixture.store.paths).unwrap();

    let connection = Connection::open(fixture.store.paths.database()).unwrap();
    let count = connection
        .query_row(
            "SELECT COUNT(*) FROM note_links WHERE source_note_id=?1 AND target_note_id=?2",
            params![blob(SOURCE_A), blob(TARGET)],
            |row| row.get::<_, i64>(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    assert!(fixture
        .source_markdown()
        .contains(&format!("[[Old title|{TARGET}]]")));
}

#[test]
fn rename_discovers_durable_links_when_their_index_rows_are_missing() {
    let fixture = LinkFixture::linked_notes("Old");
    Connection::open(fixture.store.paths.database())
        .unwrap()
        .execute(
            "DELETE FROM note_links WHERE source_note_id=?1",
            [blob(SOURCE_A)],
        )
        .unwrap();

    let result = LinkRepository::new(fixture.store.paths.clone())
        .rename_target_labels(fixture.target_id, "New")
        .unwrap();

    assert_eq!(result.updated, 1);
    assert!(result.failed_source_ids.is_empty());
    assert!(fixture
        .source_markdown()
        .contains(&format!("[[New|{TARGET}]]")));
}

#[test]
fn rename_reports_unreadable_durable_sources_and_retries_after_they_are_repaired() {
    let fixture = LinkFixture::linked_notes("Old");
    let malformed_id = note_id(SOURCE_B);
    let missing_id = note_id(MISSING);
    let malformed_dir = fixture.store.paths.notes().join(SOURCE_B);
    let missing_dir = fixture.store.paths.notes().join(MISSING);
    create_note(
        &fixture.store,
        malformed_id,
        "Recovered",
        &format!("[[Old|{TARGET}]]"),
        "2026-07-30T08:03:00Z",
    );
    let valid_source = fs::read(malformed_dir.join("note.md")).unwrap();
    Connection::open(fixture.store.paths.database())
        .unwrap()
        .execute(
            "DELETE FROM note_links WHERE source_note_id=?1",
            [blob(SOURCE_B)],
        )
        .unwrap();
    fs::write(
        malformed_dir.join("note.md"),
        b"---\ninvalid: [\n---\nbroken",
    )
    .unwrap();
    fs::create_dir(&missing_dir).unwrap();

    let first = LinkRepository::new(fixture.store.paths.clone())
        .rename_target_labels(fixture.target_id, "New")
        .unwrap();

    assert_eq!(first.updated, 1);
    assert_eq!(first.failed_source_ids, vec![malformed_id, missing_id]);

    fs::write(malformed_dir.join("note.md"), valid_source).unwrap();
    fs::remove_dir(&missing_dir).unwrap();

    let retry = LinkRepository::new(fixture.store.paths.clone())
        .rename_target_labels(fixture.target_id, "New")
        .unwrap();

    assert_eq!(retry.updated, 1);
    assert!(retry.failed_source_ids.is_empty());
    assert!(NoteRepository::new(fixture.store.paths.clone())
        .load(malformed_id)
        .unwrap()
        .markdown
        .contains(&format!("[[New|{TARGET}]]")));
}

#[test]
fn escaped_labels_round_trip_and_malformed_escapes_are_not_indexed() {
    let store = TestStore::new();
    create_note(
        &store,
        note_id(TARGET),
        "Target",
        "body",
        "2026-07-30T08:00:00Z",
    );
    let markdown = format!(
        r"[[plain title|{TARGET}]] [[a\\b\|c\[d\]😀|{TARGET}]] [[bad\q|{TARGET}]] [[trailing\|{TARGET}]]"
    );
    create_note(
        &store,
        note_id(SOURCE_A),
        "Source",
        &markdown,
        "2026-07-30T08:01:00Z",
    );

    let connection = Connection::open(store.paths.database()).unwrap();
    let labels = connection
        .prepare(
            "SELECT visible_label FROM note_links WHERE source_note_id=?1 ORDER BY source_start",
        )
        .unwrap()
        .query_map([blob(SOURCE_A)], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();

    assert_eq!(labels, vec!["plain title", "a\\b|c[d]😀"]);
}

#[test]
fn rename_escapes_special_characters_and_reindex_decodes_the_same_label() {
    let fixture = LinkFixture::linked_notes("Old");
    let title = r"a\b|c[d]😀";

    let result = LinkRepository::new(fixture.store.paths.clone())
        .rename_target_labels(fixture.target_id, title)
        .unwrap();

    assert_eq!(result.updated, 1);
    assert_eq!(
        fixture.source_markdown(),
        format!(r"before [[a\\b\|c\[d\]😀|{TARGET}]] after")
    );
    let stored_label: String = Connection::open(fixture.store.paths.database())
        .unwrap()
        .query_row(
            "SELECT visible_label FROM note_links WHERE source_note_id=?1",
            [blob(SOURCE_A)],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored_label, title);
}

#[test]
fn resolve_returns_only_formal_non_deleted_notes() {
    let store = TestStore::new();
    create_note(
        &store,
        note_id(TARGET),
        "Formal",
        "body",
        "2026-07-30T08:00:00Z",
    );
    NoteRepository::new(store.paths.clone())
        .create(NoteDocument {
            id: note_id(TEMP),
            kind: NoteKind::Temporary,
            title: "Temporary".into(),
            folder_id: None,
            tags: vec![],
            markdown: "body".into(),
            revision: 0,
            created_at: "2026-07-30T08:00:00Z".into(),
            updated_at: "2026-07-30T08:00:00Z".into(),
        })
        .unwrap();
    let links = LinkRepository::new(store.paths.clone());
    assert_eq!(
        links.resolve(note_id(TARGET)).unwrap().unwrap().title,
        "Formal"
    );
    assert!(links.resolve(note_id(TEMP)).unwrap().is_none());
    assert!(links.resolve(note_id(MISSING)).unwrap().is_none());
    Connection::open(store.paths.database())
        .unwrap()
        .execute(
            "UPDATE notes SET deleted_at='2026-07-30T09:00:00Z' WHERE id=?1",
            [blob(TARGET)],
        )
        .unwrap();
    assert!(links.resolve(note_id(TARGET)).unwrap().is_none());
}

#[test]
fn backlinks_deduplicate_sources_and_order_by_newest_then_title_then_id() {
    let store = TestStore::new();
    create_note(
        &store,
        note_id(TARGET),
        "Target",
        "self",
        "2026-07-30T08:00:00Z",
    );
    create_note(
        &store,
        note_id(SOURCE_A),
        "Zulu",
        &format!("[[one|{TARGET}]] and [[two|{TARGET}]]"),
        "2026-07-30T09:00:00Z",
    );
    create_note(
        &store,
        note_id(SOURCE_B),
        "Alpha",
        &format!("[[target|{TARGET}]]"),
        "2026-07-30T09:00:00Z",
    );
    let results = LinkRepository::new(store.paths.clone())
        .backlinks(note_id(TARGET))
        .unwrap();
    assert_eq!(
        results.iter().map(|item| item.id).collect::<Vec<_>>(),
        vec![note_id(SOURCE_B), note_id(SOURCE_A)]
    );
    assert_eq!(results[0].excerpt, format!("[[target|{TARGET}]]"));
}

#[test]
fn rename_updates_all_matching_labels_once_per_source_without_changing_ids_or_other_bytes() {
    let fixture = LinkFixture::linked_notes("Old title");
    let repository = NoteRepository::new(fixture.store.paths.clone());
    let mut source = repository.load(fixture.source_id).unwrap();
    source.markdown =
        format!("前😀 [[Old title|{TARGET}]] middle [[stale|{TARGET}]] [[other|{MISSING}]] 后");
    repository.save(source, 0).unwrap();
    let mut target = repository.load(fixture.target_id).unwrap();
    target.markdown = format!("self [[Old title|{TARGET}]]");
    repository.save(target, 0).unwrap();

    let result = LinkRepository::new(fixture.store.paths.clone())
        .rename_target_labels(fixture.target_id, "新的标题😀")
        .unwrap();

    assert_eq!(result.updated, 2);
    assert!(result.failed_source_ids.is_empty());
    assert_eq!(
        repository.load(fixture.source_id).unwrap().markdown,
        format!(
            "前😀 [[新的标题😀|{TARGET}]] middle [[新的标题😀|{TARGET}]] [[other|{MISSING}]] 后"
        )
    );
    assert_eq!(
        repository.load(fixture.target_id).unwrap().markdown,
        format!("self [[新的标题😀|{TARGET}]]")
    );
}

#[test]
fn per_source_write_failure_is_partial_deterministic_and_retry_repairs_only_the_remaining_source() {
    let store = TestStore::new();
    create_note(
        &store,
        note_id(TARGET),
        "Target",
        "body",
        "2026-07-30T08:00:00Z",
    );
    create_note(
        &store,
        note_id(SOURCE_A),
        "A",
        &format!("left [[Old|{TARGET}]]"),
        "2026-07-30T08:01:00Z",
    );
    create_note(
        &store,
        note_id(SOURCE_B),
        "B",
        &format!("right [[Old|{TARGET}]]"),
        "2026-07-30T08:02:00Z",
    );

    let result =
        LinkRepository::new_with_writer(store.paths.clone(), fail_source_b as DocumentWriter)
            .rename_target_labels(note_id(TARGET), "New")
            .unwrap();
    assert_eq!(result.updated, 1);
    assert_eq!(result.failed_source_ids, vec![note_id(SOURCE_B)]);
    assert!(NoteRepository::new(store.paths.clone())
        .load(note_id(SOURCE_A))
        .unwrap()
        .markdown
        .contains("[[New|"));
    assert!(NoteRepository::new(store.paths.clone())
        .load(note_id(SOURCE_B))
        .unwrap()
        .markdown
        .contains("[[Old|"));

    let retry = LinkRepository::new(store.paths.clone())
        .rename_target_labels(note_id(TARGET), "New")
        .unwrap();
    assert_eq!(retry.updated, 1);
    assert!(retry.failed_source_ids.is_empty());
    assert!(NoteRepository::new(store.paths.clone())
        .load(note_id(SOURCE_A))
        .unwrap()
        .markdown
        .contains("[[New|"));
    assert!(NoteRepository::new(store.paths.clone())
        .load(note_id(SOURCE_B))
        .unwrap()
        .markdown
        .contains("[[New|"));
}

#[test]
fn index_failure_after_durable_repair_is_reported_and_retry_reindexes_current_markdown() {
    let fixture = LinkFixture::linked_notes("Old");
    Connection::open(fixture.store.paths.database()).unwrap().execute_batch(&format!(
        "CREATE TRIGGER fail_link_reindex BEFORE INSERT ON note_links WHEN hex(NEW.source_note_id)=upper('{}') BEGIN SELECT RAISE(ABORT, 'injected'); END;",
        SOURCE_A.replace('-', "")
    )).unwrap();
    let first = LinkRepository::new(fixture.store.paths.clone())
        .rename_target_labels(fixture.target_id, "New")
        .unwrap();
    assert_eq!(first.updated, 0);
    assert_eq!(first.failed_source_ids, vec![fixture.source_id]);
    assert!(
        fixture.source_markdown().contains("[[New|"),
        "durable publication happened before index failure"
    );
    Connection::open(fixture.store.paths.database())
        .unwrap()
        .execute("DROP TRIGGER fail_link_reindex", [])
        .unwrap();

    let retry = LinkRepository::new(fixture.store.paths.clone())
        .rename_target_labels(fixture.target_id, "New")
        .unwrap();
    assert_eq!(retry.updated, 0);
    assert!(retry.failed_source_ids.is_empty());
    let label: String = Connection::open(fixture.store.paths.database())
        .unwrap()
        .query_row(
            "SELECT visible_label FROM note_links WHERE source_note_id=?1",
            [blob(SOURCE_A)],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(label, "New");
}

#[test]
fn repair_waits_for_the_cross_process_mutation_lock_instead_of_reentering_it() {
    let fixture = LinkFixture::linked_notes("Old");
    let paths = fixture.store.paths.clone();
    let target = fixture.target_id;
    let guard = simple_notes_lib::platform::IndexMutationLock::acquire(paths.root()).unwrap();
    let (sent, received) = mpsc::channel();
    let worker = thread::spawn(move || {
        let result = LinkRepository::new(paths).rename_target_labels(target, "New");
        sent.send(result).unwrap();
    });
    assert!(received.recv_timeout(Duration::from_millis(150)).is_err());
    drop(guard);
    let result = received
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    assert_eq!(result.updated, 1);
    worker.join().unwrap();
}

#[test]
fn public_load_waits_for_the_mutation_lock_before_reading_or_recovering() {
    let fixture = LinkFixture::linked_notes("Old");
    let paths = fixture.store.paths.clone();
    let source_id = fixture.source_id;
    let guard = simple_notes_lib::platform::IndexMutationLock::acquire(paths.root()).unwrap();
    let (sent, received) = mpsc::channel();
    let worker = thread::spawn(move || {
        let result = NoteRepository::new(paths).load(source_id);
        sent.send(result).unwrap();
    });

    assert!(received.recv_timeout(Duration::from_millis(150)).is_err());
    drop(guard);
    assert_eq!(
        received
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap()
            .id,
        source_id
    );
    worker.join().unwrap();
}

fn blob(value: &str) -> Vec<u8> {
    uuid::Uuid::parse_str(value).unwrap().as_bytes().to_vec()
}

fn fail_source_b(
    paths: &simple_notes_lib::storage::paths::StoragePaths,
    id: NoteId,
    kind: NoteKind,
    bytes: &[u8],
) -> PublishResult {
    if id == note_id(SOURCE_B) {
        return Err(PublishFailure::not_published(
            simple_notes_lib::error::CommandError::io("injected source write failure"),
        ));
    }
    let id_string = id.to_string();
    atomic_replace_contained(
        paths.root(),
        &[
            match kind {
                NoteKind::Formal => "notes",
                NoteKind::Temporary => "temporary",
            },
            id_string.as_str(),
        ],
        "note.md",
        bytes,
    )
}
