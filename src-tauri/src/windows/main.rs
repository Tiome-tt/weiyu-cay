use crate::error::CommandError;
use serde::Serialize;
use std::sync::Mutex;
use tauri::Emitter;

pub const MAIN_WINDOW_LABEL: &str = "main";
pub const MAIN_WINDOW_CLOSE_REQUESTED_EVENT: &str = "main-window-close-requested";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseRequestDecision {
    RequestFlush { generation: u64 },
    WaitForRenderer { generation: u64 },
    AllowExit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseCompletion {
    Approved,
    Retry,
    Stale,
}

#[derive(Debug, Default)]
struct CloseState {
    next_generation: u64,
    pending_generation: Option<u64>,
    approved: bool,
    renderer_listener: Option<String>,
}

#[derive(Default)]
pub struct MainWindowCloseCoordinator(Mutex<CloseState>);

impl MainWindowCloseCoordinator {
    pub fn request_close(&self) -> CloseRequestDecision {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.approved {
            return CloseRequestDecision::AllowExit;
        }
        let generation = match state.pending_generation {
            Some(generation) => generation,
            None => {
                state.next_generation = state.next_generation.saturating_add(1);
                let generation = state.next_generation;
                state.pending_generation = Some(generation);
                generation
            }
        };
        if state.renderer_listener.is_some() {
            CloseRequestDecision::RequestFlush { generation }
        } else {
            CloseRequestDecision::WaitForRenderer { generation }
        }
    }

    pub fn renderer_ready(&self, listener_id: &str) -> Option<u64> {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.renderer_listener = Some(listener_id.to_owned());
        state.pending_generation
    }

    pub fn renderer_not_ready(&self, listener_id: &str) {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.renderer_listener.as_deref() == Some(listener_id) {
            state.renderer_listener = None;
        }
    }

    pub fn complete_close(&self, generation: u64, saved: bool) -> CloseCompletion {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.pending_generation != Some(generation) {
            return CloseCompletion::Stale;
        }
        state.pending_generation = None;
        if saved {
            state.approved = true;
            CloseCompletion::Approved
        } else {
            CloseCompletion::Retry
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct MainWindowCloseRequest {
    generation: u64,
}

fn emit_close_request(app: &tauri::AppHandle, generation: u64) -> Result<(), CommandError> {
    app.emit_to(
        MAIN_WINDOW_LABEL,
        MAIN_WINDOW_CLOSE_REQUESTED_EVENT,
        MainWindowCloseRequest { generation },
    )
    .map_err(|error| CommandError::io(format!("failed to emit main-window close request: {error}")))
}

#[doc(hidden)]
pub fn mark_close_listener_ready_with_emit<Emit>(
    coordinator: &MainWindowCloseCoordinator,
    listener_id: &str,
    emit: Emit,
) -> Result<(), CommandError>
where
    Emit: FnOnce(u64) -> Result<(), CommandError>,
{
    if let Some(generation) = coordinator.renderer_ready(listener_id) {
        emit(generation)?;
    }
    Ok(())
}

pub fn request_renderer_flush(
    app: &tauri::AppHandle,
    coordinator: &MainWindowCloseCoordinator,
) -> CloseRequestDecision {
    let decision = coordinator.request_close();
    if let CloseRequestDecision::RequestFlush { generation } = decision {
        let _ = emit_close_request(app, generation);
    }
    decision
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_main_window_close_listener_ready(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, MainWindowCloseCoordinator>,
    ready: bool,
    listener_id: String,
) -> Result<(), CommandError> {
    if window.label() != MAIN_WINDOW_LABEL {
        return Err(CommandError::validation(
            "main-window close listener readiness requires the main window",
        ));
    }
    if listener_id.trim().is_empty() || listener_id.len() > 128 {
        return Err(CommandError::validation(
            "main-window close listener id is invalid",
        ));
    }
    if ready {
        mark_close_listener_ready_with_emit(&state, &listener_id, |generation| {
            emit_close_request(&app, generation)
        })?;
    } else {
        state.renderer_not_ready(&listener_id);
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn complete_main_window_close(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, MainWindowCloseCoordinator>,
    generation: u64,
    saved: bool,
) -> Result<(), CommandError> {
    if window.label() != MAIN_WINDOW_LABEL {
        return Err(CommandError::validation(
            "main-window close acknowledgement requires the main window",
        ));
    }
    match state.complete_close(generation, saved) {
        CloseCompletion::Approved => app.exit(0),
        CloseCompletion::Retry => {}
        CloseCompletion::Stale => {
            return Err(CommandError::conflict(
                "main-window close acknowledgement generation is stale",
            ));
        }
    }
    Ok(())
}
