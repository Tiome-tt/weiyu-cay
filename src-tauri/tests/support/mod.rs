use weiyu_cay_lib::storage::{database::Database, paths::StoragePaths};
use weiyu_cay_lib::{
    domain::{NoteDocument, NoteId, NoteKind},
    storage::repository::NoteRepository,
};
use std::fs;
use uuid::Uuid;

#[allow(dead_code)]
const RECOVERY_NOTE_ID: &str = "019c0000-0000-7000-8000-000000000611";

#[allow(dead_code)]
pub struct RecoveryFixture {
    pub store: TestStore,
    candidate_sequence: u128,
}

#[allow(dead_code)]
impl RecoveryFixture {
    pub fn with_document(revision: u64, markdown: &str) -> Self {
        let store = TestStore::new();
        let repository = NoteRepository::new(store.paths.clone());
        let mut current = repository
            .create(recovery_document(0, markdown))
            .expect("create recovery fixture note");
        for expected in 0..revision {
            current.revision = expected;
            current.markdown = markdown.to_owned();
            current = repository
                .save(current, expected)
                .expect("advance recovery fixture revision");
        }
        Self {
            store,
            candidate_sequence: 1,
        }
    }

    pub fn add_candidate(&mut self, revision: u64, markdown: &str) {
        self.add_candidate_with_id(RECOVERY_NOTE_ID, revision, markdown);
    }

    pub fn add_candidate_with_id(&mut self, id: &str, revision: u64, markdown: &str) {
        let name = format!(".note.md.{}.tmp", Uuid::from_u128(self.candidate_sequence));
        self.candidate_sequence += 1;
        fs::write(
            self.note_directory().join(name),
            serialized_document(id, revision, markdown),
        )
        .expect("write recovery candidate");
    }

    pub fn loaded_markdown(&self) -> String {
        NoteRepository::new(self.store.paths.clone())
            .load(NoteId::parse_str(RECOVERY_NOTE_ID).unwrap())
            .unwrap()
            .markdown
    }

    pub fn candidate_names(&self) -> Vec<String> {
        fs::read_dir(self.note_directory())
            .unwrap()
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.starts_with(".note.md.") && name.ends_with(".tmp"))
            .collect()
    }

    pub fn note_path(&self) -> std::path::PathBuf {
        self.note_directory().join("note.md")
    }

    fn note_directory(&self) -> std::path::PathBuf {
        self.store.paths.notes().join(RECOVERY_NOTE_ID)
    }
}

#[allow(dead_code)]
fn recovery_document(revision: u64, markdown: &str) -> NoteDocument {
    NoteDocument {
        id: NoteId::parse_str(RECOVERY_NOTE_ID).unwrap(),
        kind: NoteKind::Formal,
        title: "Recovery fixture".to_owned(),
        folder_id: None,
        tags: Vec::new(),
        markdown: markdown.to_owned(),
        revision,
        created_at: "2026-07-30T00:00:00Z".to_owned(),
        updated_at: "2026-07-30T00:00:00Z".to_owned(),
    }
}

#[allow(dead_code)]
fn serialized_document(id: &str, revision: u64, markdown: &str) -> String {
    format!(
        "---\nid: {id}\nkind: formal\ntitle: Recovery fixture\nfolderId: null\ntags: []\nrevision: {revision}\ncreatedAt: 2026-07-30T00:00:00Z\nupdatedAt: 2026-07-30T00:00:00Z\n---\n{markdown}"
    )
}

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
