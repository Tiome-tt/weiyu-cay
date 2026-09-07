use super::{
    lifecycle::{Effect, Intent, Phase},
    lifecycle_registry::LifecycleRegistry,
    sticky::{
        clamp_to_available_monitors, parse_temporary_window_label, MonitorGeometry,
        PhysicalWindowBounds,
    },
};
use crate::error::CommandError;
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};

pub const MAIN_WINDOW_LABEL: &str = "main";
pub const PREPARE_EVENT: &str = "app-lifecycle-prepare";
pub const RELEASE_EVENT: &str = "app-lifecycle-release";
pub const FAILURE_EVENT: &str = "app-lifecycle-failed";
pub const PREPARED_EVENT: &str = "app-lifecycle-prepared";
pub const CLOSE_CHOICE_EVENT: &str = "main-close-choice-requested";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MainCloseAction {
    Prompt,
    Lifecycle(Intent),
}

pub fn main_close_action(
    is_macos: bool,
    confirmed: bool,
    close_to_tray: bool,
    tray_available: bool,
) -> MainCloseAction {
    if is_macos {
        return MainCloseAction::Lifecycle(Intent::Hide);
    }
    if !confirmed || (close_to_tray && !tray_available) {
        MainCloseAction::Prompt
    } else if close_to_tray {
        MainCloseAction::Lifecycle(Intent::Hide)
    } else {
        MainCloseAction::Lifecycle(Intent::Exit)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseRequestDecision {
    RequestFlush { generation: u64 },
    WaitForRenderer { generation: u64 },
    AllowExit,
}

pub struct MainWindowCloseCoordinator {
    registry: Mutex<LifecycleRegistry>,
    started: Instant,
    armed_generation: AtomicU64,
    active_mutations: Arc<AtomicUsize>,
}

impl Default for MainWindowCloseCoordinator {
    fn default() -> Self {
        Self {
            registry: Mutex::new(LifecycleRegistry::default()),
            started: Instant::now(),
            armed_generation: AtomicU64::new(0),
            active_mutations: Arc::new(AtomicUsize::new(0)),
        }
    }
}

impl MainWindowCloseCoordinator {
    fn now_ms(&self) -> u64 {
        self.started
            .elapsed()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX)
    }

    fn with_registry<T>(
        &self,
        action: impl FnOnce(&mut LifecycleRegistry, u64) -> Result<T, CommandError>,
    ) -> Result<T, CommandError> {
        let now = self.now_ms();
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| CommandError::io("application lifecycle state is unavailable"))?;
        action(&mut registry, now)
    }

    pub fn phase(&self) -> Phase {
        self.registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .phase()
    }

    fn operation(&self) -> Option<(u64, Intent, u64)> {
        self.registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .operation()
    }

    fn register(&self, label: &str) -> Result<(u64, Vec<Effect>), CommandError> {
        self.with_registry(|registry, _| registry.register(label))
    }

    fn set_ready(&self, label: &str, token: u64, ready: bool) -> Result<Vec<Effect>, CommandError> {
        self.with_registry(|registry, _| registry.set_ready(label, token, ready))
    }

    fn request(&self, intent: Intent, labels: Vec<String>) -> Result<Vec<Effect>, CommandError> {
        self.with_registry(|registry, now| {
            if intent != Intent::Hide && self.active_mutations.load(Ordering::SeqCst) != 0 {
                return Err(CommandError::conflict(
                    "application lifecycle is waiting for content creation to finish",
                ));
            }
            registry.request(intent, labels, now)
        })
    }

    fn acknowledge(
        &self,
        generation: u64,
        label: &str,
        token: u64,
        saved: bool,
        labels: Vec<String>,
    ) -> Result<Vec<Effect>, CommandError> {
        self.with_registry(|registry, now| {
            registry.acknowledge(generation, label, token, saved, labels, now)
        })
    }

    fn expire(&self) -> Vec<Effect> {
        let now = self.now_ms();
        self.registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .expire(now)
    }

    fn activate(&self) -> Vec<Effect> {
        self.registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .activate()
    }

    fn invalidate(&self) -> Vec<Effect> {
        self.registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .invalidate()
    }

    fn confirm_hide(&self, generation: u64, succeeded: bool) -> Vec<Effect> {
        self.registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .confirm_hide(generation, succeeded)
    }

    pub fn is_prepared_relocation(&self) -> bool {
        self.registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_prepared_relocation()
    }

    fn cancel(&self, generation: u64) -> Vec<Effect> {
        self.registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .cancel(generation)
    }

    fn commit_prepared_relocation(&self) -> Vec<Effect> {
        self.registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .commit_prepared_relocation()
    }

    fn acquire_mutation(&self) -> Result<LifecycleMutationPermit, CommandError> {
        let registry = self
            .registry
            .lock()
            .map_err(|_| CommandError::io("application lifecycle state is unavailable"))?;
        if !lifecycle_mutations_allowed(registry.phase()) {
            return Err(CommandError::conflict(
                "application exit preparation blocks new content",
            ));
        }
        self.active_mutations.fetch_add(1, Ordering::SeqCst);
        drop(registry);
        Ok(LifecycleMutationPermit {
            active_mutations: self.active_mutations.clone(),
        })
    }
}

pub struct LifecycleMutationPermit {
    active_mutations: Arc<AtomicUsize>,
}

impl Drop for LifecycleMutationPermit {
    fn drop(&mut self) {
        let previous = self.active_mutations.fetch_sub(1, Ordering::SeqCst);
        debug_assert!(previous > 0, "lifecycle mutation permit underflow");
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrepareRequest {
    generation: u64,
    intent: Intent,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseRequest {
    generation: u64,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedNotice {
    generation: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FailureNotice {
    participant: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloseChoiceRequest {
    tray_available: bool,
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseChoice {
    Hide,
    Exit,
}

pub fn authorize_lifecycle_window_label(label: &str) -> Result<(), CommandError> {
    if label == MAIN_WINDOW_LABEL {
        return Ok(());
    }
    parse_temporary_window_label(label).map(|_| ())
}

pub fn lifecycle_mutations_allowed(phase: Phase) -> bool {
    !matches!(phase, Phase::PreparingExit | Phase::Exiting)
}

pub fn acquire_lifecycle_mutation_permit(
    app: &tauri::AppHandle,
) -> Result<LifecycleMutationPermit, CommandError> {
    let Some(state) = app.try_state::<MainWindowCloseCoordinator>() else {
        return Err(CommandError::conflict(
            "application lifecycle is not ready for new content",
        ));
    };
    state.acquire_mutation()
}

fn live_editor_labels(app: &tauri::AppHandle) -> Vec<String> {
    let mut labels: Vec<_> = app
        .webview_windows()
        .into_keys()
        .filter(|label| authorize_lifecycle_window_label(label).is_ok())
        .collect();
    labels.sort();
    labels.dedup();
    labels
}

fn restore_main(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    if let (Ok(position), Ok(size), Ok(monitors)) = (
        window.outer_position(),
        window.outer_size(),
        window.available_monitors(),
    ) {
        let bounds = PhysicalWindowBounds {
            x: f64::from(position.x),
            y: f64::from(position.y),
            width: f64::from(size.width),
            height: f64::from(size.height),
        };
        let monitor_bounds = monitors
            .into_iter()
            .map(|monitor| MonitorGeometry {
                x: f64::from(monitor.position().x),
                y: f64::from(monitor.position().y),
                width: f64::from(monitor.size().width),
                height: f64::from(monitor.size().height),
                scale_factor: monitor.scale_factor(),
            })
            .collect::<Vec<_>>();
        let restored = clamp_to_available_monitors(bounds, &monitor_bounds);
        if restored != bounds {
            let _ =
                window.set_position(PhysicalPosition::new(restored.x as i32, restored.y as i32));
            let _ = window.set_size(PhysicalSize::new(
                restored.width as u32,
                restored.height as u32,
            ));
        }
    }
    let _ = window.show();
    let _ = window.set_focus();
}

fn mark_process_shutdown(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<crate::commands::shortcuts::CaptureShortcutState>() {
        state.shutdown();
    }
    if let Some(state) = app.try_state::<crate::commands::temporary::TemporaryCommandState>() {
        state.mark_lifecycle(super::sticky::AppLifecycleEvent::ExitRequested);
    }
}

fn execute_effects(
    app: &tauri::AppHandle,
    coordinator: &MainWindowCloseCoordinator,
    effects: Vec<Effect>,
) {
    let mut flush_delivery_failed = false;
    for effect in effects {
        match effect {
            Effect::Flush {
                generation,
                intent,
                participant,
            } => {
                if app
                    .emit_to(
                        participant.label,
                        PREPARE_EVENT,
                        PrepareRequest { generation, intent },
                    )
                    .is_err()
                {
                    flush_delivery_failed = true;
                }
            }
            Effect::Release {
                generation,
                participant,
            } => {
                let _ = app.emit_to(
                    participant.label,
                    RELEASE_EVENT,
                    ReleaseRequest { generation },
                );
            }
            Effect::HideMain { generation } => {
                let succeeded = app
                    .get_webview_window(MAIN_WINDOW_LABEL)
                    .is_some_and(|window| window.hide().is_ok());
                let completion = coordinator.confirm_hide(generation, succeeded);
                execute_effects(app, coordinator, completion);
            }
            Effect::ShowMain => restore_main(app),
            Effect::Exit => {
                mark_process_shutdown(app);
                app.exit(0);
            }
            Effect::Restart => {
                mark_process_shutdown(app);
                app.restart();
            }
            Effect::Prepared { generation } => {
                if app
                    .emit_to(
                        MAIN_WINDOW_LABEL,
                        PREPARED_EVENT,
                        PreparedNotice { generation },
                    )
                    .is_err()
                {
                    flush_delivery_failed = true;
                }
            }
            Effect::ReportFailure { label } => {
                restore_main(app);
                let _ = app.emit_to(
                    MAIN_WINDOW_LABEL,
                    FAILURE_EVENT,
                    FailureNotice { participant: label },
                );
            }
        }
    }
    if flush_delivery_failed {
        let cancellation = coordinator.invalidate();
        if !cancellation.is_empty() {
            execute_effects(app, coordinator, cancellation);
        }
    }
}

fn arm_expiry(app: &tauri::AppHandle, coordinator: &MainWindowCloseCoordinator) {
    let Some((generation, _, deadline)) = coordinator.operation() else {
        return;
    };
    if coordinator
        .armed_generation
        .swap(generation, Ordering::SeqCst)
        == generation
    {
        return;
    }
    let delay = deadline.saturating_sub(coordinator.now_ms());
    let timer_app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(delay));
        let dispatch_app = timer_app.clone();
        let _ = timer_app.run_on_main_thread(move || {
            let coordinator = dispatch_app.state::<MainWindowCloseCoordinator>();
            if coordinator
                .armed_generation
                .compare_exchange(generation, 0, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                let effects = coordinator.expire();
                execute_effects(&dispatch_app, &coordinator, effects);
            }
        });
    });
}

pub fn request_renderer_flush(
    app: &tauri::AppHandle,
    coordinator: &MainWindowCloseCoordinator,
) -> CloseRequestDecision {
    request_lifecycle(app, coordinator, Intent::Exit)
}

pub fn request_main_window_close(
    app: &tauri::AppHandle,
    coordinator: &MainWindowCloseCoordinator,
) -> CloseRequestDecision {
    let settings = app
        .state::<crate::commands::settings::SettingsCommandState>()
        .stored_settings();
    let tray_available = app.state::<super::tray::TrayState>().is_available();
    let action = settings
        .map(|settings| {
            main_close_action(
                cfg!(target_os = "macos"),
                settings.close_behavior_confirmed,
                settings.close_to_tray,
                tray_available,
            )
        })
        .unwrap_or(MainCloseAction::Prompt);
    match action {
        MainCloseAction::Prompt => {
            restore_main(app);
            let _ = app.emit_to(
                MAIN_WINDOW_LABEL,
                CLOSE_CHOICE_EVENT,
                CloseChoiceRequest { tray_available },
            );
            CloseRequestDecision::WaitForRenderer { generation: 0 }
        }
        MainCloseAction::Lifecycle(intent) => request_lifecycle(app, coordinator, intent),
    }
}

pub fn request_lifecycle(
    app: &tauri::AppHandle,
    coordinator: &MainWindowCloseCoordinator,
    intent: Intent,
) -> CloseRequestDecision {
    if coordinator.phase() == Phase::Exiting {
        return CloseRequestDecision::AllowExit;
    }
    let effects = match coordinator.request(intent, live_editor_labels(app)) {
        Ok(effects) => effects,
        Err(_) => {
            restore_main(app);
            return CloseRequestDecision::WaitForRenderer { generation: 0 };
        }
    };
    let requested = effects
        .iter()
        .any(|effect| matches!(effect, Effect::Flush { .. }));
    let generation = coordinator
        .operation()
        .map(|(generation, _, _)| generation)
        .unwrap_or(0);
    arm_expiry(app, coordinator);
    execute_effects(app, coordinator, effects);
    if requested {
        CloseRequestDecision::RequestFlush { generation }
    } else {
        CloseRequestDecision::WaitForRenderer { generation }
    }
}

pub fn request_restart(
    app: &tauri::AppHandle,
    coordinator: &MainWindowCloseCoordinator,
) -> Result<(), CommandError> {
    match request_lifecycle(app, coordinator, Intent::Restart) {
        CloseRequestDecision::RequestFlush { generation }
        | CloseRequestDecision::WaitForRenderer { generation }
            if generation > 0 =>
        {
            Ok(())
        }
        CloseRequestDecision::AllowExit => Ok(()),
        _ => Err(CommandError::conflict(
            "application restart could not begin while content is changing",
        )),
    }
}

#[tauri::command]
pub fn request_storage_relocation(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, MainWindowCloseCoordinator>,
) -> Result<(), CommandError> {
    if window.label() != MAIN_WINDOW_LABEL {
        return Err(CommandError::validation(
            "storage relocation can only be requested by the main window",
        ));
    }
    match request_lifecycle(&app, &state, Intent::Relocate) {
        CloseRequestDecision::RequestFlush { generation }
        | CloseRequestDecision::WaitForRenderer { generation }
            if generation > 0 =>
        {
            Ok(())
        }
        CloseRequestDecision::AllowExit => Err(CommandError::conflict(
            "application lifecycle is already exiting",
        )),
        _ => Err(CommandError::conflict(
            "storage relocation could not begin while content is changing",
        )),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn cancel_storage_relocation(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, MainWindowCloseCoordinator>,
    generation: u64,
) -> Result<(), CommandError> {
    if window.label() != MAIN_WINDOW_LABEL {
        return Err(CommandError::validation(
            "storage relocation can only be cancelled by the main window",
        ));
    }
    execute_effects(&app, &state, state.cancel(generation));
    Ok(())
}

pub fn commit_storage_relocation_restart(
    app: &tauri::AppHandle,
    coordinator: &MainWindowCloseCoordinator,
) -> Result<(), CommandError> {
    if !coordinator.is_prepared_relocation() {
        return Err(CommandError::conflict(
            "all editor windows must be safely saved before relocation restart",
        ));
    }
    execute_effects(app, coordinator, coordinator.commit_prepared_relocation());
    Ok(())
}

pub fn activate_main(app: &tauri::AppHandle) {
    let coordinator = app.state::<MainWindowCloseCoordinator>();
    let effects = coordinator.activate();
    execute_effects(app, &coordinator, effects);
}

#[tauri::command(rename_all = "camelCase")]
pub fn begin_main_window_close_listener_registration(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, MainWindowCloseCoordinator>,
) -> Result<u64, CommandError> {
    authorize_lifecycle_window_label(window.label())?;
    let (token, effects) = state.register(window.label())?;
    execute_effects(&app, &state, effects);
    Ok(token)
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_main_window_close_listener_ready(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, MainWindowCloseCoordinator>,
    ready: bool,
    registration_token: u64,
) -> Result<(), CommandError> {
    authorize_lifecycle_window_label(window.label())?;
    let effects = state.set_ready(window.label(), registration_token, ready)?;
    arm_expiry(&app, &state);
    execute_effects(&app, &state, effects);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn complete_main_window_close(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, MainWindowCloseCoordinator>,
    generation: u64,
    registration_token: u64,
    saved: bool,
) -> Result<(), CommandError> {
    authorize_lifecycle_window_label(window.label())?;
    let effects = state.acknowledge(
        generation,
        window.label(),
        registration_token,
        saved,
        live_editor_labels(&app),
    )?;
    execute_effects(&app, &state, effects);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn resolve_main_window_close_choice(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, MainWindowCloseCoordinator>,
    choice: CloseChoice,
) -> Result<(), CommandError> {
    if window.label() != MAIN_WINDOW_LABEL {
        return Err(CommandError::validation(
            "main window close choice requires the main window",
        ));
    }
    let intent = match choice {
        CloseChoice::Hide => {
            if !app.state::<super::tray::TrayState>().is_available() {
                return Err(CommandError::conflict(
                    "system tray is unavailable; the main window cannot be hidden",
                ));
            }
            Intent::Hide
        }
        CloseChoice::Exit => Intent::Exit,
    };
    let _ = request_lifecycle(&app, &state, intent);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_creation_permit_atomically_blocks_a_terminal_snapshot() {
        let coordinator = MainWindowCloseCoordinator::default();
        let (token, _) = coordinator.register(MAIN_WINDOW_LABEL).unwrap();
        coordinator
            .set_ready(MAIN_WINDOW_LABEL, token, true)
            .unwrap();

        let permit = coordinator.acquire_mutation().unwrap();
        assert!(coordinator
            .request(Intent::Exit, vec![MAIN_WINDOW_LABEL.to_owned()])
            .is_err());
        assert_eq!(coordinator.phase(), Phase::Visible);

        drop(permit);
        assert!(coordinator
            .request(Intent::Exit, vec![MAIN_WINDOW_LABEL.to_owned()])
            .unwrap()
            .iter()
            .any(|effect| matches!(effect, Effect::Flush { .. })));
    }
}
