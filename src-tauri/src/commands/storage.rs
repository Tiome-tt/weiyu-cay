use crate::{
    domain::StartupGuideTarget,
    error::CommandError,
    storage::recovery::{StartupRecoveryReadiness, StartupRecoveryReport, StartupRecoveryState},
    storage::{atomic_file::atomic_replace_contained, paths::StoragePaths},
};
use std::{fs, io::ErrorKind, sync::Mutex};

const STARTUP_GUIDE_MARKER: &str = ".startup-guide-v1.json";

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
    pending_startup_guide: Mutex<Option<StartupGuideTarget>>,
    startup_guide_initialization_error: Option<CommandError>,
    startup_guide_target: Mutex<Option<StartupGuideTarget>>,
}

impl StorageCommandState {
    pub fn new(paths: StoragePaths, readiness: StartupRecoveryReadiness) -> Self {
        let (pending_startup_guide, startup_guide_initialization_error) =
            match load_or_create_startup_guide_marker(&paths) {
                Ok(target) => (target, None),
                Err(error) => (None, Some(error)),
            };
        Self {
            paths,
            readiness,
            pending_startup_guide: Mutex::new(pending_startup_guide),
            startup_guide_initialization_error,
            startup_guide_target: Mutex::new(None),
        }
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

    pub(crate) fn take_pending_startup_guide(
        &self,
    ) -> Result<Option<StartupGuideTarget>, CommandError> {
        if let Some(error) = &self.startup_guide_initialization_error {
            return Err(error.clone());
        }
        self.pending_startup_guide
            .lock()
            .map(|mut target| target.take())
            .map_err(|_| CommandError::io("pending startup guide state poisoned"))
    }

    pub(crate) fn restore_pending_startup_guide(
        &self,
        target: StartupGuideTarget,
    ) -> Result<(), CommandError> {
        *self
            .pending_startup_guide
            .lock()
            .map_err(|_| CommandError::io("pending startup guide state poisoned"))? = Some(target);
        Ok(())
    }

    pub(crate) fn publish_startup_guide_target(
        &self,
        target: StartupGuideTarget,
    ) -> Result<(), CommandError> {
        *self
            .startup_guide_target
            .lock()
            .map_err(|_| CommandError::io("startup guide state poisoned"))? = Some(target);
        Ok(())
    }

    #[doc(hidden)]
    pub fn startup_guide_target(&self) -> Result<Option<StartupGuideTarget>, CommandError> {
        self.startup_guide_target
            .lock()
            .map(|target| *target)
            .map_err(|_| CommandError::io("startup guide state poisoned"))
    }

    #[doc(hidden)]
    pub fn complete_startup_guide(&self, target: StartupGuideTarget) -> Result<(), CommandError> {
        let mut current = self
            .startup_guide_target
            .lock()
            .map_err(|_| CommandError::io("startup guide state poisoned"))?;
        match *current {
            Some(expected) if expected != target => Err(CommandError::conflict(
                "startup guide completion target does not match",
            )),
            Some(_) => {
                clear_startup_guide_marker(&self.paths)?;
                *current = None;
                Ok(())
            }
            None => Ok(()),
        }
    }
}

fn load_or_create_startup_guide_marker(
    paths: &StoragePaths,
) -> Result<Option<StartupGuideTarget>, CommandError> {
    // Marker selection must be serialized across processes. Atomic replacement
    // prevents torn bytes, but only the root lock makes every process retain
    // the same UUID pair.
    let _guard = crate::platform::IndexMutationLock::acquire(paths.root())?;
    let marker = paths.child(&[STARTUP_GUIDE_MARKER])?;
    match fs::symlink_metadata(&marker) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(CommandError::validation(
                    "startup guide marker must be a regular file",
                ));
            }
            let bytes = fs::read(&marker).map_err(|source| {
                CommandError::io(format!("could not read startup guide marker: {source}"))
            })?;
            if bytes.len() > 4096 {
                return Err(CommandError::validation(
                    "startup guide marker is too large",
                ));
            }
            let target = serde_json::from_slice(&bytes).map_err(|source| {
                CommandError::validation(format!("startup guide marker is invalid: {source}"))
            })?;
            Ok(Some(target))
        }
        Err(source)
            if source.kind() == ErrorKind::NotFound && storage_has_durable_content(paths)? =>
        {
            Ok(None)
        }
        Err(source) if source.kind() == ErrorKind::NotFound => {
            let target = StartupGuideTarget {
                folder_id: crate::domain::FolderId::now_v7(),
                note_id: crate::domain::NoteId::now_v7(),
            };
            let bytes = serde_json::to_vec_pretty(&target).map_err(|source| {
                CommandError::io(format!(
                    "could not serialize startup guide marker: {source}"
                ))
            })?;
            atomic_replace_contained(paths.root(), &[], STARTUP_GUIDE_MARKER, &bytes)
                .map_err(|failure| failure.into_error())?;
            Ok(Some(target))
        }
        Err(source) => Err(CommandError::io(format!(
            "could not inspect startup guide marker: {source}"
        ))),
    }
}

fn storage_has_durable_content(paths: &StoragePaths) -> Result<bool, CommandError> {
    match fs::symlink_metadata(paths.folders_manifest()) {
        Ok(_) => return Ok(true),
        Err(source) if source.kind() == ErrorKind::NotFound => {}
        Err(source) => {
            return Err(CommandError::io(format!(
                "could not inspect folder manifest: {source}"
            )))
        }
    }
    for directory in [paths.notes(), paths.temporary(), paths.trash()] {
        let mut entries = fs::read_dir(directory).map_err(|source| {
            CommandError::io(format!("could not inspect durable storage: {source}"))
        })?;
        if entries.next().is_some() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn clear_startup_guide_marker(paths: &StoragePaths) -> Result<(), CommandError> {
    let marker = paths.child(&[STARTUP_GUIDE_MARKER])?;
    match fs::symlink_metadata(&marker) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => Err(
            CommandError::validation("startup guide marker must be a regular file"),
        ),
        Ok(_) => fs::remove_file(marker).map_err(|source| {
            CommandError::io(format!("could not remove startup guide marker: {source}"))
        }),
        Err(source) if source.kind() == ErrorKind::NotFound => Ok(()),
        Err(source) => Err(CommandError::io(format!(
            "could not inspect startup guide marker: {source}"
        ))),
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
    storage: tauri::State<'_, StorageCommandState>,
    temporary: tauri::State<'_, crate::commands::temporary::TemporaryCommandState>,
) -> Result<StartupRecoveryReport, CommandError> {
    if window.label() != "main" {
        return Err(CommandError::validation(
            "startup recovery retry requires the main window",
        ));
    }
    recovery.retry_with(|| {
        temporary.finish_startup_recovery()?;
        crate::commands::notes::prepare_startup_repository_after_recovery(&storage)?;
        crate::commands::settings::finalize_reopened_relocation(temporary.paths())
    })
}
