use simple_notes_lib::{
    domain::FolderId,
    platform::IndexMutationLock,
    storage::{paths::StoragePaths, rebuild::rebuild_index_strict, repository::NoteRepository},
};
use std::time::Instant;

#[test]
#[ignore = "requires an explicitly generated 10,000-note fixture"]
fn generated_folder_list_performance() {
    let root = std::env::var("CAY_LIST_FIXTURE").expect("fixture path required");
    let paths = StoragePaths::open(&root).unwrap();
    if std::env::var_os("CAY_LIST_FIXTURE_READY").is_none() {
        let report = rebuild_index_strict(&paths).unwrap();
        assert_eq!(report.notes_recovered, 10000, "{report:?}");
        assert_eq!(report.notes_failed, 0);
    }
    let connection = rusqlite::Connection::open(paths.root().join("index.sqlite")).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM notes", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        10000
    );
    #[derive(serde::Deserialize)]
    struct FixtureFolder {
        id: FolderId,
    }

    let folders: Vec<FixtureFolder> =
        serde_json::from_slice(&std::fs::read(paths.root().join("folders.json")).unwrap()).unwrap();
    let repo = NoteRepository::new(paths.clone());
    let summaries = repo.list_in_folder(Some(folders[0].id)).unwrap();
    let ids: Vec<_> = summaries.iter().map(|note| note.id).collect();
    let baseline = Instant::now();
    {
        let guard = IndexMutationLock::acquire(paths.root()).unwrap();
        for id in &ids {
            let note = repo.load_locked(*id, &guard).unwrap();
            let _: String = note.markdown.chars().take(160).collect();
        }
    }
    let legacy_ms = baseline.elapsed().as_secs_f64() * 1000.0;
    let start = Instant::now();
    let current = repo.list_in_folder(Some(folders[0].id)).unwrap();
    let indexed_ms = start.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(current.len(), ids.len());
    println!(
        "notes=10000 folder_notes={} legacy_read_ms={legacy_ms:.2} indexed_list_ms={indexed_ms:.2}",
        ids.len()
    );
}
