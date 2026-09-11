use simple_notes_lib::{
    commands::files::import_files_with_scope,
    storage::{managed_files::ImportFilesInput, paths::StoragePaths},
};

#[test]
fn unauthorized_import_sources_fail_individually_without_blocking_selected_files() {
    let root = tempfile::tempdir().unwrap();
    let sources = tempfile::tempdir().unwrap();
    let selected = sources.path().join("selected.txt");
    let denied = sources.path().join("private.txt");
    std::fs::write(&selected, "selected content").unwrap();
    std::fs::write(&denied, "private content").unwrap();
    // macOS temporary roots can include symlinked path components. Normalize the
    // fixture paths so authorization checks use the selected file identity.
    let selected_for_scope = selected.canonicalize().unwrap();
    let denied_for_assertion = denied.canonicalize().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let result = import_files_with_scope(
        &paths,
        ImportFilesInput {
            paths: vec![
                denied.to_string_lossy().into_owned(),
                selected.to_string_lossy().into_owned(),
            ],
            folder_id: None,
        },
        |path| {
            path.canonicalize()
                .map(|candidate| candidate == selected_for_scope)
                .unwrap_or(false)
        },
    )
    .unwrap();
    assert_eq!(result.imported.len(), 1);
    assert_eq!(result.imported[0].title, "selected.txt");
    assert_eq!(result.failed.len(), 1);
    assert_eq!(result.failed[0].name, "private.txt");
    assert_eq!(
        result.failed[0].message,
        "import source must be selected or dropped by the user"
    );
    assert!(!result.failed[0]
        .message
        .contains(&denied_for_assertion.to_string_lossy().to_string()));
    assert_eq!(std::fs::read_to_string(&denied).unwrap(), "private content");
}
