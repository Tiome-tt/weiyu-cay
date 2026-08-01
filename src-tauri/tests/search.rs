mod support;

use rusqlite::{params, Connection};
use simple_notes_lib::{
    commands::search::SearchRepository,
    domain::{FolderId, NoteDocument, NoteId, NoteKind},
    error::CommandErrorCode,
    storage::{
        atomic_file::PublishFailure, markdown::plain_text_from_markdown, rebuild::rebuild_index,
        repository::NoteRepository,
    },
};
use std::fs;
use support::TestStore;

const NOTE_A: &str = "019c0000-0000-7000-8000-000000000041";
const NOTE_B: &str = "019c0000-0000-7000-8000-000000000042";
const NOTE_C: &str = "019c0000-0000-7000-8000-000000000043";
const TEMP: &str = "019c0000-0000-7000-8000-000000000044";
const ROOT_FOLDER: &str = "019c0000-0000-7000-8000-000000000051";
const CHILD_FOLDER: &str = "019c0000-0000-7000-8000-000000000052";

#[test]
fn tag_search_ranks_exact_prefix_then_substring_and_returns_complete_context() {
    let store = seeded_store();
    create_note(
        &store,
        NOTE_A,
        "Exact",
        NoteKind::Formal,
        vec!["Rust", "Backend"],
        "2026-07-31T08:03:00Z",
    );
    create_note(
        &store,
        NOTE_B,
        "Prefix",
        NoteKind::Formal,
        vec!["Rustacean"],
        "2026-07-31T08:02:00Z",
    );
    create_note(
        &store,
        NOTE_C,
        "Substring",
        NoteKind::Formal,
        vec!["Trust", "Book"],
        "2026-07-31T08:01:00Z",
    );
    create_note(
        &store,
        TEMP,
        "Temporary",
        NoteKind::Temporary,
        vec!["Rust"],
        "2026-07-31T09:00:00Z",
    );
    let search = SearchRepository::new(store.paths.clone());

    let results = search.search_tag("ＲＵＳＴ", 20).unwrap();

    assert_eq!(
        results
            .iter()
            .map(|item| item.title.as_str())
            .collect::<Vec<_>>(),
        vec!["Exact", "Prefix", "Substring"]
    );
    assert_eq!(results[0].tags, vec!["Backend", "Rust"]);
    assert_eq!(results[0].folder_breadcrumb, vec!["Work", "Project B"]);
    assert!(results[0].score > results[1].score && results[1].score > results[2].score);
}

#[test]
fn search_deduplicates_notes_escapes_like_metacharacters_and_keeps_injection_inert() {
    let store = seeded_store();
    create_note(
        &store,
        NOTE_A,
        "Literal",
        NoteKind::Formal,
        vec!["100%", "under_score", r"path\tag"],
        "2026-07-31T08:00:00Z",
    );
    create_note(
        &store,
        NOTE_B,
        "Wildcard",
        NoteKind::Formal,
        vec!["1000", "underXscore"],
        "2026-07-31T08:00:00Z",
    );
    let search = SearchRepository::new(store.paths.clone());

    assert_eq!(search.search_tag("%", 20).unwrap().len(), 1);
    assert_eq!(search.search_tag("_", 20).unwrap().len(), 1);
    assert_eq!(search.search_tag(r"\", 20).unwrap().len(), 1);
    assert!(search.search_tag("%' OR 1=1 --", 20).unwrap().is_empty());
    assert_eq!(search.search_tag("100", 20).unwrap().len(), 2);
}

#[test]
fn tag_update_is_durable_first_preserves_first_display_and_rebuilds_identically() {
    let mut store = seeded_store();
    create_note(
        &store,
        NOTE_A,
        "First",
        NoteKind::Formal,
        vec!["TypeScript"],
        "2026-07-31T08:00:00Z",
    );
    create_note(
        &store,
        NOTE_B,
        "Second",
        NoteKind::Formal,
        vec![],
        "2026-07-31T08:01:00Z",
    );
    let search = SearchRepository::new(store.paths.clone());
    let updated = search
        .update_tags(
            note_id(NOTE_B),
            vec!["  typescript  ".into(), " 后端 ".into()],
        )
        .unwrap();
    assert_eq!(updated.tags, vec!["TypeScript", "后端"]);
    assert_eq!(updated.revision, 1);
    let markdown = fs::read_to_string(
        store
            .paths
            .note_dir(note_id(NOTE_B), NoteKind::Formal)
            .unwrap()
            .join("note.md"),
    )
    .unwrap();
    assert!(markdown.contains("- TypeScript") && markdown.contains("- 后端"));

    store.close_database();
    fs::remove_file(store.paths.database()).unwrap();
    rebuild_index(&store.paths).unwrap();
    let rebuilt = SearchRepository::new(store.paths.clone())
        .search_tag("typescript", 20)
        .unwrap();
    assert_eq!(rebuilt.len(), 2);
    assert!(rebuilt
        .iter()
        .all(|item| item.tags.contains(&"TypeScript".to_owned())));
}

#[test]
fn injected_document_write_failure_leaves_file_and_tag_index_unchanged() {
    let store = seeded_store();
    create_note(
        &store,
        NOTE_A,
        "Safe",
        NoteKind::Formal,
        vec!["kept"],
        "2026-07-31T08:00:00Z",
    );
    let before = fs::read(
        store
            .paths
            .note_dir(note_id(NOTE_A), NoteKind::Formal)
            .unwrap()
            .join("note.md"),
    )
    .unwrap();
    let search = SearchRepository::new_with_writer(store.paths.clone(), failing_writer);

    let error = search
        .update_tags(note_id(NOTE_A), vec!["lost".into()])
        .unwrap_err();

    assert_eq!(error.code(), CommandErrorCode::Io);
    assert_eq!(
        fs::read(
            store
                .paths
                .note_dir(note_id(NOTE_A), NoteKind::Formal)
                .unwrap()
                .join("note.md")
        )
        .unwrap(),
        before
    );
    assert_eq!(
        SearchRepository::new(store.paths.clone())
            .search_tag("kept", 20)
            .unwrap()
            .len(),
        1
    );
    assert!(SearchRepository::new(store.paths.clone())
        .search_tag("lost", 20)
        .unwrap()
        .is_empty());
}

#[test]
fn search_clamps_limits_and_rejects_empty_control_and_overlong_queries() {
    let store = seeded_store();
    create_note(
        &store,
        NOTE_A,
        "A",
        NoteKind::Formal,
        vec!["shared"],
        "2026-07-31T08:00:00Z",
    );
    create_note(
        &store,
        NOTE_B,
        "B",
        NoteKind::Formal,
        vec!["shared"],
        "2026-07-31T08:00:00Z",
    );
    let search = SearchRepository::new(store.paths.clone());
    let limited = search.search_tag("shared", 1).unwrap();
    assert_eq!(limited.len(), 1);
    assert_eq!(limited[0].title, "A");
    for query in ["", "bad\u{7}", &"a".repeat(257)] {
        assert_eq!(
            search.search_tag(query, 20).unwrap_err().code(),
            CommandErrorCode::Validation
        );
    }
}

#[test]
fn tag_updates_apply_nfkc_whitespace_and_case_rules_and_reject_invalid_values() {
    let store = seeded_store();
    create_note(
        &store,
        NOTE_A,
        "Normalize",
        NoteKind::Formal,
        vec![],
        "2026-07-31T08:00:00Z",
    );
    let search = SearchRepository::new(store.paths.clone());
    let updated = search
        .update_tags(
            note_id(NOTE_A),
            vec![" Ｆｏｏ\t Bar ".into(), " 后端 ".into()],
        )
        .unwrap();
    assert_eq!(updated.tags, vec!["Foo Bar", "后端"]);
    assert_eq!(search.search_tag("foo bar", 20).unwrap().len(), 1);
    assert_eq!(search.search_tag("后端", 20).unwrap().len(), 1);

    for invalid in [
        vec!["Foo".into(), " foo ".into()],
        vec!["bad\u{7}".into()],
        vec!["a".repeat(81)],
    ] {
        assert_eq!(
            search
                .update_tags(note_id(NOTE_A), invalid)
                .unwrap_err()
                .code(),
            CommandErrorCode::Validation
        );
    }
    assert_eq!(
        SearchRepository::new(store.paths.clone())
            .search_tag("foo bar", 20)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn normalization_vectors_match_the_renderer_case_fold_and_explicit_whitespace() {
    let store = seeded_store();
    create_note(
        &store,
        NOTE_A,
        "Parity",
        NoteKind::Formal,
        vec![],
        "2026-07-31T08:00:00Z",
    );
    let search = SearchRepository::new(store.paths.clone());
    let updated = search
        .update_tags(
            note_id(NOTE_A),
            vec![
                "Straße".into(),
                "ΟΣ".into(),
                "Ａ\u{85} B\u{feff}中 文".into(),
            ],
        )
        .unwrap();
    assert_eq!(updated.tags, vec!["Straße", "ΟΣ", "A B 中 文"]);
    assert_eq!(search.search_tag("STRASSE", 20).unwrap().len(), 1);
    assert_eq!(search.search_tag("ος", 20).unwrap().len(), 1);
    assert_eq!(search.search_tag("a b 中", 20).unwrap().len(), 1);
    assert_eq!(
        search
            .update_tags(note_id(NOTE_A), vec!["bad\u{9f}".into()])
            .unwrap_err()
            .code(),
        CommandErrorCode::Validation,
    );
}

#[test]
fn one_note_matching_two_tags_is_returned_once() {
    let store = seeded_store();
    create_note(
        &store,
        NOTE_A,
        "Deduplicated",
        NoteKind::Formal,
        vec!["Rust book", "Trust"],
        "2026-07-31T08:00:00Z",
    );
    let results = SearchRepository::new(store.paths.clone())
        .search_tag("rust", 20)
        .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].title, "Deduplicated");
}

#[test]
fn plain_text_extraction_keeps_meaning_and_discards_markup_and_raw_html() {
    let markdown = "---\ntitle: hidden\n---\n# 登录流程\n\n- **刷新** [令牌](https://example.test)\n- ![错误截图](asset.png)\n\n`status_code`\n\n<script>alert('secret')</script>";

    let plain = plain_text_from_markdown(markdown);

    assert!(plain.contains("登录流程"));
    assert!(plain.contains("刷新 令牌"));
    assert!(plain.contains("错误截图"));
    assert!(plain.contains("status_code"));
    assert!(!plain.contains("---"));
    assert!(!plain.contains("**"));
    assert!(!plain.contains("script"));
    assert!(!plain.contains("alert"));
    assert!(!plain.contains("https://"));
}

#[test]
fn text_search_matches_chinese_title_body_and_short_queries() {
    let store = seeded_store();
    create_note_with_markdown(
        &store,
        NOTE_A,
        "登录流程",
        NoteKind::Formal,
        vec!["后端"],
        "刷新令牌失败后的处理",
        "2026-07-31T08:03:00Z",
    );
    let search = SearchRepository::new(store.paths.clone());

    assert_eq!(search.search_text("登录", 20).unwrap().len(), 1);
    assert_eq!(search.search_text("令牌失败", 20).unwrap().len(), 1);
    assert_eq!(search.search_text("令", 20).unwrap().len(), 1);
    assert_eq!(search.search_text("令牌", 20).unwrap().len(), 1);
}

#[test]
fn text_search_is_literal_ranked_filtered_and_returns_bounded_context() {
    let store = seeded_store();
    create_note_with_markdown(
        &store,
        NOTE_A,
        "Token failure",
        NoteKind::Formal,
        vec!["Backend"],
        "ordinary body",
        "2026-07-31T08:01:00Z",
    );
    create_note_with_markdown(&store, NOTE_B, "Body match", NoteKind::Formal, vec!["Ops"], "A token failure happened during refresh. This sentence provides enough context around the first match for clipping.", "2026-07-31T08:02:00Z");
    create_note_with_markdown(
        &store,
        NOTE_C,
        "Deleted",
        NoteKind::Formal,
        vec![],
        "token failure",
        "2026-07-31T08:03:00Z",
    );
    create_note_with_markdown(
        &store,
        TEMP,
        "Temporary",
        NoteKind::Temporary,
        vec![],
        "token failure",
        "2026-07-31T08:04:00Z",
    );
    let connection = Connection::open(store.paths.database()).unwrap();
    connection
        .execute(
            "UPDATE notes SET deleted_at = '2026-07-31T09:00:00Z' WHERE id = ?1",
            [folder_blob(NOTE_C)],
        )
        .unwrap();
    drop(connection);
    let search = SearchRepository::new(store.paths.clone());

    let results = search.search_text("token failure", 1000).unwrap();
    assert_eq!(
        results
            .iter()
            .map(|item| item.title.as_str())
            .collect::<Vec<_>>(),
        vec!["Token failure", "Body match"]
    );
    assert_eq!(results[1].folder_breadcrumb, vec!["Work", "Project B"]);
    assert_eq!(results[1].tags, vec!["Ops"]);
    assert!(results[0].score > results[1].score);
    assert!(results[1].excerpt.chars().count() <= 180);

    for literal in [
        "%",
        "_",
        r"\",
        "\"",
        "OR",
        "NEAR(token failure)",
        "token*",
        "' OR 1=1 --",
    ] {
        let _ = search.search_text(literal, 20).unwrap();
    }
}

#[test]
fn text_search_excerpt_clips_both_unicode_boundaries_within_the_limit() {
    let store = seeded_store();
    let body = format!("{}匹配词{}", "前".repeat(120), "后".repeat(120));
    create_note_with_markdown(
        &store,
        NOTE_A,
        "摘要",
        NoteKind::Formal,
        vec![],
        &body,
        "2026-07-31T08:00:00Z",
    );

    let excerpt = SearchRepository::new(store.paths.clone())
        .search_text("匹配词", 20)
        .unwrap()
        .remove(0)
        .excerpt;

    assert!(excerpt.starts_with('…'));
    assert!(excerpt.ends_with('…'));
    assert!(excerpt.contains("匹配词"));
    assert!(excerpt.chars().count() <= 160);
}

#[test]
fn version_one_migration_preserves_notes_and_backfills_search() {
    let root = tempfile::tempdir().unwrap();
    let paths = simple_notes_lib::storage::paths::StoragePaths::open(root.path()).unwrap();
    let connection = Connection::open(paths.database()).unwrap();
    connection
        .execute_batch(include_str!("../migrations/0001_initial.sql"))
        .unwrap();
    connection
        .execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (1, '2026-07-31T08:00:00Z')",
            [],
        )
        .unwrap();
    connection.execute(
        "INSERT INTO notes(id, kind, title, folder_id, relative_path, created_at, updated_at, revision, deleted_at) VALUES (?1, 'formal', 'Legacy token', NULL, 'notes/legacy', '2026-07-31T08:00:00Z', '2026-07-31T08:00:00Z', 0, NULL)",
        [folder_blob(NOTE_A)],
    ).unwrap();
    connection.execute(
        "INSERT INTO search_documents(note_id, title, plain_text) VALUES (?1, 'Legacy token', 'migrated body')",
        [folder_blob(NOTE_A)],
    ).unwrap();
    drop(connection);

    let database = simple_notes_lib::storage::database::Database::open(paths.database()).unwrap();
    database.migrate().unwrap();
    assert_eq!(database.applied_migration_versions().unwrap(), vec![1, 2]);
    drop(database);
    assert_eq!(
        SearchRepository::new(paths)
            .search_text("Legacy", 20)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn index_failure_keeps_durable_markdown_and_rebuild_repairs_text_search() {
    let mut store = seeded_store();
    create_note_with_markdown(
        &store,
        NOTE_A,
        "Recoverable",
        NoteKind::Formal,
        vec![],
        "old searchable body",
        "2026-07-31T08:00:00Z",
    );
    let connection = Connection::open(store.paths.database()).unwrap();
    connection.execute_batch(
        "CREATE TRIGGER reject_search_update BEFORE INSERT ON search_documents BEGIN SELECT RAISE(ABORT, 'injected index failure'); END;",
    ).unwrap();
    drop(connection);
    let repository = NoteRepository::new(
        store.paths.clone(),
        simple_notes_lib::storage::database::Database::open(store.paths.database()).unwrap(),
    );
    let mut document = repository.load(note_id(NOTE_A)).unwrap();
    document.markdown = "new repaired phrase".into();
    let error = repository.save(document, 0).unwrap_err();
    assert_eq!(error.code(), CommandErrorCode::Database);
    let durable = fs::read_to_string(
        store
            .paths
            .note_dir(note_id(NOTE_A), NoteKind::Formal)
            .unwrap()
            .join("note.md"),
    )
    .unwrap();
    assert!(durable.contains("new repaired phrase"));
    drop(repository);
    let connection = Connection::open(store.paths.database()).unwrap();
    connection
        .execute("DROP TRIGGER reject_search_update", [])
        .unwrap();
    drop(connection);
    store.close_database();

    rebuild_index(&store.paths).unwrap();

    assert_eq!(
        SearchRepository::new(store.paths.clone())
            .search_text("repaired phrase", 20)
            .unwrap()
            .len(),
        1
    );
}

fn seeded_store() -> TestStore {
    let store = TestStore::new();
    let _isolated_root = store.root.path();
    let connection = Connection::open(store.paths.database()).unwrap();
    connection
        .pragma_update(None, "foreign_keys", true)
        .unwrap();
    connection.execute(
        "INSERT INTO folders (id, parent_id, name, sort_order, created_at, updated_at) VALUES (?1, NULL, 'Work', 0, '2026-07-31T08:00:00Z', '2026-07-31T08:00:00Z')",
        params![folder_blob(ROOT_FOLDER)],
    ).unwrap();
    connection.execute(
        "INSERT INTO folders (id, parent_id, name, sort_order, created_at, updated_at) VALUES (?1, ?2, 'Project B', 0, '2026-07-31T08:00:00Z', '2026-07-31T08:00:00Z')",
        params![folder_blob(CHILD_FOLDER), folder_blob(ROOT_FOLDER)],
    ).unwrap();
    fs::write(
        store.paths.folders_manifest(),
        format!(r#"[
  {{"id":"{ROOT_FOLDER}","parentId":null,"name":"Work","sortOrder":0,"createdAt":"2026-07-31T08:00:00Z","updatedAt":"2026-07-31T08:00:00Z"}},
  {{"id":"{CHILD_FOLDER}","parentId":"{ROOT_FOLDER}","name":"Project B","sortOrder":0,"createdAt":"2026-07-31T08:00:00Z","updatedAt":"2026-07-31T08:00:00Z"}}
]"#),
    ).unwrap();
    store
}

fn create_note(
    store: &TestStore,
    id: &str,
    title: &str,
    kind: NoteKind,
    tags: Vec<&str>,
    updated_at: &str,
) {
    create_note_with_markdown(
        store,
        id,
        title,
        kind,
        tags,
        &format!("Body for {title}"),
        updated_at,
    )
}

fn create_note_with_markdown(
    store: &TestStore,
    id: &str,
    title: &str,
    kind: NoteKind,
    tags: Vec<&str>,
    markdown: &str,
    updated_at: &str,
) {
    NoteRepository::new(
        store.paths.clone(),
        simple_notes_lib::storage::database::Database::open(store.paths.database()).unwrap(),
    )
    .create(NoteDocument {
        id: note_id(id),
        kind,
        title: title.into(),
        folder_id: (kind == NoteKind::Formal).then(|| folder_id(CHILD_FOLDER)),
        tags: tags.into_iter().map(str::to_owned).collect(),
        markdown: markdown.into(),
        revision: 0,
        created_at: "2026-07-31T08:00:00Z".into(),
        updated_at: updated_at.into(),
    })
    .unwrap();
}

fn note_id(value: &str) -> NoteId {
    NoteId::parse_str(value).unwrap()
}
fn folder_id(value: &str) -> FolderId {
    FolderId::parse_str(value).unwrap()
}
fn folder_blob(value: &str) -> Vec<u8> {
    uuid::Uuid::parse_str(value).unwrap().as_bytes().to_vec()
}
fn failing_writer(
    _: &simple_notes_lib::storage::paths::StoragePaths,
    _: NoteId,
    _: NoteKind,
    _: &[u8],
) -> Result<simple_notes_lib::storage::atomic_file::PublishState, PublishFailure> {
    Err(PublishFailure::not_published(
        simple_notes_lib::error::CommandError::io("injected write failure"),
    ))
}
