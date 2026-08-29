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
fn tag_update_repairs_a_dirty_index_without_reentering_the_mutation_lock() {
    let mut store = seeded_store();
    create_note(
        &store,
        NOTE_A,
        "Dirty tags",
        NoteKind::Formal,
        vec!["before"],
        "2026-07-31T08:00:00Z",
    );
    Connection::open(store.paths.database())
        .unwrap()
        .execute(
            "UPDATE search_index_state SET needs_rebuild = 1 WHERE singleton = 1",
            [],
        )
        .unwrap();
    store.close_database();

    let updated = SearchRepository::new(store.paths.clone())
        .update_tags(note_id(NOTE_A), vec!["after".into()])
        .unwrap();

    assert_eq!(updated.tags, vec!["after"]);
    assert_eq!(updated.revision, 1);
    assert_eq!(
        SearchRepository::new(store.paths.clone())
            .search_tag("after", 20)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn tag_update_consumes_a_rebuild_marker_without_reentering_the_mutation_lock() {
    let mut store = seeded_store();
    create_note(
        &store,
        NOTE_A,
        "Marked tags",
        NoteKind::Formal,
        vec!["before"],
        "2026-07-31T08:00:00Z",
    );
    fs::write(store.paths.root().join("rebuild-needed.json"), b"{}").unwrap();
    store.close_database();

    let updated = SearchRepository::new(store.paths.clone())
        .update_tags(note_id(NOTE_A), vec!["after-marker".into()])
        .unwrap();

    assert_eq!(updated.tags, vec!["after-marker"]);
    assert!(!store.paths.root().join("rebuild-needed.json").exists());
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
fn plain_text_extraction_preserves_inline_adjacency_and_suppresses_script_style_payloads() {
    let markdown = "你**好**，前[链接](https://example.test)后\n\n<script>inline-secret</script><style>.hidden-secret { color: red }</style>\n\n<script/>self-closing-visible <scripture>scripture-visible</scripture> <styleguide>styleguide-visible</styleguide>\n\n| 列一 | 列二 |\n| --- | --- |\n| 单元 | 内容 |\n\n- [x] ~~完成~~";
    let plain = plain_text_from_markdown(markdown);
    assert!(plain.contains("你好,前链接后"));
    assert!(plain.contains("列一 列二"));
    assert!(plain.contains("单元 内容"));
    assert!(plain.contains("完成"));
    assert!(!plain.contains("inline-secret"));
    assert!(!plain.contains("hidden-secret"));
    assert!(plain.contains("self-closing-visible"));
    assert!(plain.contains("scripture-visible"));
    assert!(plain.contains("styleguide-visible"));
}

#[test]
fn text_index_and_query_share_nfkc_without_collapsing_internal_spaces() {
    let store = seeded_store();
    create_note_with_markdown(
        &store,
        NOTE_A,
        "Ｆｕｌｌｗｉｄｔｈ",
        NoteKind::Formal,
        vec![],
        "Cafe\u{301} keeps  two spaces",
        "2026-07-31T08:00:00Z",
    );
    let search = SearchRepository::new(store.paths.clone());
    assert_eq!(search.search_text("Fullwidth", 20).unwrap().len(), 1);
    assert_eq!(search.search_text("Ｃａｆé", 20).unwrap().len(), 1);
    assert_eq!(search.search_text("keeps  two", 20).unwrap().len(), 1);
    assert!(search.search_text("keeps two", 20).unwrap().is_empty());
}

#[test]
fn text_query_trims_application_boundary_whitespace_and_preserves_it_inside() {
    let store = seeded_store();
    create_note_with_markdown(
        &store,
        NOTE_A,
        "Boundary",
        NoteKind::Formal,
        vec![],
        "A\u{feff}B\u{85}C D E",
        "2026-07-31T08:00:00Z",
    );
    let search = SearchRepository::new(store.paths.clone());

    assert_eq!(
        search
            .search_text("\u{feff}\u{85}\u{a0}\u{2003}Boundary\u{202f}", 20)
            .unwrap()
            .len(),
        1,
    );
    assert_eq!(
        search
            .search_text("A\u{feff}B\u{85}C D E", 20)
            .unwrap()
            .len(),
        1,
    );
}

#[test]
fn strict_upgrade_keeps_old_index_dirty_until_every_durable_note_can_rebuild() {
    let root = tempfile::tempdir().unwrap();
    let paths = simple_notes_lib::storage::paths::StoragePaths::open(root.path()).unwrap();
    write_durable_note(&paths, NOTE_A, "Valid", "visible valid prose");
    let broken_dir = paths.note_dir(note_id(NOTE_B), NoteKind::Formal).unwrap();
    fs::create_dir_all(&broken_dir).unwrap();
    fs::write(broken_dir.join("note.md"), "---\ninvalid: [\n---\nbroken").unwrap();
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
    for (id, title) in [(NOTE_A, "Valid"), (NOTE_B, "Broken")] {
        connection.execute(
            "INSERT INTO notes(id, kind, title, folder_id, relative_path, created_at, updated_at, revision, deleted_at) VALUES (?1, 'formal', ?2, NULL, ?3, '2026-07-31T08:00:00Z', '2026-07-31T08:00:00Z', 0, NULL)",
            params![folder_blob(id), title, format!("notes/{id}")],
        ).unwrap();
        connection
            .execute(
                "INSERT INTO search_documents(note_id, title, plain_text) VALUES (?1, ?2, ?3)",
                params![folder_blob(id), title, format!("legacy raw {title}")],
            )
            .unwrap();
    }
    drop(connection);

    assert!(SearchRepository::new(paths.clone())
        .search_text("visible", 20)
        .is_err());
    assert!(!fs::read_dir(paths.root()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("rebuild-new")
    }));
    let old = Connection::open(paths.database()).unwrap();
    assert_eq!(
        old.query_row("SELECT COUNT(*) FROM notes", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        old.query_row(
            "SELECT needs_rebuild FROM search_index_state WHERE singleton=1",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    drop(old);

    write_durable_note(&paths, NOTE_B, "Repaired", "visible repaired prose");
    let results = SearchRepository::new(paths.clone())
        .search_text("visible", 20)
        .unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(
        Connection::open(paths.database())
            .unwrap()
            .query_row(
                "SELECT needs_rebuild FROM search_index_state WHERE singleton=1",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
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
}

#[test]
fn text_search_treats_metacharacters_and_injection_payloads_as_literal_content() {
    let store = seeded_store();
    let literals = [
        ("%", "prefix safe suffix"),
        ("_", "prefix safe suffix"),
        (r"\", "prefix safe suffix"),
        ("\"", "prefix safe suffix"),
        ("OR", "prefix boolean suffix"),
        ("NEAR(token failure)", "prefix NEAR token failure suffix"),
        ("token*", "prefix token suffix"),
        ("' OR 1=1 --", "prefix OR 1=1 suffix"),
    ];
    for (index, (literal, decoy_body)) in literals.into_iter().enumerate() {
        let target = format!("019c0000-0000-7000-8001-{index:012x}");
        let decoy = format!("019c0000-0000-7000-8002-{index:012x}");
        create_note_with_markdown(
            &store,
            &target,
            &format!("Literal {index}"),
            NoteKind::Formal,
            vec![],
            &format!("prefix {literal} suffix"),
            "2026-07-31T08:00:00Z",
        );
        create_note_with_markdown(
            &store,
            &decoy,
            &format!("Decoy {index}"),
            NoteKind::Formal,
            vec![],
            decoy_body,
            "2026-07-31T08:00:00Z",
        );
        let results = SearchRepository::new(store.paths.clone())
            .search_text(literal, 100)
            .unwrap();
        assert_eq!(
            results
                .iter()
                .map(|result| result.note_id)
                .collect::<Vec<_>>(),
            vec![note_id(&target)],
            "literal query {literal:?} must not match a decoy",
        );
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
    assert_eq!(
        database.applied_migration_versions().unwrap(),
        vec![1, 2, 3, 4]
    );
    drop(database);
    let migrated = Connection::open(paths.database()).unwrap();
    assert_eq!(
        migrated
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        1,
    );
    assert_eq!(
        migrated
            .query_row("SELECT COUNT(*) FROM search_documents", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1,
    );
    assert_eq!(
        migrated
            .query_row("SELECT COUNT(*) FROM search_documents_fts", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        0,
    );
}

#[test]
fn version_one_upgrade_rebuilds_search_from_durable_markdown_not_raw_cache() {
    let root = tempfile::tempdir().unwrap();
    let paths = simple_notes_lib::storage::paths::StoragePaths::open(root.path()).unwrap();
    let note_dir = paths.note_dir(note_id(NOTE_A), NoteKind::Formal).unwrap();
    fs::create_dir_all(&note_dir).unwrap();
    fs::write(
        note_dir.join("note.md"),
        format!(
            "---\nid: {NOTE_A}\nkind: formal\ntitle: Durable\nfolderId: null\ntags: []\ncreatedAt: 2026-07-31T08:00:00Z\nupdatedAt: 2026-07-31T08:00:00Z\nrevision: 0\n---\n\nVisible **prose** <script>cache-secret</script>"
        ),
    )
    .unwrap();
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
        "INSERT INTO notes(id, kind, title, folder_id, relative_path, created_at, updated_at, revision, deleted_at) VALUES (?1, 'formal', 'Durable', NULL, ?2, '2026-07-31T08:00:00Z', '2026-07-31T08:00:00Z', 0, NULL)",
        params![folder_blob(NOTE_A), format!("notes/{NOTE_A}")],
    ).unwrap();
    connection.execute(
        "INSERT INTO search_documents(note_id, title, plain_text) VALUES (?1, 'Durable', 'Visible **prose** <script>cache-secret</script>')",
        [folder_blob(NOTE_A)],
    ).unwrap();
    drop(connection);

    let migrated = simple_notes_lib::storage::database::Database::open(paths.database()).unwrap();
    migrated.migrate().unwrap();
    drop(migrated);
    assert_eq!(
        Connection::open(paths.database())
            .unwrap()
            .query_row(
                "SELECT needs_rebuild FROM search_index_state WHERE singleton = 1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1,
    );

    let search = SearchRepository::new(paths.clone());
    assert_eq!(search.search_text("Visible prose", 20).unwrap().len(), 1);
    assert!(search.search_text("cache-secret", 20).unwrap().is_empty());
    assert!(search.search_text("script", 20).unwrap().is_empty());
    assert_eq!(
        simple_notes_lib::storage::database::Database::open(paths.database())
            .unwrap()
            .applied_migration_versions()
            .unwrap(),
        vec![1, 2, 3, 4],
    );
    assert_eq!(
        Connection::open(paths.database())
            .unwrap()
            .query_row(
                "SELECT needs_rebuild FROM search_index_state WHERE singleton = 1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0,
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
    let repository = NoteRepository::new(store.paths.clone());
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
    assert!(store.paths.root().join("rebuild-needed.json").is_file());

    assert_eq!(
        SearchRepository::new(store.paths.clone())
            .search_text("repaired phrase", 20)
            .unwrap()
            .len(),
        1
    );
    assert!(!store.paths.root().join("rebuild-needed.json").exists());
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
    NoteRepository::new(store.paths.clone())
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

fn write_durable_note(
    paths: &simple_notes_lib::storage::paths::StoragePaths,
    id: &str,
    title: &str,
    markdown: &str,
) {
    let note_dir = paths.note_dir(note_id(id), NoteKind::Formal).unwrap();
    fs::create_dir_all(&note_dir).unwrap();
    fs::write(
        note_dir.join("note.md"),
        format!("---\nid: {id}\nkind: formal\ntitle: {title}\nfolderId: null\ntags: []\nrevision: 0\ncreatedAt: 2026-07-31T08:00:00Z\nupdatedAt: 2026-07-31T08:00:00Z\n---\n{markdown}"),
    ).unwrap();
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

#[test]
fn search_returns_complete_context_for_multiple_notes_in_different_folders() {
    let store = seeded_store();
    create_note_with_folder(
        &store,
        NOTE_A,
        "Root context",
        vec!["RootTag", "Shared"],
        ROOT_FOLDER,
        "batch context phrase",
        "2026-07-31T08:02:00Z",
    );
    create_note_with_folder(
        &store,
        NOTE_B,
        "Nested context",
        vec!["NestedTag", "Shared"],
        CHILD_FOLDER,
        "batch context phrase",
        "2026-07-31T08:01:00Z",
    );

    let results = SearchRepository::new(store.paths.clone())
        .search_text("batch context", 20)
        .unwrap();

    assert_eq!(
        results
            .iter()
            .map(|result| result.title.as_str())
            .collect::<Vec<_>>(),
        vec!["Root context", "Nested context"]
    );
    assert_eq!(results[0].tags, vec!["RootTag", "Shared"]);
    assert_eq!(results[0].folder_breadcrumb, vec!["Work"]);
    assert_eq!(results[1].tags, vec!["NestedTag", "Shared"]);
    assert_eq!(results[1].folder_breadcrumb, vec!["Work", "Project B"]);
}

fn create_note_with_folder(
    store: &TestStore,
    id: &str,
    title: &str,
    tags: Vec<&str>,
    folder: &str,
    markdown: &str,
    updated_at: &str,
) {
    NoteRepository::new(store.paths.clone())
        .create(NoteDocument {
            id: note_id(id),
            kind: NoteKind::Formal,
            title: title.into(),
            folder_id: Some(folder_id(folder)),
            tags: tags.into_iter().map(str::to_owned).collect(),
            markdown: markdown.into(),
            revision: 0,
            created_at: "2026-07-31T08:00:00Z".into(),
            updated_at: updated_at.into(),
        })
        .unwrap();
}
