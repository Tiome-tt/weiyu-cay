use criterion::{criterion_group, criterion_main, Criterion};
use simple_notes_lib::{
    commands::search::SearchRepository,
    domain::{NoteDocument, NoteId, NoteKind},
    storage::{database::Database, paths::StoragePaths, repository::NoteRepository},
};
use std::{hint::black_box, time::Instant};

const NOTE_COUNT: usize = 10_000;

struct SearchFixture {
    _root: tempfile::TempDir,
    paths: StoragePaths,
}

impl SearchFixture {
    fn new() -> Self {
        let root = tempfile::tempdir().expect("create benchmark directory");
        let paths = StoragePaths::open(root.path()).expect("open benchmark storage");
        let database = Database::open(paths.database()).expect("open benchmark index");
        database.migrate().expect("migrate benchmark index");
        database.close().expect("close benchmark setup index");
        let repository = NoteRepository::new(paths.clone());
        let started = Instant::now();
        for index in 0..NOTE_COUNT {
            let id = NoteId::parse_str(&format!(
                "019c0000-{:04x}-7000-8000-{:012x}",
                index / 4096,
                index + 1
            ))
            .expect("deterministic UUIDv7");
            let topic = index % 97;
            repository
                .create(NoteDocument {
                    id,
                    kind: NoteKind::Formal,
                    title: format!("开发笔记 {index:05} topic-{topic}"),
                    folder_id: None,
                    tags: vec![format!("group-{}", index % 20)],
                    markdown: format!(
                        "# 记录 {index}\n\n这是确定性正文，包含 refresh-token-{topic} 和索引恢复步骤。\n\n```rust\nlet item = {index};\n```"
                    ),
                    revision: 0,
                    created_at: "2026-07-31T08:00:00Z".into(),
                    updated_at: format!("2026-07-31T{:02}:{:02}:00Z", 8 + index % 10, index % 60),
                })
                .expect("index benchmark note");
        }
        eprintln!(
            "generated {NOTE_COUNT} deterministic notes through NoteRepository in {:?}",
            started.elapsed()
        );
        drop(repository);
        Self { _root: root, paths }
    }
}

fn search_benchmarks(criterion: &mut Criterion) {
    let fixture = SearchFixture::new();

    criterion.bench_function("fixture/index_startup_10000", |bencher| {
        bencher.iter(|| {
            let database = Database::open(black_box(fixture.paths.database()))
                .expect("open existing benchmark index");
            database.migrate().expect("verify benchmark migrations");
            black_box(database.applied_migration_versions().unwrap())
        })
    });
    criterion.bench_function("search/text_trigram_10000", |bencher| {
        bencher.iter(|| {
            black_box(
                SearchRepository::new(fixture.paths.clone())
                    .search_text(black_box("refresh-token-42"), 100)
                    .expect("trigram search"),
            )
        })
    });
    criterion.bench_function("search/text_short_10000", |bencher| {
        bencher.iter(|| {
            black_box(
                SearchRepository::new(fixture.paths.clone())
                    .search_text(black_box("索"), 100)
                    .expect("short text search"),
            )
        })
    });
    criterion.bench_function("search/tag_10000", |bencher| {
        bencher.iter(|| {
            black_box(
                SearchRepository::new(fixture.paths.clone())
                    .search_tag(black_box("group-7"), 100)
                    .expect("tag search"),
            )
        })
    });
}

criterion_group!(
    name = benches;
    config = Criterion::default().sample_size(10);
    targets = search_benchmarks
);
criterion_main!(benches);
