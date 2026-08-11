use crate::error::CommandError;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{Manager, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

pub struct UpdateCommandState(Mutex<Option<Update>>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    version: String,
    notes: Option<String>,
}

pub fn setup(app: &mut tauri::App) {
    app.manage(UpdateCommandState(Mutex::new(None)));
}

pub fn authorize_main_window_label(label: &str) -> Result<(), CommandError> {
    if label == "main" {
        Ok(())
    } else {
        Err(CommandError::validation(
            "updates are available only from the main application window",
        ))
    }
}

fn authorize_main(window: &WebviewWindow) -> Result<(), CommandError> {
    authorize_main_window_label(window.label())
}

fn updater_error(action: &str, error: impl std::fmt::Display) -> CommandError {
    CommandError::io(format!("could not {action}: {error}"))
}

#[tauri::command]
pub async fn check_for_update(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, UpdateCommandState>,
) -> Result<Option<AvailableUpdate>, CommandError> {
    authorize_main(&window)?;
    let update = app
        .updater()
        .map_err(|error| updater_error("configure updater", error))?
        .check()
        .await
        .map_err(|error| updater_error("check for an update", error))?;
    let metadata = update.as_ref().map(|update| AvailableUpdate {
        version: update.version.clone(),
        notes: update.body.clone(),
    });
    *state
        .0
        .lock()
        .map_err(|_| CommandError::io("pending updater state is unavailable"))? = update;
    Ok(metadata)
}

#[tauri::command]
pub async fn install_pending_update(
    window: WebviewWindow,
    state: tauri::State<'_, UpdateCommandState>,
) -> Result<(), CommandError> {
    authorize_main(&window)?;
    let update = state
        .0
        .lock()
        .map_err(|_| CommandError::io("pending updater state is unavailable"))?
        .take()
        .ok_or_else(|| CommandError::conflict("no checked update is pending"))?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| updater_error("download, verify, and install the update", error))
}

#[tauri::command]
pub fn restart_after_update(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), CommandError> {
    authorize_main(&window)?;
    app.restart()
}
