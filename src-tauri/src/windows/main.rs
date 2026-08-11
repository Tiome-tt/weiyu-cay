use crate::error::CommandError;
use std::sync::Mutex;
use tauri::Emitter;

pub const MAIN_WINDOW_LABEL: &str = "main";
pub const MAIN_WINDOW_CLOSE_REQUESTED_EVENT: &str = "main-window-close-requested";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseRequestDecision {
    RequestFlush,
    WaitForFlush,
    AllowExit,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum CloseState {
    #[default]
    Idle,
    WaitingForFlush,
    Approved,
}

#[derive(Default)]
pub struct MainWindowCloseCoordinator(Mutex<CloseState>);

impl MainWindowCloseCoordinator {
    pub fn request_close(&self) -> CloseRequestDecision {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match *state {
            CloseState::Idle => {
                *state = CloseState::WaitingForFlush;
                CloseRequestDecision::RequestFlush
            }
            CloseState::WaitingForFlush => CloseRequestDecision::WaitForFlush,
            CloseState::Approved => CloseRequestDecision::AllowExit,
        }
    }

    /// Returns true only when a pending renderer request becomes approved.
    pub fn complete_close(&self, saved: bool) -> bool {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *state != CloseState::WaitingForFlush {
            return false;
        }
        *state = if saved {
            CloseState::Approved
        } else {
            CloseState::Idle
        };
        saved
    }

    pub fn cancel_request(&self) {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *state == CloseState::WaitingForFlush {
            *state = CloseState::Idle;
        }
    }
}

pub fn request_renderer_flush(
    app: &tauri::AppHandle,
    coordinator: &MainWindowCloseCoordinator,
) -> CloseRequestDecision {
    let decision = coordinator.request_close();
    if decision == CloseRequestDecision::RequestFlush
        && app
            .emit_to(MAIN_WINDOW_LABEL, MAIN_WINDOW_CLOSE_REQUESTED_EVENT, ())
            .is_err()
    {
        coordinator.cancel_request();
    }
    decision
}

#[tauri::command(rename_all = "camelCase")]
pub fn complete_main_window_close(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, MainWindowCloseCoordinator>,
    saved: bool,
) -> Result<(), CommandError> {
    if window.label() != MAIN_WINDOW_LABEL {
        return Err(CommandError::validation(
            "main-window close acknowledgement requires the main window",
        ));
    }
    if saved {
        if !state.complete_close(true) {
            return Err(CommandError::conflict(
                "no main-window close request is awaiting acknowledgement",
            ));
        }
        app.exit(0);
    } else {
        state.complete_close(false);
    }
    Ok(())
}
