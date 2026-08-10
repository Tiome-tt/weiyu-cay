use crate::storage::paths::StoragePaths;

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
