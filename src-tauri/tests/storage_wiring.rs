use weiyu_cay_lib::{
    commands::storage::{StorageCommandState, StorageConsumer},
    storage::{
        paths::StoragePaths,
        recovery::{StartupRecoveryReadiness, StartupRecoveryState},
    },
};

#[test]
fn every_storage_backed_command_uses_the_configured_root() {
    let default = tempfile::tempdir().unwrap();
    let configured = tempfile::tempdir().unwrap();
    let configured_paths = StoragePaths::open(configured.path()).unwrap();
    let readiness = StartupRecoveryReadiness::new();
    let _recovery = StartupRecoveryState::initialize(configured_paths.clone(), readiness.clone());
    let state = StorageCommandState::new(configured_paths, readiness);

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
        let paths = state.paths_for(consumer).unwrap();
        assert_eq!(paths.root(), configured.path().canonicalize().unwrap());
        assert_ne!(paths.root(), default.path().canonicalize().unwrap());
    }
}
