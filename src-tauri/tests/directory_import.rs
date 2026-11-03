use simple_notes_lib::{
    commands::{files::import_files_with_scope, folders::FolderRepository},
    domain::CreateFolderInput,
    storage::{
        managed_files::{import_files, ImportFilesInput},
        paths::StoragePaths,
    },
};

#[test]
fn dropped_directory_preserves_nested_and_empty_folders_and_source_files() {
    let root = tempfile::tempdir().unwrap();
    let sources = tempfile::tempdir().unwrap();
    let source = sources.path().canonicalize().unwrap().join("资料");
    std::fs::create_dir_all(source.join("子目录")).unwrap();
    std::fs::create_dir(source.join("空目录")).unwrap();
    std::fs::write(source.join("笔记.md"), "# 正文").unwrap();
    std::fs::write(source.join("子目录/笔记.md"), "嵌套正文").unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let folders = FolderRepository::new(paths.clone());
    let target = folders
        .create(CreateFolderInput {
            parent_id: None,
            name: "目标".into(),
        })
        .unwrap();
    let existing = folders
        .create(CreateFolderInput {
            parent_id: Some(target.id),
            name: "资料".into(),
        })
        .unwrap();
    let result = import_files_with_scope(
        &paths,
        ImportFilesInput {
            paths: vec![source.to_string_lossy().into_owned()],
            folder_id: Some(target.id),
        },
        |path| path == source,
    )
    .unwrap();
    assert!(result.failed.is_empty(), "{:?}", result.failed);
    assert_eq!(result.imported.len(), 2);
    let all = folders.list().unwrap();
    let imported = all
        .iter()
        .find(|f| f.parent_id == Some(target.id) && f.id != existing.id)
        .unwrap();
    assert_eq!(imported.name, "资料 (2)");
    let child = all.iter().find(|f| f.name == "子目录").unwrap();
    assert_eq!(child.parent_id, Some(imported.id));
    assert!(all
        .iter()
        .any(|f| f.name == "空目录" && f.parent_id == Some(imported.id)));
    assert!(result
        .imported
        .iter()
        .any(|n| n.folder_id == Some(imported.id) && n.markdown == "# 正文"));
    assert!(result
        .imported
        .iter()
        .any(|n| n.folder_id == Some(child.id) && n.markdown == "嵌套正文"));
    assert_eq!(
        std::fs::read_to_string(source.join("笔记.md")).unwrap(),
        "# 正文"
    );
}

#[test]
fn unauthorized_directory_creates_no_folders_or_notes() {
    let root = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let result = import_files_with_scope(
        &paths,
        ImportFilesInput {
            paths: vec![source.path().to_string_lossy().into_owned()],
            folder_id: None,
        },
        |_| false,
    )
    .unwrap();
    assert!(result.imported.is_empty());
    assert_eq!(result.failed.len(), 1);
    assert!(FolderRepository::new(paths).list().unwrap().is_empty());
}

#[test]
fn recursive_import_is_bounded_and_keeps_successful_files() {
    let root = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let source_path = source.path().canonicalize().unwrap();
    for index in 0..1001 {
        std::fs::write(source_path.join(format!("{index:04}.txt")), "text").unwrap();
    }
    let paths = StoragePaths::open(root.path()).unwrap();
    let result = import_files(
        &paths,
        ImportFilesInput {
            paths: vec![source_path.to_string_lossy().into_owned()],
            folder_id: None,
        },
    )
    .unwrap();
    assert!(result.imported.len() < 1000);
    assert!(!result.failed.is_empty());
    assert_eq!(std::fs::read_dir(source_path).unwrap().count(), 1001);
}

#[cfg(unix)]
#[test]
fn recursive_import_rejects_symlink_files_and_directories() {
    let root = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let source_path = source.path().canonicalize().unwrap();
    std::fs::write(outside.path().join("private.txt"), "private").unwrap();
    std::fs::write(source_path.join("good.txt"), "good").unwrap();
    std::os::unix::fs::symlink(outside.path(), source_path.join("linked-dir")).unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("private.txt"),
        source_path.join("linked.txt"),
    )
    .unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let result = import_files(
        &paths,
        ImportFilesInput {
            paths: vec![source_path.to_string_lossy().into_owned()],
            folder_id: None,
        },
    )
    .unwrap();
    assert_eq!(result.imported.len(), 1);
    assert_eq!(result.imported[0].title, "good.txt");
    assert_eq!(result.failed.len(), 2);
}

#[test]
fn depth_limit_keeps_files_at_the_last_allowed_directory_level() {
    let root = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let source_path = source.path().canonicalize().unwrap();
    let mut deepest = source_path.clone();
    for _ in 0..64 {
        deepest.push("d");
    }
    std::fs::create_dir_all(deepest.join("overflow")).unwrap();
    std::fs::write(deepest.join("note.txt"), "last allowed level").unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let result = import_files(
        &paths,
        ImportFilesInput {
            paths: vec![source_path.to_string_lossy().into_owned()],
            folder_id: None,
        },
    )
    .unwrap();
    assert_eq!(result.imported_folders.len(), 65);
    assert_eq!(result.imported.len(), 1);
    assert_eq!(result.failed.len(), 1);
    assert_eq!(result.failed[0].name, "overflow");
}

#[cfg(windows)]
#[test]
fn recursive_import_rejects_junctions_without_reading_outside_files() {
    let root = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let source_path = source.path().canonicalize().unwrap();
    std::fs::write(source_path.join("good.txt"), "good").unwrap();
    std::fs::write(outside.path().join("private.txt"), "private").unwrap();
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(source.path().join("linked-dir"))
        .arg(outside.path())
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    let paths = StoragePaths::open(root.path()).unwrap();
    let result = import_files(
        &paths,
        ImportFilesInput {
            paths: vec![source_path.to_string_lossy().into_owned()],
            folder_id: None,
        },
    )
    .unwrap();
    assert_eq!(result.imported.len(), 1);
    assert_eq!(result.imported[0].title, "good.txt");
    assert_eq!(result.failed.len(), 1);
    assert_eq!(
        std::fs::read_to_string(outside.path().join("private.txt")).unwrap(),
        "private"
    );
}
