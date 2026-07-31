use simple_notes_lib::storage::{database::Database, paths::StoragePaths};

pub struct TestStore {
    // Keep the database before TempDir so Windows closes SQLite before cleanup.
    pub db: Database,
    pub paths: StoragePaths,
    pub root: tempfile::TempDir,
}

impl TestStore {
    pub fn new() -> Self {
        let root = tempfile::tempdir().expect("create isolated storage root");
        let paths = StoragePaths::open(root.path()).expect("open storage paths");
        let db = Database::open(paths.database()).expect("open isolated database");
        db.migrate().expect("migrate isolated database");
        Self { db, paths, root }
    }

    #[allow(dead_code)]
    pub fn close_database(&mut self) {
        let open = std::mem::replace(
            &mut self.db,
            Database::memory().expect("open placeholder db"),
        );
        drop(open);
    }
}
