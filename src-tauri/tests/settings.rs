use serde_json::Value;
use simple_notes_lib::{
    commands::settings::{
        authorize_restart_request, authorize_settings_caller, authorize_sticky_settings_caller,
        finalize_reopened_relocation, load_bootstrap_settings, open_configured_storage,
        quarantine_incomplete_destination_with_hook, recover_interrupted_source_relocation,
        AppSettings, DataRootSetting, SettingsPatch, SettingsService, SettingsStore,
        StickySettings, StorageMoveFailurePoint, SystemSettings,
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
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    time::Duration,
};

#[test]
fn sticky_settings_expose_only_shared_appearance_fields() {
    let full = AppSettings::default();
    let sticky = StickySettings::from(&full);
    let value = serde_json::to_value(sticky).unwrap();
    assert_eq!(
        value
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        vec![
            "autosaveDelayMs",
            "bodyFont",
            "codeFont",
            "fontSize",
            "lineHeight",
            "stickyColorMode",
            "theme",
        ]
    );
    assert!(!value.to_string().contains("shortcut"));
    assert!(!value.to_string().contains("dataRoot"));
    assert!(!value.to_string().contains("launchAtStartup"));
}

#[test]
fn sticky_settings_are_authorized_only_for_main_and_canonical_temporary_windows() {
    let id = uuid::Uuid::now_v7();
    assert!(authorize_sticky_settings_caller("main").is_ok());
    assert!(authorize_sticky_settings_caller(&format!("temporary-{id}")).is_ok());
    assert!(authorize_sticky_settings_caller("temporary-not-a-uuid").is_err());
    assert!(authorize_sticky_settings_caller(&format!("temporary-{id}-extra")).is_err());
    assert!(authorize_sticky_settings_caller("other").is_err());
}

#[derive(Clone, Default)]
struct MemoryStore {
    value: Arc<Mutex<Option<Value>>>,
    fail_save: Arc<Mutex<bool>>,
    root_backup: Arc<Mutex<Option<DataRootSetting>>>,
    load_count: Arc<AtomicUsize>,
    backup_read_count: Arc<AtomicUsize>,
    save_count: Arc<AtomicUsize>,
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
        self.load_count.fetch_add(1, Ordering::SeqCst);
        Ok(self.value.lock().unwrap().clone())
    }

    fn save_bundle(&self, value: &Value, root: &DataRootSetting) -> Result<(), CommandError> {
        self.save_count.fetch_add(1, Ordering::SeqCst);
        if std::mem::take(&mut *self.fail_save.lock().unwrap()) {
            return Err(CommandError::io("injected settings save failure"));
        }
        *self.value.lock().unwrap() = Some(value.clone());
        *self.root_backup.lock().unwrap() = Some(root.clone());
        Ok(())
    }

    fn load_data_root_backup(&self) -> Result<Option<DataRootSetting>, CommandError> {
        self.backup_read_count.fetch_add(1, Ordering::SeqCst);
        Ok(self.root_backup.lock().unwrap().clone())
    }
}

#[derive(Clone, Default)]
struct AutostartReadFailureSystem {
    launch_at_startup_calls: Arc<AtomicUsize>,
}

impl SystemSettings for AutostartReadFailureSystem {
    fn shortcut(&self) -> Result<String, CommandError> {
        Err(CommandError::io(
            "shortcut should not be read for sticky appearance",
        ))
    }

    fn rebind_shortcut(&self, _shortcut: &str) -> Result<(), CommandError> {
        Err(CommandError::io(
            "shortcut should not be rebound for sticky appearance",
        ))
    }

    fn launch_at_startup(&self) -> Result<bool, CommandError> {
        self.launch_at_startup_calls.fetch_add(1, Ordering::SeqCst);
        Err(CommandError::io("injected autostart read failure"))
    }

    fn set_launch_at_startup(&self, _enabled: bool) -> Result<(), CommandError> {
        Err(CommandError::io(
            "autostart should not be changed for sticky appearance",
        ))
    }
}

#[test]
fn sticky_read_uses_valid_persisted_appearance_without_system_or_store_mutation() {
    let root = tempfile::tempdir().unwrap();
    let store = MemoryStore::default();
    let persisted = AppSettings {
        theme: simple_notes_lib::commands::settings::AppTheme::Sand,
        font_size: 19.0,
        ..AppSettings::default()
    };
    let mut raw = serde_json::to_value(&persisted).unwrap();
    raw["shortcut"] = serde_json::json!({ "invalid": "main-only" });
    raw["launchAtStartup"] = serde_json::json!("not a sticky setting");
    raw["dataRoot"] = serde_json::json!(["not", "a", "sticky", "setting"]);
    *store.value.lock().unwrap() = Some(raw);
    let system = AutostartReadFailureSystem::default();
    let service = SettingsService::new(
        StoragePaths::open(root.path()).unwrap(),
        store.clone(),
        system.clone(),
    );

    assert_eq!(
        service.load_sticky_settings().unwrap(),
        StickySettings::from(&persisted)
    );
    assert_eq!(store.load_count.load(Ordering::SeqCst), 1);
    assert_eq!(store.backup_read_count.load(Ordering::SeqCst), 0);
    assert_eq!(store.save_count.load(Ordering::SeqCst), 0);
    assert_eq!(system.launch_at_startup_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn sticky_read_missing_primary_with_custom_lkg_conflicts_without_defaulting() {
    let root = tempfile::tempdir().unwrap();
    let store = MemoryStore::default();
    *store.root_backup.lock().unwrap() = Some(DataRootSetting::Custom {
        path: root
            .path()
            .join("custom-library")
            .to_string_lossy()
            .into_owned(),
    });
    let system = AutostartReadFailureSystem::default();
    let service = SettingsService::new(
        StoragePaths::open(root.path()).unwrap(),
        store.clone(),
        system.clone(),
    );

    assert!(service.load_sticky_settings().is_err());
    assert_eq!(store.load_count.load(Ordering::SeqCst), 1);
    assert_eq!(store.backup_read_count.load(Ordering::SeqCst), 1);
    assert_eq!(store.save_count.load(Ordering::SeqCst), 0);
    assert_eq!(system.launch_at_startup_calls.load(Ordering::SeqCst), 0);
}

#[derive(Clone)]
struct DeferredFirstSaveStore {
    value: Arc<Mutex<Option<Value>>>,
    save_count: Arc<AtomicUsize>,
    first_save_entered: mpsc::Sender<()>,
    first_save_release: Arc<(Mutex<bool>, Condvar)>,
    root_backup: Arc<Mutex<Option<DataRootSetting>>>,
}

impl SettingsStore for DeferredFirstSaveStore {
    fn load(&self) -> Result<Option<Value>, CommandError> {
        Ok(self.value.lock().unwrap().clone())
    }

    fn save_bundle(&self, value: &Value, root: &DataRootSetting) -> Result<(), CommandError> {
        if self.save_count.fetch_add(1, Ordering::SeqCst) == 0 {
            self.first_save_entered.send(()).unwrap();
            let (released, wake) = &*self.first_save_release;
            let mut released = released.lock().unwrap();
            while !*released {
                released = wake.wait(released).unwrap();
            }
        }
        *self.value.lock().unwrap() = Some(value.clone());
        *self.root_backup.lock().unwrap() = Some(root.clone());
        Ok(())
    }

    fn load_data_root_backup(&self) -> Result<Option<DataRootSetting>, CommandError> {
        Ok(self.root_backup.lock().unwrap().clone())
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
    assert_eq!(defaults.theme.as_str(), "forest");
    assert_eq!(defaults.sticky_color_mode.as_str(), "follow-theme");
    assert_eq!(defaults.shortcut, "CommandOrControl+Shift+Space");
    assert_eq!(defaults.font_size, 16.0);
    assert_eq!(defaults.line_height, 1.6);
    assert_eq!(defaults.autosave_delay_ms, 500);
    assert_eq!(
        serde_json::to_value(&defaults).unwrap(),
        serde_json::from_str::<Value>(include_str!("../../src/shared/settings-defaults.json"))
            .unwrap(),
        "Rust and TypeScript must consume the same canonical default vector"
    );

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
fn corrupted_settings_never_overwrite_the_last_known_custom_root() {
    let root = tempfile::tempdir().unwrap();
    let store = MemoryStore::corrupted();
    let custom = DataRootSetting::Custom {
        path: root
            .path()
            .join("custom-library")
            .to_string_lossy()
            .into_owned(),
    };
    *store.root_backup.lock().unwrap() = Some(custom.clone());
    let original = store.load().unwrap().unwrap();

    let error = service(&root, store.clone(), FakeSystem::default())
        .load()
        .unwrap_err();
    assert!(error
        .diagnostic()
        .is_some_and(|message| message.contains("last known custom library")));
    assert_eq!(store.load().unwrap().unwrap(), original);
    assert_eq!(store.load_data_root_backup().unwrap(), Some(custom));
    assert!(load_bootstrap_settings(&store).is_err());
}

#[test]
fn missing_settings_never_overwrite_or_bypass_the_last_known_custom_root() {
    let root = tempfile::tempdir().unwrap();
    let store = MemoryStore::default();
    let custom = DataRootSetting::Custom {
        path: root
            .path()
            .join("preserved-library")
            .to_string_lossy()
            .into_owned(),
    };
    *store.root_backup.lock().unwrap() = Some(custom.clone());

    assert!(service(&root, store.clone(), FakeSystem::default())
        .load()
        .is_err());
    assert!(load_bootstrap_settings(&store).is_err());
    assert!(store.load().unwrap().is_none());
    assert_eq!(store.load_data_root_backup().unwrap(), Some(custom));
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
fn load_reconciles_persisted_settings_with_actual_system_behavior() {
    let root = tempfile::tempdir().unwrap();
    let store = MemoryStore::default();
    *store.value.lock().unwrap() = Some(serde_json::to_value(AppSettings::default()).unwrap());
    let system = FakeSystem::default();
    *system.shortcut.lock().unwrap() = "CommandOrControl+Alt+M".to_owned();
    *system.autostart.lock().unwrap() = true;

    let loaded = service(&root, store.clone(), system).load().unwrap();
    assert_eq!(loaded.shortcut, "CommandOrControl+Alt+M");
    assert!(loaded.launch_at_startup);
    assert_eq!(
        serde_json::from_value::<AppSettings>(store.load().unwrap().unwrap()).unwrap(),
        loaded
    );
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
fn custom_root_and_main_settings_publish_atomically_or_neither_changes() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let store = MemoryStore::default();
    *store.value.lock().unwrap() = Some(serde_json::to_value(AppSettings::default()).unwrap());
    *store.root_backup.lock().unwrap() = Some(DataRootSetting::Default);
    store.fail_next_save();
    let destination = parent.path().join("atomic-settings-failure");
    let service = SettingsService::new(
        StoragePaths::open(source.path()).unwrap(),
        store.clone(),
        FakeSystem::default(),
    );

    assert!(service.move_storage_root(&destination).is_err());
    assert!(!destination.exists());
    assert_eq!(
        store.load_data_root_backup().unwrap(),
        Some(DataRootSetting::Default)
    );
    assert_eq!(
        serde_json::from_value::<AppSettings>(store.load().unwrap().unwrap())
            .unwrap()
            .data_root,
        DataRootSetting::Default
    );
    assert!(fs::read_dir(parent.path()).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".simple-notes-incomplete-")));
}

#[test]
fn concurrent_updates_linearize_store_shortcut_and_autostart() {
    let root = tempfile::tempdir().unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let release = Arc::new((Mutex::new(false), Condvar::new()));
    let store = DeferredFirstSaveStore {
        value: Arc::new(Mutex::new(Some(
            serde_json::to_value(AppSettings::default()).unwrap(),
        ))),
        save_count: Arc::new(AtomicUsize::new(0)),
        first_save_entered: entered_tx,
        first_save_release: release.clone(),
        root_backup: Arc::new(Mutex::new(None)),
    };
    let system = FakeSystem::default();
    let service = SettingsService::new(
        StoragePaths::open(root.path()).unwrap(),
        store.clone(),
        system.clone(),
    );

    let shortcut_service = service.clone();
    let shortcut = std::thread::spawn(move || {
        shortcut_service.update(SettingsPatch {
            shortcut: Some("CommandOrControl+Alt+M".to_owned()),
            ..SettingsPatch::default()
        })
    });
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();

    let autostart_service = service.clone();
    let (done_tx, done_rx) = mpsc::channel();
    let autostart = std::thread::spawn(move || {
        let result = autostart_service.update(SettingsPatch {
            launch_at_startup: Some(true),
            ..SettingsPatch::default()
        });
        done_tx.send(()).unwrap();
        result
    });
    let second_update_escaped = done_rx.recv_timeout(Duration::from_millis(150)).is_ok();

    let (released, wake) = &*release;
    *released.lock().unwrap() = true;
    wake.notify_all();
    shortcut.join().unwrap().unwrap();
    autostart.join().unwrap().unwrap();

    assert!(
        !second_update_escaped,
        "a concurrent update escaped while the first settings transaction was pending"
    );
    let persisted: AppSettings = serde_json::from_value(store.load().unwrap().unwrap()).unwrap();
    assert_eq!(persisted.shortcut, system.shortcut().unwrap());
    assert_eq!(
        persisted.launch_at_startup,
        system.launch_at_startup().unwrap()
    );
    assert_eq!(persisted.shortcut, "CommandOrControl+Alt+M");
    assert!(persisted.launch_at_startup);
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
fn storage_move_uses_a_sqlite_snapshot_and_preserves_uncheckpointed_window_state() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(source.path()).unwrap();
    let temporary = TemporaryRepository::new(paths.clone()).create().unwrap();

    let reader = rusqlite::Connection::open(paths.database()).unwrap();
    reader.execute_batch("BEGIN").unwrap();
    let _: i64 = reader
        .query_row("SELECT COUNT(*) FROM temporary_windows", [], |row| {
            row.get(0)
        })
        .unwrap();
    let writer = rusqlite::Connection::open(paths.database()).unwrap();
    writer.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    writer
        .execute(
            "INSERT INTO temporary_windows \
             (note_id, visible, x, y, width, height, always_on_top) \
             VALUES (?1, 0, 17.5, 23.5, 411, 433, 1)",
            [uuid::Uuid::parse_str(&temporary.id.to_string())
                .unwrap()
                .as_bytes()
                .to_vec()],
        )
        .unwrap();
    assert!(paths.database().with_extension("sqlite-wal").exists());

    let destination = parent.path().join("wal-snapshot");
    SettingsService::new(paths, MemoryStore::default(), FakeSystem::default())
        .move_storage_root(&destination)
        .unwrap();
    let moved = rusqlite::Connection::open(destination.join("index.sqlite")).unwrap();
    let actual: (i64, f64, f64, f64, f64, i64) = moved
        .query_row(
            "SELECT visible, x, y, width, height, always_on_top \
             FROM temporary_windows WHERE note_id = ?1",
            [uuid::Uuid::parse_str(&temporary.id.to_string())
                .unwrap()
                .as_bytes()
                .to_vec()],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(actual, (0, 17.5, 23.5, 411.0, 433.0, 1));
    reader.execute_batch("ROLLBACK").unwrap();
}

#[test]
fn active_relocation_lease_rejects_storage_queries_and_second_moves_immediately() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(source.path()).unwrap();
    let service = SettingsService::new(paths, MemoryStore::default(), FakeSystem::default());
    service
        .move_storage_root(parent.path().join("first-destination"))
        .unwrap();

    let started = std::time::Instant::now();
    assert!(service.get_storage_info().is_err());
    assert!(
        started.elapsed() < Duration::from_millis(250),
        "storage info waited on the retained relocation lock"
    );

    let started = std::time::Instant::now();
    assert!(service
        .move_storage_root(parent.path().join("second-destination"))
        .is_err());
    assert!(
        started.elapsed() < Duration::from_millis(250),
        "a second relocation waited instead of reporting the active lease"
    );
    assert!(!parent.path().join("second-destination").exists());
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
    let error = service.move_storage_root(&destination).unwrap_err();
    assert!(
        !destination.exists(),
        "destination remained after quarantine: {error:?}; siblings={:?}",
        fs::read_dir(parent.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>()
    );
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
    assert!(main.contains("allow-load-sticky-settings"));
    assert!(sticky.contains("allow-load-sticky-settings"));
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
fn restart_quarantines_a_verified_destination_when_config_was_never_published() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(source.path()).unwrap();
    fs::write(paths.notes().join("crash.bin"), b"recoverable copy").unwrap();
    let store = MemoryStore::default();
    let crashed = SettingsService::new_with_failure(
        paths.clone(),
        store.clone(),
        FakeSystem::default(),
        StorageMoveFailurePoint::CrashBeforeSettingsPublish,
    );
    let destination = parent.path().join("retryable-destination");
    assert!(crashed.move_storage_root(&destination).is_err());
    assert!(destination.exists());
    assert_eq!(crashed.load().unwrap().data_root, DataRootSetting::Default);
    assert!(source
        .path()
        .join(".simple-notes-storage-move-source.json")
        .exists());

    recover_interrupted_source_relocation(&paths).unwrap();
    assert!(!destination.exists());
    assert!(fs::read_dir(parent.path()).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".simple-notes-incomplete-")));
    SettingsService::new(paths, store, FakeSystem::default())
        .move_storage_root(&destination)
        .unwrap();
    assert_eq!(
        fs::read(destination.join("notes/crash.bin")).unwrap(),
        b"recoverable copy"
    );
}

#[test]
fn crash_before_staging_marker_never_occupies_the_requested_destination() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(source.path()).unwrap();
    let store = MemoryStore::default();
    let destination = parent.path().join("still-retryable");
    let crashed = SettingsService::new_with_failure(
        paths.clone(),
        store.clone(),
        FakeSystem::default(),
        StorageMoveFailurePoint::CrashAfterStagingCreate,
    );
    assert!(crashed.move_storage_root(&destination).is_err());
    assert!(!destination.exists());
    assert!(fs::read_dir(parent.path()).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".simple-notes-relocation-")));

    recover_interrupted_source_relocation(&paths).unwrap();
    assert!(!destination.exists());
    assert!(!fs::read_dir(parent.path()).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".simple-notes-relocation-")));
    assert!(fs::read_dir(parent.path()).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".simple-notes-orphan-")));
    SettingsService::new(paths, store, FakeSystem::default())
        .move_storage_root(&destination)
        .unwrap();
    assert!(destination.exists());
}

#[test]
fn restart_quarantines_an_unmarked_staging_link_without_following_it() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let sentinel = outside.path().join("outside-sentinel.bin");
    fs::write(&sentinel, b"never move or delete").unwrap();
    let paths = StoragePaths::open(source.path()).unwrap();
    let store = MemoryStore::default();
    let destination = parent.path().join("still-retryable-after-link-swap");
    let crashed = SettingsService::new_with_failure(
        paths.clone(),
        store.clone(),
        FakeSystem::default(),
        StorageMoveFailurePoint::CrashAfterStagingCreate,
    );
    assert!(crashed.move_storage_root(&destination).is_err());
    let staging = fs::read_dir(parent.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".simple-notes-relocation-")
        })
        .unwrap();
    let parked = parent.path().join("parked-original-staging");
    fs::rename(&staging, &parked).unwrap();
    create_directory_link(outside.path(), &staging).unwrap();

    recover_interrupted_source_relocation(&paths).unwrap();

    assert_eq!(fs::read(&sentinel).unwrap(), b"never move or delete");
    assert!(!staging.exists());
    assert!(!destination.exists());
    let orphan = fs::read_dir(parent.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".simple-notes-orphan-")
        })
        .unwrap();
    remove_directory_link(&orphan).unwrap();
    SettingsService::new(paths, store, FakeSystem::default())
        .move_storage_root(&destination)
        .unwrap();
    assert!(destination.exists());
}

#[test]
fn quarantine_rejects_a_destination_replaced_by_an_external_directory_link() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let sentinel = outside.path().join("outside-sentinel.bin");
    fs::write(&sentinel, b"never move or delete").unwrap();
    let paths = StoragePaths::open(source.path()).unwrap();
    let destination = parent.path().join("replace-before-quarantine");
    let crashed = SettingsService::new_with_failure(
        paths,
        MemoryStore::default(),
        FakeSystem::default(),
        StorageMoveFailurePoint::CrashBeforeSettingsPublish,
    );
    assert!(crashed.move_storage_root(&destination).is_err());
    let parked = parent.path().join("original-operation");
    let destination_for_hook = destination.clone();
    let outside_for_hook = outside.path().to_path_buf();
    let result = quarantine_incomplete_destination_with_hook(&destination, move || {
        fs::rename(&destination_for_hook, &parked).unwrap();
        create_directory_link(&outside_for_hook, &destination_for_hook).unwrap();
    });
    assert!(result.is_err());
    assert_eq!(fs::read(&sentinel).unwrap(), b"never move or delete");
    remove_directory_link(&destination).unwrap();
}

#[test]
fn same_length_staging_file_replacement_is_rejected_before_publish() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(source.path()).unwrap();
    fs::write(paths.notes().join("content.bin"), b"trusted-content").unwrap();
    let parent_for_hook = parent.path().to_path_buf();
    let service = SettingsService::new_with_staging_publish_hook(
        paths,
        MemoryStore::default(),
        FakeSystem::default(),
        move || {
            let staging = fs::read_dir(&parent_for_hook)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .find(|path| {
                    path.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with(".simple-notes-relocation-")
                })
                .unwrap();
            fs::write(staging.join("notes/content.bin"), b"tampered-value!").unwrap();
        },
    );
    let destination = parent.path().join("must-not-publish");

    assert!(service.move_storage_root(&destination).is_err());
    assert!(!destination.exists());
}

#[test]
fn same_length_source_file_replacement_is_rejected_before_publish() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(source.path()).unwrap();
    let source_file = paths.notes().join("content.bin");
    fs::write(&source_file, b"trusted-content").unwrap();
    let service = SettingsService::new_with_staging_publish_hook(
        paths,
        MemoryStore::default(),
        FakeSystem::default(),
        move || fs::write(&source_file, b"tampered-value!").unwrap(),
    );
    let destination = parent.path().join("must-not-publish-source-change");

    assert!(service.move_storage_root(&destination).is_err());
    assert!(!destination.exists());
}

fn relocation_staging_directory(parent: &std::path::Path) -> PathBuf {
    fs::read_dir(parent)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".simple-notes-relocation-")
        })
        .unwrap()
}

#[test]
fn source_tree_file_added_after_copy_is_rejected_before_relocation_publish() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(source.path()).unwrap();
    let source_notes = paths.notes().to_path_buf();
    let service = SettingsService::new_with_staging_publish_hook(
        paths,
        MemoryStore::default(),
        FakeSystem::default(),
        move || fs::write(source_notes.join("late-durable.bin"), b"late durable bytes").unwrap(),
    );
    let destination = parent.path().join("must-not-publish-late-tree-file");

    assert!(service.move_storage_root(&destination).is_err());
    assert!(!destination.exists());
}

#[test]
fn unknown_root_file_added_after_copy_is_rejected_before_relocation_publish() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(source.path()).unwrap();
    let source_root = paths.root().to_path_buf();
    let service = SettingsService::new_with_staging_publish_hook(
        paths,
        MemoryStore::default(),
        FakeSystem::default(),
        move || fs::write(source_root.join("late-unknown.bin"), b"late root bytes").unwrap(),
    );
    let destination = parent.path().join("must-not-publish-late-root-file");

    assert!(service.move_storage_root(&destination).is_err());
    assert!(!destination.exists());
}

#[test]
fn extra_staging_file_after_copy_is_rejected_before_relocation_publish() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let parent_path = parent.path().to_path_buf();
    let service = SettingsService::new_with_staging_publish_hook(
        StoragePaths::open(source.path()).unwrap(),
        MemoryStore::default(),
        FakeSystem::default(),
        move || {
            fs::write(
                relocation_staging_directory(&parent_path).join("injected.bin"),
                b"unexpected staging file",
            )
            .unwrap();
        },
    );
    let destination = parent.path().join("must-not-publish-extra-staging-file");

    assert!(service.move_storage_root(&destination).is_err());
    assert!(!destination.exists());
}

#[test]
fn extra_empty_staging_directory_after_copy_is_rejected_before_relocation_publish() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let parent_path = parent.path().to_path_buf();
    let service = SettingsService::new_with_staging_publish_hook(
        StoragePaths::open(source.path()).unwrap(),
        MemoryStore::default(),
        FakeSystem::default(),
        move || {
            fs::create_dir(relocation_staging_directory(&parent_path).join("injected-empty"))
                .unwrap();
        },
    );
    let destination = parent
        .path()
        .join("must-not-publish-extra-staging-directory");

    assert!(service.move_storage_root(&destination).is_err());
    assert!(!destination.exists());
}

#[test]
fn relocation_owned_marker_and_index_tampering_are_rejected_before_publish() {
    for target in [".simple-notes-storage-move.json", "index.sqlite"] {
        let source = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let parent_path = parent.path().to_path_buf();
        let tampered = target.to_owned();
        let service = SettingsService::new_with_staging_publish_hook(
            StoragePaths::open(source.path()).unwrap(),
            MemoryStore::default(),
            FakeSystem::default(),
            move || {
                fs::write(
                    relocation_staging_directory(&parent_path).join(&tampered),
                    b"tampered relocation-owned bytes",
                )
                .unwrap();
            },
        );
        let destination = parent.path().join(format!("must-not-publish-{target}"));

        assert!(
            service.move_storage_root(&destination).is_err(),
            "tampering {target} must reject publication"
        );
        assert!(!destination.exists());
    }
}

#[test]
fn pinned_destination_parent_prevents_staging_creation_in_a_replacement_link() {
    let source = tempfile::tempdir().unwrap();
    let outer = tempfile::tempdir().unwrap();
    let selected_parent = outer.path().join("selected-parent");
    fs::create_dir(&selected_parent).unwrap();
    let outside = tempfile::tempdir().unwrap();
    let sentinel = outside.path().join("sentinel.bin");
    fs::write(&sentinel, b"outside remains isolated").unwrap();
    let destination = selected_parent.join("requested-library");
    let selected_for_hook = selected_parent.clone();
    let parked = outer.path().join("parked-parent");
    #[cfg(unix)]
    let outside_for_hook = outside.path().to_path_buf();
    let service = SettingsService::new_with_staging_hook(
        StoragePaths::open(source.path()).unwrap(),
        MemoryStore::default(),
        FakeSystem::default(),
        move || {
            #[cfg(unix)]
            {
                fs::rename(&selected_for_hook, &parked).unwrap();
                create_directory_link(&outside_for_hook, &selected_for_hook).unwrap();
            }
            #[cfg(windows)]
            {
                assert!(
                    fs::rename(&selected_for_hook, &parked).is_err(),
                    "the pinned Windows parent unexpectedly allowed replacement"
                );
            }
        },
    );
    let result = service.move_storage_root(&destination);
    #[cfg(unix)]
    assert!(result.is_err());
    #[cfg(windows)]
    assert!(result.is_ok());
    assert_eq!(fs::read(&sentinel).unwrap(), b"outside remains isolated");
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 1);
}

#[test]
fn index_snapshot_never_writes_through_a_replaced_staging_path() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let sentinel = outside.path().join("sentinel.bin");
    fs::write(&sentinel, b"outside index is untouched").unwrap();
    let parent_for_hook = parent.path().to_path_buf();
    #[cfg(unix)]
    let outside_for_hook = outside.path().to_path_buf();
    let service = SettingsService::new_with_index_snapshot_hook(
        StoragePaths::open(source.path()).unwrap(),
        MemoryStore::default(),
        FakeSystem::default(),
        move || {
            let staging = fs::read_dir(&parent_for_hook)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .find(|path| {
                    path.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with(".simple-notes-relocation-")
                })
                .unwrap();
            let parked = parent_for_hook.join("parked-staging");
            #[cfg(unix)]
            {
                fs::rename(&staging, &parked).unwrap();
                create_directory_link(&outside_for_hook, &staging).unwrap();
            }
            #[cfg(windows)]
            {
                assert!(
                    fs::rename(&staging, &parked).is_err(),
                    "the pinned Windows staging directory unexpectedly allowed replacement"
                );
            }
        },
    );
    let result = service.move_storage_root(parent.path().join("requested"));
    #[cfg(unix)]
    assert!(result.is_err());
    #[cfg(windows)]
    assert!(result.is_ok());
    assert_eq!(fs::read(&sentinel).unwrap(), b"outside index is untouched");
    assert!(!outside.path().join("index.sqlite").exists());
}

#[test]
fn verified_staging_identity_is_bound_to_the_published_directory() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let sentinel = outside.path().join("sentinel.bin");
    fs::write(&sentinel, b"outside publication is inert").unwrap();
    let parent_for_hook = parent.path().to_path_buf();
    #[cfg(unix)]
    let outside_for_hook = outside.path().to_path_buf();
    let store = MemoryStore::default();
    let service = SettingsService::new_with_staging_publish_hook(
        StoragePaths::open(source.path()).unwrap(),
        store.clone(),
        FakeSystem::default(),
        move || {
            let staging = fs::read_dir(&parent_for_hook)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .find(|path| {
                    path.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with(".simple-notes-relocation-")
                })
                .unwrap();
            let parked = parent_for_hook.join("parked-before-publish");
            #[cfg(unix)]
            {
                fs::rename(&staging, &parked).unwrap();
                create_directory_link(&outside_for_hook, &staging).unwrap();
            }
            #[cfg(windows)]
            {
                assert!(
                    fs::rename(&staging, &parked).is_err(),
                    "the pinned Windows staging directory unexpectedly allowed replacement"
                );
            }
        },
    );
    let destination = parent.path().join("requested");
    let result = service.move_storage_root(&destination);
    #[cfg(unix)]
    assert!(result.is_err());
    #[cfg(windows)]
    assert!(result.is_ok());
    assert_eq!(
        fs::read(&sentinel).unwrap(),
        b"outside publication is inert"
    );
    #[cfg(unix)]
    assert_eq!(
        service.load().unwrap().data_root,
        DataRootSetting::Default,
        "a replacement entry must never be published as the configured root"
    );
}

#[cfg(unix)]
fn create_directory_link(target: &std::path::Path, link: &std::path::Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(unix)]
fn remove_directory_link(link: &std::path::Path) -> std::io::Result<()> {
    fs::remove_file(link)
}

#[cfg(windows)]
fn create_directory_link(target: &std::path::Path, link: &std::path::Path) -> std::io::Result<()> {
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other("mklink /J failed"))
    }
}

#[cfg(windows)]
fn remove_directory_link(link: &std::path::Path) -> std::io::Result<()> {
    fs::remove_dir(link)
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
    fs::write(
        source.path().join("unknown-durable.bin"),
        b"copy unknown bytes",
    )
    .unwrap();
    fs::write(
        source.path().join("settings.json"),
        b"must never be offered",
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
    assert!(!reopened.root().join("settings.json").exists());
    assert_eq!(
        fs::read(reopened.root().join("unknown-durable.bin")).unwrap(),
        b"copy unknown bytes"
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
    let cleanup = info
        .previous_storage_cleanup
        .expect("verified reopen should expose exact cleanup candidates");
    assert_eq!(
        PathBuf::from(cleanup.root).canonicalize().unwrap(),
        source.path().canonicalize().unwrap()
    );
    assert!(cleanup
        .candidates
        .iter()
        .any(|candidate| candidate.relative_path == "notes" && candidate.kind == "notes"));
    assert!(cleanup
        .candidates
        .iter()
        .any(|candidate| candidate.relative_path == "index.sqlite"
            && candidate.kind == "index-database"));
    assert!(!cleanup
        .candidates
        .iter()
        .any(|candidate| candidate.relative_path == "settings.json"));
    assert!(!cleanup
        .candidates
        .iter()
        .any(|candidate| candidate.relative_path == "unknown-durable.bin"));
}

#[test]
fn failed_reopen_window_state_validation_preserves_active_index_and_retryable_marker() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(source.path()).unwrap();
    let temporary = TemporaryRepository::new(paths.clone()).create().unwrap();
    let database = rusqlite::Connection::open(paths.database()).unwrap();
    database
        .execute_batch(
            "PRAGMA foreign_keys=OFF;
             DROP TABLE temporary_windows;
             CREATE TABLE temporary_windows (
                note_id BLOB,
                visible INTEGER,
                x REAL,
                y REAL,
                width REAL,
                height REAL,
                always_on_top INTEGER
             );",
        )
        .unwrap();
    database
        .execute(
            "INSERT INTO temporary_windows (note_id, visible, x, y, width, height, always_on_top) VALUES (?1, 0, 12, 18, -1, 410, 0)",
            [uuid::Uuid::parse_str(&temporary.id.to_string())
                .unwrap()
                .as_bytes()
                .to_vec()],
        )
        .unwrap();
    drop(database);
    let destination = parent.path().join("window-state-validation");
    SettingsService::new(paths, MemoryStore::default(), FakeSystem::default())
        .move_storage_root(&destination)
        .unwrap();
    let reopened = StoragePaths::open(&destination).unwrap();
    let index_before = fs::read(reopened.database()).unwrap();
    let marker_path = destination.join(".simple-notes-storage-move.json");

    for _ in 0..2 {
        assert!(finalize_reopened_relocation(&reopened).is_err());
        assert_eq!(fs::read(reopened.database()).unwrap(), index_before);
        let marker: Value = serde_json::from_slice(&fs::read(&marker_path).unwrap()).unwrap();
        assert_eq!(marker["phase"], "awaiting_restart");
    }
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
