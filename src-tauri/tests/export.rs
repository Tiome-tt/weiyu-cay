mod support;

use serde_json::Value;
use weiyu_cay_lib::{
    commands::folders::FolderRepository,
    domain::{CreateFolderInput, NoteDocument, NoteId, NoteKind},
    error::CommandErrorCode,
    storage::{export::export_library, repository::NoteRepository},
};
use std::{fs, path::PathBuf};
use support::{note_id, TestStore};

const FIRST_ID: &str = "019c0000-0000-7000-8000-000000000401";
const SECOND_ID: &str = "019c0000-0000-7000-8000-000000000402";

#[test]
fn export_materializes_readable_folders_markdown_and_assets() {
    let store = TestStore::new();
    let folders = FolderRepository::new(store.paths.clone());
    let work = folders
        .create(CreateFolderInput {
            parent_id: None,
            name: "Work".into(),
        })
        .unwrap();
    let project = folders
        .create(CreateFolderInput {
            parent_id: Some(work.id),
            name: "Project B".into(),
        })
        .unwrap();
    let target_id = note_id(SECOND_ID);
    create_formal_note(&store, target_id, "Reference", None, "target");
    let source_id = note_id(FIRST_ID);
    create_formal_note(
        &store,
        source_id,
        "Login Flow",
        Some(project.id),
        &format!("![screen](assets/screenshot.png)\n[assets/screenshot.png](assets/screenshot.png \"assets/screenshot.png\")\n[angle](<assets/screenshot.png> \"kept title\")\n[title-decoy](assets/screenshot.png \"decoy ](assets/screenshot.png\")\n[nested [label]](assets/screenshot.png \"nested\")\n[escaped \\[label\\]](assets/screenshot.png \"escaped\")\n![unicode](assets/Cafe\u{301}.png)\n![reference][shot]\n\n[shot]: assets/screenshot.png\n\n[[Reference|{target_id}]]"),
    );
    let assets = store.paths.assets_dir(source_id, NoteKind::Formal).unwrap();
    fs::create_dir(&assets).unwrap();
    fs::write(assets.join("screenshot.png"), b"portable image").unwrap();
    fs::write(assets.join("Cafe\u{301}.png"), b"unicode image").unwrap();
    let destination = tempfile::tempdir().unwrap();

    let report = export_library(&store.paths, destination.path(), "0.1.0").unwrap();
    let output = successful_output(&report);

    assert!(report.completed, "{report:?}");
    assert!(report.global_failure.is_none());
    assert!(report.incomplete_root.is_none());
    let report_json = serde_json::to_value(&report).unwrap();
    assert_eq!(report_json["completed"], true);
    assert_eq!(report_json["outputRoot"], output.display().to_string());
    assert!(report_json["incompleteRoot"].is_null());
    assert!(report_json["globalFailure"].is_null());
    assert_eq!(report.notes_exported, 2, "{report:?}");
    assert_eq!(report.assets_exported, 2);
    assert!(report.failed.is_empty());
    let exported = fs::read_to_string(output.join("Work/Project B/Login Flow.md")).unwrap();
    assert!(exported.contains(&format!("[[Reference|{target_id}]]")));
    assert!(exported.contains("![screen](Login%20Flow-assets/screenshot.png)"));
    assert!(exported.contains(
        "[assets/screenshot.png](Login%20Flow-assets/screenshot.png \"assets/screenshot.png\")"
    ));
    assert!(exported.contains("[angle](<Login%20Flow-assets/screenshot.png> \"kept title\")"));
    assert!(exported.contains(
        "[title-decoy](Login%20Flow-assets/screenshot.png \"decoy ](assets/screenshot.png\")"
    ));
    assert!(exported.contains("[nested [label]](Login%20Flow-assets/screenshot.png \"nested\")"));
    assert!(
        exported.contains("[escaped \\[label\\]](Login%20Flow-assets/screenshot.png \"escaped\")")
    );
    assert!(exported.contains("![unicode](Login%20Flow-assets/Caf\u{e9}.png)"));
    assert!(exported.contains("[shot]: Login%20Flow-assets/screenshot.png"));
    assert_eq!(
        fs::read(output.join("Work/Project B/Login Flow-assets/screenshot.png")).unwrap(),
        b"portable image"
    );
    assert_eq!(
        report.renamed_paths,
        vec![weiyu_cay_lib::storage::export::RenamedExportPath {
            source: "Work/Project B/Login Flow-assets/Cafe\u{301}.png".into(),
            destination: "Work/Project B/Login Flow-assets/Caf\u{e9}.png".into(),
        }]
    );
    let manifest: Value =
        serde_json::from_slice(&fs::read(output.join("export-manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest["appVersion"], "0.1.0");
    assert_eq!(manifest["notes"][FIRST_ID], "Work/Project B/Login Flow.md");
    assert_eq!(manifest["notes"][SECOND_ID], "Reference.md");
}

#[test]
fn export_rewrites_parser_confirmed_asset_variants_and_preserves_suffixes_and_code() {
    let store = TestStore::new();
    let note_id = note_id(FIRST_ID);
    create_formal_note(
        &store,
        note_id,
        "Variants",
        None,
        "![percent](assets/space%20file.png)\n![escaped](assets/a\\(b\\).png)\n![dot](./assets/plain.png)\n![lexical](assets/sub/../plain.png)\n![normalized-root](docs/../assets/plain.png)\n![encoded-root](%61ssets/plain.png)\n![suffix](assets/plain.png?download=1#preview)\n![external](https://cdn.example/assets/plain.png)\n[relative](docs/100%ready)\n![reference][asset]\n\n    [code]: assets/plain.png\n\n[asset]: <assets/space%20file.png?raw=1#reference> \"kept title\"",
    );
    let assets = store.paths.assets_dir(note_id, NoteKind::Formal).unwrap();
    fs::create_dir(&assets).unwrap();
    fs::write(assets.join("space file.png"), b"space").unwrap();
    fs::write(assets.join("a(b).png"), b"parentheses").unwrap();
    fs::write(assets.join("plain.png"), b"plain").unwrap();
    let destination = tempfile::tempdir().unwrap();

    let report = export_library(&store.paths, destination.path(), "0.1.0").unwrap();
    let output = successful_output(&report);
    let exported = fs::read_to_string(output.join("Variants.md")).unwrap();

    assert!(report.failed.is_empty(), "{report:?}");
    assert!(exported.contains("![percent](Variants-assets/space%20file.png)"));
    assert!(exported.contains("![escaped](Variants-assets/a%28b%29.png)"));
    assert!(exported.contains("![dot](Variants-assets/plain.png)"));
    assert!(exported.contains("![lexical](Variants-assets/plain.png)"));
    assert!(exported.contains("![normalized-root](Variants-assets/plain.png)"));
    assert!(exported.contains("![encoded-root](Variants-assets/plain.png)"));
    assert!(exported.contains("![suffix](Variants-assets/plain.png?download=1#preview)"));
    assert!(exported.contains("![external](https://cdn.example/assets/plain.png)"));
    assert!(exported.contains("[relative](docs/100%ready)"));
    assert!(exported
        .contains("[asset]: <Variants-assets/space%20file.png?raw=1#reference> \"kept title\""));
    assert!(exported.contains("    [code]: assets/plain.png"));
}

#[test]
fn export_preserves_unmanaged_relative_and_root_relative_asset_paths() {
    let store = TestStore::new();
    create_formal_note(
        &store,
        note_id(FIRST_ID),
        "Documentation",
        None,
        "[documentation](docs/assets/diagram.png)\n[second](reference/assets/index.html)\n[root documentation](/docs/assets/diagram.png)\n[root asset](/assets/image.png)\n[root percent](/assets/100%ready.png)\n[drive](C:/assets/image.png)\n[cdn](//cdn.example/assets/image.png)",
    );
    let destination = tempfile::tempdir().unwrap();

    let report = export_library(&store.paths, destination.path(), "0.1.0").unwrap();
    let output = successful_output(&report);
    let exported = fs::read_to_string(output.join("Documentation.md")).unwrap();

    assert_eq!(report.notes_exported, 1, "{report:?}");
    assert!(report.failed.is_empty(), "{report:?}");
    assert!(exported.contains("[documentation](docs/assets/diagram.png)"));
    assert!(exported.contains("[second](reference/assets/index.html)"));
    assert!(exported.contains("[root documentation](/docs/assets/diagram.png)"));
    assert!(exported.contains("[root asset](/assets/image.png)"));
    assert!(exported.contains("[root percent](/assets/100%ready.png)"));
    assert!(exported.contains("[drive](C:/assets/image.png)"));
    assert!(exported.contains("[cdn](//cdn.example/assets/image.png)"));
}

#[test]
fn export_rejects_raw_and_percent_encoded_asset_traversal() {
    let store = TestStore::new();
    create_formal_note(
        &store,
        note_id(FIRST_ID),
        "Raw traversal",
        None,
        "![escape](../assets/plain.png)",
    );
    create_formal_note(
        &store,
        note_id(SECOND_ID),
        "Encoded traversal",
        None,
        "![escape](assets/%2e%2e/secret.png)",
    );
    create_formal_note(
        &store,
        note_id("019c0000-0000-7000-8000-000000000403"),
        "Encoded leading traversal",
        None,
        "![escape](%2e%2e/assets/plain.png)",
    );
    create_formal_note(
        &store,
        note_id("019c0000-0000-7000-8000-000000000404"),
        "Encoded backslash escape",
        None,
        "![escape](assets/%5coutside.png)",
    );
    let destination = tempfile::tempdir().unwrap();

    let report = export_library(&store.paths, destination.path(), "0.1.0").unwrap();
    let output = successful_output(&report);
    let manifest: Value =
        serde_json::from_slice(&fs::read(output.join("export-manifest.json")).unwrap()).unwrap();

    assert_eq!(report.notes_exported, 0, "{report:?}");
    assert_eq!(report.failed.len(), 4, "{report:?}");
    assert_eq!(manifest["notes"], serde_json::json!({}));
}

#[test]
fn export_allocates_portable_names_deterministically() {
    let store = TestStore::new();
    let folders = FolderRepository::new(store.paths.clone());
    let composed = folders
        .create(CreateFolderInput {
            parent_id: None,
            name: "Caf\u{e9}".into(),
        })
        .unwrap();
    let decomposed = folders
        .create(CreateFolderInput {
            parent_id: None,
            name: "Cafe\u{301}".into(),
        })
        .unwrap();
    create_formal_note(&store, note_id(FIRST_ID), "CON", Some(composed.id), "one");
    create_formal_note(&store, note_id(SECOND_ID), "CON", Some(composed.id), "two");
    let third_id = note_id("019c0000-0000-7000-8000-000000000403");
    create_formal_note(&store, third_id, "AUX", Some(decomposed.id), "three");
    let destination = tempfile::tempdir().unwrap();

    let report = export_library(&store.paths, destination.path(), "0.1.0").unwrap();
    let output = successful_output(&report);

    assert!(output.join("Caf\u{e9}/CON_.md").exists());
    assert!(output.join("Caf\u{e9}/CON_ (2).md").exists());
    assert!(output.join("Caf\u{e9} (2)/AUX_.md").exists());
    assert_eq!(report.renamed_paths.len(), 3);
    assert_eq!(report.notes_exported, 3);
}

#[test]
fn export_limits_portable_components_by_utf8_bytes_and_revalidates_truncation() {
    let store = TestStore::new();
    let folder_name = "😀".repeat(120);
    let folder = FolderRepository::new(store.paths.clone())
        .create(CreateFolderInput {
            parent_id: None,
            name: folder_name,
        })
        .unwrap();
    let note_id = note_id(FIRST_ID);
    create_formal_note(&store, note_id, "Long names", Some(folder.id), "body");
    let assets = store.paths.assets_dir(note_id, NoteKind::Formal).unwrap();
    fs::create_dir(&assets).unwrap();
    let long_asset = format!("{}.x", "a".repeat(119));
    fs::write(assets.join(&long_asset), b"long asset").unwrap();
    let destination = tempfile::tempdir().unwrap();

    let report = export_library(&store.paths, destination.path(), "0.1.0").unwrap();
    let output = successful_output(&report);

    assert_eq!(report.notes_exported, 1, "{report:?}");
    let folder = fs::read_dir(output)
        .unwrap()
        .filter_map(Result::ok)
        .find(|entry| entry.file_type().unwrap().is_dir())
        .unwrap();
    assert!(folder.file_name().to_string_lossy().len() <= 120);
    let assets = fs::read_dir(folder.path().join("Long names-assets")).unwrap();
    for entry in assets {
        let name = entry.unwrap().file_name().to_string_lossy().into_owned();
        assert!(name.len() <= 120);
        assert!(!name.ends_with([' ', '.']));
    }
}

#[test]
fn export_budgets_final_note_and_asset_components_with_collisions_and_unicode() {
    let store = TestStore::new();
    let ascii = "a".repeat(120);
    create_formal_note(&store, note_id(FIRST_ID), &ascii, None, "one");
    create_formal_note(&store, note_id(SECOND_ID), &ascii, None, "two");
    let cjk_id = note_id("019c0000-0000-7000-8000-000000000403");
    create_formal_note(&store, cjk_id, &"界".repeat(60), None, "three");
    let emoji_id = note_id("019c0000-0000-7000-8000-000000000404");
    create_formal_note(&store, emoji_id, &"😀".repeat(60), None, "four");
    let assets = store
        .paths
        .assets_dir(note_id(FIRST_ID), NoteKind::Formal)
        .unwrap();
    fs::create_dir(&assets).unwrap();
    fs::write(assets.join("plain.png"), b"asset").unwrap();
    let destination = tempfile::tempdir().unwrap();

    let report = export_library(&store.paths, destination.path(), "0.1.0").unwrap();
    let output = successful_output(&report);
    let names = fs::read_dir(&output)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();

    assert_eq!(report.notes_exported, 4, "{report:?}");
    assert!(names.iter().any(|name| name.ends_with("-assets")));
    for name in names {
        assert!(name.len() <= 120, "UTF-8 budget exceeded: {name}");
        assert!(
            name.encode_utf16().count() <= 120,
            "UTF-16 budget exceeded: {name}"
        );
        assert!(!name.ends_with([' ', '.']));
    }
}

#[test]
fn export_publishes_a_unique_child_without_overwriting_existing_content() {
    let store = TestStore::new();
    create_formal_note(&store, note_id(FIRST_ID), "Blocked", None, "blocked body");
    create_formal_note(&store, note_id(SECOND_ID), "Good", None, "good body");
    let destination = tempfile::tempdir().unwrap();
    let existing = destination.path().join("微屿导出");
    fs::create_dir(&existing).unwrap();
    fs::write(existing.join("user.txt"), b"user content").unwrap();

    let report = export_library(&store.paths, destination.path(), "0.1.0").unwrap();
    let output = successful_output(&report);

    assert_eq!(
        fs::read(existing.join("user.txt")).unwrap(),
        b"user content"
    );
    assert_eq!(output.file_name().unwrap(), "微屿导出 (2)");
    assert_eq!(report.notes_exported, 2);
    assert!(report.failed.is_empty());
    assert!(output.join("Blocked.md").exists());
    assert!(output.join("Good.md").exists());
    let manifest: Value =
        serde_json::from_slice(&fs::read(output.join("export-manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest["notes"][FIRST_ID], "Blocked.md");
    assert_eq!(manifest["notes"][SECOND_ID], "Good.md");
}

#[test]
fn manifest_and_renames_include_only_notes_that_were_staged_successfully() {
    let store = TestStore::new();
    create_formal_note(&store, note_id(FIRST_ID), "AUX", None, "blocked body");
    create_formal_note(&store, note_id(SECOND_ID), "Good", None, "good body");
    fs::write(
        store
            .paths
            .note_dir(note_id(FIRST_ID), NoteKind::Formal)
            .unwrap()
            .join("note.md"),
        b"not valid note markdown",
    )
    .unwrap();
    let destination = tempfile::tempdir().unwrap();

    let report = export_library(&store.paths, destination.path(), "0.1.0").unwrap();
    let output = successful_output(&report);

    assert_eq!(report.notes_exported, 1);
    assert_eq!(report.failed.len(), 1);
    assert_eq!(report.failed[0].note_id, note_id(FIRST_ID));
    assert!(report.renamed_paths.is_empty());
    let manifest: Value =
        serde_json::from_slice(&fs::read(output.join("export-manifest.json")).unwrap()).unwrap();
    assert!(manifest["notes"].get(FIRST_ID).is_none());
    assert_eq!(manifest["notes"][SECOND_ID], "Good.md");
}

#[test]
fn export_materializes_nested_empty_and_all_failed_logical_folders() {
    let store = TestStore::new();
    let folders = FolderRepository::new(store.paths.clone());
    let empty = folders
        .create(CreateFolderInput {
            parent_id: None,
            name: "Empty".into(),
        })
        .unwrap();
    folders
        .create(CreateFolderInput {
            parent_id: Some(empty.id),
            name: "Nested".into(),
        })
        .unwrap();
    folders
        .create(CreateFolderInput {
            parent_id: None,
            name: "Caf\u{e9}".into(),
        })
        .unwrap();
    folders
        .create(CreateFolderInput {
            parent_id: None,
            name: "Cafe\u{301}".into(),
        })
        .unwrap();
    let failed = folders
        .create(CreateFolderInput {
            parent_id: None,
            name: "Failed only".into(),
        })
        .unwrap();
    create_formal_note(
        &store,
        note_id(FIRST_ID),
        "Unreadable",
        Some(failed.id),
        "body",
    );
    fs::write(
        store
            .paths
            .note_dir(note_id(FIRST_ID), NoteKind::Formal)
            .unwrap()
            .join("note.md"),
        b"not valid note markdown",
    )
    .unwrap();
    let destination = tempfile::tempdir().unwrap();

    let report = export_library(&store.paths, destination.path(), "0.1.0").unwrap();
    let output = successful_output(&report);

    assert!(output.join("Empty/Nested").is_dir());
    assert!(output.join("Failed only").is_dir());
    assert!(output.join("Caf\u{e9}").is_dir());
    assert!(output.join("Caf\u{e9} (2)").is_dir());
    assert_eq!(report.notes_exported, 0, "{report:?}");
    assert_eq!(report.failed.len(), 1, "{report:?}");
    let manifest: Value =
        serde_json::from_slice(&fs::read(output.join("export-manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest["notes"], serde_json::json!({}));
}

#[test]
fn export_rejects_data_root_descendants_and_traversal_before_writing() {
    let store = TestStore::new();
    create_formal_note(&store, note_id(FIRST_ID), "Keep", None, "body");
    let descendant = store.paths.root().join("export");
    fs::create_dir(&descendant).unwrap();
    let error = export_library(&store.paths, &descendant, "0.1.0").unwrap_err();
    assert_eq!(
        error.code(),
        CommandErrorCode::Validation,
        "{:?}",
        error.diagnostic()
    );
    assert!(fs::read_dir(&descendant).unwrap().next().is_none());

    let ancestor = store.paths.root().parent().unwrap();
    let error = export_library(&store.paths, ancestor, "0.1.0").unwrap_err();
    assert_eq!(error.code(), CommandErrorCode::Validation);

    let destination = tempfile::tempdir().unwrap();
    let traversal = destination.path().join("child").join("..");
    fs::create_dir(destination.path().join("child")).unwrap();
    let error = export_library(&store.paths, &traversal, "0.1.0").unwrap_err();
    assert_eq!(error.code(), CommandErrorCode::Validation);
}

#[cfg(unix)]
#[test]
fn export_rejects_a_symlink_destination() {
    use std::os::unix::fs::symlink;

    let store = TestStore::new();
    let outside = tempfile::tempdir().unwrap();
    let link_parent = tempfile::tempdir().unwrap();
    let link = link_parent.path().join("export");
    symlink(outside.path(), &link).unwrap();

    let error = export_library(&store.paths, &link, "0.1.0").unwrap_err();

    assert_eq!(error.code(), CommandErrorCode::Validation);
    assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
}

fn create_formal_note(
    store: &TestStore,
    id: NoteId,
    title: &str,
    folder_id: Option<weiyu_cay_lib::domain::FolderId>,
    markdown: &str,
) -> NoteDocument {
    NoteRepository::new(store.paths.clone())
        .create(NoteDocument {
            id,
            kind: NoteKind::Formal,
            title: title.to_owned(),
            folder_id,
            tags: Vec::new(),
            markdown: markdown.to_owned(),
            revision: 0,
            created_at: "2026-07-30T08:00:00Z".to_owned(),
            updated_at: "2026-07-30T08:01:00Z".to_owned(),
        })
        .unwrap()
}

fn successful_output(report: &weiyu_cay_lib::storage::export::ExportReport) -> PathBuf {
    assert!(report.completed, "{report:?}");
    PathBuf::from(report.output_root.as_ref().expect("successful output root"))
}
