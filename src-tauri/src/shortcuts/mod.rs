mod adapter;
mod tauri_backend;

pub use adapter::{map_accelerator_for_platform, AcceleratorPlatform};
pub use tauri_backend::{TauriCaptureBackend, TauriShortcutBackend};

use crate::{domain::NoteId, error::CommandError, windows::sticky::temporary_window_label};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{Arc, Mutex, MutexGuard},
};

pub const DEFAULT_CAPTURE_SHORTCUT: &str = "CommandOrControl+Shift+Space";
const MAX_ACCELERATOR_LENGTH: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ShortcutError {
    Validation {
        reason: String,
    },
    Conflict {
        accelerator: String,
        reason: String,
    },
    Backend {
        reason: String,
        #[serde(skip)]
        diagnostic: Option<String>,
    },
    RecoveryRequired {
        bindings: Vec<String>,
        reason: String,
    },
}

impl ShortcutError {
    pub fn validation(reason: impl Into<String>) -> Self {
        Self::Validation {
            reason: reason.into(),
        }
    }

    pub fn conflict(accelerator: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::Conflict {
            accelerator: accelerator.into(),
            reason: reason.into(),
        }
    }

    pub fn backend(diagnostic: impl Into<String>) -> Self {
        Self::Backend {
            reason: "The shortcut operation could not be completed.".to_owned(),
            diagnostic: Some(diagnostic.into()),
        }
    }

    pub fn diagnostic(&self) -> Option<&str> {
        match self {
            Self::Backend { diagnostic, .. } => diagnostic.as_deref(),
            _ => None,
        }
    }

    fn with_accelerator(self, accelerator: &str) -> Self {
        match self {
            Self::Conflict { reason, .. } => Self::Conflict {
                accelerator: accelerator.to_owned(),
                reason,
            },
            other => other,
        }
    }
}

impl std::fmt::Display for ShortcutError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Validation { reason }
            | Self::Conflict { reason, .. }
            | Self::Backend { reason, .. }
            | Self::RecoveryRequired { reason, .. } => formatter.write_str(reason),
        }
    }
}

impl std::error::Error for ShortcutError {}

pub trait ShortcutBackend: Send + Sync {
    fn register(&self, accelerator: &str) -> Result<(), ShortcutError>;
    fn unregister(&self, accelerator: &str) -> Result<(), ShortcutError>;
}

#[derive(Clone)]
struct Binding {
    canonical: String,
    platform: String,
}

#[derive(Default)]
struct RegistrationState {
    active: Option<Binding>,
    shutdown_requested: bool,
}

pub struct ShortcutService<B> {
    backend: B,
    platform: AcceleratorPlatform,
    state: Arc<Mutex<RegistrationState>>,
    delivery_gate: Arc<Mutex<()>>,
}

impl<B: Clone> Clone for ShortcutService<B> {
    fn clone(&self) -> Self {
        Self {
            backend: self.backend.clone(),
            platform: self.platform,
            state: self.state.clone(),
            delivery_gate: self.delivery_gate.clone(),
        }
    }
}

impl<B: ShortcutBackend> ShortcutService<B> {
    pub fn new(backend: B) -> Self {
        Self::new_for_platform(backend, AcceleratorPlatform::current())
    }

    pub fn new_for_platform(backend: B, platform: AcceleratorPlatform) -> Self {
        Self {
            backend,
            platform,
            state: Arc::new(Mutex::new(RegistrationState::default())),
            delivery_gate: Arc::new(Mutex::new(())),
        }
    }

    pub fn register(&self, accelerator: &str) -> Result<String, ShortcutError> {
        let canonical = normalize_accelerator(accelerator)?;
        let mapped = map_accelerator_for_platform(&canonical, self.platform)?;
        let _delivery = lock_recover(&self.delivery_gate);
        let mut state = lock_recover(&self.state);
        if let Some(active) = &state.active {
            if active.canonical == canonical {
                return Ok(canonical);
            }
            return Err(ShortcutError::conflict(
                canonical,
                "A capture shortcut is already active.",
            ));
        }
        self.backend
            .register(&mapped)
            .map_err(|error| error.with_accelerator(&canonical))?;
        state.active = Some(Binding {
            canonical: canonical.clone(),
            platform: mapped,
        });
        state.shutdown_requested = false;
        Ok(canonical)
    }

    pub fn rebind(&self, accelerator: &str) -> Result<String, ShortcutError> {
        let canonical = normalize_accelerator(accelerator)?;
        let mapped = map_accelerator_for_platform(&canonical, self.platform)?;
        let _delivery = lock_recover(&self.delivery_gate);
        let mut state = lock_recover(&self.state);
        let Some(previous) = state.active.clone() else {
            self.backend
                .register(&mapped)
                .map_err(|error| error.with_accelerator(&canonical))?;
            state.active = Some(Binding {
                canonical: canonical.clone(),
                platform: mapped,
            });
            state.shutdown_requested = false;
            return Ok(canonical);
        };
        if previous.canonical == canonical {
            return Ok(canonical);
        }

        self.backend
            .register(&mapped)
            .map_err(|error| error.with_accelerator(&canonical))?;
        if let Err(old_error) = self.backend.unregister(&previous.platform) {
            if let Err(rollback_error) = self.backend.unregister(&mapped) {
                return Err(ShortcutError::RecoveryRequired {
                    bindings: vec![previous.canonical, canonical],
                    reason: format!(
                        "The old shortcut and the replacement may both be active; recovery is required. {} {}",
                        old_error, rollback_error
                    ),
                });
            }
            return Err(old_error.with_accelerator(&previous.canonical));
        }
        state.active = Some(Binding {
            canonical: canonical.clone(),
            platform: mapped,
        });
        state.shutdown_requested = false;
        Ok(canonical)
    }

    pub fn unregister(&self) -> Result<(), ShortcutError> {
        let _delivery = lock_recover(&self.delivery_gate);
        self.unregister_locked()
    }

    pub fn shutdown(&self) -> Result<(), ShortcutError> {
        let _delivery = lock_recover(&self.delivery_gate);
        {
            let mut state = lock_recover(&self.state);
            if state.shutdown_requested {
                return Ok(());
            }
            state.shutdown_requested = true;
        }
        self.unregister_locked()
    }

    pub fn current(&self) -> Option<String> {
        lock_recover(&self.state)
            .active
            .as_ref()
            .map(|binding| binding.canonical.clone())
    }

    pub fn delivery_gate(&self) -> Arc<Mutex<()>> {
        self.delivery_gate.clone()
    }

    fn unregister_locked(&self) -> Result<(), ShortcutError> {
        let mut state = lock_recover(&self.state);
        let Some(active) = state.active.clone() else {
            return Ok(());
        };
        self.backend
            .unregister(&active.platform)
            .map_err(|error| error.with_accelerator(&active.canonical))?;
        state.active = None;
        Ok(())
    }
}

pub fn normalize_accelerator(input: &str) -> Result<String, ShortcutError> {
    if input.is_empty() {
        return Err(ShortcutError::validation("shortcut is empty"));
    }
    if input.len() > MAX_ACCELERATOR_LENGTH {
        return Err(ShortcutError::validation("shortcut is too long"));
    }
    if input.chars().any(char::is_control) {
        return Err(ShortcutError::validation(
            "shortcut contains a control character",
        ));
    }
    let parts = input.split('+').collect::<Vec<_>>();
    if parts.len() < 2
        || parts
            .iter()
            .any(|part| part.is_empty() || part.trim() != *part)
    {
        return Err(ShortcutError::validation(
            "shortcut requires modifiers and one key",
        ));
    }

    let mut modifiers = HashSet::new();
    let mut key = None;
    for part in parts {
        let lowered = part.to_ascii_lowercase();
        let modifier = match lowered.as_str() {
            "commandorcontrol" | "cmdorctrl" => Some("CommandOrControl"),
            "control" | "ctrl" => Some("Control"),
            "command" | "cmd" => Some("Command"),
            "alt" | "option" => Some("Alt"),
            "shift" => Some("Shift"),
            "super" | "meta" => Some("Super"),
            _ => None,
        };
        if let Some(modifier) = modifier {
            if key.is_some() || !modifiers.insert(modifier) {
                return Err(ShortcutError::validation(
                    "shortcut has duplicate or misplaced modifiers",
                ));
            }
            continue;
        }
        if key.is_some() {
            return Err(ShortcutError::validation(
                "shortcut must contain exactly one key",
            ));
        }
        key = Some(canonical_key(part)?);
    }
    if modifiers.is_empty() || key.is_none() {
        return Err(ShortcutError::validation(
            "shortcut requires modifiers and one key",
        ));
    }
    if modifiers.contains("CommandOrControl")
        && (modifiers.contains("Command") || modifiers.contains("Control"))
    {
        return Err(ShortcutError::validation(
            "shortcut has conflicting command modifiers",
        ));
    }
    let ordered = [
        "CommandOrControl",
        "Command",
        "Control",
        "Alt",
        "Shift",
        "Super",
    ];
    let mut canonical = ordered
        .into_iter()
        .filter(|modifier| modifiers.contains(modifier))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    canonical.push(key.expect("validated shortcut key"));
    Ok(canonical.join("+"))
}

fn canonical_key(input: &str) -> Result<String, ShortcutError> {
    if input.len() == 1
        && input
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Ok(input.to_ascii_uppercase());
    }
    let lowered = input.to_ascii_lowercase();
    let named = match lowered.as_str() {
        "space" => Some("Space"),
        "enter" | "return" => Some("Enter"),
        "tab" => Some("Tab"),
        "backspace" => Some("Backspace"),
        "delete" => Some("Delete"),
        "escape" | "esc" => Some("Escape"),
        "arrowup" | "up" => Some("ArrowUp"),
        "arrowdown" | "down" => Some("ArrowDown"),
        "arrowleft" | "left" => Some("ArrowLeft"),
        "arrowright" | "right" => Some("ArrowRight"),
        "home" => Some("Home"),
        "end" => Some("End"),
        "pageup" => Some("PageUp"),
        "pagedown" => Some("PageDown"),
        "insert" => Some("Insert"),
        _ => None,
    };
    if let Some(named) = named {
        return Ok(named.to_owned());
    }
    if let Some(number) = lowered
        .strip_prefix('f')
        .and_then(|value| value.parse::<u8>().ok())
    {
        if (1..=24).contains(&number) {
            return Ok(format!("F{number}"));
        }
    }
    Err(ShortcutError::validation("shortcut key is unsupported"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortcutEvent {
    Pressed,
    Released,
}

pub trait CaptureBackend: Clone + Send + Sync + 'static {
    fn create(&self) -> Result<NoteId, CommandError>;
    fn show(&self, note_id: NoteId) -> Result<(), CommandError>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum TriggerOutcome {
    Ignored,
    Shown {
        capture_id: NoteId,
        window_label: String,
    },
    CreateFailed {
        error: CommandError,
    },
    ShowFailed {
        capture_id: NoteId,
        window_label: String,
        error: CommandError,
    },
}

impl TriggerOutcome {
    pub fn capture_id(&self) -> Option<NoteId> {
        match self {
            Self::Shown { capture_id, .. } | Self::ShowFailed { capture_id, .. } => {
                Some(*capture_id)
            }
            Self::Ignored | Self::CreateFailed { .. } => None,
        }
    }
}

pub struct CaptureTrigger<C> {
    backend: C,
    pressed: Arc<Mutex<bool>>,
    delivery_gate: Arc<Mutex<()>>,
}

impl<C: Clone> Clone for CaptureTrigger<C> {
    fn clone(&self) -> Self {
        Self {
            backend: self.backend.clone(),
            pressed: self.pressed.clone(),
            delivery_gate: self.delivery_gate.clone(),
        }
    }
}

impl<C: CaptureBackend> CaptureTrigger<C> {
    pub fn new(backend: C) -> Self {
        Self::with_gate(backend, Arc::new(Mutex::new(())))
    }

    pub fn with_gate(backend: C, delivery_gate: Arc<Mutex<()>>) -> Self {
        Self {
            backend,
            pressed: Arc::new(Mutex::new(false)),
            delivery_gate,
        }
    }

    pub fn handle_event(&self, event: ShortcutEvent) -> TriggerOutcome {
        {
            let _delivery = lock_recover(&self.delivery_gate);
            let mut pressed = lock_recover(&self.pressed);
            match event {
                ShortcutEvent::Released => {
                    *pressed = false;
                    return TriggerOutcome::Ignored;
                }
                ShortcutEvent::Pressed if *pressed => return TriggerOutcome::Ignored,
                ShortcutEvent::Pressed => *pressed = true,
            }
        }
        self.activate()
    }

    pub fn activate(&self) -> TriggerOutcome {
        let created = catch_unwind(AssertUnwindSafe(|| self.backend.create()));
        let capture_id = match created {
            Ok(Ok(capture_id)) => capture_id,
            Ok(Err(error)) => return TriggerOutcome::CreateFailed { error },
            Err(_) => {
                return TriggerOutcome::CreateFailed {
                    error: CommandError::io("capture handler panicked while creating a note"),
                }
            }
        };
        let window_label = temporary_window_label(capture_id);
        match catch_unwind(AssertUnwindSafe(|| self.backend.show(capture_id))) {
            Ok(Ok(())) => TriggerOutcome::Shown {
                capture_id,
                window_label,
            },
            Ok(Err(error)) => TriggerOutcome::ShowFailed {
                capture_id,
                window_label,
                error,
            },
            Err(_) => TriggerOutcome::ShowFailed {
                capture_id,
                window_label,
                error: CommandError::io("capture handler panicked while showing a window"),
            },
        }
    }
}

fn lock_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
