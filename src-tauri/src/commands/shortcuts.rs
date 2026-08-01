use crate::{
    commands::temporary::TemporaryCommandState,
    error::CommandError,
    shortcuts::{
        CaptureTrigger, ShortcutError, ShortcutEvent, ShortcutService, TauriCaptureBackend,
        TauriShortcutBackend, TriggerOutcome, DEFAULT_CAPTURE_SHORTCUT,
    },
};
use serde::Serialize;
use std::sync::{Mutex, MutexGuard};
use tauri::{Emitter, Manager, State};

pub struct CaptureShortcutState {
    service: ShortcutService<TauriShortcutBackend>,
    trigger: CaptureTrigger<TauriCaptureBackend>,
    startup_error: Mutex<Option<ShortcutError>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureShortcutStatus {
    current: Option<String>,
    startup_error: Option<ShortcutError>,
}

impl CaptureShortcutState {
    pub fn handle_plugin_event(
        &self,
        app: &tauri::AppHandle,
        event: tauri_plugin_global_shortcut::ShortcutState,
    ) {
        let event = match event {
            tauri_plugin_global_shortcut::ShortcutState::Pressed => ShortcutEvent::Pressed,
            tauri_plugin_global_shortcut::ShortcutState::Released => ShortcutEvent::Released,
        };
        let outcome = self.trigger.handle_event(event);
        if outcome != TriggerOutcome::Ignored {
            let _ = app.emit_to("main", "capture-shortcut-outcome", outcome);
        }
    }

    pub fn shutdown(&self) {
        let _ = self.service.shutdown();
    }

    fn status(&self) -> CaptureShortcutStatus {
        CaptureShortcutStatus {
            current: self.service.current(),
            startup_error: lock_recover(&self.startup_error).clone(),
        }
    }
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let temporary = app.state::<TemporaryCommandState>();
    let service = ShortcutService::new(TauriShortcutBackend::new(app.handle().clone()));
    let trigger = CaptureTrigger::with_gate(
        TauriCaptureBackend::new(temporary.paths().clone(), temporary.backend().clone()),
        service.delivery_gate(),
    );
    let startup_error = service.register(DEFAULT_CAPTURE_SHORTCUT).err();
    app.manage(CaptureShortcutState {
        service,
        trigger,
        startup_error: Mutex::new(startup_error),
    });
    Ok(())
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
    state.service.rebind(&accelerator)?;
    *lock_recover(&state.startup_error) = None;
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
