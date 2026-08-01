use simple_notes_lib::{
    error::CommandError,
    shortcuts::{
        map_accelerator_for_platform, AcceleratorPlatform, CaptureBackend, CaptureTrigger,
        ShortcutBackend, ShortcutError, ShortcutEvent, ShortcutService, TriggerOutcome,
        DEFAULT_CAPTURE_SHORTCUT,
    },
    storage::paths::StoragePaths,
    windows::sticky::{
        temporary_window_label, InMemoryTemporaryWindowBackend, TemporaryRepository,
        TemporaryWindowService,
    },
};
use std::{
    collections::{HashMap, HashSet},
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Barrier, Mutex,
    },
    thread,
};

#[derive(Clone, Default)]
struct ShortcutFixture {
    inner: Arc<Mutex<ShortcutFixtureState>>,
}

#[derive(Default)]
struct ShortcutFixtureState {
    calls: Vec<String>,
    failures: HashMap<String, Vec<ShortcutError>>,
}

impl ShortcutFixture {
    fn fail(&self, operation: &str, accelerator: &str, error: ShortcutError) {
        self.inner
            .lock()
            .unwrap()
            .failures
            .entry(format!("{operation}:{accelerator}"))
            .or_default()
            .push(error);
    }

    fn calls(&self) -> Vec<String> {
        self.inner.lock().unwrap().calls.clone()
    }

    fn operation(&self, name: &str, accelerator: &str) -> Result<(), ShortcutError> {
        let key = format!("{name}:{accelerator}");
        let mut inner = self.inner.lock().unwrap();
        inner.calls.push(key.clone());
        inner
            .failures
            .get_mut(&key)
            .and_then(|failures| (!failures.is_empty()).then(|| failures.remove(0)))
            .map_or(Ok(()), Err)
    }
}

impl ShortcutBackend for ShortcutFixture {
    fn register(&self, accelerator: &str) -> Result<(), ShortcutError> {
        self.operation("register", accelerator)
    }

    fn unregister(&self, accelerator: &str) -> Result<(), ShortcutError> {
        self.operation("unregister", accelerator)
    }
}

#[test]
fn default_and_platform_mapping_are_canonical() {
    assert_eq!(DEFAULT_CAPTURE_SHORTCUT, "CommandOrControl+Shift+Space");
    assert_eq!(
        map_accelerator_for_platform(DEFAULT_CAPTURE_SHORTCUT, AcceleratorPlatform::Windows)
            .unwrap(),
        "Control+Shift+Space"
    );
    assert_eq!(
        map_accelerator_for_platform(DEFAULT_CAPTURE_SHORTCUT, AcceleratorPlatform::MacOs).unwrap(),
        "Command+Shift+Space"
    );
}

#[test]
fn invalid_accelerators_never_reach_the_backend() {
    let backend = ShortcutFixture::default();
    let service = ShortcutService::new(backend.clone());
    for invalid in [
        "",
        "Shift",
        "CommandOrControl++Space",
        "CommandOrControl+Hyper+Space",
        "CommandOrControl+Shift+Bad Key",
        "CommandOrControl+Shift+\n",
        &"A".repeat(129),
    ] {
        assert!(matches!(
            service.register(invalid),
            Err(ShortcutError::Validation { .. })
        ));
    }
    assert!(backend.calls().is_empty());
}

#[test]
fn initial_registration_is_idempotent_and_conflicts_are_structured() {
    let backend = ShortcutFixture::default();
    let service = ShortcutService::new(backend.clone());
    assert_eq!(
        service.register("shift+commandorcontrol+space").unwrap(),
        DEFAULT_CAPTURE_SHORTCUT
    );
    assert_eq!(
        service.register(DEFAULT_CAPTURE_SHORTCUT).unwrap(),
        DEFAULT_CAPTURE_SHORTCUT
    );
    assert_eq!(backend.calls().len(), 1);

    let conflicted_backend = ShortcutFixture::default();
    conflicted_backend.fail(
        "register",
        "Control+Shift+Space",
        ShortcutError::conflict(DEFAULT_CAPTURE_SHORTCUT, "shortcut is already in use"),
    );
    let conflicted =
        ShortcutService::new_for_platform(conflicted_backend, AcceleratorPlatform::Windows);
    let error = conflicted.register(DEFAULT_CAPTURE_SHORTCUT).unwrap_err();
    assert!(matches!(
        error,
        ShortcutError::Conflict { ref accelerator, ref reason }
            if accelerator == DEFAULT_CAPTURE_SHORTCUT && reason == "shortcut is already in use"
    ));
    assert_eq!(conflicted.current(), None);
}

#[test]
fn rebind_preserves_or_rolls_back_authoritative_state() {
    let backend = ShortcutFixture::default();
    let service = ShortcutService::new_for_platform(backend.clone(), AcceleratorPlatform::Windows);
    service.register(DEFAULT_CAPTURE_SHORTCUT).unwrap();

    backend.fail(
        "register",
        "Control+Alt+Space",
        ShortcutError::backend("new binding failed"),
    );
    assert!(service.rebind("CommandOrControl+Alt+Space").is_err());
    assert_eq!(service.current().as_deref(), Some(DEFAULT_CAPTURE_SHORTCUT));

    backend.fail(
        "unregister",
        "Control+Shift+Space",
        ShortcutError::backend("old binding could not unregister"),
    );
    assert!(service.rebind("CommandOrControl+Alt+Space").is_err());
    assert_eq!(service.current().as_deref(), Some(DEFAULT_CAPTURE_SHORTCUT));
    assert!(backend.calls().ends_with(&[
        "register:Control+Alt+Space".to_owned(),
        "unregister:Control+Shift+Space".to_owned(),
        "unregister:Control+Alt+Space".to_owned(),
    ]));
}

#[test]
fn same_value_rebind_does_not_churn_the_operating_system_registration() {
    let backend = ShortcutFixture::default();
    let service = ShortcutService::new_for_platform(backend.clone(), AcceleratorPlatform::Windows);
    service.register(DEFAULT_CAPTURE_SHORTCUT).unwrap();
    service.rebind("shift+commandorcontrol+space").unwrap();
    assert_eq!(
        backend.calls(),
        vec!["register:Control+Shift+Space".to_owned()]
    );
}

#[test]
fn rollback_failure_requires_recovery_and_lists_possible_bindings() {
    let backend = ShortcutFixture::default();
    let service = ShortcutService::new_for_platform(backend.clone(), AcceleratorPlatform::Windows);
    service.register(DEFAULT_CAPTURE_SHORTCUT).unwrap();
    backend.fail(
        "unregister",
        "Control+Shift+Space",
        ShortcutError::backend("old unregister failed"),
    );
    backend.fail(
        "unregister",
        "Control+Alt+Space",
        ShortcutError::backend("rollback failed"),
    );
    let error = service.rebind("CommandOrControl+Alt+Space").unwrap_err();
    assert!(matches!(
        error,
        ShortcutError::RecoveryRequired { ref bindings, .. }
            if bindings == &vec![
                DEFAULT_CAPTURE_SHORTCUT.to_owned(),
                "CommandOrControl+Alt+Space".to_owned()
            ]
    ));
    assert_eq!(service.current().as_deref(), Some(DEFAULT_CAPTURE_SHORTCUT));
}

#[test]
fn unregister_failure_is_retryable_and_shutdown_runs_once() {
    let backend = ShortcutFixture::default();
    let service = ShortcutService::new_for_platform(backend.clone(), AcceleratorPlatform::Windows);
    service.register(DEFAULT_CAPTURE_SHORTCUT).unwrap();
    backend.fail(
        "unregister",
        "Control+Shift+Space",
        ShortcutError::backend("temporary failure"),
    );
    assert!(service.unregister().is_err());
    assert_eq!(service.current().as_deref(), Some(DEFAULT_CAPTURE_SHORTCUT));
    service.unregister().unwrap();
    service.unregister().unwrap();
    assert_eq!(service.current(), None);

    service.register(DEFAULT_CAPTURE_SHORTCUT).unwrap();
    service.shutdown().unwrap();
    service.shutdown().unwrap();
    let unregisters = backend
        .calls()
        .into_iter()
        .filter(|call| call == "unregister:Control+Shift+Space")
        .count();
    assert_eq!(unregisters, 3);
}

#[test]
fn failed_shutdown_cleanup_is_attempted_only_once() {
    let backend = ShortcutFixture::default();
    let service = ShortcutService::new_for_platform(backend.clone(), AcceleratorPlatform::Windows);
    service.register(DEFAULT_CAPTURE_SHORTCUT).unwrap();
    backend.fail(
        "unregister",
        "Control+Shift+Space",
        ShortcutError::backend("shutdown cleanup failed"),
    );
    assert!(service.shutdown().is_err());
    assert!(service.shutdown().is_ok());
    assert_eq!(service.current().as_deref(), Some(DEFAULT_CAPTURE_SHORTCUT));
    assert_eq!(
        backend
            .calls()
            .into_iter()
            .filter(|call| call == "unregister:Control+Shift+Space")
            .count(),
        1
    );
}

#[derive(Clone)]
struct DurableCaptureBackend {
    paths: StoragePaths,
    windows: InMemoryTemporaryWindowBackend,
}

impl CaptureBackend for DurableCaptureBackend {
    fn create(&self) -> Result<simple_notes_lib::domain::NoteId, CommandError> {
        TemporaryRepository::new(self.paths.clone())
            .create()
            .map(|note| note.id)
    }

    fn show(&self, note_id: simple_notes_lib::domain::NoteId) -> Result<(), CommandError> {
        TemporaryWindowService::new(self.paths.clone(), self.windows.clone())
            .show(note_id)
            .map(|_| ())
    }
}

fn durable_trigger() -> (
    tempfile::TempDir,
    CaptureTrigger<DurableCaptureBackend>,
    InMemoryTemporaryWindowBackend,
    StoragePaths,
) {
    let temporary = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(temporary.path().join("app-data")).unwrap();
    let windows = InMemoryTemporaryWindowBackend::default();
    let trigger = CaptureTrigger::new(DurableCaptureBackend {
        paths: paths.clone(),
        windows: windows.clone(),
    });
    (temporary, trigger, windows, paths)
}

#[test]
fn key_down_creates_one_capture_and_key_up_or_repeat_do_not_duplicate() {
    let (_temporary, trigger, windows, paths) = durable_trigger();
    let first = trigger.handle_event(ShortcutEvent::Pressed);
    let id = match first {
        TriggerOutcome::Shown {
            capture_id,
            ref window_label,
        } => {
            assert_eq!(window_label, &temporary_window_label(capture_id));
            capture_id
        }
        outcome => panic!("unexpected outcome: {outcome:?}"),
    };
    assert_eq!(
        uuid::Uuid::parse_str(&id.to_string())
            .unwrap()
            .get_version_num(),
        7
    );
    assert_eq!(
        trigger.handle_event(ShortcutEvent::Pressed),
        TriggerOutcome::Ignored
    );
    assert_eq!(
        trigger.handle_event(ShortcutEvent::Released),
        TriggerOutcome::Ignored
    );
    assert_eq!(windows.show_count(), 1);
    assert_eq!(TemporaryRepository::new(paths).list().unwrap()[0].id, id);
}

#[test]
fn concurrent_pressed_events_are_latched_until_release() {
    let backend = FailingCaptureBackend::default();
    let trigger = CaptureTrigger::new(backend.clone());
    let barrier = Arc::new(Barrier::new(3));
    let handles = (0..2)
        .map(|_| {
            let trigger = trigger.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                trigger.handle_event(ShortcutEvent::Pressed)
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let outcomes = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, TriggerOutcome::Shown { .. }))
            .count(),
        1
    );
    assert_eq!(*backend.creates.lock().unwrap(), 1);
}

#[test]
fn sequential_and_concurrent_activations_create_distinct_captures_and_windows() {
    let (_temporary, trigger, windows, paths) = durable_trigger();
    let one = trigger.activate().capture_id().unwrap();
    let two = trigger.activate().capture_id().unwrap();
    assert_ne!(one, two);

    let barrier = Arc::new(Barrier::new(3));
    let handles = (0..2)
        .map(|_| {
            let trigger = trigger.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                trigger.activate().capture_id().unwrap()
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let concurrent = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect::<Vec<_>>();
    assert_ne!(concurrent[0], concurrent[1]);
    let ids = TemporaryRepository::new(paths)
        .list()
        .unwrap()
        .into_iter()
        .map(|note| note.id)
        .collect::<HashSet<_>>();
    assert_eq!(ids.len(), 4);
    assert_eq!(
        windows
            .created_labels()
            .into_iter()
            .collect::<HashSet<_>>()
            .len(),
        4
    );
}

#[derive(Clone, Default)]
struct FailingCaptureBackend {
    creates: Arc<Mutex<usize>>,
    shows: Arc<Mutex<usize>>,
    fail_create_once: Arc<Mutex<bool>>,
    fail_show_once: Arc<Mutex<bool>>,
}

#[derive(Clone, Default)]
struct PanickingCaptureBackend {
    panic_once: Arc<AtomicBool>,
}

impl CaptureBackend for PanickingCaptureBackend {
    fn create(&self) -> Result<simple_notes_lib::domain::NoteId, CommandError> {
        if self.panic_once.swap(false, Ordering::SeqCst) {
            panic!("injected handler panic");
        }
        Ok(simple_notes_lib::domain::NoteId::now_v7())
    }

    fn show(&self, _note_id: simple_notes_lib::domain::NoteId) -> Result<(), CommandError> {
        Ok(())
    }
}

impl CaptureBackend for FailingCaptureBackend {
    fn create(&self) -> Result<simple_notes_lib::domain::NoteId, CommandError> {
        *self.creates.lock().unwrap() += 1;
        if std::mem::take(&mut *self.fail_create_once.lock().unwrap()) {
            return Err(CommandError::io("injected create failure"));
        }
        Ok(simple_notes_lib::domain::NoteId::now_v7())
    }

    fn show(&self, _note_id: simple_notes_lib::domain::NoteId) -> Result<(), CommandError> {
        *self.shows.lock().unwrap() += 1;
        if std::mem::take(&mut *self.fail_show_once.lock().unwrap()) {
            return Err(CommandError::io("injected show failure"));
        }
        Ok(())
    }
}

#[test]
fn create_failure_does_not_show_and_later_activation_recovers() {
    let backend = FailingCaptureBackend::default();
    *backend.fail_create_once.lock().unwrap() = true;
    let trigger = CaptureTrigger::new(backend.clone());
    assert!(matches!(
        trigger.activate(),
        TriggerOutcome::CreateFailed { .. }
    ));
    assert_eq!(*backend.shows.lock().unwrap(), 0);
    assert!(matches!(trigger.activate(), TriggerOutcome::Shown { .. }));
}

#[test]
fn handler_panic_is_contained_and_does_not_poison_later_activation() {
    let backend = PanickingCaptureBackend::default();
    backend.panic_once.store(true, Ordering::SeqCst);
    let trigger = CaptureTrigger::new(backend);
    assert!(matches!(
        trigger.activate(),
        TriggerOutcome::CreateFailed { .. }
    ));
    assert!(matches!(trigger.activate(), TriggerOutcome::Shown { .. }));
}

#[test]
fn show_failure_reports_capture_id_without_deleting_durable_capture() {
    let temporary = tempfile::tempdir().unwrap();
    let paths = StoragePaths::open(temporary.path().join("app-data")).unwrap();
    let windows = InMemoryTemporaryWindowBackend::default();
    windows.fail_on_operation(3);
    let trigger = CaptureTrigger::new(DurableCaptureBackend {
        paths: paths.clone(),
        windows,
    });
    let id = match trigger.activate() {
        TriggerOutcome::ShowFailed { capture_id, .. } => capture_id,
        outcome => panic!("unexpected outcome: {outcome:?}"),
    };
    assert_eq!(TemporaryRepository::new(paths).list().unwrap()[0].id, id);
}

#[test]
fn permissions_keep_shortcut_management_out_of_sticky_windows() {
    let main = fs::read_to_string("capabilities/default.json").unwrap();
    let sticky = fs::read_to_string("capabilities/temporary.json").unwrap();
    let desktop = fs::read_to_string("capabilities/desktop.json").unwrap();
    for permission in [
        "allow-get-capture-shortcut",
        "allow-rebind-capture-shortcut",
    ] {
        assert!(main.contains(permission));
        assert!(!sticky.contains(permission));
    }
    assert!(!sticky.contains("global-shortcut"));
    assert!(!desktop.contains("global-shortcut:default"));

    let application = fs::read_to_string("src/lib.rs").unwrap();
    let tauri_backend = fs::read_to_string("src/shortcuts/tauri_backend.rs").unwrap();
    assert_eq!(application.matches(".with_handler(").count(), 1);
    assert!(!tauri_backend.contains(".on_shortcut("));
}
