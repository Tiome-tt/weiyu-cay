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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListenerRegistrationDecision {
    Accepted { pending_generation: Option<u64> },
    Stale,
}

#[derive(Debug, Clone, Copy)]
struct RendererRegistration {
    token: u64,
    ready: bool,
}

#[derive(Debug, Default)]
struct CloseState {
    next_generation: u64,
    pending_generation: Option<u64>,
    approved: bool,
    next_registration_token: u64,
    renderer_registration: Option<RendererRegistration>,
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
        if state
            .renderer_registration
            .is_some_and(|registration| registration.ready)
        {
            CloseRequestDecision::RequestFlush { generation }
        } else {
            CloseRequestDecision::WaitForRenderer { generation }
        }
    }

    pub fn begin_renderer_registration(&self) -> Result<u64, CommandError> {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.next_registration_token = state
            .next_registration_token
            .checked_add(1)
            .ok_or_else(|| CommandError::conflict("main-window close registration exhausted"))?;
        let token = state.next_registration_token;
        state.renderer_registration = Some(RendererRegistration {
            token,
            ready: false,
        });
        Ok(token)
    }

    pub fn renderer_ready(&self, token: u64) -> ListenerRegistrationDecision {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(registration) = state.renderer_registration.as_mut() else {
            return ListenerRegistrationDecision::Stale;
        };
        if registration.token != token {
            return ListenerRegistrationDecision::Stale;
        }
        registration.ready = true;
        ListenerRegistrationDecision::Accepted {
            pending_generation: state.pending_generation,
        }
    }

    pub fn renderer_not_ready(&self, token: u64) {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state
            .renderer_registration
            .is_some_and(|registration| registration.token == token)
        {
            state.renderer_registration = None;
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
    registration_token: u64,
    emit: Emit,
) -> Result<(), CommandError>
where
    Emit: FnOnce(u64) -> Result<(), CommandError>,
{
    match coordinator.renderer_ready(registration_token) {
        ListenerRegistrationDecision::Accepted {
            pending_generation: Some(generation),
        } => emit(generation)?,
        ListenerRegistrationDecision::Accepted {
            pending_generation: None,
        } => {}
        ListenerRegistrationDecision::Stale => {
            return Err(CommandError::conflict(
                "main-window close listener registration is stale",
            ));
        }
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
pub fn begin_main_window_close_listener_registration(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, MainWindowCloseCoordinator>,
) -> Result<u64, CommandError> {
    if window.label() != MAIN_WINDOW_LABEL {
        return Err(CommandError::validation(
            "main-window close listener registration requires the main window",
        ));
    }
    state.begin_renderer_registration()
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_main_window_close_listener_ready(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, MainWindowCloseCoordinator>,
    ready: bool,
    registration_token: u64,
) -> Result<(), CommandError> {
    if window.label() != MAIN_WINDOW_LABEL {
        return Err(CommandError::validation(
            "main-window close listener readiness requires the main window",
        ));
    }
    if ready {
        mark_close_listener_ready_with_emit(&state, registration_token, |generation| {
            emit_close_request(&app, generation)
        })?;
    } else {
        state.renderer_not_ready(registration_token);
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
