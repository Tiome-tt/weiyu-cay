use serde_json::Value;
use simple_notes_lib::{
    commands::settings::{
        authorize_restart_request, authorize_settings_caller, finalize_reopened_relocation,
        open_configured_storage, AppSettings, DataRootSetting, SettingsPatch, SettingsService,
        SettingsStore, StorageMoveFailurePoint, SystemSettings,
    },
    error::CommandError,
    storage::paths::StoragePaths,
    windows::sticky::{
        InMemoryTemporaryWindowBackend, TemporaryRepository, TemporaryWindowService,
    },
};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Clone, Default)]
struct MemoryStore {
    value: Arc<Mutex<Option<Value>>>,
    fail_save: Arc<Mutex<bool>>,
}

impl MemoryStore {
    fn corrupted() -> Self {
        Self {
            value: Arc::new(Mutex::new(Some(serde_json::json!({ "fontSize": "huge" })))),
            ..Self::default()
        }
    }

    fn fail_next_save(&self) {
        *self.fail_save.lock().unwrap() = true;
    }
}

impl SettingsStore for MemoryStore {
    fn load(&self) -> Result<Option<Value>, CommandError> {
        Ok(self.value.lock().unwrap().clone())
    }

    fn save(&self, value: &Value) -> Result<(), CommandError> {
        if std::mem::take(&mut *self.fail_save.lock().unwrap()) {
            return Err(CommandError::io("injected settings save failure"));
        }
        *self.value.lock().unwrap() = Some(value.clone());
        Ok(())
    }
}

#[derive(Clone)]
struct FakeSystem {
    shortcut: Arc<Mutex<String>>,
    autostart: Arc<Mutex<bool>>,
    reject_shortcut: Arc<Mutex<bool>>,
    reject_autostart: Arc<Mutex<bool>>,
}

impl Default for FakeSystem {
    fn default() -> Self {
        Self {
            shortcut: Arc::new(Mutex::new("CommandOrControl+Shift+Space".to_owned())),
            autostart: Arc::new(Mutex::new(false)),
            reject_shortcut: Arc::new(Mutex::new(false)),
            reject_autostart: Arc::new(Mutex::new(false)),
        }
    }
}

impl SystemSettings for FakeSystem {
    fn shortcut(&self) -> Result<String, CommandError> {
        Ok(self.shortcut.lock().unwrap().clone())
    }

    fn rebind_shortcut(&self, shortcut: &str) -> Result<(), CommandError> {
        if *self.reject_shortcut.lock().unwrap() {
            return Err(CommandError::conflict("injected shortcut conflict"));
        }
        *self.shortcut.lock().unwrap() = shortcut.to_owned();
        Ok(())
    }

    fn launch_at_startup(&self) -> Result<bool, CommandError> {
        Ok(*self.autostart.lock().unwrap())
    }

    fn set_launch_at_startup(&self, enabled: bool) -> Result<(), CommandError> {
        if *self.reject_autostart.lock().unwrap() {
            return Err(CommandError::io("injected autostart failure"));
        }
        *self.autostart.lock().unwrap() = enabled;
        Ok(())
    }
}

fn service(
    root: &tempfile::TempDir,
    store: MemoryStore,
    system: FakeSystem,
) -> SettingsService<MemoryStore, FakeSystem> {
    SettingsService::new(StoragePaths::open(root.path()).unwrap(), store, system)
}

#[test]
fn defaults_and_numeric_bounds_are_explicit() {
    let defaults = AppSettings::default();
    assert_eq!(defaults.theme.as_str(), "system");
    assert_eq!(defaults.sticky_color_mode.as_str(), "follow-theme");
    assert_eq!(defaults.shortcut, "CommandOrControl+Shift+Space");
    assert_eq!(defaults.font_size, 16.0);
    assert_eq!(defaults.line_height, 1.6);
    assert_eq!(defaults.autosave_delay_ms, 500);

    let root = tempfile::tempdir().unwrap();
    let updated = service(&root, MemoryStore::default(), FakeSystem::default())
        .update(SettingsPatch {
            font_size: Some(99.0),
            line_height: Some(0.2),
            autosave_delay_ms: Some(10),
            ..SettingsPatch::default()
        })
        .unwrap();
    assert_eq!(updated.font_size, 28.0);
    assert_eq!(updated.line_height, 1.2);
    assert_eq!(updated.autosave_delay_ms, 150);
}

#[test]
fn corrupted_settings_recover_to_valid_defaults() {
    let root = tempfile::tempdir().unwrap();
    let store = MemoryStore::corrupted();
    let loaded = service(&root, store.clone(), FakeSystem::default())
        .load()
        .unwrap();
    assert_eq!(loaded, AppSettings::default());
    assert_eq!(
        serde_json::from_value::<AppSettings>(store.load().unwrap().unwrap()).unwrap(),
        AppSettings::default()
    );
}

#[test]
fn shortcut_and_autostart_failures_leave_behavior_and_settings_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let store = MemoryStore::default();
    let system = FakeSystem::default();
    *system.reject_shortcut.lock().unwrap() = true;
    let service = service(&root, store.clone(), system.clone());
    assert!(service
        .update(SettingsPatch {
            shortcut: Some("CommandOrControl+Alt+M".to_owned()),
            ..SettingsPatch::default()
        })
        .is_err());
    assert_eq!(system.shortcut().unwrap(), "CommandOrControl+Shift+Space");
    assert_eq!(service.load().unwrap(), AppSettings::default());

    *system.reject_shortcut.lock().unwrap() = false;
    *system.reject_autostart.lock().unwrap() = true;
    assert!(service
        .update(SettingsPatch {
            launch_at_startup: Some(true),
            ..SettingsPatch::default()
        })
        .is_err());
    assert!(!system.launch_at_startup().unwrap());
    assert_eq!(service.load().unwrap(), AppSettings::default());
}

#[test]
fn persistence_failure_rolls_back_system_changes() {
    let root = tempfile::tempdir().unwrap();
    let store = MemoryStore::default();
    let system = FakeSystem::default();
    let service = service(&root, store.clone(), system.clone());
    service.load().unwrap();
    store.fail_next_save();
    assert!(service
        .update(SettingsPatch {
            shortcut: Some("CommandOrControl+Alt+M".to_owned()),
            launch_at_startup: Some(true),
            ..SettingsPatch::default()
        })
        .is_err());
    assert_eq!(system.shortcut().unwrap(), "CommandOrControl+Shift+Space");
    assert!(!system.launch_at_startup().unwrap());
    assert_eq!(service.load().unwrap(), AppSettings::default());
}

#[test]
fn reset_never_deletes_note_data() {
    let root = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    let note = paths.notes().join("sentinel.md");
    fs::write(&note, b"keep me").unwrap();
    let service = SettingsService::new(paths, MemoryStore::default(), FakeSystem::default());
    service
        .update(SettingsPatch {
            font_size: Some(22.0),
            ..SettingsPatch::default()
        })
        .unwrap();
    assert_eq!(service.reset().unwrap(), AppSettings::default());
    assert_eq!(fs::read(note).unwrap(), b"keep me");
}

#[test]
fn storage_info_counts_notes_assets_and_trash_without_following_links() {
    let root = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(root.path()).unwrap();
    fs::write(paths.notes().join("note.bin"), vec![1_u8; 7]).unwrap();
    fs::create_dir(paths.notes().join("assets")).unwrap();
    fs::write(paths.notes().join("assets/image.bin"), vec![2_u8; 11]).unwrap();
    fs::write(paths.trash().join("trash.bin"), vec![3_u8; 13]).unwrap();
    let info = SettingsService::new(paths, MemoryStore::default(), FakeSystem::default())
        .get_storage_info()
        .unwrap();
    assert_eq!(info.note_bytes, 7);
    assert_eq!(info.asset_bytes, 11);
    assert_eq!(info.trash_bytes, 13);
    assert!(!info.root.is_empty());
}

#[test]
fn storage_move_copies_and_verifies_bytes_then_persists_custom_root() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(source.path()).unwrap();
    fs::write(paths.notes().join("content.bin"), b"durable bytes").unwrap();
    let store = MemoryStore::default();
    let service = SettingsService::new(paths, store.clone(), FakeSystem::default());
    let destination = parent.path().join("moved-library");
    service.move_storage_root(&destination).unwrap();
    assert_eq!(
        fs::read(destination.join("notes/content.bin")).unwrap(),
        b"durable bytes"
    );
    assert_eq!(
        service.load().unwrap().data_root,
        DataRootSetting::Custom {
            path: destination
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        }
    );
}

#[test]
fn storage_move_rejects_collision_and_symlink_source_entries() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(source.path()).unwrap();
    let service =
        SettingsService::new(paths.clone(), MemoryStore::default(), FakeSystem::default());
    let collision = parent.path().join("exists");
    fs::create_dir(&collision).unwrap();
    assert!(service.move_storage_root(&collision).is_err());

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(parent.path(), paths.notes().join("escape")).unwrap();
        assert!(service
            .move_storage_root(&parent.path().join("symlink-copy"))
            .is_err());
    }
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_file(
            parent.path().join("missing"),
            paths.notes().join("escape"),
        )
        .is_ok()
        {
            assert!(service
                .move_storage_root(parent.path().join("symlink-copy"))
                .is_err());
        }
    }
}

#[test]
fn failed_move_keeps_old_root_and_removes_only_created_destination() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(source.path()).unwrap();
    fs::write(paths.notes().join("content.bin"), b"old active root").unwrap();
    let store = MemoryStore::default();
    let service = SettingsService::new_with_failure(
        paths,
        store,
        FakeSystem::default(),
        StorageMoveFailurePoint::AfterCopy,
    );
    let destination = parent.path().join("incomplete");
    assert!(service.move_storage_root(&destination).is_err());
    assert!(!destination.exists());
    assert_eq!(service.load().unwrap().data_root, DataRootSetting::Default);
    assert_eq!(
        fs::read(source.path().join("notes/content.bin")).unwrap(),
        b"old active root"
    );
}

#[test]
fn destination_path_must_be_absolute_and_fresh() {
    let source = tempfile::tempdir().unwrap();
    let service = service(&source, MemoryStore::default(), FakeSystem::default());
    assert!(service
        .move_storage_root(PathBuf::from("relative-root"))
        .is_err());
}

#[test]
fn settings_commands_are_main_only_and_capabilities_exclude_sticky_windows() {
    assert!(authorize_settings_caller("main").is_ok());
    assert!(authorize_settings_caller("temporary-note").is_err());
    let main = fs::read_to_string("capabilities/default.json").unwrap();
    let sticky = fs::read_to_string("capabilities/temporary.json").unwrap();
    for command in [
        "allow-load-settings",
        "allow-update-settings",
        "allow-reset-settings",
        "allow-get-storage-info",
        "allow-move-storage-root",
        "allow-restart-application",
    ] {
        assert!(main.contains(command));
        assert!(!sticky.contains(command));
    }
    assert!(authorize_restart_request("main", true).is_ok());
    assert!(authorize_restart_request("main", false).is_err());
    assert!(authorize_restart_request("temporary-note", true).is_err());
}

#[test]
fn storage_move_waits_for_the_global_mutation_lock() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(source.path()).unwrap();
    fs::write(paths.notes().join("content.bin"), b"serialized save").unwrap();
    let service =
        SettingsService::new(paths.clone(), MemoryStore::default(), FakeSystem::default());
    let destination = parent.path().join("serialized-move");
    let guard = simple_notes_lib::platform::IndexMutationLock::acquire(paths.root()).unwrap();
    let (sent, received) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let result = service.move_storage_root(destination);
        sent.send(result).unwrap();
    });
    assert!(received.recv_timeout(Duration::from_millis(100)).is_err());
    drop(guard);
    received
        .recv_timeout(Duration::from_secs(10))
        .unwrap()
        .unwrap();
    worker.join().unwrap();
}

#[test]
fn post_validation_failure_removes_fresh_destination_and_keeps_configuration() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(source.path()).unwrap();
    let service = SettingsService::new_with_failure(
        paths,
        MemoryStore::default(),
        FakeSystem::default(),
        StorageMoveFailurePoint::AfterValidation,
    );
    let destination = parent.path().join("validated-but-unpublished");
    assert!(service.move_storage_root(&destination).is_err());
    assert!(!destination.exists());
    assert_eq!(service.load().unwrap().data_root, DataRootSetting::Default);
}

#[test]
fn successful_relocation_blocks_all_future_old_root_mutations_until_restart() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(source.path()).unwrap();
    let service =
        SettingsService::new(paths.clone(), MemoryStore::default(), FakeSystem::default());
    service
        .move_storage_root(parent.path().join("restart-required"))
        .unwrap();
    let blocked = simple_notes_lib::platform::IndexMutationLock::acquire_with_timeout(
        paths.root(),
        Duration::from_millis(25),
    );
    assert!(blocked.is_err());
}

#[test]
fn visible_sticky_note_prevents_relocation_before_copying() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(source.path()).unwrap();
    let temporary = TemporaryRepository::new(paths.clone()).create().unwrap();
    let database = rusqlite::Connection::open(paths.database()).unwrap();
    database
        .execute(
            "INSERT INTO temporary_windows (note_id, visible, x, y, width, height, always_on_top) VALUES (?1, 1, 0, 0, 360, 420, 1)",
            [uuid::Uuid::parse_str(&temporary.id.to_string())
                .unwrap()
                .as_bytes()
                .to_vec()],
        )
        .unwrap();
    drop(database);
    let destination = parent.path().join("must-not-copy");
    let service = SettingsService::new(paths, MemoryStore::default(), FakeSystem::default());
    assert!(service.move_storage_root(&destination).is_err());
    assert!(!destination.exists());
}

#[test]
fn concurrent_show_and_move_cannot_both_publish() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(source.path()).unwrap();
    let temporary = TemporaryRepository::new(paths.clone()).create().unwrap();
    let windows =
        TemporaryWindowService::new(paths.clone(), InMemoryTemporaryWindowBackend::default());
    let settings = SettingsService::new(paths, MemoryStore::default(), FakeSystem::default());
    let retained_lease = settings.clone();
    let destination = parent.path().join("show-race");
    let start = Arc::new(std::sync::Barrier::new(3));
    let show_start = start.clone();
    let show = std::thread::spawn(move || {
        show_start.wait();
        windows.show(temporary.id)
    });
    let move_start = start.clone();
    let relocate = std::thread::spawn(move || {
        move_start.wait();
        settings.move_storage_root(destination)
    });
    start.wait();
    let shown = show.join().unwrap().is_ok();
    let moved = relocate.join().unwrap().is_ok();
    assert_ne!(shown, moved, "show and relocation must linearize");
    drop(retained_lease);
}

#[test]
fn restart_opens_the_verified_custom_root_with_complete_bytes() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(source.path()).unwrap();
    fs::write(
        paths.notes().join("restart.bin"),
        b"complete before restart",
    )
    .unwrap();
    let store = MemoryStore::default();
    let service = SettingsService::new(paths, store, FakeSystem::default());
    let destination = parent.path().join("reopened");
    service.move_storage_root(&destination).unwrap();
    let reopened = open_configured_storage(source.path(), &service.load().unwrap()).unwrap();
    assert_eq!(reopened.root(), destination.canonicalize().unwrap());
    assert_eq!(
        fs::read(reopened.notes().join("restart.bin")).unwrap(),
        b"complete before restart"
    );
    let relocation_path = reopened.root().join(".simple-notes-storage-move.json");
    let relocation: Value = serde_json::from_slice(&fs::read(&relocation_path).unwrap()).unwrap();
    assert_eq!(relocation["phase"], "awaiting_restart");
    finalize_reopened_relocation(&reopened).unwrap();
    let relocation: Value = serde_json::from_slice(&fs::read(relocation_path).unwrap()).unwrap();
    assert_eq!(relocation["phase"], "ready_for_cleanup");
    let info = SettingsService::new(reopened, MemoryStore::default(), FakeSystem::default())
        .get_storage_info()
        .unwrap();
    assert_eq!(
        PathBuf::from(info.previous_root.unwrap())
            .canonicalize()
            .unwrap(),
        source.path().canonicalize().unwrap()
    );
    assert!(info.previous_root_cleanup_ready);
}

#[test]
fn failed_reopen_validation_keeps_relocation_awaiting_restart() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(source.path()).unwrap();
    let store = MemoryStore::default();
    let service = SettingsService::new(paths, store, FakeSystem::default());
    let destination = parent.path().join("broken-reopen");
    service.move_storage_root(&destination).unwrap();
    fs::write(destination.join("index.sqlite"), b"not a sqlite database").unwrap();
    let reopened = StoragePaths::open(&destination).unwrap();
    assert!(finalize_reopened_relocation(&reopened).is_err());
    let relocation: Value = serde_json::from_slice(
        &fs::read(destination.join(".simple-notes-storage-move.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(relocation["phase"], "awaiting_restart");
}

#[test]
fn configured_custom_root_rejects_relative_and_link_paths() {
    let default_root = tempfile::tempdir().unwrap();
    let settings = AppSettings {
        data_root: DataRootSetting::Custom {
            path: "relative-library".to_owned(),
        },
        ..AppSettings::default()
    };
    assert!(open_configured_storage(default_root.path(), &settings).is_err());

    #[cfg(unix)]
    {
        let target = tempfile::tempdir().unwrap();
        let link = default_root.path().join("linked-root");
        std::os::unix::fs::symlink(target.path(), &link).unwrap();
        let settings = AppSettings {
            data_root: DataRootSetting::Custom {
                path: link.to_string_lossy().into_owned(),
            },
            ..AppSettings::default()
        };
        assert!(open_configured_storage(default_root.path(), &settings).is_err());
    }
}
