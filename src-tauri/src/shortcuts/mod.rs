mod adapter;
mod tauri_backend;

pub use adapter::{map_accelerator_for_platform, AcceleratorPlatform};
pub use tauri_backend::{TauriCaptureBackend, TauriShortcutBackend};

use crate::{
    domain::NoteId, error::CommandError, storage::recovery::StartupRecoveryReadiness,
    windows::sticky::temporary_window_label,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
};
use tauri_plugin_global_shortcut::Shortcut;

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutBindingStatus {
    pub canonical: String,
    pub platform: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Binding {
    canonical: String,
    platform: String,
    identity: ShortcutIdentity,
}

impl Binding {
    fn status(&self) -> ShortcutBindingStatus {
        ShortcutBindingStatus {
            canonical: self.canonical.clone(),
            platform: self.platform.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ShortcutRegistrationStatus {
    Inactive,
    Active {
        binding: ShortcutBindingStatus,
    },
    InProgress,
    RecoveryRequired {
        bindings: Vec<ShortcutBindingStatus>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutServiceStatus {
    pub registration: ShortcutRegistrationStatus,
    pub accepting_triggers: bool,
}

#[derive(Clone)]
enum RegistrationState {
    Inactive,
    Active(Binding),
    InProgress,
    RecoveryRequired(Vec<Binding>),
}

struct SharedRegistrationState {
    registration: RegistrationState,
    generation: u64,
}

impl Default for SharedRegistrationState {
    fn default() -> Self {
        Self {
            registration: RegistrationState::Inactive,
            generation: 0,
        }
    }
}

pub struct ShortcutService<B> {
    backend: B,
    platform: AcceleratorPlatform,
    state: Arc<Mutex<SharedRegistrationState>>,
    shutdown_requested: Arc<AtomicBool>,
}

impl<B: Clone> Clone for ShortcutService<B> {
    fn clone(&self) -> Self {
        Self {
            backend: self.backend.clone(),
            platform: self.platform,
            state: self.state.clone(),
            shutdown_requested: self.shutdown_requested.clone(),
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
            state: Arc::new(Mutex::new(SharedRegistrationState::default())),
            shutdown_requested: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn register(&self, accelerator: &str) -> Result<String, ShortcutError> {
        let canonical = normalize_accelerator(accelerator)?;
        let mapped = map_accelerator_for_platform(&canonical, self.platform)?;
        let identity = shortcut_identity_from_accelerator(&mapped)?;
        if self.shutdown_requested.load(Ordering::Acquire) {
            return Err(ShortcutError::validation(
                "shortcut service is shutting down",
            ));
        }
        let previous = self.reserve_transition(|registration| match registration {
            RegistrationState::Inactive => Ok(()),
            RegistrationState::Active(active) if active.canonical == canonical => {
                Err(TransitionDecision::AlreadyActive)
            }
            RegistrationState::Active(_) => Err(TransitionDecision::Error(
                ShortcutError::conflict(&canonical, "A capture shortcut is already active."),
            )),
            RegistrationState::InProgress => Err(TransitionDecision::Error(
                ShortcutError::backend("shortcut transition is already in progress"),
            )),
            RegistrationState::RecoveryRequired(bindings) => {
                Err(TransitionDecision::Error(recovery_error(
                    bindings,
                    "Shortcut recovery is required before registering.",
                )))
            }
        });
        let previous = match previous {
            Ok(previous) => previous,
            Err(TransitionDecision::AlreadyActive) => return Ok(canonical),
            Err(TransitionDecision::Error(error)) => return Err(error),
            Err(TransitionDecision::AlreadyInactive) => unreachable!(),
            Err(TransitionDecision::PendingCleanup) => unreachable!(),
        };
        let result = self.backend.register(&mapped);
        match result {
            Ok(()) => {
                let binding = Binding {
                    canonical: canonical.clone(),
                    platform: mapped,
                    identity,
                };
                self.finish_active(binding).map(|()| canonical)
            }
            Err(error) => match self.restore_or_shutdown(previous) {
                Ok(()) => Err(error.with_accelerator(&canonical)),
                Err(cleanup) => Err(cleanup),
            },
        }
    }

    pub fn rebind(&self, accelerator: &str) -> Result<String, ShortcutError> {
        let canonical = normalize_accelerator(accelerator)?;
        let mapped = map_accelerator_for_platform(&canonical, self.platform)?;
        let identity = shortcut_identity_from_accelerator(&mapped)?;
        if self.shutdown_requested.load(Ordering::Acquire) {
            return Err(ShortcutError::validation(
                "shortcut service is shutting down",
            ));
        }
        let previous = self.reserve_transition(|registration| match registration {
            RegistrationState::Inactive => Ok(()),
            RegistrationState::Active(active) if active.canonical == canonical => {
                Err(TransitionDecision::AlreadyActive)
            }
            RegistrationState::Active(_) => Ok(()),
            RegistrationState::InProgress => Err(TransitionDecision::Error(
                ShortcutError::backend("shortcut transition is already in progress"),
            )),
            RegistrationState::RecoveryRequired(bindings) => Err(TransitionDecision::Error(
                recovery_error(bindings, "Shortcut recovery is required before rebinding."),
            )),
        });
        let previous = match previous {
            Ok(previous) => previous,
            Err(TransitionDecision::AlreadyActive) => return Ok(canonical),
            Err(TransitionDecision::Error(error)) => return Err(error),
            Err(TransitionDecision::AlreadyInactive) => unreachable!(),
            Err(TransitionDecision::PendingCleanup) => unreachable!(),
        };
        let old = match &previous {
            RegistrationState::Active(binding) => Some(binding.clone()),
            RegistrationState::Inactive => None,
            RegistrationState::InProgress | RegistrationState::RecoveryRequired(_) => {
                unreachable!("only stable registrations can reserve a transition")
            }
        };
        if let Err(error) = self.backend.register(&mapped) {
            return match self.restore_or_shutdown(previous) {
                Ok(()) => Err(error.with_accelerator(&canonical)),
                Err(cleanup) => Err(cleanup),
            };
        }
        if let Some(old) = old {
            if let Err(old_error) = self.backend.unregister(&old.platform) {
                if let Err(rollback_error) = self.backend.unregister(&mapped) {
                    let bindings = vec![
                        old.clone(),
                        Binding {
                            canonical: canonical.clone(),
                            platform: mapped,
                            identity,
                        },
                    ];
                    let reason = format!(
                        "The old shortcut and the replacement may both be active; recovery is required. {} {}",
                        old_error, rollback_error
                    );
                    return Err(self.finish_recovery(bindings, &reason));
                }
                return match self.restore_or_shutdown(previous) {
                    Ok(()) => Err(old_error.with_accelerator(&old.canonical)),
                    Err(cleanup) => Err(cleanup),
                };
            }
        }
        self.finish_active(Binding {
            canonical: canonical.clone(),
            platform: mapped,
            identity,
        })
        .map(|()| canonical)
    }

    pub fn unregister(&self) -> Result<(), ShortcutError> {
        self.cleanup_bindings()
    }

    pub fn shutdown(&self) -> Result<(), ShortcutError> {
        if self.shutdown_requested.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        self.cleanup_bindings()
    }

    pub fn current(&self) -> Option<String> {
        match &lock_recover(&self.state).registration {
            RegistrationState::Active(binding) => Some(binding.canonical.clone()),
            RegistrationState::Inactive
            | RegistrationState::InProgress
            | RegistrationState::RecoveryRequired(_) => None,
        }
    }

    pub fn status(&self) -> ShortcutServiceStatus {
        let state = lock_recover(&self.state);
        let registration = match &state.registration {
            RegistrationState::Inactive => ShortcutRegistrationStatus::Inactive,
            RegistrationState::Active(binding) => ShortcutRegistrationStatus::Active {
                binding: binding.status(),
            },
            RegistrationState::InProgress => ShortcutRegistrationStatus::InProgress,
            RegistrationState::RecoveryRequired(bindings) => {
                ShortcutRegistrationStatus::RecoveryRequired {
                    bindings: bindings.iter().map(Binding::status).collect(),
                }
            }
        };
        ShortcutServiceStatus {
            registration,
            accepting_triggers: !self.shutdown_requested.load(Ordering::Acquire),
        }
    }

    pub fn match_event(
        &self,
        shortcut_identity: ShortcutIdentity,
        _event: ShortcutEvent,
    ) -> Option<ActivationIdentity> {
        if self.shutdown_requested.load(Ordering::Acquire) {
            return None;
        }
        let state = lock_recover(&self.state);
        match &state.registration {
            RegistrationState::Active(binding) if binding.identity == shortcut_identity => {
                Some(ActivationIdentity {
                    shortcut: binding.identity,
                    generation: state.generation,
                })
            }
            RegistrationState::Inactive
            | RegistrationState::Active(_)
            | RegistrationState::InProgress
            | RegistrationState::RecoveryRequired(_) => None,
        }
    }

    pub fn accept_matched_event(&self, identity: &ActivationIdentity) -> bool {
        let state = lock_recover(&self.state);
        let binding_is_current = matches!(
            &state.registration,
            RegistrationState::Active(binding)
                if binding.identity == identity.shortcut && state.generation == identity.generation
        );
        binding_is_current && !self.shutdown_requested.load(Ordering::Acquire)
    }

    fn reserve_transition<F>(&self, decide: F) -> Result<RegistrationState, TransitionDecision>
    where
        F: FnOnce(&RegistrationState) -> Result<(), TransitionDecision>,
    {
        let mut state = lock_recover(&self.state);
        decide(&state.registration)?;
        let previous = state.registration.clone();
        state.registration = RegistrationState::InProgress;
        Ok(previous)
    }

    fn restore_or_shutdown(&self, previous: RegistrationState) -> Result<(), ShortcutError> {
        {
            let mut state = lock_recover(&self.state);
            if !self.shutdown_requested.load(Ordering::Acquire) {
                state.registration = previous;
                return Ok(());
            }
        }
        let bindings = match previous {
            RegistrationState::Inactive => {
                self.commit_transition(RegistrationState::Inactive, true);
                return Ok(());
            }
            RegistrationState::Active(binding) => vec![binding],
            RegistrationState::RecoveryRequired(bindings) => bindings,
            RegistrationState::InProgress => unreachable!(),
        };
        self.cleanup_reserved(bindings)
    }

    fn finish_active(&self, binding: Binding) -> Result<(), ShortcutError> {
        {
            let mut state = lock_recover(&self.state);
            if !self.shutdown_requested.load(Ordering::Acquire) {
                state.registration = RegistrationState::Active(binding);
                state.generation = state.generation.wrapping_add(1);
                return Ok(());
            }
        }
        self.cleanup_reserved(vec![binding])?;
        Err(ShortcutError::validation(
            "shortcut service is shutting down",
        ))
    }

    fn finish_recovery(&self, bindings: Vec<Binding>, reason: &str) -> ShortcutError {
        {
            let mut state = lock_recover(&self.state);
            if !self.shutdown_requested.load(Ordering::Acquire) {
                state.registration = RegistrationState::RecoveryRequired(bindings.clone());
                state.generation = state.generation.wrapping_add(1);
                return recovery_error(&bindings, reason);
            }
        }
        match self.cleanup_reserved(bindings) {
            Ok(()) => ShortcutError::validation("shortcut service is shutting down"),
            Err(error) => error,
        }
    }

    fn commit_transition(&self, registration: RegistrationState, advance_generation: bool) {
        let mut state = lock_recover(&self.state);
        state.registration = registration;
        if advance_generation {
            state.generation = state.generation.wrapping_add(1);
        }
    }

    fn cleanup_bindings(&self) -> Result<(), ShortcutError> {
        let previous = self.reserve_transition(|registration| match registration {
            RegistrationState::Inactive => Err(TransitionDecision::AlreadyInactive),
            RegistrationState::Active(_) | RegistrationState::RecoveryRequired(_) => Ok(()),
            RegistrationState::InProgress if self.shutdown_requested.load(Ordering::Acquire) => {
                Err(TransitionDecision::PendingCleanup)
            }
            RegistrationState::InProgress => Err(TransitionDecision::Error(
                ShortcutError::backend("shortcut transition is already in progress"),
            )),
        });
        let previous = match previous {
            Ok(previous) => previous,
            Err(TransitionDecision::AlreadyInactive) => return Ok(()),
            Err(TransitionDecision::PendingCleanup) => return Ok(()),
            Err(TransitionDecision::Error(error)) => return Err(error),
            Err(TransitionDecision::AlreadyActive) => unreachable!(),
        };
        let bindings = match &previous {
            RegistrationState::Active(binding) => vec![binding.clone()],
            RegistrationState::RecoveryRequired(bindings) => bindings.clone(),
            RegistrationState::Inactive | RegistrationState::InProgress => unreachable!(),
        };
        self.cleanup_reserved(bindings)
    }

    fn cleanup_reserved(&self, bindings: Vec<Binding>) -> Result<(), ShortcutError> {
        let mut failed = Vec::new();
        for binding in &bindings {
            if self.backend.unregister(&binding.platform).is_err() {
                failed.push(binding.clone());
            }
        }
        if failed.is_empty() {
            self.commit_transition(RegistrationState::Inactive, true);
            Ok(())
        } else {
            self.commit_transition(RegistrationState::RecoveryRequired(failed.clone()), true);
            Err(recovery_error(
                &failed,
                "One or more shortcut bindings still require cleanup.",
            ))
        }
    }
}

enum TransitionDecision {
    AlreadyActive,
    AlreadyInactive,
    PendingCleanup,
    Error(ShortcutError),
}

fn recovery_error(bindings: &[Binding], reason: &str) -> ShortcutError {
    ShortcutError::RecoveryRequired {
        bindings: bindings
            .iter()
            .map(|binding| binding.canonical.clone())
            .collect(),
        reason: reason.to_owned(),
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ShortcutIdentity(u32);

impl ShortcutIdentity {
    pub fn from_shortcut(shortcut: &Shortcut) -> Self {
        Self(shortcut.id())
    }
}

pub fn shortcut_identity_from_accelerator(
    accelerator: &str,
) -> Result<ShortcutIdentity, ShortcutError> {
    accelerator
        .parse::<Shortcut>()
        .map(|shortcut| ShortcutIdentity::from_shortcut(&shortcut))
        .map_err(|error| ShortcutError::validation(format!("shortcut is unsupported: {error}")))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivationIdentity {
    shortcut: ShortcutIdentity,
    generation: u64,
}

pub trait CaptureBackend: Clone + Send + Sync + 'static {
    fn create(&self) -> Result<NoteId, CommandError>;
    fn show(&self, note_id: NoteId) -> Result<(), CommandError>;
}

#[derive(Clone)]
pub struct RecoveryGatedCaptureBackend<C> {
    inner: C,
    readiness: StartupRecoveryReadiness,
}

impl<C> RecoveryGatedCaptureBackend<C> {
    pub fn new(inner: C, readiness: StartupRecoveryReadiness) -> Self {
        Self { inner, readiness }
    }
}

impl<C: CaptureBackend> CaptureBackend for RecoveryGatedCaptureBackend<C> {
    fn create(&self) -> Result<NoteId, CommandError> {
        self.readiness.with_ready(|| self.inner.create())
    }

    fn show(&self, note_id: NoteId) -> Result<(), CommandError> {
        self.readiness.with_ready(|| self.inner.show(note_id))
    }
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
    pressed: Arc<Mutex<Option<ActivationIdentity>>>,
}

impl<C: Clone> Clone for CaptureTrigger<C> {
    fn clone(&self) -> Self {
        Self {
            backend: self.backend.clone(),
            pressed: self.pressed.clone(),
        }
    }
}

impl<C: CaptureBackend> CaptureTrigger<C> {
    pub fn new(backend: C) -> Self {
        Self {
            backend,
            pressed: Arc::new(Mutex::new(None)),
        }
    }

    pub fn handle_event(&self, event: ShortcutEvent) -> TriggerOutcome {
        self.handle_routed(
            ActivationIdentity {
                shortcut: ShortcutIdentity(0),
                generation: 0,
            },
            event,
        )
    }

    pub fn handle_routed(
        &self,
        identity: ActivationIdentity,
        event: ShortcutEvent,
    ) -> TriggerOutcome {
        {
            let mut pressed = lock_recover(&self.pressed);
            match event {
                ShortcutEvent::Released => {
                    if pressed.as_ref() == Some(&identity) {
                        *pressed = None;
                    }
                    return TriggerOutcome::Ignored;
                }
                ShortcutEvent::Pressed if pressed.as_ref() == Some(&identity) => {
                    return TriggerOutcome::Ignored
                }
                ShortcutEvent::Pressed => *pressed = Some(identity),
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

#[derive(Clone)]
pub struct CaptureEventRouter<B, C> {
    service: ShortcutService<B>,
    trigger: CaptureTrigger<C>,
}

impl<B: ShortcutBackend + Clone, C: CaptureBackend> CaptureEventRouter<B, C> {
    pub fn new(service: ShortcutService<B>, trigger: CaptureTrigger<C>) -> Self {
        Self { service, trigger }
    }

    pub fn dispatch(
        &self,
        shortcut_identity: ShortcutIdentity,
        event: ShortcutEvent,
    ) -> TriggerOutcome {
        let Some(identity) = self.service.match_event(shortcut_identity, event) else {
            return TriggerOutcome::Ignored;
        };
        self.dispatch_matched(identity, event)
    }

    pub fn dispatch_matched(
        &self,
        identity: ActivationIdentity,
        event: ShortcutEvent,
    ) -> TriggerOutcome {
        if !self.service.accept_matched_event(&identity) {
            return TriggerOutcome::Ignored;
        }
        self.trigger.handle_routed(identity, event)
    }
}

fn lock_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
