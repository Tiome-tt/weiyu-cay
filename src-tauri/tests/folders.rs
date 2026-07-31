mod support;

use rusqlite::{params, Connection};
use simple_notes_lib::{
    commands::folders::FolderRepository,
    domain::{CreateFolderInput, FolderId, NoteDocument, NoteId, NoteKind},
    error::CommandErrorCode,
    storage::{database::Database, rebuild::rebuild_index, repository::NoteRepository},
};
use support::TestStore;

const ROOT_A: &str = "019c0000-0000-7000-8000-000000000101";
const ROOT_B: &str = "019c0000-0000-7000-8000-000000000102";
const CHILD: &str = "019c0000-0000-7000-8000-000000000103";
const GRANDCHILD: &str = "019c0000-0000-7000-8000-000000000104";

fn folder_id(value: &str) -> FolderId {
    FolderId::parse_str(value).unwrap()
}

fn repository(store: &TestStore) -> FolderRepository {
    assert!(store.root.path().exists());
    FolderRepository::new(
        store.paths.clone(),
        Database::open(store.paths.database()).unwrap(),
    )
}

#[test]
fn create_trims_names_and_appends_a_deterministic_sort_order() {
    let store = TestStore::new();
    let repo = repository(&store);

    let first = repo
        .create(CreateFolderInput {
            parent_id: None,
            name: "  工作  ".to_owned(),
        })
        .unwrap();
    let second = repo
        .create(CreateFolderInput {
            parent_id: None,
            name: "生活".to_owned(),
        })
        .unwrap();

    assert_eq!(first.name, "工作");
    assert_eq!(first.sort_order, 0);
    assert_eq!(second.sort_order, 1);
    assert_eq!(repo.list().unwrap(), vec![first, second]);
}

#[test]
fn create_rejects_blank_control_and_path_separator_names() {
    let store = TestStore::new();
    let repo = repository(&store);

    for name in ["   ", "bad/name", "bad\\name", "bad\u{0000}name", ".", ".."] {
        let error = repo
            .create(CreateFolderInput {
                parent_id: None,
                name: name.to_owned(),
            })
            .unwrap_err();
        assert_eq!(error.code(), CommandErrorCode::Validation, "{name:?}");
    }
}

#[test]
fn rename_preserves_identity_and_rejects_a_sibling_name_conflict() {
    let store = TestStore::new();
    seed_folder(&store, ROOT_A, None, "项目 A", 0);
    seed_folder(&store, ROOT_B, None, "项目 B", 1);
    let repo = repository(&store);

    let renamed = repo
        .rename(folder_id(ROOT_A), "  核心项目  ".to_owned())
        .unwrap();
    assert_eq!(renamed.id, folder_id(ROOT_A));
    assert_eq!(renamed.name, "核心项目");

    let error = repo
        .rename(folder_id(ROOT_A), "项目 B".to_owned())
        .unwrap_err();
    assert_eq!(error.code(), CommandErrorCode::Conflict);
}

#[test]
fn move_updates_parent_and_reorders_both_sibling_sets() {
    let store = TestStore::new();
    seed_folder(&store, ROOT_A, None, "项目 A", 0);
    seed_folder(&store, ROOT_B, None, "项目 B", 1);
    seed_folder(&store, CHILD, Some(ROOT_A), "子目录", 0);
    let repo = repository(&store);

    let moved = repo
        .move_folder(folder_id(ROOT_B), Some(folder_id(ROOT_A)))
        .unwrap();

    assert_eq!(moved.parent_id, Some(folder_id(ROOT_A)));
    assert_eq!(moved.sort_order, 1);
    let root = repo.list().unwrap();
    assert_eq!(
        root.iter()
            .find(|folder| folder.id == folder_id(ROOT_A))
            .unwrap()
            .sort_order,
        0
    );
}

#[test]
fn move_rejects_self_and_descendant_cycles_without_changing_the_tree() {
    let store = TestStore::new();
    seed_folder(&store, ROOT_A, None, "根", 0);
    seed_folder(&store, CHILD, Some(ROOT_A), "子", 0);
    seed_folder(&store, GRANDCHILD, Some(CHILD), "孙", 0);
    let repo = repository(&store);

    for parent in [ROOT_A, CHILD, GRANDCHILD] {
        let error = repo
            .move_folder(folder_id(ROOT_A), Some(folder_id(parent)))
            .unwrap_err();
        assert_eq!(error.code(), CommandErrorCode::Conflict);
    }
    let root = repo
        .list()
        .unwrap()
        .into_iter()
        .find(|folder| folder.id == folder_id(ROOT_A))
        .unwrap();
    assert_eq!(root.parent_id, None);
}

#[test]
fn delete_rejects_child_folders_and_existing_notes_and_preserves_them() {
    let store = TestStore::new();
    seed_folder(&store, ROOT_A, None, "根", 0);
    seed_folder(&store, CHILD, Some(ROOT_A), "子", 0);
    let repo = repository(&store);

    assert_eq!(
        repo.delete_empty(folder_id(ROOT_A)).unwrap_err().code(),
        CommandErrorCode::Conflict
    );
    repo.delete_empty(folder_id(CHILD)).unwrap();
    seed_note(&store, ROOT_A);
    assert_eq!(
        repo.delete_empty(folder_id(ROOT_A)).unwrap_err().code(),
        CommandErrorCode::Conflict
    );

    let connection = Connection::open(store.paths.database()).unwrap();
    let note_count: i64 = connection
        .query_row("SELECT count(*) FROM notes", [], |row| row.get(0))
        .unwrap();
    assert_eq!(note_count, 1);
    assert_eq!(repo.list().unwrap().len(), 1);
}

#[test]
fn delete_removes_only_an_empty_folder_and_compacts_sort_order() {
    let store = TestStore::new();
    seed_folder(&store, ROOT_A, None, "项目 A", 0);
    seed_folder(&store, ROOT_B, None, "项目 B", 1);
    let repo = repository(&store);

    repo.delete_empty(folder_id(ROOT_A)).unwrap();

    let folders = repo.list().unwrap();
    assert_eq!(folders.len(), 1);
    assert_eq!(folders[0].id, folder_id(ROOT_B));
    assert_eq!(folders[0].sort_order, 0);
}

#[test]
fn folder_mutations_survive_a_full_index_rebuild_with_note_associations() {
    let mut store = TestStore::new();
    let repo = repository(&store);
    let root_a = repo
        .create(CreateFolderInput {
            parent_id: None,
            name: "项目 A".to_owned(),
        })
        .unwrap();
    let root_b = repo
        .create(CreateFolderInput {
            parent_id: None,
            name: "项目 B".to_owned(),
        })
        .unwrap();
    let child = repo
        .create(CreateFolderInput {
            parent_id: Some(root_a.id),
            name: "初始子目录".to_owned(),
        })
        .unwrap();
    let notes = NoteRepository::new(
        store.paths.clone(),
        Database::open(store.paths.database()).unwrap(),
    );
    let note_id = NoteId::parse_str("019c0000-0000-7000-8000-000000000198").unwrap();
    notes
        .create(NoteDocument {
            id: note_id,
            kind: NoteKind::Formal,
            title: "保留文件夹关联".to_owned(),
            folder_id: Some(child.id),
            tags: Vec::new(),
            markdown: "rebuild me".to_owned(),
            revision: 0,
            created_at: "2026-07-31T00:00:00Z".to_owned(),
            updated_at: "2026-07-31T00:00:00Z".to_owned(),
        })
        .unwrap();
    repo.move_folder(child.id, Some(root_b.id)).unwrap();
    let renamed = repo.rename(child.id, "归档".to_owned()).unwrap();
    drop(notes);
    drop(repo);
    store.close_database();

    let report = rebuild_index(&store.paths).unwrap();

    assert_eq!(report.folders_recovered, 3);
    assert_eq!(report.notes_recovered, 1);
    let connection = Connection::open(store.paths.database()).unwrap();
    let (name, parent): (String, Vec<u8>) = connection
        .query_row(
            "SELECT name, parent_id FROM folders WHERE id = ?1",
            params![uuid::Uuid::parse_str(&renamed.id.to_string())
                .unwrap()
                .as_bytes()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(name, "归档");
    assert_eq!(
        parent,
        uuid::Uuid::parse_str(&root_b.id.to_string())
            .unwrap()
            .as_bytes()
    );
    let note_folder: Vec<u8> = connection
        .query_row(
            "SELECT folder_id FROM notes WHERE id = ?1",
            params![uuid::Uuid::parse_str(&note_id.to_string())
                .unwrap()
                .as_bytes()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        note_folder,
        uuid::Uuid::parse_str(&renamed.id.to_string())
            .unwrap()
            .as_bytes()
    );
}

fn seed_folder(store: &TestStore, id: &str, parent_id: Option<&str>, name: &str, sort_order: i64) {
    let connection = Connection::open(store.paths.database()).unwrap();
    let id = uuid::Uuid::parse_str(id).unwrap().as_bytes().to_vec();
    let parent_id =
        parent_id.map(|value| uuid::Uuid::parse_str(value).unwrap().as_bytes().to_vec());
    connection.execute(
        "INSERT INTO folders (id, parent_id, name, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, '2026-07-31T00:00:00Z', '2026-07-31T00:00:00Z')",
        params![id, parent_id, name, sort_order],
    ).unwrap();
}

fn seed_note(store: &TestStore, folder: &str) {
    let connection = Connection::open(store.paths.database()).unwrap();
    let note = uuid::Uuid::parse_str("019c0000-0000-7000-8000-000000000199")
        .unwrap()
        .as_bytes()
        .to_vec();
    let folder = uuid::Uuid::parse_str(folder).unwrap().as_bytes().to_vec();
    connection.execute(
        "INSERT INTO notes (id, kind, title, folder_id, relative_path, created_at, updated_at, revision, deleted_at) VALUES (?1, 'formal', '保留', ?2, 'notes/keep', '2026-07-31T00:00:00Z', '2026-07-31T00:00:00Z', 0, NULL)",
        params![note, folder],
    ).unwrap();
}
