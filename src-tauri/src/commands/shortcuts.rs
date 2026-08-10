use crate::{
    commands::temporary::TemporaryCommandState,
    error::CommandError,
    shortcuts::{
        CaptureEventRouter, CaptureTrigger, RecoveryGatedCaptureBackend, ShortcutError,
        ShortcutEvent, ShortcutIdentity, ShortcutRegistrationStatus, ShortcutService,
        TauriCaptureBackend, TauriShortcutBackend, TriggerOutcome, DEFAULT_CAPTURE_SHORTCUT,
    },
};
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc, Mutex, MutexGuard,
    },
    thread,
    time::Duration,
};
use tauri::{Emitter, Manager, State};

pub struct CaptureShortcutState {
    service: ShortcutService<TauriShortcutBackend>,
    dispatcher: PluginEventDispatcher,
    worker_stop: Arc<AtomicBool>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
    startup_error: Mutex<Option<ShortcutError>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureShortcutStatus {
    current: Option<String>,
    registration: ShortcutRegistrationStatus,
    accepting_triggers: bool,
    startup_error: Option<ShortcutError>,
}

impl CaptureShortcutState {
    pub(crate) fn rebind(&self, accelerator: &str) -> Result<(), ShortcutError> {
        let result = self.service.rebind(accelerator).map(|_| ());
        clear_startup_error_after_success(&self.startup_error, &result);
        result
    }

    pub(crate) fn current(&self) -> Option<String> {
        self.service.current()
    }

    pub fn shutdown(&self) {
        let _ = self.service.shutdown();
        self.worker_stop.store(true, Ordering::Release);
        self.dispatcher.detach();
        if let Some(worker) = lock_recover(&self.worker).take() {
            // Joining away from Tauri's event-loop thread avoids blocking native window teardown.
            let _ = thread::Builder::new()
                .name("capture-shortcut-worker-reaper".to_owned())
                .spawn(move || {
                    let _ = worker.join();
                });
        }
    }

    fn status(&self) -> CaptureShortcutStatus {
        let service = self.service.status();
        CaptureShortcutStatus {
            current: self.service.current(),
            registration: service.registration,
            accepting_triggers: service.accepting_triggers,
            startup_error: lock_recover(&self.startup_error).clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct PluginShortcutEvent {
    pub shortcut_identity: ShortcutIdentity,
    pub event: ShortcutEvent,
}

#[derive(Clone, Default)]
pub struct PluginEventDispatcher {
    sender: Arc<Mutex<Option<Sender<PluginShortcutEvent>>>>,
}

impl PluginEventDispatcher {
    pub fn dispatch(&self, event: PluginShortcutEvent) -> bool {
        let Ok(sender) = self.sender.try_lock() else {
            return false;
        };
        let Some(sender) = sender.as_ref() else {
            return false;
        };
        sender.send(event).is_ok()
    }

    pub fn attach(&self, sender: Sender<PluginShortcutEvent>) {
        *lock_recover(&self.sender) = Some(sender);
    }

    pub fn detach(&self) {
        *lock_recover(&self.sender) = None;
    }
}

pub fn setup(
    app: &mut tauri::App,
    dispatcher: PluginEventDispatcher,
) -> Result<(), Box<dyn std::error::Error>> {
    let temporary = app.state::<TemporaryCommandState>();
    let service = ShortcutService::new(TauriShortcutBackend::new(app.handle().clone()));
    let trigger = CaptureTrigger::new(RecoveryGatedCaptureBackend::new(
        TauriCaptureBackend::new(temporary.paths().clone(), temporary.backend().clone()),
        temporary.readiness(),
    ));
    let router = CaptureEventRouter::new(service.clone(), trigger);
    let (sender, receiver) = mpsc::channel();
    dispatcher.attach(sender);
    let worker_stop = Arc::new(AtomicBool::new(false));
    let worker = spawn_worker(app.handle().clone(), router, receiver, worker_stop.clone())?;
    let configured_shortcut = app
        .state::<crate::commands::settings::SettingsCommandState>()
        .stored_settings()
        .map(|settings| settings.shortcut)
        .unwrap_or_else(|_| DEFAULT_CAPTURE_SHORTCUT.to_owned());
    let startup_error = service.register(&configured_shortcut).err();
    app.manage(CaptureShortcutState {
        service,
        dispatcher,
        worker_stop,
        worker: Mutex::new(Some(worker)),
        startup_error: Mutex::new(startup_error),
    });
    Ok(())
}

fn spawn_worker(
    app: tauri::AppHandle,
    router: CaptureEventRouter<
        TauriShortcutBackend,
        RecoveryGatedCaptureBackend<TauriCaptureBackend>,
    >,
    receiver: Receiver<PluginShortcutEvent>,
    stop: Arc<AtomicBool>,
) -> Result<thread::JoinHandle<()>, std::io::Error> {
    thread::Builder::new()
        .name("capture-shortcut-worker".to_owned())
        .spawn(move || loop {
            if stop.load(Ordering::Acquire) {
                break;
            }
            let event = match receiver.recv_timeout(Duration::from_millis(25)) {
                Ok(event) => event,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            if stop.load(Ordering::Acquire) {
                break;
            }
            let outcome = router.dispatch(event.shortcut_identity, event.event);
            if outcome != TriggerOutcome::Ignored {
                let _ = app.emit_to("main", "capture-shortcut-outcome", outcome);
            }
            while let Ok(event) = receiver.try_recv() {
                if stop.load(Ordering::Acquire) {
                    break;
                }
                let outcome = router.dispatch(event.shortcut_identity, event.event);
                if outcome != TriggerOutcome::Ignored {
                    let _ = app.emit_to("main", "capture-shortcut-outcome", outcome);
                }
            }
        })
}

#[tauri::command]
pub fn get_capture_shortcut(
    window: tauri::WebviewWindow,
    state: State<'_, CaptureShortcutState>,
) -> Result<CaptureShortcutStatus, CommandError> {
    authorize_main(window.label())?;
    Ok(state.status())
}

#[tauri::command]
pub fn rebind_capture_shortcut(
    window: tauri::WebviewWindow,
    state: State<'_, CaptureShortcutState>,
    accelerator: String,
) -> Result<CaptureShortcutStatus, ShortcutError> {
    authorize_main(window.label())
        .map_err(|_| ShortcutError::validation("shortcut management requires the main window"))?;
    state.rebind(&accelerator)?;
    Ok(state.status())
}

fn authorize_main(label: &str) -> Result<(), CommandError> {
    if label == "main" {
        Ok(())
    } else {
        Err(CommandError::validation(
            "shortcut management requires the main window",
        ))
    }
}

fn lock_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn clear_startup_error_after_success<T>(
    startup_error: &Mutex<Option<ShortcutError>>,
    result: &Result<T, ShortcutError>,
) {
    if result.is_ok() {
        *lock_recover(startup_error) = None;
    }
}

#[cfg(test)]
mod tests {
    use super::clear_startup_error_after_success;
    use crate::shortcuts::ShortcutError;
    use std::sync::Mutex;

    #[test]
    fn successful_rebind_clears_a_previous_startup_error() {
        let error = Mutex::new(Some(ShortcutError::backend("startup conflict")));
        clear_startup_error_after_success(&error, &Ok::<(), ShortcutError>(()));
        assert!(error.lock().unwrap().is_none());
    }

    #[test]
    fn failed_rebind_retains_the_previous_startup_error() {
        let startup = ShortcutError::backend("startup conflict");
        let error = Mutex::new(Some(startup.clone()));
        let result = Err::<(), _>(ShortcutError::backend("new conflict"));
        clear_startup_error_after_success(&error, &result);
        assert_eq!(error.lock().unwrap().as_ref(), Some(&startup));
    }
}
