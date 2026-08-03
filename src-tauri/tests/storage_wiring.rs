use simple_notes_lib::{
    commands::storage::{StorageCommandState, StorageConsumer},
    storage::paths::StoragePaths,
};

#[test]
fn every_storage_backed_command_uses_the_configured_root() {
    let default = tempfile::tempdir().unwrap();
    let configured = tempfile::tempdir().unwrap();
    let configured_paths = StoragePaths::open(configured.path()).unwrap();
    let state = StorageCommandState::new(configured_paths);

    for consumer in [
        StorageConsumer::Folders,
        StorageConsumer::Notes,
        StorageConsumer::Temporary,
        StorageConsumer::Assets,
        StorageConsumer::Search,
        StorageConsumer::Links,
        StorageConsumer::Trash,
        StorageConsumer::StickyWindows,
    ] {
        let paths = state.paths_for(consumer);
        assert_eq!(paths.root(), configured.path().canonicalize().unwrap());
        assert_ne!(paths.root(), default.path().canonicalize().unwrap());
    }
}
