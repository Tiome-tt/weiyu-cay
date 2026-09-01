use simple_notes_lib::{
    commands::{
        folders::FolderRepository,
        notes::{
            getting_started_markdown, legacy_getting_started_markdown, prepare_startup_repository,
            prepare_startup_repository_after_recovery,
        },
        storage::StorageCommandState,
    },
    domain::{CreateFolderInput, NoteDocument, NoteId, NoteKind},
    storage::{
        database::Database,
        paths::StoragePaths,
        recovery::{StartupRecoveryReadiness, StartupRecoveryState},
        repository::NoteRepository,
    },
};
use std::fs;

#[test]
fn fresh_storage_creates_the_getting_started_guide_once() {
    let root = tempfile::tempdir().expect("create fresh storage root");
    let paths = StoragePaths::open(root.path()).expect("open fresh storage paths");
    assert!(!paths.database().exists());
    let readiness = StartupRecoveryReadiness::new();
    let state = StorageCommandState::new(paths.clone(), readiness.clone());
    let _recovery = StartupRecoveryState::initialize(paths.clone(), readiness);

    prepare_startup_repository(&state).expect("prepare fresh repository");
    prepare_startup_repository(&state).expect("repeat startup preparation");
    assert!(root.path().join(".startup-guide-v1.json").exists());

    let second_readiness = StartupRecoveryReadiness::new();
    let second_state = StorageCommandState::new(paths.clone(), second_readiness.clone());
    let _second_recovery = StartupRecoveryState::initialize(paths.clone(), second_readiness);
    prepare_startup_repository(&second_state).expect("prepare a second process state");

    let folders = FolderRepository::new(paths.clone())
        .list()
        .expect("list seeded folders");
    assert_eq!(folders.len(), 1);
    assert_eq!(folders[0].name, "开始使用");

    let notes = NoteRepository::new(paths.clone())
        .list_in_folder(Some(folders[0].id))
        .expect("list seeded notes");
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].title, "欢迎来到微屿");

    let guide = NoteRepository::new(paths)
        .load(notes[0].id)
        .expect("load getting-started guide");
    assert!(guide.markdown.contains("无需登录，也不依赖网络"));
    assert!(guide.markdown.contains("[[笔记标题]]"));
    assert!(guide.markdown.contains("临时便笺"));
    assert!(guide.markdown.contains("Ctrl+Shift+D"));
    assert!(guide.markdown.contains("Command+Shift+D"));
    assert!(!guide.markdown.contains("Shift+Space"));
    assert!(guide.markdown.contains("设置中修改全局快捷键"));
    assert!(guide.markdown.contains("钉在桌面最上层"));
    assert!(guide.markdown.contains("转为正式笔记"));
    assert!(guide.markdown.contains("- [ ] 任务项"));
    assert!(guide.markdown.contains("> 引用一段重要内容"));
    assert!(guide.markdown.contains("[显示文字](https://example.com)"));
    assert!(guide.markdown.contains("分隔线使用三个短横线："));
    assert!(!guide.markdown.contains("这篇引导笔记也可以随时删除。"));
    assert!(!guide.markdown.contains("## 你的内容属于你"));
    let target = simple_notes_lib::domain::StartupGuideTarget {
        folder_id: folders[0].id,
        note_id: guide.id,
    };
    assert_eq!(state.startup_guide_target().unwrap(), Some(target));
    state.complete_startup_guide(target).unwrap();
    assert!(!root.path().join(".startup-guide-v1.json").exists());
    assert_eq!(state.startup_guide_target().unwrap(), None);
}

#[test]
fn an_existing_empty_library_is_seeded_with_the_getting_started_guide() {
    let root = tempfile::tempdir().expect("create existing storage root");
    let paths = StoragePaths::open(root.path()).expect("open existing storage paths");
    let database = Database::open(paths.database()).expect("create existing database");
    database.migrate().expect("migrate existing database");
    database.close().expect("close existing database");
    let readiness = StartupRecoveryReadiness::new();
    let state = StorageCommandState::new(paths.clone(), readiness.clone());
    let _recovery = StartupRecoveryState::initialize(paths.clone(), readiness);

    prepare_startup_repository(&state).expect("prepare existing repository");

    let folders = FolderRepository::new(paths.clone()).list().unwrap();
    assert_eq!(folders.len(), 1);
    assert_eq!(folders[0].name, "开始使用");
    let notes = NoteRepository::new(paths)
        .list_in_folder(Some(folders[0].id))
        .unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].title, "欢迎来到微屿");
    assert_eq!(
        state.startup_guide_target().unwrap().unwrap().note_id,
        notes[0].id
    );
}

#[test]
fn a_fresh_install_interrupted_before_seeding_resumes_on_restart() {
    let root = tempfile::tempdir().expect("create fresh storage root");
    let paths = StoragePaths::open(root.path()).expect("open fresh storage paths");
    let first_readiness = StartupRecoveryReadiness::new();
    let first_state = StorageCommandState::new(paths.clone(), first_readiness.clone());
    let _first_recovery = StartupRecoveryState::initialize(paths.clone(), first_readiness);
    drop(first_state);

    let restart_readiness = StartupRecoveryReadiness::new();
    let restarted_state = StorageCommandState::new(paths.clone(), restart_readiness.clone());
    let _restart_recovery = StartupRecoveryState::initialize(paths.clone(), restart_readiness);
    prepare_startup_repository(&restarted_state).expect("resume startup preparation");

    let folders = FolderRepository::new(paths.clone()).list().unwrap();
    assert_eq!(folders.len(), 1);
    let notes = NoteRepository::new(paths)
        .list_in_folder(Some(folders[0].id))
        .unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(
        restarted_state.startup_guide_target().unwrap(),
        Some(simple_notes_lib::domain::StartupGuideTarget {
            folder_id: folders[0].id,
            note_id: notes[0].id,
        })
    );
}

#[test]
fn durable_notes_without_an_index_are_recovered_without_seeding_a_guide() {
    let root = tempfile::tempdir().expect("create existing storage root");
    let paths = StoragePaths::open(root.path()).expect("open existing storage paths");
    let database = Database::open(paths.database()).expect("create existing database");
    database.migrate().expect("migrate existing database");
    database.close().expect("close existing database");
    let existing_id = NoteId::now_v7();
    NoteRepository::new(paths.clone())
        .create(NoteDocument {
            id: existing_id,
            kind: NoteKind::Formal,
            title: "已有笔记".to_owned(),
            folder_id: None,
            tags: Vec::new(),
            markdown: "旧内容".to_owned(),
            revision: 0,
            created_at: "2026-08-01T00:00:00Z".to_owned(),
            updated_at: "2026-08-01T00:00:00Z".to_owned(),
        })
        .expect("create durable note");
    fs::remove_file(paths.database()).expect("remove rebuildable index");

    let readiness = StartupRecoveryReadiness::new();
    let state = StorageCommandState::new(paths.clone(), readiness.clone());
    let _recovery = StartupRecoveryState::initialize(paths.clone(), readiness);
    prepare_startup_repository(&state).expect("prepare recovered repository");

    let notes = NoteRepository::new(paths.clone()).list().unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].id, existing_id);
    assert!(FolderRepository::new(paths).list().unwrap().is_empty());
    assert_eq!(state.startup_guide_target().unwrap(), None);
}

#[test]
fn a_successful_recovery_retry_finishes_pending_guide_setup() {
    let root = tempfile::tempdir().expect("create fresh storage root");
    let paths = StoragePaths::open(root.path()).expect("open fresh storage paths");
    let readiness = StartupRecoveryReadiness::new();
    let state = StorageCommandState::new(paths.clone(), readiness.clone());
    let recovery = StartupRecoveryState::initialize(paths.clone(), readiness);

    recovery
        .retry_with(|| prepare_startup_repository_after_recovery(&state))
        .expect("retry startup recovery");

    let folders = FolderRepository::new(paths.clone()).list().unwrap();
    assert_eq!(folders.len(), 1);
    let notes = NoteRepository::new(paths)
        .list_in_folder(Some(folders[0].id))
        .unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(
        state.startup_guide_target().unwrap().unwrap().note_id,
        notes[0].id
    );
}

#[test]
fn startup_upgrades_only_an_unmodified_legacy_guide() {
    let root = tempfile::tempdir().expect("create storage root");
    let paths = StoragePaths::open(root.path()).expect("open storage paths");
    let database = Database::open(paths.database()).expect("create database");
    database.migrate().expect("migrate database");
    database.close().expect("close database");
    let folder = FolderRepository::new(paths.clone())
        .create(CreateFolderInput {
            parent_id: None,
            name: "开始使用".to_owned(),
        })
        .unwrap();
    let notes = NoteRepository::new(paths.clone());
    let legacy_id = NoteId::now_v7();
    let edited_id = NoteId::now_v7();
    for (id, markdown) in [
        (legacy_id, legacy_getting_started_markdown().to_owned()),
        (
            edited_id,
            format!("{}\n\n用户补充", legacy_getting_started_markdown()),
        ),
    ] {
        notes
            .create(NoteDocument {
                id,
                kind: NoteKind::Formal,
                title: "欢迎来到微屿".to_owned(),
                folder_id: Some(folder.id),
                tags: Vec::new(),
                markdown,
                revision: 0,
                created_at: "2026-08-31T00:00:00Z".to_owned(),
                updated_at: "2026-08-31T00:00:00Z".to_owned(),
            })
            .unwrap();
    }

    let readiness = StartupRecoveryReadiness::new();
    let state = StorageCommandState::new(paths.clone(), readiness.clone());
    let _recovery = StartupRecoveryState::initialize(paths.clone(), readiness);
    prepare_startup_repository(&state).expect("upgrade startup guide");

    assert_eq!(
        notes.load(legacy_id).unwrap().markdown,
        getting_started_markdown()
    );
    assert!(notes.load(legacy_id).unwrap().revision > 0);
    assert!(notes
        .load(edited_id)
        .unwrap()
        .markdown
        .ends_with("用户补充"));
}

#[test]
fn startup_upgrades_unmodified_previous_guides() {
    for use_space_shortcut in [false, true] {
        let root = tempfile::tempdir().expect("create storage root");
        let paths = StoragePaths::open(root.path()).expect("open storage paths");
        let database = Database::open(paths.database()).expect("create database");
        database.migrate().expect("migrate database");
        database.close().expect("close database");
        let folder = FolderRepository::new(paths.clone())
            .create(CreateFolderInput {
                parent_id: None,
                name: "开始使用".to_owned(),
            })
            .unwrap();
        let previous_guide = getting_started_markdown()
            .replace("分隔线使用三个短横线：\n\n---", "---")
            .replace(
                "现在，新建你的第一篇笔记吧。\n",
                "现在，新建你的第一篇笔记吧。\n\n这篇引导笔记也可以随时删除。\n",
            );
        let previous_guide = if use_space_shortcut {
            previous_guide
                .replace("Ctrl+Shift+D", "Ctrl+Shift+Space")
                .replace("Command+Shift+D", "Command+Shift+Space")
        } else {
            previous_guide
        };
        let note_id = NoteId::now_v7();
        let notes = NoteRepository::new(paths.clone());
        notes
            .create(NoteDocument {
                id: note_id,
                kind: NoteKind::Formal,
                title: "欢迎来到微屿".to_owned(),
                folder_id: Some(folder.id),
                tags: Vec::new(),
                markdown: previous_guide,
                revision: 0,
                created_at: "2026-09-01T00:00:00Z".to_owned(),
                updated_at: "2026-09-01T00:00:00Z".to_owned(),
            })
            .unwrap();

        let readiness = StartupRecoveryReadiness::new();
        let state = StorageCommandState::new(paths.clone(), readiness.clone());
        let _recovery = StartupRecoveryState::initialize(paths.clone(), readiness);
        prepare_startup_repository(&state).expect("upgrade previous guide");

        let upgraded = notes.load(note_id).unwrap();
        assert!(upgraded.markdown.contains("Ctrl+Shift+D"));
        assert!(upgraded.markdown.contains("Command+Shift+D"));
        assert!(upgraded.markdown.contains("分隔线使用三个短横线："));
        assert!(!upgraded.markdown.contains("Shift+Space"));
        assert!(!upgraded.markdown.contains("这篇引导笔记也可以随时删除。"));
        assert!(upgraded.revision > 0);
    }
}
