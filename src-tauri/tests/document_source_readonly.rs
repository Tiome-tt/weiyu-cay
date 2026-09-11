#![cfg(windows)]

use simple_notes_lib::storage::{
    managed_files::{import_files, ImportFilesInput},
    paths::StoragePaths,
};

#[test]
fn importing_external_files_never_interprets_app_recovery_sidecars() {
    let root = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let original = source.path().join("original.txt");
    let sidecar = source.path().join(".original.txt.replace-recovery.json");
    std::fs::write(&original, "external original").unwrap();
    std::fs::write(&sidecar, "external application metadata").unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let result = import_files(
        &paths,
        ImportFilesInput {
            paths: vec![original.to_string_lossy().into_owned()],
            folder_id: None,
        },
    )
    .unwrap();
    assert_eq!(result.imported.len(), 1, "{:?}", result.failed);
    assert_eq!(
        std::fs::read_to_string(original).unwrap(),
        "external original"
    );
    assert_eq!(
        std::fs::read_to_string(sidecar).unwrap(),
        "external application metadata"
    );
}
