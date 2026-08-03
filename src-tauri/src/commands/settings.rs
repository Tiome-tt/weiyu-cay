use crate::{
    error::CommandError,
    platform::IndexMutationLock,
    shortcuts::{normalize_accelerator, DEFAULT_CAPTURE_SHORTCUT},
    storage::{database::Database, paths::StoragePaths, rebuild::rebuild_index_strict},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{BufReader, Read},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::Manager;
use uuid::Uuid;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_store::{Store, StoreExt};

const SETTINGS_VERSION: u32 = 1;
const MOVE_MARKER: &str = ".simple-notes-storage-move.json";
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
            theme: AppTheme::System,
            sticky_color_mode: StickyColorMode::FollowTheme,
            body_font: "system-ui, sans-serif".to_owned(),
            code_font: "ui-monospace, SFMono-Regular, Consolas, monospace".to_owned(),
            font_size: 16.0,
            line_height: 1.6,
            shortcut: DEFAULT_CAPTURE_SHORTCUT.to_owned(),
            launch_at_startup: false,
            default_editor_mode: EditorMode::Split,
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
    pub previous_root: Option<String>,
    pub previous_root_cleanup_ready: bool,
}

pub trait SettingsStore: Clone + Send + Sync + 'static {
    fn load(&self) -> Result<Option<Value>, CommandError>;
    fn save(&self, value: &Value) -> Result<(), CommandError>;
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
}

#[derive(Clone)]
pub struct SettingsService<S, Y> {
    paths: StoragePaths,
    store: S,
    system: Y,
    failure: StorageMoveFailurePoint,
    relocation_lease: Arc<Mutex<Option<IndexMutationLock>>>,
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
        }
    }

    fn new_with_lease(
        paths: StoragePaths,
        store: S,
        system: Y,
        relocation_lease: Arc<Mutex<Option<IndexMutationLock>>>,
    ) -> Self {
        Self {
            paths,
            store,
            system,
            failure: StorageMoveFailurePoint::None,
            relocation_lease,
        }
    }

    pub fn load(&self) -> Result<AppSettings, CommandError> {
        let value = self.store.load()?;
        if let Some(value) = value {
            if let Ok(settings) = serde_json::from_value::<AppSettings>(value) {
                if let Ok(settings) = validate_settings(settings) {
                    return Ok(settings);
                }
            }
        }
        let defaults = AppSettings::default();
        self.persist(&defaults)?;
        Ok(defaults)
    }

    pub fn update(&self, patch: SettingsPatch) -> Result<AppSettings, CommandError> {
        let previous = self.load()?;
        let next = apply_patch(previous.clone(), patch)?;
        self.apply_system_transaction(&previous, &next, || self.persist(&next))?;
        Ok(next)
    }

    pub fn reset(&self) -> Result<AppSettings, CommandError> {
        let previous = self.load()?;
        // A preference reset must never abandon a custom library location.
        let defaults = AppSettings {
            data_root: previous.data_root.clone(),
            ..AppSettings::default()
        };
        self.apply_system_transaction(&previous, &defaults, || self.persist(&defaults))?;
        Ok(defaults)
    }

    pub fn get_storage_info(&self) -> Result<StorageInfo, CommandError> {
        let _guard = IndexMutationLock::acquire(self.paths.root())?;
        let (note_bytes, asset_bytes) = count_note_storage(&self.paths)?;
        let trash_bytes = count_tree_bytes(self.paths.trash())?;
        let relocation = read_relocation_marker(&self.paths)?;
        Ok(StorageInfo {
            root: self.paths.root().to_string_lossy().into_owned(),
            note_bytes,
            asset_bytes,
            trash_bytes,
            previous_root: relocation.as_ref().map(|marker| marker.source.clone()),
            previous_root_cleanup_ready: relocation
                .is_some_and(|marker| marker.phase == RelocationPhase::ReadyForCleanup),
        })
    }

    pub fn move_storage_root(&self, destination: impl AsRef<Path>) -> Result<(), CommandError> {
        let destination = validate_fresh_destination(self.paths.root(), destination.as_ref())?;
        let guard = IndexMutationLock::acquire(self.paths.root())?;
        reject_visible_sticky_windows(&self.paths)?;
        let operation_id = Uuid::now_v7().to_string();
        fs::create_dir(&destination).map_err(|source| {
            CommandError::io(format!(
                "could not create destination storage root: {source}"
            ))
        })?;
        let canonical_destination = destination.canonicalize().map_err(|source| {
            CommandError::io(format!(
                "could not resolve destination storage root: {source}"
            ))
        })?;
        let marker = MoveMarker {
            operation_id,
            source: self.paths.root().to_string_lossy().into_owned(),
            destination: canonical_destination.to_string_lossy().into_owned(),
            phase: RelocationPhase::AwaitingRestart,
        };
        write_marker(&canonical_destination, &marker)?;

        let moved = (|| {
            let copied = copy_tree(self.paths.root(), &canonical_destination)?;
            verify_copy(self.paths.root(), &canonical_destination, &copied)?;
            if self.failure == StorageMoveFailurePoint::AfterCopy {
                return Err(CommandError::io("injected failure after storage copy"));
            }

            let copied_paths = StoragePaths::open(&canonical_destination)?;
            let database = Database::open(copied_paths.database())?;
            database.migrate()?;
            database.close()?;
            rebuild_index_strict(&copied_paths)?;
            if self.failure == StorageMoveFailurePoint::AfterValidation {
                return Err(CommandError::io(
                    "injected failure after destination validation",
                ));
            }

            let mut settings = self.load()?;
            settings.data_root = DataRootSetting::Custom {
                path: canonical_destination.to_string_lossy().into_owned(),
            };
            self.persist(&settings)?;
            Ok(())
        })();
        if let Err(error) = moved {
            cleanup_created_destination(&canonical_destination, &marker)?;
            return Err(error);
        }
        *self
            .relocation_lease
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(guard);
        Ok(())
    }

    fn persist(&self, settings: &AppSettings) -> Result<(), CommandError> {
        let value = serde_json::to_value(settings).map_err(|source| {
            CommandError::validation(format!("could not encode settings: {source}"))
        })?;
        self.store.save(&value)
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

fn copy_tree(source: &Path, destination: &Path) -> Result<Vec<PathBuf>, CommandError> {
    let mut copied = Vec::new();
    copy_directory(source, source, destination, &mut copied)?;
    Ok(copied)
}

fn copy_directory(
    source_root: &Path,
    source: &Path,
    destination_root: &Path,
    copied: &mut Vec<PathBuf>,
) -> Result<(), CommandError> {
    for entry in fs::read_dir(source)
        .map_err(|source| CommandError::io(format!("could not read storage root: {source}")))?
    {
        let entry = entry.map_err(|source| {
            CommandError::io(format!("could not read storage entry: {source}"))
        })?;
        if entry.path() == source_root.join(MUTATION_LOCK)
            || entry.path() == source_root.join(MOVE_MARKER)
        {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|source| {
            CommandError::io(format!("could not inspect storage entry: {source}"))
        })?;
        reject_link_or_reparse(&metadata)?;
        let relative = entry
            .path()
            .strip_prefix(source_root)
            .map_err(|_| CommandError::validation("storage entry escaped the active data root"))?
            .to_path_buf();
        let target = destination_root.join(&relative);
        if metadata.is_dir() {
            fs::create_dir(&target).map_err(|source| {
                CommandError::io(format!("could not create destination directory: {source}"))
            })?;
            copy_directory(source_root, &entry.path(), destination_root, copied)?;
        } else if metadata.is_file() {
            fs::copy(entry.path(), &target).map_err(|source| {
                CommandError::io(format!("could not copy storage file: {source}"))
            })?;
            copied.push(relative);
        } else {
            return Err(CommandError::validation(
                "storage contains an unsupported filesystem entry",
            ));
        }
    }
    Ok(())
}

fn verify_copy(source: &Path, destination: &Path, copied: &[PathBuf]) -> Result<(), CommandError> {
    for relative in copied {
        compare_files(&source.join(relative), &destination.join(relative))?;
    }
    let expected = copied.iter().cloned().collect::<BTreeSet<_>>();
    let mut actual = BTreeSet::new();
    collect_destination_files(destination, destination, &mut actual)?;
    actual.remove(Path::new(MOVE_MARKER));
    if actual != expected {
        return Err(CommandError::validation(
            "destination storage layout does not match the source",
        ));
    }
    Ok(())
}

fn collect_destination_files(
    root: &Path,
    directory: &Path,
    files: &mut BTreeSet<PathBuf>,
) -> Result<(), CommandError> {
    for entry in fs::read_dir(directory).map_err(|source| {
        CommandError::io(format!("could not inspect destination storage: {source}"))
    })? {
        let entry = entry.map_err(|source| {
            CommandError::io(format!("could not inspect destination entry: {source}"))
        })?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|source| {
            CommandError::io(format!("could not inspect destination metadata: {source}"))
        })?;
        reject_link_or_reparse(&metadata)?;
        if metadata.is_dir() {
            collect_destination_files(root, &entry.path(), files)?;
        } else if metadata.is_file() {
            files.insert(
                entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|_| CommandError::validation("destination entry escaped its root"))?
                    .to_path_buf(),
            );
        } else {
            return Err(CommandError::validation(
                "destination contains an unsupported filesystem entry",
            ));
        }
    }
    Ok(())
}

fn compare_files(source: &Path, destination: &Path) -> Result<(), CommandError> {
    let source_file = File::open(source)
        .map_err(|error| CommandError::io(format!("could not verify source file: {error}")))?;
    let destination_file = File::open(destination)
        .map_err(|error| CommandError::io(format!("could not verify destination file: {error}")))?;
    let mut source_reader = BufReader::new(source_file);
    let mut destination_reader = BufReader::new(destination_file);
    let mut source_chunk = [0_u8; 64 * 1024];
    let mut destination_chunk = [0_u8; 64 * 1024];
    loop {
        let source_read = source_reader
            .read(&mut source_chunk)
            .map_err(|error| CommandError::io(format!("could not verify source bytes: {error}")))?;
        let destination_read =
            destination_reader
                .read(&mut destination_chunk)
                .map_err(|error| {
                    CommandError::io(format!("could not verify destination bytes: {error}"))
                })?;
        if source_read != destination_read
            || source_chunk[..source_read] != destination_chunk[..destination_read]
        {
            return Err(CommandError::io(
                "destination storage bytes do not match the source",
            ));
        }
        if source_read == 0 {
            return Ok(());
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RelocationPhase {
    AwaitingRestart,
    ReadyForCleanup,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MoveMarker {
    operation_id: String,
    source: String,
    destination: String,
    phase: RelocationPhase,
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
    let database = Database::open(paths.database())?;
    database.migrate()?;
    database.close()?;
    marker.phase = RelocationPhase::ReadyForCleanup;
    write_marker(paths.root(), &marker)
}

fn cleanup_created_destination(
    destination: &Path,
    expected: &MoveMarker,
) -> Result<(), CommandError> {
    let canonical = destination.canonicalize().map_err(|source| {
        CommandError::validation(format!(
            "could not validate incomplete destination: {source}"
        ))
    })?;
    if canonical != destination {
        return Err(CommandError::validation(
            "incomplete destination identity changed",
        ));
    }
    let marker_path = canonical.join(MOVE_MARKER);
    let metadata = fs::symlink_metadata(&marker_path).map_err(|source| {
        CommandError::validation(format!(
            "incomplete destination marker is missing: {source}"
        ))
    })?;
    reject_link_or_reparse(&metadata)?;
    let actual: MoveMarker = serde_json::from_slice(&fs::read(&marker_path).map_err(|source| {
        CommandError::io(format!(
            "could not read incomplete destination marker: {source}"
        ))
    })?)
    .map_err(|source| CommandError::validation(format!("move marker is invalid: {source}")))?;
    if &actual != expected {
        return Err(CommandError::validation(
            "incomplete destination marker identity changed",
        ));
    }
    remove_tree_without_following(&canonical)?;
    fs::remove_dir(&canonical).map_err(|source| {
        CommandError::io(format!("could not remove incomplete destination: {source}"))
    })
}

fn remove_tree_without_following(directory: &Path) -> Result<(), CommandError> {
    for entry in fs::read_dir(directory).map_err(|source| {
        CommandError::io(format!(
            "could not inspect incomplete destination: {source}"
        ))
    })? {
        let entry = entry.map_err(|source| {
            CommandError::io(format!("could not inspect incomplete entry: {source}"))
        })?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|source| {
            CommandError::io(format!("could not inspect incomplete metadata: {source}"))
        })?;
        if metadata.is_dir() && !is_link_or_reparse(&metadata) {
            remove_tree_without_following(&entry.path())?;
            fs::remove_dir(entry.path()).map_err(|source| {
                CommandError::io(format!("could not remove incomplete directory: {source}"))
            })?;
        } else {
            fs::remove_file(entry.path()).map_err(|source| {
                CommandError::io(format!("could not remove incomplete file: {source}"))
            })?;
        }
    }
    Ok(())
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

#[derive(Clone)]
pub struct TauriSettingsStore {
    store: std::sync::Arc<Store<tauri::Wry>>,
}

impl SettingsStore for TauriSettingsStore {
    fn load(&self) -> Result<Option<Value>, CommandError> {
        Ok(self.store.get(SETTINGS_KEY))
    }

    fn save(&self, value: &Value) -> Result<(), CommandError> {
        let previous = self.store.get(SETTINGS_KEY);
        self.store.set(SETTINGS_KEY, value.clone());
        if let Err(source) = self.store.save() {
            match previous {
                Some(previous) => self.store.set(SETTINGS_KEY, previous),
                None => {
                    self.store.delete(SETTINGS_KEY);
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
        )
    }

    pub(crate) fn stored_settings(&self) -> Result<AppSettings, CommandError> {
        self.service().load()
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
    let settings = match store.load()? {
        Some(value) => serde_json::from_value::<AppSettings>(value)
            .ok()
            .and_then(|settings| validate_settings(settings).ok())
            .unwrap_or_default(),
        None => AppSettings::default(),
    };
    let paths = open_configured_storage(default_root, &settings)?;
    app.manage(SettingsCommandState {
        paths,
        store,
        app: app.handle().clone(),
        relocation_lease: Arc::new(Mutex::new(None)),
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
    state.service().update(patch)
}

#[tauri::command]
pub fn reset_settings(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, SettingsCommandState>,
) -> Result<AppSettings, CommandError> {
    authorize_settings_caller(window.label())?;
    state.service().reset()
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
