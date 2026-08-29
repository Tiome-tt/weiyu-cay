use rusqlite::Connection;
use weiyu_cay_lib::storage::{
    database::Database, paths::StoragePaths, rebuild::rebuild_index_strict,
};
use std::{path::Path, process::Command};

#[test]
fn generated_ten_thousand_note_fixture_strictly_rebuilds_the_production_index() {
    let root = tempfile::tempdir().expect("create fixture root");
    generate_fixture(root.path(), 10_000, 20260730);
    let paths = StoragePaths::open(root.path()).expect("open generated production layout");
    let empty_index = Database::open(paths.database()).expect("create empty production index");
    empty_index
        .migrate()
        .expect("migrate empty production index");
    empty_index.close().expect("close empty production index");

    let report = rebuild_index_strict(&paths).expect("strict rebuild generated fixture");

    assert_eq!(report.notes_recovered, 10_000);
    assert_eq!(report.notes_failed, 0);
    assert_eq!(report.folders_recovered, 3);
    let database = Connection::open(paths.database()).expect("open rebuilt index");
    let notes: i64 = database
        .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
        .expect("count indexed notes");
    let search_documents: i64 = database
        .query_row("SELECT COUNT(*) FROM search_documents", [], |row| {
            row.get(0)
        })
        .expect("count indexed search documents");
    assert_eq!(notes, 10_000);
    assert_eq!(search_documents, 10_000);
}

fn generate_fixture(root: &Path, count: usize, seed: u64) {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace root");
    let output = Command::new("node")
        .args([
            "--experimental-strip-types",
            "scripts/generate-search-fixture.ts",
            "--count",
            &count.to_string(),
            "--seed",
            &seed.to_string(),
            "--output",
            root.to_str().expect("UTF-8 fixture path"),
        ])
        .current_dir(workspace)
        .output()
        .expect("run fixture generator");
    assert!(
        output.status.success(),
        "fixture generator failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
