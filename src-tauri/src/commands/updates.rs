use crate::error::CommandError;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{Manager, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

pub struct UpdateCommandState(Mutex<RetryableUpdateState<Update>>);

enum PendingUpdatePhase<T> {
    Empty,
    Ready { generation: u64, update: T },
    Installing { generation: u64, update: T },
}

struct RetryableUpdateState<T> {
    next_generation: u64,
    phase: PendingUpdatePhase<T>,
}

struct InstallLease<T> {
    generation: u64,
    update: T,
}

impl<T> Default for RetryableUpdateState<T> {
    fn default() -> Self {
        Self {
            next_generation: 0,
            phase: PendingUpdatePhase::Empty,
        }
    }
}

impl<T: Clone> RetryableUpdateState<T> {
    fn replace(&mut self, update: Option<T>) {
        self.next_generation = self.next_generation.saturating_add(1);
        self.phase = match update {
            Some(update) => PendingUpdatePhase::Ready {
                generation: self.next_generation,
                update,
            },
            None => PendingUpdatePhase::Empty,
        };
    }

    fn begin_install(&mut self) -> Result<InstallLease<T>, CommandError> {
        let phase = std::mem::replace(&mut self.phase, PendingUpdatePhase::Empty);
        match phase {
            PendingUpdatePhase::Ready { generation, update } => {
                let lease = InstallLease {
                    generation,
                    update: update.clone(),
                };
                self.phase = PendingUpdatePhase::Installing { generation, update };
                Ok(lease)
            }
            PendingUpdatePhase::Installing { generation, update } => {
                self.phase = PendingUpdatePhase::Installing { generation, update };
                Err(CommandError::conflict(
                    "an update installation is already in progress",
                ))
            }
            PendingUpdatePhase::Empty => {
                Err(CommandError::conflict("no checked update is pending"))
            }
        }
    }

    fn complete_install(&mut self, generation: u64, succeeded: bool) -> bool {
        let phase = std::mem::replace(&mut self.phase, PendingUpdatePhase::Empty);
        match phase {
            PendingUpdatePhase::Installing {
                generation: current,
                update,
            } if current == generation => {
                if !succeeded {
                    self.phase = PendingUpdatePhase::Ready {
                        generation: current,
                        update,
                    };
                }
                true
            }
            current => {
                self.phase = current;
                false
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    version: String,
    notes: Option<String>,
}

pub fn setup(app: &mut tauri::App) {
    app.manage(UpdateCommandState(Mutex::new(
        RetryableUpdateState::default(),
    )));
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
    state
        .0
        .lock()
        .map_err(|_| CommandError::io("pending updater state is unavailable"))?
        .replace(update);
    Ok(metadata)
}

#[tauri::command]
pub async fn install_pending_update(
    window: WebviewWindow,
    state: tauri::State<'_, UpdateCommandState>,
) -> Result<(), CommandError> {
    authorize_main(&window)?;
    let lease = state
        .0
        .lock()
        .map_err(|_| CommandError::io("pending updater state is unavailable"))?
        .begin_install()?;
    let install = lease.update.download_and_install(|_, _| {}, || {}).await;
    let completion_applied = state
        .0
        .lock()
        .map_err(|_| CommandError::io("pending updater state is unavailable"))?
        .complete_install(lease.generation, install.is_ok());
    if !completion_applied {
        return Err(CommandError::conflict(
            "the checked update changed while installation was running",
        ));
    }
    install.map_err(|error| updater_error("download, verify, and install the update", error))
}

#[tauri::command]
pub fn restart_after_update(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), CommandError> {
    authorize_main(&window)?;
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::RetryableUpdateState;

    #[test]
    fn failed_install_remains_retryable_until_success() {
        let mut state = RetryableUpdateState::default();
        state.replace(Some("0.1.1"));

        let first = state
            .begin_install()
            .expect("checked update should install");
        assert_eq!(first.update, "0.1.1");
        assert!(
            state.begin_install().is_err(),
            "parallel installation must be rejected"
        );
        assert!(state.complete_install(first.generation, false));

        let retry = state
            .begin_install()
            .expect("failed update should remain retryable");
        assert_eq!(retry.update, "0.1.1");
        assert!(state.complete_install(retry.generation, true));
        assert!(
            state.begin_install().is_err(),
            "successful install consumes the pending update"
        );
    }

    #[test]
    fn stale_install_completion_does_not_replace_a_newer_checked_update() {
        let mut state = RetryableUpdateState::default();
        state.replace(Some("0.1.1"));
        let old_install = state.begin_install().expect("first update should install");
        state.replace(Some("0.2.0"));

        assert!(!state.complete_install(old_install.generation, false));
        let current = state
            .begin_install()
            .expect("newer checked update must be retained");
        assert_eq!(current.update, "0.2.0");
    }
}
