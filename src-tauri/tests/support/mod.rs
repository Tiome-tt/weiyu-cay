use simple_notes_lib::storage::{database::Database, paths::StoragePaths};

pub struct TestStore {
    pub root: tempfile::TempDir,
    pub paths: StoragePaths,
    pub db: Database,
}

impl TestStore {
    pub fn new() -> Self {
        let root = tempfile::tempdir().expect("create isolated storage root");
        let paths = StoragePaths::open(root.path()).expect("open storage paths");
        let db = Database::open(paths.database()).expect("open isolated database");
        db.migrate().expect("migrate isolated database");
        Self { root, paths, db }
    }
}
