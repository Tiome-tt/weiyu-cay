use super::{CaptureBackend, ShortcutBackend, ShortcutError};
use crate::{
    domain::NoteId,
    error::CommandError,
    storage::paths::StoragePaths,
    windows::sticky::{TauriTemporaryWindowBackend, TemporaryRepository, TemporaryWindowService},
};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

#[derive(Clone)]
pub struct TauriShortcutBackend {
    app: tauri::AppHandle,
}

impl TauriShortcutBackend {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl ShortcutBackend for TauriShortcutBackend {
    fn register(&self, accelerator: &str) -> Result<(), ShortcutError> {
        self.app
            .global_shortcut()
            .register(accelerator)
            .map_err(|source| map_plugin_error(accelerator, source))
    }

    fn unregister(&self, accelerator: &str) -> Result<(), ShortcutError> {
        self.app
            .global_shortcut()
            .unregister(accelerator)
            .map_err(|source| {
                ShortcutError::backend(format!("could not unregister shortcut: {source}"))
            })
    }
}

fn map_plugin_error(
    accelerator: &str,
    source: tauri_plugin_global_shortcut::Error,
) -> ShortcutError {
    let diagnostic = source.to_string();
    let lower = diagnostic.to_ascii_lowercase();
    if lower.contains("already") || lower.contains("registered") || lower.contains("in use") {
        ShortcutError::conflict(accelerator, "This shortcut is already in use.")
    } else {
        ShortcutError::backend(format!("could not register shortcut: {diagnostic}"))
    }
}

#[derive(Clone)]
pub struct TauriCaptureBackend {
    paths: StoragePaths,
    windows: TauriTemporaryWindowBackend,
}

impl TauriCaptureBackend {
    pub fn new(paths: StoragePaths, windows: TauriTemporaryWindowBackend) -> Self {
        Self { paths, windows }
    }
}

impl CaptureBackend for TauriCaptureBackend {
    fn create(&self) -> Result<NoteId, CommandError> {
        TemporaryRepository::new(self.paths.clone())
            .create()
            .map(|document| document.id)
    }

    fn show(&self, note_id: NoteId) -> Result<(), CommandError> {
        TemporaryWindowService::new(self.paths.clone(), self.windows.clone())
            .show(note_id)
            .map(|_| ())
    }
}
