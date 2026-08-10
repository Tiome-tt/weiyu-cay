use crate::storage::paths::StoragePaths;
use crate::{
    error::CommandError,
    storage::recovery::{StartupRecoveryReadiness, StartupRecoveryReport, StartupRecoveryState},
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
    readiness: StartupRecoveryReadiness,
}

impl StorageCommandState {
    pub fn new(paths: StoragePaths, readiness: StartupRecoveryReadiness) -> Self {
        Self { paths, readiness }
    }

    pub fn paths_for(&self, _consumer: StorageConsumer) -> Result<&StoragePaths, CommandError> {
        self.readiness.ensure_ready()?;
        Ok(&self.paths)
    }

    pub(crate) fn configured_paths(&self) -> &StoragePaths {
        &self.paths
    }

    pub(crate) fn readiness(&self) -> StartupRecoveryReadiness {
        self.readiness.clone()
    }
}

pub fn setup(
    app: &mut tauri::App,
    readiness: StartupRecoveryReadiness,
) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;

    let paths = app
        .state::<crate::commands::settings::SettingsCommandState>()
        .paths()
        .clone();
    app.manage(StorageCommandState::new(paths, readiness));
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
    temporary: tauri::State<'_, crate::commands::temporary::TemporaryCommandState>,
) -> Result<StartupRecoveryReport, CommandError> {
    if window.label() != "main" {
        return Err(CommandError::validation(
            "startup recovery retry requires the main window",
        ));
    }
    recovery.retry_with(|| {
        temporary.finish_startup_recovery()?;
        crate::commands::settings::finalize_reopened_relocation(temporary.paths())
    })
}
