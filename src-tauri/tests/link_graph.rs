mod support;
use simple_notes_lib::storage::link_graph::neighborhood;
use support::{create_note, note_id, TestStore};
fn id(n: u32) -> simple_notes_lib::domain::NoteId {
    note_id(&format!("019c0000-0000-7000-8000-{n:012x}"))
}
fn add(store: &TestStore, n: u32, targets: &[u32]) {
    create_note(
        store,
        id(n),
        &format!("Note {n}"),
        &targets
            .iter()
            .map(|target| format!("[[Note|{}]]", id(*target)))
            .collect::<Vec<_>>()
            .join(" "),
        "2026-11-02T08:00:00Z",
    );
}
#[test]
fn graph_follows_both_directions_for_two_hops_and_deduplicates_cycles() {
    let store = TestStore::new();
    add(&store, 1, &[2, 2, 99]);
    add(&store, 2, &[1, 3]);
    add(&store, 3, &[2, 5]);
    add(&store, 4, &[1]);
    add(&store, 5, &[]);
    let graph = neighborhood(&store.paths, id(1)).unwrap();
    assert_eq!(graph.nodes.len(), 4);
    assert_eq!(graph.edges.len(), 5);
    assert_eq!(
        graph
            .nodes
            .iter()
            .find(|node| node.id == id(3))
            .unwrap()
            .distance,
        2
    );
    assert!(!graph
        .nodes
        .iter()
        .any(|node| node.id == id(5) || node.id == id(99)));
    assert!(!graph.truncated);
}
#[test]
fn graph_excludes_deleted_notes_and_reads_only_index_metadata() {
    let store = TestStore::new();
    add(&store, 1, &[2, 3]);
    add(&store, 2, &[]);
    add(&store, 3, &[]);
    rusqlite::Connection::open(store.paths.database())
        .unwrap()
        .execute(
            "UPDATE notes SET deleted_at='2026-11-02' WHERE id=?1",
            [uuid::Uuid::parse_str(&id(2).to_string())
                .unwrap()
                .as_bytes()
                .to_vec()],
        )
        .unwrap();
    std::fs::remove_dir_all(store.paths.root().join("notes").join(id(3).to_string())).unwrap();
    let graph = neighborhood(&store.paths, id(1)).unwrap();
    assert_eq!(graph.nodes.len(), 2);
    assert!(graph.nodes.iter().any(|node| node.id == id(3)));
    assert!(neighborhood(&store.paths, id(2)).unwrap().nodes.is_empty());
}
#[test]
fn graph_is_bounded_and_deterministic_for_high_degree_notes() {
    let store = TestStore::new();
    add(&store, 1, &(2..40).collect::<Vec<_>>());
    for n in 2..40 {
        add(&store, n, &[])
    }
    let graph = neighborhood(&store.paths, id(1)).unwrap();
    assert_eq!(graph.nodes.len(), 24);
    assert!(graph.edges.len() <= 48);
    assert!(graph.truncated);
    assert_eq!(
        serde_json::to_value(&graph).unwrap(),
        serde_json::to_value(neighborhood(&store.paths, id(1)).unwrap()).unwrap()
    );
}
