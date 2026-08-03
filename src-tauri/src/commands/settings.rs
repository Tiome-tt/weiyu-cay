use crate::{
    error::CommandError,
    platform::{IndexMutationLock, SafeDirectory, SafeEntryKind},
    shortcuts::{normalize_accelerator, DEFAULT_CAPTURE_SHORTCUT},
    storage::{database::Database, paths::StoragePaths, rebuild::rebuild_index_strict},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager};
use uuid::Uuid;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_store::{Store, StoreExt};

const SETTINGS_VERSION: u32 = 1;
const MOVE_MARKER: &str = ".simple-notes-storage-move.json";
const SOURCE_MOVE_MARKER: &str = ".simple-notes-storage-move-source.json";
const MUTATION_LOCK: &str = ".index-mutation.lock";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppTheme {
    Forest,
    Sand,
    System,
}

impl AppTheme {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Forest => "forest",
            Self::Sand => "sand",
            Self::System => "system",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StickyColorMode {
    FollowTheme,
}

impl StickyColorMode {
    pub fn as_str(self) -> &'static str {
        "follow-theme"
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditorMode {
    Source,
    Split,
    Preview,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum DataRootSetting {
    Default,
    Custom { path: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppSettings {
    #[serde(skip, default = "settings_version")]
    pub version: u32,
    pub theme: AppTheme,
    pub sticky_color_mode: StickyColorMode,
    pub body_font: String,
    pub code_font: String,
    pub font_size: f64,
    pub line_height: f64,
    pub shortcut: String,
    pub launch_at_startup: bool,
    pub default_editor_mode: EditorMode,
    pub autosave_delay_ms: u64,
    pub data_root: DataRootSetting,
}

const fn settings_version() -> u32 {
    SETTINGS_VERSION
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            theme: AppTheme::Forest,
            sticky_color_mode: StickyColorMode::FollowTheme,
            body_font: "system-ui, sans-serif".to_owned(),
            code_font: "ui-monospace, SFMono-Regular, Consolas, monospace".to_owned(),
            font_size: 16.0,
            line_height: 1.6,
            shortcut: DEFAULT_CAPTURE_SHORTCUT.to_owned(),
            launch_at_startup: false,
            default_editor_mode: EditorMode::Source,
            autosave_delay_ms: 500,
            data_root: DataRootSetting::Default,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsPatch {
    pub theme: Option<AppTheme>,
    pub sticky_color_mode: Option<StickyColorMode>,
    pub body_font: Option<String>,
    pub code_font: Option<String>,
    pub font_size: Option<f64>,
    pub line_height: Option<f64>,
    pub shortcut: Option<String>,
    pub launch_at_startup: Option<bool>,
    pub default_editor_mode: Option<EditorMode>,
    pub autosave_delay_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    pub root: String,
    pub note_bytes: u64,
    pub asset_bytes: u64,
    pub trash_bytes: u64,
    pub previous_storage_cleanup: Option<PreviousStorageCleanup>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageCleanupCandidate {
    pub relative_path: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviousStorageCleanup {
    pub root: String,
    pub candidates: Vec<StorageCleanupCandidate>,
}

pub trait SettingsStore: Clone + Send + Sync + 'static {
    fn load(&self) -> Result<Option<Value>, CommandError>;
    fn save(&self, value: &Value) -> Result<(), CommandError>;
    fn load_data_root_backup(&self) -> Result<Option<DataRootSetting>, CommandError>;
    fn save_data_root_backup(&self, root: &DataRootSetting) -> Result<(), CommandError>;
}

#[doc(hidden)]
pub fn load_bootstrap_settings<S: SettingsStore>(store: &S) -> Result<AppSettings, CommandError> {
    match store.load()? {
        Some(value) => match serde_json::from_value::<AppSettings>(value)
            .ok()
            .and_then(|settings| validate_settings(settings).ok())
        {
            Some(settings) => {
                store.save_data_root_backup(&settings.data_root)?;
                Ok(settings)
            }
            None
                if matches!(
                    store.load_data_root_backup()?,
                    Some(DataRootSetting::Custom { .. })
                ) =>
            {
                Err(CommandError::conflict(
                    "application settings are damaged; the last known custom library location was preserved",
                ))
            }
            None => Ok(AppSettings::default()),
        },
        None => Ok(AppSettings::default()),
    }
}

pub trait SystemSettings: Clone + Send + Sync + 'static {
    fn shortcut(&self) -> Result<String, CommandError>;
    fn rebind_shortcut(&self, shortcut: &str) -> Result<(), CommandError>;
    fn launch_at_startup(&self) -> Result<bool, CommandError>;
    fn set_launch_at_startup(&self, enabled: bool) -> Result<(), CommandError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageMoveFailurePoint {
    None,
    AfterCopy,
    AfterValidation,
    CrashAfterStagingCreate,
    CrashBeforeSettingsPublish,
}

#[derive(Clone)]
pub struct SettingsService<S, Y> {
    paths: StoragePaths,
    store: S,
    system: Y,
    failure: StorageMoveFailurePoint,
    relocation_lease: Arc<Mutex<Option<IndexMutationLock>>>,
    transaction: Arc<Mutex<()>>,
    before_staging_create: Option<Arc<dyn Fn() + Send + Sync>>,
    before_index_snapshot: Option<Arc<dyn Fn() + Send + Sync>>,
    before_staging_publish: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl<S: SettingsStore, Y: SystemSettings> SettingsService<S, Y> {
    pub fn new(paths: StoragePaths, store: S, system: Y) -> Self {
        Self::new_with_failure(paths, store, system, StorageMoveFailurePoint::None)
    }

    pub fn new_with_failure(
        paths: StoragePaths,
        store: S,
        system: Y,
        failure: StorageMoveFailurePoint,
    ) -> Self {
        Self {
            paths,
            store,
            system,
            failure,
            relocation_lease: Arc::new(Mutex::new(None)),
            transaction: Arc::new(Mutex::new(())),
            before_staging_create: None,
            before_index_snapshot: None,
            before_staging_publish: None,
        }
    }

    #[doc(hidden)]
    pub fn new_with_staging_hook<F>(paths: StoragePaths, store: S, system: Y, hook: F) -> Self
    where
        F: Fn() + Send + Sync + 'static,
    {
        let mut service = Self::new(paths, store, system);
        service.before_staging_create = Some(Arc::new(hook));
        service
    }

    #[doc(hidden)]
    pub fn new_with_index_snapshot_hook<F>(
        paths: StoragePaths,
        store: S,
        system: Y,
        hook: F,
    ) -> Self
    where
        F: Fn() + Send + Sync + 'static,
    {
        let mut service = Self::new(paths, store, system);
        service.before_index_snapshot = Some(Arc::new(hook));
        service
    }

    #[doc(hidden)]
    pub fn new_with_staging_publish_hook<F>(
        paths: StoragePaths,
        store: S,
        system: Y,
        hook: F,
    ) -> Self
    where
        F: Fn() + Send + Sync + 'static,
    {
        let mut service = Self::new(paths, store, system);
        service.before_staging_publish = Some(Arc::new(hook));
        service
    }

    fn new_with_lease(
        paths: StoragePaths,
        store: S,
        system: Y,
        relocation_lease: Arc<Mutex<Option<IndexMutationLock>>>,
        transaction: Arc<Mutex<()>>,
    ) -> Self {
        Self {
            paths,
            store,
            system,
            failure: StorageMoveFailurePoint::None,
            relocation_lease,
            transaction,
            before_staging_create: None,
            before_index_snapshot: None,
            before_staging_publish: None,
        }
    }

    pub fn load(&self) -> Result<AppSettings, CommandError> {
        let _transaction = self
            .transaction
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.load_unlocked()
    }

    fn load_unlocked(&self) -> Result<AppSettings, CommandError> {
        let value = self.store.load()?;
        if let Some(value) = value {
            if let Ok(settings) = serde_json::from_value::<AppSettings>(value) {
                if let Ok(settings) = validate_settings(settings) {
                    return self.reconcile_system(settings);
                }
            }
            if matches!(
                self.store.load_data_root_backup()?,
                Some(DataRootSetting::Custom { .. })
            ) {
                return Err(CommandError::conflict(
                    "application settings are damaged; the last known custom library location was preserved",
                ));
            }
        }
        let defaults = AppSettings::default();
        self.persist(&defaults)?;
        self.reconcile_system(defaults)
    }

    pub fn update(&self, patch: SettingsPatch) -> Result<AppSettings, CommandError> {
        let _transaction = self
            .transaction
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous = self.load_unlocked()?;
        let next = apply_patch(previous.clone(), patch)?;
        self.apply_system_transaction(&previous, &next, || self.persist(&next))?;
        Ok(next)
    }

    pub fn reset(&self) -> Result<AppSettings, CommandError> {
        let _transaction = self
            .transaction
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous = self.load_unlocked()?;
        // A preference reset must never abandon a custom library location.
        let defaults = AppSettings {
            data_root: previous.data_root.clone(),
            ..AppSettings::default()
        };
        self.apply_system_transaction(&previous, &defaults, || self.persist(&defaults))?;
        Ok(defaults)
    }

    pub fn get_storage_info(&self) -> Result<StorageInfo, CommandError> {
        self.reject_active_relocation()?;
        let _guard = IndexMutationLock::acquire(self.paths.root())?;
        let (note_bytes, asset_bytes) = count_note_storage(&self.paths)?;
        let trash_bytes = count_tree_bytes(self.paths.trash())?;
        let relocation = read_relocation_marker(&self.paths)?;
        Ok(StorageInfo {
            root: self.paths.root().to_string_lossy().into_owned(),
            note_bytes,
            asset_bytes,
            trash_bytes,
            previous_storage_cleanup: relocation.and_then(|marker| {
                (marker.phase == RelocationPhase::ReadyForCleanup).then_some(
                    PreviousStorageCleanup {
                        root: marker.source,
                        candidates: marker.cleanup_candidates,
                    },
                )
            }),
        })
    }

    pub fn move_storage_root(&self, destination: impl AsRef<Path>) -> Result<(), CommandError> {
        let _transaction = self
            .transaction
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.reject_active_relocation()?;
        let destination = validate_fresh_destination(self.paths.root(), destination.as_ref())?;
        let guard = IndexMutationLock::acquire(self.paths.root())?;
        reject_visible_sticky_windows(&self.paths)?;
        let operation_id = Uuid::now_v7().to_string();
        let parent_path = destination
            .parent()
            .ok_or_else(|| CommandError::validation("storage destination has no parent"))?;
        let parent = SafeDirectory::open(parent_path, &[], false)?;
        let staging = parent_path.join(format!(".simple-notes-relocation-{operation_id}"));
        if fs::symlink_metadata(&staging).is_ok() {
            return Err(CommandError::conflict(
                "storage relocation staging path already exists",
            ));
        }
        let marker = MoveMarker {
            operation_id,
            source: self.paths.root().to_string_lossy().into_owned(),
            destination: destination.to_string_lossy().into_owned(),
            phase: RelocationPhase::AwaitingRestart,
            cleanup_candidates: collect_cleanup_candidates(self.paths.root())?,
        };
        let mut source_record = SourceMoveRecord {
            marker: marker.clone(),
            staging: staging.to_string_lossy().into_owned(),
            phase: SourceMovePhase::Preparing,
        };
        write_source_move_record(self.paths.root(), &source_record)?;
        let mut operation_path = staging.clone();
        let moved = (|| {
            if let Some(hook) = &self.before_staging_create {
                hook();
            }
            let staging_name = staging
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| CommandError::validation("storage staging name is invalid"))?;
            let staging_directory = parent.create_child_no_replace(staging_name)?;
            if self.failure == StorageMoveFailurePoint::CrashAfterStagingCreate {
                return Err(CommandError::io(
                    "injected crash after storage staging creation",
                ));
            }
            write_new_marker(&staging_directory, &marker)?;
            source_record.phase = SourceMovePhase::StagingPrepared;
            write_source_move_record(self.paths.root(), &source_record)?;

            let source_directory = SafeDirectory::open(self.paths.root(), &[], false)?;
            let copied = copy_tree(&source_directory, &staging_directory)?;
            verify_copy(&staging_directory, &copied)?;
            if self.failure == StorageMoveFailurePoint::AfterCopy {
                return Err(CommandError::io("injected failure after storage copy"));
            }

            if let Some(hook) = &self.before_index_snapshot {
                hook();
            }
            backup_index_snapshot(self.paths.database(), &staging_directory)?;
            staging_directory.ensure_path_identity()?;
            source_record.phase = SourceMovePhase::DestinationVerified;
            write_source_move_record(self.paths.root(), &source_record)?;
            if self.failure == StorageMoveFailurePoint::AfterValidation {
                return Err(CommandError::io(
                    "injected failure after destination validation",
                ));
            }

            let destination_name = destination
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| CommandError::validation("storage destination name is invalid"))?;
            staging_directory.ensure_path_identity()?;
            if let Some(hook) = &self.before_staging_publish {
                hook();
            }
            staging_directory
                .move_self_no_replace(&parent, destination_name)
                .map_err(|failure| failure.into_error())?;
            parent.sync()?;
            operation_path = destination.clone();
            source_record.phase = SourceMovePhase::DestinationPublished;
            write_source_move_record(self.paths.root(), &source_record)?;
            if self.failure == StorageMoveFailurePoint::CrashBeforeSettingsPublish {
                return Err(CommandError::io(
                    "injected crash before storage configuration publish",
                ));
            }

            let mut settings = self.load_unlocked()?;
            settings.data_root = DataRootSetting::Custom {
                path: destination.to_string_lossy().into_owned(),
            };
            self.persist(&settings)?;
            source_record.phase = SourceMovePhase::ConfigurationPublished;
            write_source_move_record(self.paths.root(), &source_record)?;
            Ok(())
        })();
        if let Err(error) = moved {
            if matches!(
                self.failure,
                StorageMoveFailurePoint::CrashAfterStagingCreate
                    | StorageMoveFailurePoint::CrashBeforeSettingsPublish
            ) {
                return Err(error);
            }
            if operation_path.exists() {
                cleanup_created_destination(&operation_path, &marker)?;
            }
            source_record.phase = SourceMovePhase::Quarantined;
            write_source_move_record(self.paths.root(), &source_record)?;
            return Err(error);
        }
        *self
            .relocation_lease
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(guard);
        Ok(())
    }

    fn reject_active_relocation(&self) -> Result<(), CommandError> {
        if self
            .relocation_lease
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some()
        {
            Err(CommandError::conflict(
                "storage relocation is complete and restart is required",
            ))
        } else {
            Ok(())
        }
    }

    fn persist(&self, settings: &AppSettings) -> Result<(), CommandError> {
        let value = serde_json::to_value(settings).map_err(|source| {
            CommandError::validation(format!("could not encode settings: {source}"))
        })?;
        self.store.save_data_root_backup(&settings.data_root)?;
        self.store.save(&value)
    }

    fn reconcile_system(&self, mut settings: AppSettings) -> Result<AppSettings, CommandError> {
        let mut changed = false;
        // A registration failure is reported through get_capture_shortcut; when a
        // shortcut is active, its actual registration is the authoritative value.
        if let Ok(actual) = self.system.shortcut() {
            if actual != settings.shortcut {
                settings.shortcut = actual;
                changed = true;
            }
        }
        let actual_autostart = self.system.launch_at_startup()?;
        if actual_autostart != settings.launch_at_startup {
            settings.launch_at_startup = actual_autostart;
            changed = true;
        }
        if changed {
            self.persist(&settings)?;
        }
        Ok(settings)
    }

    fn apply_system_transaction<F>(
        &self,
        previous: &AppSettings,
        next: &AppSettings,
        persist: F,
    ) -> Result<(), CommandError>
    where
        F: FnOnce() -> Result<(), CommandError>,
    {
        let shortcut_changed = previous.shortcut != next.shortcut;
        let autostart_changed = previous.launch_at_startup != next.launch_at_startup;
        if shortcut_changed {
            self.system.rebind_shortcut(&next.shortcut)?;
        }
        if autostart_changed {
            if let Err(error) = self.system.set_launch_at_startup(next.launch_at_startup) {
                if shortcut_changed {
                    self.system.rebind_shortcut(&previous.shortcut)?;
                }
                return Err(error);
            }
        }
        if let Err(error) = persist() {
            let mut rollback_error = None;
            if autostart_changed {
                if let Err(error) = self
                    .system
                    .set_launch_at_startup(previous.launch_at_startup)
                {
                    rollback_error = Some(error);
                }
            }
            if shortcut_changed {
                if let Err(error) = self.system.rebind_shortcut(&previous.shortcut) {
                    rollback_error = Some(error);
                }
            }
            return rollback_error.map_or(Err(error), |rollback| {
                Err(CommandError::conflict(format!(
                    "settings persistence failed and system rollback failed: {rollback}"
                )))
            });
        }
        Ok(())
    }
}

fn reject_visible_sticky_windows(paths: &StoragePaths) -> Result<(), CommandError> {
    let database = Database::open(paths.database())?;
    database.migrate()?;
    let visible: bool = database
        .connection()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM temporary_windows WHERE visible = 1)",
            [],
            |row| row.get(0),
        )
        .map_err(|source| {
            CommandError::database(format!(
                "could not inspect visible sticky windows: {source}"
            ))
        })?;
    database.close()?;
    if visible {
        Err(CommandError::conflict(
            "hide all sticky note windows before moving storage",
        ))
    } else {
        Ok(())
    }
}

fn apply_patch(
    mut settings: AppSettings,
    patch: SettingsPatch,
) -> Result<AppSettings, CommandError> {
    if let Some(theme) = patch.theme {
        settings.theme = theme;
    }
    if let Some(mode) = patch.sticky_color_mode {
        settings.sticky_color_mode = mode;
    }
    if let Some(font) = patch.body_font {
        settings.body_font = validate_font(font)?;
    }
    if let Some(font) = patch.code_font {
        settings.code_font = validate_font(font)?;
    }
    if let Some(value) = patch.font_size {
        if !value.is_finite() {
            return Err(CommandError::validation("font size must be finite"));
        }
        settings.font_size = value.clamp(12.0, 28.0);
    }
    if let Some(value) = patch.line_height {
        if !value.is_finite() {
            return Err(CommandError::validation("line height must be finite"));
        }
        settings.line_height = value.clamp(1.2, 2.2);
    }
    if let Some(shortcut) = patch.shortcut {
        settings.shortcut = normalize_accelerator(&shortcut)
            .map_err(|error| CommandError::validation(error.to_string()))?;
    }
    if let Some(value) = patch.launch_at_startup {
        settings.launch_at_startup = value;
    }
    if let Some(value) = patch.default_editor_mode {
        settings.default_editor_mode = value;
    }
    if let Some(value) = patch.autosave_delay_ms {
        settings.autosave_delay_ms = value.clamp(150, 2_000);
    }
    validate_settings(settings)
}

fn validate_settings(mut settings: AppSettings) -> Result<AppSettings, CommandError> {
    if settings.version != SETTINGS_VERSION {
        return Err(CommandError::validation("settings version is unsupported"));
    }
    settings.body_font = validate_font(settings.body_font)?;
    settings.code_font = validate_font(settings.code_font)?;
    if !settings.font_size.is_finite() || !settings.line_height.is_finite() {
        return Err(CommandError::validation(
            "settings contain non-finite values",
        ));
    }
    settings.font_size = settings.font_size.clamp(12.0, 28.0);
    settings.line_height = settings.line_height.clamp(1.2, 2.2);
    settings.autosave_delay_ms = settings.autosave_delay_ms.clamp(150, 2_000);
    settings.shortcut = normalize_accelerator(&settings.shortcut)
        .map_err(|error| CommandError::validation(error.to_string()))?;
    if let DataRootSetting::Custom { path } = &settings.data_root {
        let path = Path::new(path);
        if !path.is_absolute()
            || path
                .components()
                .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
        {
            return Err(CommandError::validation(
                "custom storage root must be an absolute normalized path",
            ));
        }
    }
    Ok(settings)
}

#[doc(hidden)]
pub fn open_configured_storage(
    default_root: impl AsRef<Path>,
    settings: &AppSettings,
) -> Result<StoragePaths, CommandError> {
    let settings = validate_settings(settings.clone())?;
    let is_custom = matches!(settings.data_root, DataRootSetting::Custom { .. });
    let configured = match settings.data_root {
        DataRootSetting::Default => default_root.as_ref().to_path_buf(),
        DataRootSetting::Custom { path } => {
            let requested = PathBuf::from(path);
            reject_existing_path_links(&requested)?;
            let metadata = fs::symlink_metadata(&requested).map_err(|source| {
                CommandError::io(format!("configured storage root is unavailable: {source}"))
            })?;
            reject_link_or_reparse(&metadata)?;
            if !metadata.is_dir() {
                return Err(CommandError::validation(
                    "configured storage root is not a directory",
                ));
            }
            requested
        }
    };
    let paths = StoragePaths::open(configured)?;
    if is_custom {
        validate_relocation_destination(&paths)?;
    }
    Ok(paths)
}

fn validate_font(value: String) -> Result<String, CommandError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(CommandError::validation("font family is invalid"));
    }
    Ok(value.to_owned())
}

fn count_note_storage(paths: &StoragePaths) -> Result<(u64, u64), CommandError> {
    let mut notes = 0_u64;
    let mut assets = 0_u64;
    for root in [paths.notes(), paths.temporary()] {
        count_note_tree(root, false, &mut notes, &mut assets)?;
    }
    Ok((notes, assets))
}

fn count_note_tree(
    root: &Path,
    inside_assets: bool,
    notes: &mut u64,
    assets: &mut u64,
) -> Result<(), CommandError> {
    for entry in fs::read_dir(root)
        .map_err(|source| CommandError::io(format!("could not inspect storage use: {source}")))?
    {
        let entry = entry.map_err(|source| {
            CommandError::io(format!("could not inspect storage entry: {source}"))
        })?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|source| {
            CommandError::io(format!("could not inspect storage metadata: {source}"))
        })?;
        reject_link_or_reparse(&metadata)?;
        let in_assets = inside_assets || entry.file_name() == "assets";
        if metadata.is_dir() {
            count_note_tree(&entry.path(), in_assets, notes, assets)?;
        } else if metadata.is_file() {
            if in_assets {
                *assets = assets
                    .checked_add(metadata.len())
                    .ok_or_else(|| CommandError::validation("storage byte count overflow"))?;
            } else {
                *notes = notes
                    .checked_add(metadata.len())
                    .ok_or_else(|| CommandError::validation("storage byte count overflow"))?;
            }
        } else {
            return Err(CommandError::validation(
                "storage contains an unsupported filesystem entry",
            ));
        }
    }
    Ok(())
}

fn count_tree_bytes(root: &Path) -> Result<u64, CommandError> {
    let mut total = 0;
    let mut ignored_assets = 0;
    count_note_tree(root, false, &mut total, &mut ignored_assets)?;
    total = total
        .checked_add(ignored_assets)
        .ok_or_else(|| CommandError::validation("storage byte count overflow"))?;
    Ok(total)
}

fn validate_fresh_destination(source: &Path, destination: &Path) -> Result<PathBuf, CommandError> {
    if !destination.is_absolute()
        || destination
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(CommandError::validation(
            "storage destination must be an absolute normalized path",
        ));
    }
    if fs::symlink_metadata(destination).is_ok() {
        return Err(CommandError::conflict(
            "storage destination must not already exist",
        ));
    }
    let requested_parent = destination
        .parent()
        .ok_or_else(|| CommandError::validation("storage destination has no parent"))?;
    reject_existing_path_links(requested_parent)?;
    let parent = requested_parent.canonicalize().map_err(|source| {
        CommandError::validation(format!("storage destination parent is invalid: {source}"))
    })?;
    let name = destination
        .file_name()
        .ok_or_else(|| CommandError::validation("storage destination has no name"))?;
    let destination = parent.join(name);
    if destination.starts_with(source) {
        return Err(CommandError::validation(
            "storage destination must be outside the active data root",
        ));
    }
    Ok(destination)
}

fn reject_existing_path_links(path: &Path) -> Result<(), CommandError> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        // A Windows prefix such as `\\?\C:` is not itself a queryable path.
        // Wait until the root separator has been appended before inspecting it.
        if matches!(component, Component::Prefix(_) | Component::RootDir) {
            continue;
        }
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => continue,
            Err(source) => {
                return Err(CommandError::io(format!(
                    "could not inspect storage path component: {source}"
                )))
            }
        };
        reject_link_or_reparse(&metadata)?;
    }
    Ok(())
}

fn copy_tree(
    source: &SafeDirectory,
    destination: &SafeDirectory,
) -> Result<Vec<(PathBuf, u64)>, CommandError> {
    let mut copied = Vec::new();
    copy_directory(source, destination, Path::new(""), true, &mut copied)?;
    Ok(copied)
}

fn copy_directory(
    source: &SafeDirectory,
    destination: &SafeDirectory,
    relative_parent: &Path,
    root: bool,
    copied: &mut Vec<(PathBuf, u64)>,
) -> Result<(), CommandError> {
    for name in source.entry_names()? {
        if root
            && matches!(
                name.as_str(),
                MUTATION_LOCK
                    | MOVE_MARKER
                    | SOURCE_MOVE_MARKER
                    | "index.sqlite"
                    | "index.sqlite-wal"
                    | "index.sqlite-shm"
            )
        {
            continue;
        }
        let relative = relative_parent.join(&name);
        match source.entry_kind(&name)? {
            SafeEntryKind::Directory => {
                let source_child = source.open_child(&name, false)?;
                let destination_child = destination.open_child(&name, true)?;
                copy_directory(&source_child, &destination_child, &relative, false, copied)?;
                destination_child.sync()?;
            }
            SafeEntryKind::RegularFile => {
                let bytes = source.copy_regular_file_to(&name, destination)?;
                copied.push((relative, bytes));
            }
        }
    }
    destination.sync()?;
    Ok(())
}

fn verify_copy(destination: &SafeDirectory, copied: &[(PathBuf, u64)]) -> Result<(), CommandError> {
    for (relative, expected_bytes) in copied {
        let components = relative
            .iter()
            .map(|component| {
                component
                    .to_str()
                    .ok_or_else(|| CommandError::validation("copied path is not Unicode"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let (file, parents) = components
            .split_last()
            .ok_or_else(|| CommandError::validation("copied path is empty"))?;
        let mut nested: Option<SafeDirectory> = None;
        for parent in parents {
            nested = Some(match nested.as_ref() {
                Some(directory) => directory.open_child(parent, false)?,
                None => destination.open_child(parent, false)?,
            });
        }
        let actual_bytes = match nested.as_ref() {
            Some(directory) => directory.regular_file_len(file)?,
            None => destination.regular_file_len(file)?,
        };
        if actual_bytes != *expected_bytes {
            return Err(CommandError::io(
                "destination file byte count does not match its copied source",
            ));
        }
    }
    let expected = copied
        .iter()
        .map(|(path, _)| path.clone())
        .collect::<BTreeSet<_>>();
    let mut actual = BTreeSet::new();
    collect_destination_files(destination, Path::new(""), &mut actual)?;
    actual.remove(Path::new(MOVE_MARKER));
    if actual != expected {
        return Err(CommandError::validation(
            "destination storage layout does not match the source",
        ));
    }
    Ok(())
}

fn collect_destination_files(
    directory: &SafeDirectory,
    relative_parent: &Path,
    files: &mut BTreeSet<PathBuf>,
) -> Result<(), CommandError> {
    for name in directory.entry_names()? {
        let relative = relative_parent.join(&name);
        match directory.entry_kind(&name)? {
            SafeEntryKind::Directory => {
                let child = directory.open_child(&name, false)?;
                collect_destination_files(&child, &relative, files)?;
            }
            SafeEntryKind::RegularFile => {
                files.insert(relative);
            }
        }
    }
    Ok(())
}

type WindowStateRow = (Vec<u8>, i64, f64, f64, f64, f64, i64);

fn backup_index_snapshot(
    source_path: &Path,
    destination: &SafeDirectory,
) -> Result<(), CommandError> {
    let source = Database::open(source_path)?;
    source.migrate()?;
    let mut snapshot = rusqlite::Connection::open_in_memory().map_err(|error| {
        CommandError::database(format!("could not create memory index snapshot: {error}"))
    })?;
    {
        let backup =
            rusqlite::backup::Backup::new(source.connection(), &mut snapshot).map_err(|error| {
                CommandError::database(format!("could not begin index snapshot: {error}"))
            })?;
        backup
            .run_to_completion(64, Duration::from_millis(5), None)
            .map_err(|error| {
                CommandError::database(format!("could not copy index snapshot: {error}"))
            })?;
    }
    let quick_check: String = snapshot
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| {
            CommandError::database(format!("could not validate memory index snapshot: {error}"))
        })?;
    if quick_check != "ok" {
        return Err(CommandError::database(
            "memory index snapshot failed SQLite quick_check",
        ));
    }
    let serialized = snapshot.serialize(rusqlite::MAIN_DB).map_err(|error| {
        CommandError::database(format!("could not serialize index snapshot: {error}"))
    })?;
    let mut file = destination.create_new("index.sqlite")?;
    file.write_all(&serialized).map_err(|error| {
        CommandError::io(format!(
            "could not write destination index snapshot: {error}"
        ))
    })?;
    file.sync_all().map_err(|error| {
        CommandError::io(format!(
            "could not sync destination index snapshot: {error}"
        ))
    })?;
    destination.sync()?;
    drop(serialized);
    snapshot.close().map_err(|(_, error)| {
        CommandError::database(format!("could not close memory index snapshot: {error}"))
    })?;
    source.close()?;
    Ok(())
}

fn read_window_state_rows(path: &Path) -> Result<Vec<WindowStateRow>, CommandError> {
    let database = Database::open(path)?;
    database.migrate()?;
    let rows = read_window_state_rows_connection(database.connection())?;
    database.close()?;
    Ok(rows)
}

fn read_window_state_rows_connection(
    connection: &rusqlite::Connection,
) -> Result<Vec<WindowStateRow>, CommandError> {
    let mut statement = connection
        .prepare(
            "SELECT note_id, visible, x, y, width, height, always_on_top \
             FROM temporary_windows ORDER BY note_id",
        )
        .map_err(|error| {
            CommandError::database(format!("could not inspect sticky window snapshot: {error}"))
        })?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        })
        .map_err(|error| {
            CommandError::database(format!("could not read sticky window snapshot: {error}"))
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            CommandError::database(format!("sticky window snapshot is invalid: {error}"))
        })?;
    drop(statement);
    Ok(rows)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RelocationPhase {
    AwaitingRestart,
    ReadyForCleanup,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MoveMarker {
    operation_id: String,
    source: String,
    destination: String,
    phase: RelocationPhase,
    #[serde(default)]
    cleanup_candidates: Vec<StorageCleanupCandidate>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum SourceMovePhase {
    Preparing,
    StagingPrepared,
    DestinationVerified,
    DestinationPublished,
    ConfigurationPublished,
    Quarantined,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceMoveRecord {
    marker: MoveMarker,
    staging: String,
    phase: SourceMovePhase,
}

fn write_source_move_record(
    source_root: &Path,
    record: &SourceMoveRecord,
) -> Result<(), CommandError> {
    let bytes = serde_json::to_vec(record).map_err(|source| {
        CommandError::validation(format!(
            "could not encode source relocation record: {source}"
        ))
    })?;
    match crate::storage::atomic_file::atomic_replace_contained(
        source_root,
        &[],
        SOURCE_MOVE_MARKER,
        &bytes,
    ) {
        Ok(crate::storage::atomic_file::PublishState::Published) => Ok(()),
        Ok(state) => Err(CommandError::io(format!(
            "source relocation record returned invalid publication state: {state:?}"
        ))),
        Err(failure) => Err(failure.into_error()),
    }
}

fn read_source_move_record(root: &Path) -> Result<Option<SourceMoveRecord>, CommandError> {
    let directory = SafeDirectory::open(root, &[], false)?;
    if !directory.regular_file_exists(SOURCE_MOVE_MARKER)? {
        return Ok(None);
    }
    serde_json::from_slice(&directory.read(SOURCE_MOVE_MARKER, 256 * 1024)?)
        .map(Some)
        .map_err(|source| {
            CommandError::validation(format!("source relocation record is invalid: {source}"))
        })
}

#[doc(hidden)]
pub fn recover_interrupted_source_relocation(paths: &StoragePaths) -> Result<(), CommandError> {
    let Some(mut record) = read_source_move_record(paths.root())? else {
        return Ok(());
    };
    let source = Path::new(&record.marker.source)
        .canonicalize()
        .map_err(|source| {
            CommandError::validation(format!("relocation source is unavailable: {source}"))
        })?;
    if source != paths.root() {
        return Err(CommandError::validation(
            "source relocation record does not belong to the active library",
        ));
    }
    if matches!(
        record.phase,
        SourceMovePhase::ConfigurationPublished | SourceMovePhase::Quarantined
    ) {
        return Ok(());
    }
    let destination = PathBuf::from(&record.marker.destination);
    let staging = PathBuf::from(&record.staging);
    if destination.exists() {
        cleanup_created_destination(&destination, &record.marker)?;
    } else if staging.exists() && operation_marker_exists_safely(&staging)? {
        cleanup_created_destination(&staging, &record.marker)?;
    }
    record.phase = SourceMovePhase::Quarantined;
    write_source_move_record(paths.root(), &record)
}

fn operation_marker_exists_safely(path: &Path) -> Result<bool, CommandError> {
    let parent_path = path
        .parent()
        .ok_or_else(|| CommandError::validation("relocation operation has no parent"))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| CommandError::validation("relocation operation name is invalid"))?;
    let parent = SafeDirectory::open(parent_path, &[], false)?;
    match parent.open_child(name, false) {
        Ok(directory) => directory.regular_file_exists(MOVE_MARKER),
        // An untrusted replacement is never followed or removed. The source
        // record remains the diagnostic evidence while the requested path is
        // still available for a new operation whenever possible.
        Err(_) => Ok(false),
    }
}

fn collect_cleanup_candidates(root: &Path) -> Result<Vec<StorageCleanupCandidate>, CommandError> {
    const KNOWN: &[(&str, &str, bool)] = &[
        ("notes", "notes", true),
        ("temporary", "temporary", true),
        ("trash", "trash", true),
        ("folders.json", "folder-manifest", false),
        ("index.sqlite", "index-database", false),
        ("index.sqlite-wal", "index-sidecar", false),
        ("index.sqlite-shm", "index-sidecar", false),
        ("rebuild-needed.json", "recovery-marker", false),
        ("recovery-needed.json", "recovery-marker", false),
    ];
    let mut candidates = Vec::new();
    for &(relative_path, kind, directory) in KNOWN {
        let path = root.join(relative_path);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => continue,
            Err(source) => {
                return Err(CommandError::io(format!(
                    "could not inspect cleanup candidate: {source}"
                )))
            }
        };
        reject_link_or_reparse(&metadata)?;
        if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
            return Err(CommandError::validation(
                "known storage cleanup candidate has an invalid type",
            ));
        }
        candidates.push(StorageCleanupCandidate {
            relative_path: relative_path.to_owned(),
            kind: kind.to_owned(),
        });
    }
    Ok(candidates)
}

fn write_marker(destination: &Path, marker: &MoveMarker) -> Result<(), CommandError> {
    let bytes = serde_json::to_vec(marker).map_err(|source| {
        CommandError::validation(format!("could not encode move marker: {source}"))
    })?;
    match crate::storage::atomic_file::atomic_replace_contained(
        destination,
        &[],
        MOVE_MARKER,
        &bytes,
    ) {
        Ok(crate::storage::atomic_file::PublishState::Published) => Ok(()),
        Ok(state) => Err(CommandError::io(format!(
            "relocation record returned invalid publication state: {state:?}"
        ))),
        Err(failure) => Err(failure.into_error()),
    }
}

fn write_new_marker(destination: &SafeDirectory, marker: &MoveMarker) -> Result<(), CommandError> {
    let bytes = serde_json::to_vec(marker).map_err(|source| {
        CommandError::validation(format!("could not encode move marker: {source}"))
    })?;
    let mut file = destination.create_new(MOVE_MARKER)?;
    file.write_all(&bytes)
        .map_err(|source| CommandError::io(format!("could not write move marker: {source}")))?;
    file.sync_all()
        .map_err(|source| CommandError::io(format!("could not sync move marker: {source}")))?;
    destination.sync()
}

fn read_relocation_marker(paths: &StoragePaths) -> Result<Option<MoveMarker>, CommandError> {
    let marker_path = paths.root().join(MOVE_MARKER);
    let metadata = match fs::symlink_metadata(&marker_path) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(CommandError::io(format!(
                "could not inspect relocation record: {source}"
            )))
        }
    };
    reject_link_or_reparse(&metadata)?;
    if !metadata.is_file() {
        return Err(CommandError::validation(
            "relocation record is not a regular file",
        ));
    }
    let marker: MoveMarker = serde_json::from_slice(&fs::read(&marker_path).map_err(|source| {
        CommandError::io(format!("could not read relocation record: {source}"))
    })?)
    .map_err(|source| {
        CommandError::validation(format!("relocation record is invalid: {source}"))
    })?;
    Ok(Some(marker))
}

fn validate_relocation_destination(paths: &StoragePaths) -> Result<(), CommandError> {
    let Some(marker) = read_relocation_marker(paths)? else {
        return Ok(());
    };
    if Path::new(&marker.destination)
        .canonicalize()
        .map_err(|source| {
            CommandError::validation(format!("relocation destination is unavailable: {source}"))
        })?
        != paths.root()
    {
        return Err(CommandError::validation(
            "relocation record does not match the configured root",
        ));
    }
    Ok(())
}

#[doc(hidden)]
pub fn finalize_reopened_relocation(paths: &StoragePaths) -> Result<(), CommandError> {
    validate_relocation_destination(paths)?;
    let Some(mut marker) = read_relocation_marker(paths)? else {
        return Ok(());
    };
    if marker.phase == RelocationPhase::ReadyForCleanup {
        return Ok(());
    }
    let expected_window_states = read_window_state_rows(paths.database())?;
    rebuild_index_strict(paths)?;
    let rebuilt_window_states = read_window_state_rows(paths.database())?;
    if rebuilt_window_states != expected_window_states {
        return Err(CommandError::database(
            "reopened storage did not preserve every sticky window state",
        ));
    }
    marker.phase = RelocationPhase::ReadyForCleanup;
    write_marker(paths.root(), &marker)
}

fn cleanup_created_destination(
    destination: &Path,
    expected: &MoveMarker,
) -> Result<(), CommandError> {
    cleanup_created_destination_using(destination, expected, || {})
}

fn cleanup_created_destination_using<F: FnOnce()>(
    destination: &Path,
    expected: &MoveMarker,
    before_quarantine: F,
) -> Result<(), CommandError> {
    let parent = destination
        .parent()
        .ok_or_else(|| CommandError::validation("incomplete destination has no parent"))?;
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| CommandError::validation("incomplete destination name is invalid"))?;
    let parent = crate::platform::SafeDirectory::open(parent, &[], false)?;
    let created = parent.open_child(name, false)?;
    let actual: MoveMarker = serde_json::from_slice(&created.read(MOVE_MARKER, 256 * 1024)?)
        .map_err(|source| CommandError::validation(format!("move marker is invalid: {source}")))?;
    if &actual != expected {
        return Err(CommandError::validation(
            "incomplete destination marker identity changed",
        ));
    }
    drop(created);
    before_quarantine();
    let quarantine = format!(".simple-notes-incomplete-{}", expected.operation_id);
    parent
        .move_directory_no_replace(name, &parent, &quarantine)
        .map(|_| ())
        .map_err(|failure| failure.into_error())
}

#[doc(hidden)]
pub fn quarantine_incomplete_destination_with_hook<F: FnOnce()>(
    destination: &Path,
    before_quarantine: F,
) -> Result<(), CommandError> {
    let parent = destination
        .parent()
        .ok_or_else(|| CommandError::validation("incomplete destination has no parent"))?;
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| CommandError::validation("incomplete destination name is invalid"))?;
    let parent = SafeDirectory::open(parent, &[], false)?;
    let created = parent.open_child(name, false)?;
    let expected: MoveMarker = serde_json::from_slice(&created.read(MOVE_MARKER, 256 * 1024)?)
        .map_err(|source| CommandError::validation(format!("move marker is invalid: {source}")))?;
    drop(created);
    drop(parent);
    cleanup_created_destination_using(destination, &expected, before_quarantine)
}

fn reject_link_or_reparse(metadata: &fs::Metadata) -> Result<(), CommandError> {
    if is_link_or_reparse(metadata) {
        Err(CommandError::validation(
            "storage contains a symbolic link or reparse point",
        ))
    } else {
        Ok(())
    }
}

fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

const SETTINGS_KEY: &str = "appSettings";
const DATA_ROOT_BACKUP_KEY: &str = "dataRootLastKnownGood";

#[derive(Clone)]
pub struct TauriSettingsStore {
    store: std::sync::Arc<Store<tauri::Wry>>,
}

impl SettingsStore for TauriSettingsStore {
    fn load(&self) -> Result<Option<Value>, CommandError> {
        Ok(self.store.get(SETTINGS_KEY))
    }

    fn save(&self, value: &Value) -> Result<(), CommandError> {
        self.save_key(SETTINGS_KEY, value.clone())
    }

    fn load_data_root_backup(&self) -> Result<Option<DataRootSetting>, CommandError> {
        self.store
            .get(DATA_ROOT_BACKUP_KEY)
            .map(serde_json::from_value)
            .transpose()
            .map_err(|source| {
                CommandError::validation(format!(
                    "last known library location is invalid: {source}"
                ))
            })
    }

    fn save_data_root_backup(&self, root: &DataRootSetting) -> Result<(), CommandError> {
        let value = serde_json::to_value(root).map_err(|source| {
            CommandError::validation(format!(
                "could not encode last known library location: {source}"
            ))
        })?;
        self.save_key(DATA_ROOT_BACKUP_KEY, value)
    }
}

impl TauriSettingsStore {
    fn save_key(&self, key: &str, value: Value) -> Result<(), CommandError> {
        let previous = self.store.get(key);
        self.store.set(key, value);
        if let Err(source) = self.store.save() {
            match previous {
                Some(previous) => self.store.set(key, previous),
                None => {
                    self.store.delete(key);
                }
            }
            let _ = self.store.save();
            return Err(CommandError::io(format!(
                "could not persist application settings: {source}"
            )));
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct TauriSystemSettings {
    app: tauri::AppHandle,
}

impl SystemSettings for TauriSystemSettings {
    fn shortcut(&self) -> Result<String, CommandError> {
        self.app
            .try_state::<crate::commands::shortcuts::CaptureShortcutState>()
            .and_then(|state| state.current())
            .ok_or_else(|| CommandError::conflict("capture shortcut is not active"))
    }

    fn rebind_shortcut(&self, shortcut: &str) -> Result<(), CommandError> {
        self.app
            .try_state::<crate::commands::shortcuts::CaptureShortcutState>()
            .ok_or_else(|| CommandError::conflict("capture shortcut service is unavailable"))?
            .rebind(shortcut)
            .map_err(|error| CommandError::conflict(error.to_string()))
    }

    fn launch_at_startup(&self) -> Result<bool, CommandError> {
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            self.app.autolaunch().is_enabled().map_err(|source| {
                CommandError::io(format!("could not inspect autostart: {source}"))
            })
        }
        #[cfg(any(target_os = "android", target_os = "ios"))]
        Err(CommandError::unsupported(
            "autostart is unavailable on mobile platforms",
        ))
    }

    fn set_launch_at_startup(&self, enabled: bool) -> Result<(), CommandError> {
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            let manager = self.app.autolaunch();
            if enabled {
                manager.enable()
            } else {
                manager.disable()
            }
            .map_err(|source| CommandError::io(format!("could not update autostart: {source}")))
        }
        #[cfg(any(target_os = "android", target_os = "ios"))]
        {
            let _ = enabled;
            Err(CommandError::unsupported(
                "autostart is unavailable on mobile platforms",
            ))
        }
    }
}

pub struct SettingsCommandState {
    paths: StoragePaths,
    store: TauriSettingsStore,
    app: tauri::AppHandle,
    relocation_lease: Arc<Mutex<Option<IndexMutationLock>>>,
    transaction: Arc<Mutex<()>>,
}

impl SettingsCommandState {
    pub(crate) fn paths(&self) -> &StoragePaths {
        &self.paths
    }

    fn service(&self) -> SettingsService<TauriSettingsStore, TauriSystemSettings> {
        SettingsService::new_with_lease(
            self.paths.clone(),
            self.store.clone(),
            TauriSystemSettings {
                app: self.app.clone(),
            },
            self.relocation_lease.clone(),
            self.transaction.clone(),
        )
    }

    pub(crate) fn stored_settings(&self) -> Result<AppSettings, CommandError> {
        load_bootstrap_settings(&self.store)
    }

    fn relocation_pending(&self) -> bool {
        self.relocation_lease
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some()
    }
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let store = TauriSettingsStore {
        store: app.store("settings.json")?,
    };
    let default_root = app.path().app_data_dir()?;
    let settings = load_bootstrap_settings(&store)?;
    let paths = open_configured_storage(default_root, &settings)?;
    recover_interrupted_source_relocation(&paths)?;
    app.manage(SettingsCommandState {
        paths,
        store,
        app: app.handle().clone(),
        relocation_lease: Arc::new(Mutex::new(None)),
        transaction: Arc::new(Mutex::new(())),
    });
    Ok(())
}

#[doc(hidden)]
pub fn authorize_settings_caller(label: &str) -> Result<(), CommandError> {
    if label == "main" {
        Ok(())
    } else {
        Err(CommandError::validation(
            "settings management requires the main window",
        ))
    }
}

#[doc(hidden)]
pub fn authorize_restart_request(
    label: &str,
    relocation_pending: bool,
) -> Result<(), CommandError> {
    authorize_settings_caller(label)?;
    if relocation_pending {
        Ok(())
    } else {
        Err(CommandError::conflict(
            "application restart is only available after storage relocation",
        ))
    }
}

#[tauri::command]
pub fn load_settings(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SettingsCommandState>,
) -> Result<AppSettings, CommandError> {
    authorize_settings_caller(window.label())?;
    state.service().load()
}

#[tauri::command]
pub fn update_settings(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SettingsCommandState>,
    patch: SettingsPatch,
) -> Result<AppSettings, CommandError> {
    authorize_settings_caller(window.label())?;
    let settings = state.service().update(patch)?;
    let _ = state.app.emit("settings-updated", settings.clone());
    Ok(settings)
}

#[tauri::command]
pub fn reset_settings(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SettingsCommandState>,
) -> Result<AppSettings, CommandError> {
    authorize_settings_caller(window.label())?;
    let settings = state.service().reset()?;
    let _ = state.app.emit("settings-updated", settings.clone());
    Ok(settings)
}

#[tauri::command]
pub fn get_storage_info(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SettingsCommandState>,
) -> Result<StorageInfo, CommandError> {
    authorize_settings_caller(window.label())?;
    state.service().get_storage_info()
}

#[tauri::command]
pub fn move_storage_root(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SettingsCommandState>,
    destination: String,
) -> Result<(), CommandError> {
    authorize_settings_caller(window.label())?;
    state.service().move_storage_root(destination)
}

#[tauri::command]
pub fn restart_application(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SettingsCommandState>,
) -> Result<(), CommandError> {
    authorize_restart_request(window.label(), state.relocation_pending())?;
    state.app.restart()
}
