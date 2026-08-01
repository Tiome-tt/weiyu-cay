use simple_notes_lib::storage::{database::Database, paths::StoragePaths};
use simple_notes_lib::{
    domain::{NoteDocument, NoteId, NoteKind},
    storage::repository::NoteRepository,
};

pub struct TestStore {
    // Keep the database before TempDir so Windows closes SQLite before cleanup.
    pub db: Database,
    pub paths: StoragePaths,
    #[allow(dead_code)]
    pub root: tempfile::TempDir,
}

#[allow(dead_code)]
pub struct LinkFixture {
    pub store: TestStore,
    pub source_id: NoteId,
    pub target_id: NoteId,
}

#[allow(dead_code)]
impl LinkFixture {
    pub fn linked_notes(label: &str) -> Self {
        let store = TestStore::new();
        let source_id = note_id("019c0000-0000-7000-8000-000000000021");
        let target_id = note_id("019c0000-0000-7000-8000-000000000022");
        create_note(
            &store,
            target_id,
            label,
            "target body",
            "2026-07-30T08:02:00Z",
        );
        create_note(
            &store,
            source_id,
            "Source",
            &format!("before [[{label}|{target_id}]] after"),
            "2026-07-30T08:01:00Z",
        );
        Self {
            store,
            source_id,
            target_id,
        }
    }

    pub fn source_markdown(&self) -> String {
        NoteRepository::new(self.store.paths.clone())
            .load(self.source_id)
            .unwrap()
            .markdown
    }
}

#[allow(dead_code)]
pub fn note_id(value: &str) -> NoteId {
    NoteId::parse_str(value).unwrap()
}

#[allow(dead_code)]
pub fn create_note(
    store: &TestStore,
    id: NoteId,
    title: &str,
    markdown: &str,
    updated_at: &str,
) -> NoteDocument {
    NoteRepository::new(store.paths.clone())
        .create(NoteDocument {
            id,
            kind: NoteKind::Formal,
            title: title.to_owned(),
            folder_id: None,
            tags: Vec::new(),
            markdown: markdown.to_owned(),
            revision: 0,
            created_at: "2026-07-30T08:00:00Z".to_owned(),
            updated_at: updated_at.to_owned(),
        })
        .unwrap()
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
