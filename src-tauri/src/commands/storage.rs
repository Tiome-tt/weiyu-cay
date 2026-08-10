use crate::storage::paths::StoragePaths;
use crate::{
    error::CommandError,
    storage::recovery::{StartupRecoveryReport, StartupRecoveryState},
};

#[derive(Debug, Clone, Copy)]
pub enum StorageConsumer {
    Folders,
    Notes,
    Temporary,
    Assets,
    Search,
    Links,
    Trash,
    StickyWindows,
    Export,
}

/// The single configured storage root shared by every storage-backed command.
///
/// Keeping this as one managed state prevents individual command setup paths
/// from silently falling back to the platform's default application directory.
pub struct StorageCommandState {
    paths: StoragePaths,
}

impl StorageCommandState {
    pub fn new(paths: StoragePaths) -> Self {
        Self { paths }
    }

    pub fn paths_for(&self, _consumer: StorageConsumer) -> &StoragePaths {
        &self.paths
    }
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;

    let paths = app
        .state::<crate::commands::settings::SettingsCommandState>()
        .paths()
        .clone();
    app.manage(StorageCommandState::new(paths));
    Ok(())
}

#[tauri::command]
pub fn startup_recovery_report(
    window: tauri::Window,
    recovery: tauri::State<'_, StartupRecoveryState>,
) -> Result<StartupRecoveryReport, CommandError> {
    if window.label() != "main" {
        return Err(CommandError::validation(
            "startup recovery report requires the main window",
        ));
    }
    Ok(recovery.report())
}

#[tauri::command]
pub fn retry_startup_recovery(
    window: tauri::Window,
    recovery: tauri::State<'_, StartupRecoveryState>,
) -> Result<StartupRecoveryReport, CommandError> {
    if window.label() != "main" {
        return Err(CommandError::validation(
            "startup recovery retry requires the main window",
        ));
    }
    recovery.retry()
}
