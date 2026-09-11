use serde_json::json;
use simple_notes_lib::{
    domain::{NoteDocument, NoteId},
    storage::{paths::StoragePaths, repository::NoteRepository},
};
fn doc(content: serde_json::Value) -> NoteDocument {
    serde_json::from_value(json!({"id":NoteId::now_v7(),"kind":"formal","title":"多格式","folderId":null,"tags":[],"markdown":"","revision":0,"createdAt":"2026-09-08T00:00:00Z","updatedAt":"2026-09-08T00:00:00Z","content":content})).unwrap()
}
#[test]
fn document_and_text_use_distinct_durable_entries_and_reload() {
    let root = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let repo = NoteRepository::new(paths.clone());
    for (content, entry) in [
        (
            json!({"type":"document","document":{"schemaVersion":1,"root":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"你好"}]}]}}}),
            "note.cay.json",
        ),
        (json!({"type":"text","text":"# literal 文本"}), "entry.json"),
    ] {
        let note = repo.create(doc(content.clone())).unwrap();
        let dir = paths.notes().join(note.id.to_string());
        assert!(dir.join(entry).exists(), "expected {entry}");
        assert!(!dir.join("note.md").exists());
        let loaded = serde_json::to_value(repo.load(note.id).unwrap()).unwrap();
        assert_eq!(loaded["content"], content);
        assert_eq!(loaded["markdown"], "");
    }
}
#[test]
fn unknown_rich_structure_is_rejected_before_publication() {
    let root = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let repo = NoteRepository::new(paths);
    let bad = doc(
        json!({"type":"document","document":{"schemaVersion":1,"root":{"type":"doc","content":[{"type":"unknownPlugin"}]}}}),
    );
    assert!(repo.create(bad).is_err());
}

fn rich_content() -> serde_json::Value {
    json!({"type":"document","document":{"schemaVersion":1,"root":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"保留中文"}]}]}}})
}
#[test]
fn typed_save_stale_revision_and_failed_publication_preserve_previous_content() {
    use simple_notes_lib::{
        domain::NoteContent,
        error::CommandError,
        storage::atomic_file::{PublishFailure, PublishResult},
    };
    fn fail(
        _: &StoragePaths,
        _: NoteId,
        _: simple_notes_lib::domain::NoteKind,
        _: &[u8],
    ) -> PublishResult {
        Err(PublishFailure::not_published(CommandError::io(
            "injected publication failure",
        )))
    }
    let root = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let repo = NoteRepository::new(paths.clone());
    let old = repo
        .create(doc(json!({"type":"text","text":"old revision"})))
        .unwrap();
    let mut edited = old.clone();
    edited.content = Some(NoteContent::Text {
        text: "new revision 中文".into(),
    });
    assert!(NoteRepository::new_with_writer(paths.clone(), fail)
        .save(edited.clone(), 0)
        .is_err());
    assert_eq!(repo.load(old.id).unwrap(), old);
    let saved = repo.save(edited.clone(), 0).unwrap();
    assert_eq!(saved.revision, 1);
    assert!(repo.save(edited, 0).is_err());
    assert_eq!(repo.load(old.id).unwrap(), saved);
    let directory = paths.notes().join(old.id.to_string());
    assert!(
        std::fs::read_dir(directory)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with("payload-"))
            .count()
            >= 2
    );
}
#[test]
fn multiple_entries_unknown_versions_and_corrupt_payload_are_never_overwritten() {
    let root = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let repo = NoteRepository::new(paths.clone());
    let rich = repo.create(doc(rich_content())).unwrap();
    let directory = paths.notes().join(rich.id.to_string());
    let original = std::fs::read(directory.join("note.cay.json")).unwrap();
    std::fs::write(directory.join("note.md"), b"competing content").unwrap();
    assert!(repo.load(rich.id).is_err());
    assert_eq!(
        std::fs::read(directory.join("note.cay.json")).unwrap(),
        original
    );
    std::fs::remove_file(directory.join("note.md")).unwrap();
    let mut invalid: serde_json::Value = serde_json::from_slice(&original).unwrap();
    invalid["schemaVersion"] = json!(99);
    std::fs::write(
        directory.join("note.cay.json"),
        serde_json::to_vec(&invalid).unwrap(),
    )
    .unwrap();
    assert!(repo.load(rich.id).is_err());
    let text = repo
        .create(doc(json!({"type":"text","text":"intact"})))
        .unwrap();
    let directory = paths.notes().join(text.id.to_string());
    let entry: serde_json::Value =
        serde_json::from_slice(&std::fs::read(directory.join("entry.json")).unwrap()).unwrap();
    let payload = directory.join(entry["payload"]["storageName"].as_str().unwrap());
    std::fs::write(&payload, b"broken").unwrap();
    assert!(repo.load(text.id).is_err());
    std::fs::remove_file(payload).unwrap();
    assert!(repo.load(text.id).is_err());
}
#[test]
fn managed_import_preserves_sources_decodes_bom_and_reports_partial_failure() {
    use simple_notes_lib::storage::managed_files::{
        export_file, import_files, read_file, ImportFilesInput,
    };
    let root = tempfile::tempdir().unwrap();
    let sources = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let binary = sources.path().join("archive.zip");
    let body = b"PK\x03\x04exact original bytes\0\xff";
    std::fs::write(&binary, body).unwrap();
    let text = sources.path().join("utf16.txt");
    std::fs::write(&text, [0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]).unwrap();
    let markdown = sources.path().join("source.md");
    std::fs::write(&markdown, b"# source\r\n\r\n[[keep|invalid]]").unwrap();
    let result = import_files(
        &paths,
        ImportFilesInput {
            paths: vec![
                binary.display().to_string(),
                text.display().to_string(),
                markdown.display().to_string(),
                sources.path().display().to_string(),
                sources.path().join("missing").display().to_string(),
                sources
                    .path()
                    .join("..")
                    .join("escape")
                    .display()
                    .to_string(),
            ],
            folder_id: None,
        },
    )
    .unwrap();
    assert_eq!(result.imported.len(), 3);
    assert_eq!(result.failed.len(), 3);
    assert_eq!(std::fs::read(&binary).unwrap(), body);
    assert_eq!(
        read_file(&paths, result.imported[0].id).unwrap().bytes,
        body
    );
    assert_eq!(
        serde_json::to_value(&result.imported[1]).unwrap()["content"]["text"],
        "中文"
    );
    assert_eq!(
        result.imported[2].markdown,
        "# source\r\n\r\n[[keep|invalid]]"
    );
    assert!(result.imported[2].content.is_none());
    let output = sources.path().join("saved.zip");
    export_file(&paths, result.imported[0].id, &output).unwrap();
    assert_eq!(std::fs::read(&output).unwrap(), body);
    assert!(export_file(&paths, result.imported[0].id, &output).is_err());
}
#[test]
fn mixed_library_rebuild_trash_restore_and_native_export_preserve_content() {
    use simple_notes_lib::storage::{
        export::export_library,
        managed_files::{import_files, read_file, ImportFilesInput},
        rebuild::rebuild_index,
        trash::TrashService,
    };
    let root = tempfile::tempdir().unwrap();
    let sources = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let repo = NoteRepository::new(paths.clone());
    let rich = repo.create(doc(rich_content())).unwrap();
    let text = repo
        .create(doc(json!({"type":"text","text":"literal **body**"})))
        .unwrap();
    let binary = sources.path().join("original.bin");
    std::fs::write(&binary, b"managed original").unwrap();
    let file = import_files(
        &paths,
        ImportFilesInput {
            paths: vec![binary.display().to_string()],
            folder_id: None,
        },
    )
    .unwrap()
    .imported
    .remove(0);
    let report = rebuild_index(&paths).unwrap();
    assert_eq!(report.notes_recovered, 3);
    assert_eq!(report.notes_failed, 0);
    assert_eq!(repo.load(rich.id).unwrap(), rich);
    assert_eq!(repo.load(text.id).unwrap(), text);
    assert_eq!(repo.load(file.id).unwrap(), file);
    let trash = TrashService::new(paths.clone());
    let deleted = trash
        .trash(vec![rich.id, text.id, file.id], "2026-09-08T12:00:00Z")
        .unwrap();
    assert!(deleted.failed.is_empty(), "{:?}", deleted.failed);
    let restored = trash.restore(vec![rich.id, text.id, file.id]).unwrap();
    assert_eq!(restored.restored.len(), 3, "{:?}", restored.failed);
    assert_eq!(
        read_file(&paths, file.id).unwrap().bytes,
        b"managed original"
    );
    let output = tempfile::tempdir().unwrap();
    let exported = export_library(&paths, output.path(), "1.1.0").unwrap();
    assert!(exported.completed, "{:?}", exported);
    assert_eq!(exported.notes_exported, 3);
    let destination = std::path::Path::new(exported.output_root.as_ref().unwrap());
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(destination.join("export-manifest.json")).unwrap())
            .unwrap();
    for note in [&rich, &text, &file] {
        let relative = manifest["notes"][note.id.to_string()].as_str().unwrap();
        assert!(destination.join(relative).exists());
    }
}
#[test]
fn fake_docx_markers_are_rejected_without_creating_export() {
    use simple_notes_lib::storage::managed_files::save_document_export;
    let root = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let note = NoteRepository::new(paths.clone())
        .create(doc(rich_content()))
        .unwrap();
    let target = root.path().join("fake.docx");
    let fake = b"PK\x03\x04[Content_Types].xmlword/document.xmlPK\x05\x06";
    assert!(save_document_export(&paths, note.id, &target, fake).is_err());
    assert!(!target.exists());
}
#[test]
fn table_spans_and_link_nodes_survive_and_invalid_overlap_is_rejected() {
    let root = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let repo = NoteRepository::new(paths);
    let target = NoteId::now_v7();
    let cell = |span: u64| json!({"type":"tableCell","attrs":{"colspan":span,"rowspan":1,"colwidth":vec![150;span as usize],"backgroundColor":"green"},"content":[{"type":"paragraph","content":[{"type":"internalLink","attrs":{"noteId":target,"label":"目标"}}]}]});
    let content = json!({"type":"document","document":{"schemaVersion":1,"root":{"type":"doc","content":[{"type":"table","content":[{"type":"tableRow","content":[cell(2)]},{"type":"tableRow","content":[cell(1),cell(1)]}]}]}}});
    let saved = repo.create(doc(content.clone())).unwrap();
    assert_eq!(
        serde_json::to_value(repo.load(saved.id).unwrap()).unwrap()["content"],
        content
    );
    let mut bad = content;
    bad["document"]["root"]["content"][0]["content"][0]["content"][0]["attrs"]["rowspan"] =
        json!(3);
    assert!(repo.create(doc(bad)).is_err());
}

#[test]
fn typed_recovery_promotes_matching_candidate_and_preserves_unknown_canonical_schema() {
    use simple_notes_lib::storage::recovery::recover_startup;
    let root = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let repo = NoteRepository::new(paths.clone());
    let note = repo.create(doc(rich_content())).unwrap();
    let directory = paths.notes().join(note.id.to_string());
    let canonical = directory.join("note.cay.json");
    let original = std::fs::read(&canonical).unwrap();
    let mut pending: serde_json::Value = serde_json::from_slice(&original).unwrap();
    pending["note"]["revision"] = json!(1);
    pending["note"]["content"]["document"]["root"]["content"][0]["content"][0]["text"] =
        json!("recovered candidate");
    let candidate = directory.join(format!(".note.cay.json.{}.tmp", NoteId::now_v7()));
    std::fs::write(&candidate, serde_json::to_vec(&pending).unwrap()).unwrap();
    let report = recover_startup(&paths).unwrap();
    assert!(report.failure.is_none(), "{:?}", report);
    assert_eq!(repo.load(note.id).unwrap().revision, 1);
    let mut unknown = pending.clone();
    unknown["schemaVersion"] = json!(99);
    let unknown_bytes = serde_json::to_vec(&unknown).unwrap();
    std::fs::write(&canonical, &unknown_bytes).unwrap();
    pending["note"]["revision"] = json!(2);
    std::fs::write(&candidate, serde_json::to_vec(&pending).unwrap()).unwrap();
    let report = recover_startup(&paths);
    assert!(report.is_err() || report.unwrap().failure.is_some());
    assert_eq!(std::fs::read(&canonical).unwrap(), unknown_bytes);
}
#[test]
fn document_candidate_cannot_replace_text_entry_even_when_revision_is_higher() {
    use simple_notes_lib::storage::recovery::recover_startup;
    let root = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let repo = NoteRepository::new(paths.clone());
    let text = repo
        .create(doc(json!({"type":"text","text":"original text"})))
        .unwrap();
    let rich = repo.create(doc(rich_content())).unwrap();
    let directory = paths.notes().join(text.id.to_string());
    let original = std::fs::read(directory.join("entry.json")).unwrap();
    let mut candidate: serde_json::Value = serde_json::from_slice(
        &std::fs::read(
            paths
                .notes()
                .join(rich.id.to_string())
                .join("note.cay.json"),
        )
        .unwrap(),
    )
    .unwrap();
    candidate["note"]["id"] = json!(text.id);
    candidate["note"]["revision"] = json!(10);
    std::fs::write(
        directory.join(format!(".entry.json.{}.tmp", NoteId::now_v7())),
        serde_json::to_vec(&candidate).unwrap(),
    )
    .unwrap();
    let _ = recover_startup(&paths);
    assert_eq!(
        std::fs::read(directory.join("entry.json")).unwrap(),
        original
    );
    assert_eq!(repo.load(text.id).unwrap(), text);
}
#[test]
fn interrupted_import_without_manifest_does_not_block_index_rebuild() {
    use simple_notes_lib::storage::rebuild::rebuild_index_strict;
    let root = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let directory = paths.notes().join(NoteId::now_v7().to_string());
    std::fs::create_dir(&directory).unwrap();
    std::fs::write(
        directory.join(format!("payload-{}.bin", NoteId::now_v7())),
        b"incomplete copied source",
    )
    .unwrap();
    let report = rebuild_index_strict(&paths).unwrap();
    assert_eq!(report.notes_recovered, 0);
}

#[test]
fn unknown_library_version_blocks_open_without_rewriting_marker() {
    let root = tempfile::tempdir().unwrap();
    let marker = root.path().join("library-format.json");
    let bytes = b"{\"schemaVersion\":99,\"minimumAppVersion\":\"9.0.0\"}";
    std::fs::write(&marker, bytes).unwrap();
    assert!(StoragePaths::open(root.path()).is_err());
    assert_eq!(std::fs::read(marker).unwrap(), bytes);
}
#[test]
fn managed_import_rejects_symbolic_source_and_oversize_file_without_modifying_them() {
    use simple_notes_lib::storage::managed_files::{import_files, ImportFilesInput};
    let root = tempfile::tempdir().unwrap();
    let sources = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let original = sources.path().join("original.txt");
    std::fs::write(&original, b"source preserved").unwrap();
    let linked_parent = root.path().join("linked-source");
    let link = linked_parent.join("original.txt");
    #[cfg(windows)]
    assert!(std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&linked_parent)
        .arg(sources.path())
        .status()
        .unwrap()
        .success());
    #[cfg(unix)]
    std::os::unix::fs::symlink(sources.path(), &linked_parent).unwrap();
    let huge = sources.path().join("too-big.bin");
    std::fs::File::create(&huge)
        .unwrap()
        .set_len(256 * 1024 * 1024 + 1)
        .unwrap();
    let result = import_files(
        &paths,
        ImportFilesInput {
            paths: vec![link.display().to_string(), huge.display().to_string()],
            folder_id: None,
        },
    )
    .unwrap();
    assert!(result.imported.is_empty());
    assert_eq!(result.failed.len(), 2);
    assert_eq!(std::fs::read(&original).unwrap(), b"source preserved");
    assert!(NoteRepository::new(paths).list().unwrap().is_empty());
}
#[test]
fn managed_office_open_uses_independent_copy_and_rejects_executable() {
    use simple_notes_lib::storage::managed_files::{
        external_copy, import_files, read_file, ImportFilesInput,
    };
    let root = tempfile::tempdir().unwrap();
    let sources = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let office = sources.path().join("example.doc");
    let bytes = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1 office data";
    std::fs::write(&office, bytes).unwrap();
    let executable = sources.path().join("program.exe");
    std::fs::write(&executable, b"MZ executable").unwrap();
    let files = import_files(
        &paths,
        ImportFilesInput {
            paths: vec![
                office.display().to_string(),
                executable.display().to_string(),
            ],
            folder_id: None,
        },
    )
    .unwrap()
    .imported;
    let copy = external_copy(&paths, files[0].id).unwrap();
    std::fs::write(&copy, b"external edit").unwrap();
    assert_eq!(read_file(&paths, files[0].id).unwrap().bytes, bytes);
    assert!(external_copy(&paths, files[1].id).is_err());
}

#[test]
fn rich_content_matches_shared_projection_and_indexes_original_attachment_names() {
    use simple_notes_lib::storage::{
        managed_files::{import_files, ImportFilesInput},
        repository::LinkRepository,
        rich_document::plain_text,
    };
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/document-content.json")).unwrap();
    let root = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let repo = NoteRepository::new(paths.clone());
    let document = repo
        .create(doc(
            json!({"type":"document","document":fixture["richDocument"]}),
        ))
        .unwrap();
    assert_eq!(
        plain_text(&document),
        fixture["expectedText"].as_str().unwrap()
    );
    let links = LinkRepository::new(paths.clone());
    for target in fixture["targetIds"].as_array().unwrap() {
        assert_eq!(
            links
                .backlinks(NoteId::parse_str(target.as_str().unwrap()).unwrap())
                .unwrap()[0]
                .id,
            document.id
        );
    }
    let target = NoteId::parse_str(fixture["targetIds"][0].as_str().unwrap()).unwrap();
    let repair = links.rename_target_labels(target, "新标签").unwrap();
    assert!(repair.failed_source_ids.is_empty());
    assert!(plain_text(&repo.load(document.id).unwrap()).contains("新标签"));
    let source = root.path().join("original-special-name.bin");
    std::fs::write(&source, b"binary").unwrap();
    let file = import_files(
        &paths,
        ImportFilesInput {
            paths: vec![source.display().to_string()],
            folder_id: None,
        },
    )
    .unwrap()
    .imported
    .remove(0);
    let renamed = repo.rename_note(file.id, "重命名附件").unwrap();
    assert_eq!(plain_text(&renamed), "original-special-name.bin");
}
#[test]
fn valid_docx_package_is_saved_atomically_and_malformed_xml_is_rejected() {
    use simple_notes_lib::storage::managed_files::save_document_export;
    use std::io::{Cursor, Write};
    fn package(body: &str) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name,content) in [("[Content_Types].xml","<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>"),("_rels/.rels","<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"/>"),("word/document.xml",body)]{zip.start_file(name,zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)).unwrap();zip.write_all(content.as_bytes()).unwrap();}
        zip.finish().unwrap().into_inner()
    }
    let root = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let note = NoteRepository::new(paths.clone())
        .create(doc(rich_content()))
        .unwrap();
    let bytes=package("<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>中文导出</w:t></w:r></w:p></w:body></w:document>");
    let target = root.path().join("generated.docx");
    save_document_export(&paths, note.id, &target, &bytes).unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), bytes);
    assert!(save_document_export(&paths, note.id, &target, &bytes).is_err());
    let malformed = package("<w:document><w:body></wrong></w:document>");
    assert!(
        save_document_export(&paths, note.id, &root.path().join("bad.docx"), &malformed).is_err()
    );
    assert!(!root.path().join("bad.docx").exists());
}
