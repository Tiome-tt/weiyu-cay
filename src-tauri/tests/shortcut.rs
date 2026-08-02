use simple_notes_lib::{
    commands::shortcuts::{PluginEventDispatcher, PluginShortcutEvent},
    error::CommandError,
    shortcuts::{
        map_accelerator_for_platform, shortcut_identity_from_accelerator, AcceleratorPlatform,
        CaptureBackend, CaptureEventRouter, CaptureTrigger, ShortcutBackend, ShortcutError,
        ShortcutEvent, ShortcutIdentity, ShortcutRegistrationStatus, ShortcutService,
        TriggerOutcome, DEFAULT_CAPTURE_SHORTCUT,
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
        mpsc, Arc, Barrier, Mutex,
    },
    thread,
};
use tauri_plugin_global_shortcut::Shortcut;

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

fn shortcut_identity(accelerator: &str) -> ShortcutIdentity {
    shortcut_identity_from_accelerator(accelerator).unwrap()
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
fn tauri_shortcut_identity_matches_registration_for_real_plugin_keys_and_platforms() {
    for (input, platform) in [
        (DEFAULT_CAPTURE_SHORTCUT, AcceleratorPlatform::Windows),
        (DEFAULT_CAPTURE_SHORTCUT, AcceleratorPlatform::MacOs),
        ("shift+ctrl+a", AcceleratorPlatform::Windows),
        ("command+shift+a", AcceleratorPlatform::MacOs),
        ("alt+control+1", AcceleratorPlatform::Windows),
        ("option+command+1", AcceleratorPlatform::MacOs),
    ] {
        let mapped = map_accelerator_for_platform(input, platform).unwrap();
        let plugin_shortcut = mapped.parse::<Shortcut>().unwrap();
        assert_eq!(
            shortcut_identity_from_accelerator(&mapped).unwrap(),
            ShortcutIdentity::from_shortcut(&plugin_shortcut),
            "identity drift for {input} -> {mapped} -> {plugin_shortcut}"
        );

        let service = ShortcutService::new_for_platform(ShortcutFixture::default(), platform);
        service.register(input).unwrap();
        let capture_backend = FailingCaptureBackend::default();
        let router = CaptureEventRouter::new(service, CaptureTrigger::new(capture_backend.clone()));
        assert!(matches!(
            router.dispatch(
                ShortcutIdentity::from_shortcut(&plugin_shortcut),
                ShortcutEvent::Pressed
            ),
            TriggerOutcome::Shown { .. }
        ));
        assert_eq!(*capture_backend.creates.lock().unwrap(), 1);
    }

    assert_eq!(
        "Control+Shift+A".parse::<Shortcut>().unwrap().to_string(),
        "shift+control+KeyA"
    );
    assert_eq!(
        "Command+Shift+1".parse::<Shortcut>().unwrap().to_string(),
        "shift+super+Digit1"
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
    assert_eq!(service.current(), None);
    assert!(matches!(
        service.status().registration,
        ShortcutRegistrationStatus::RecoveryRequired { ref bindings }
            if bindings.len() == 2
                && bindings.iter().any(|binding| binding.platform == "Control+Shift+Space")
                && bindings.iter().any(|binding| binding.platform == "Control+Alt+Space")
    ));

    backend.fail(
        "unregister",
        "Control+Alt+Space",
        ShortcutError::backend("new binding still cannot unregister"),
    );
    let cleanup = service.unregister().unwrap_err();
    assert!(matches!(cleanup, ShortcutError::RecoveryRequired { .. }));
    assert!(matches!(
        service.status().registration,
        ShortcutRegistrationStatus::RecoveryRequired { ref bindings }
            if bindings.len() == 1 && bindings[0].platform == "Control+Alt+Space"
    ));
    service.unregister().unwrap();
    assert!(matches!(
        service.status().registration,
        ShortcutRegistrationStatus::Inactive
    ));
}

#[test]
fn backend_reentry_and_simulated_plugin_lock_order_do_not_deadlock() {
    type ReentryCallback = Arc<dyn Fn() + Send + Sync>;

    #[derive(Clone, Default)]
    struct ReentrantBackend {
        callback: Arc<Mutex<Option<ReentryCallback>>>,
    }
    impl ShortcutBackend for ReentrantBackend {
        fn register(&self, _accelerator: &str) -> Result<(), ShortcutError> {
            if let Some(callback) = self.callback.lock().unwrap().clone() {
                callback();
            }
            Ok(())
        }
        fn unregister(&self, _accelerator: &str) -> Result<(), ShortcutError> {
            Ok(())
        }
    }

    let backend = ReentrantBackend::default();
    let service = Arc::new(ShortcutService::new_for_platform(
        backend.clone(),
        AcceleratorPlatform::Windows,
    ));
    let callback_service = service.clone();
    *backend.callback.lock().unwrap() = Some(Arc::new(move || {
        let _ = callback_service.status();
        assert!(callback_service
            .match_event(
                shortcut_identity("Control+Shift+Space"),
                ShortcutEvent::Pressed
            )
            .is_none());
    }));
    let (finished_tx, finished_rx) = mpsc::channel();
    thread::spawn(move || {
        let result = service.register(DEFAULT_CAPTURE_SHORTCUT);
        let _ = finished_tx.send(result);
    });
    assert!(finished_rx
        .recv_timeout(std::time::Duration::from_millis(500))
        .expect("registration deadlocked during synchronous backend reentry")
        .is_ok());
}

#[test]
fn shutdown_during_registration_defers_cleanup_without_blocking_or_late_activation() {
    #[derive(Clone)]
    struct BlockingBackend {
        entered: Arc<Mutex<Option<mpsc::Sender<()>>>>,
        release: Arc<Mutex<mpsc::Receiver<()>>>,
        calls: Arc<Mutex<Vec<String>>>,
    }
    impl ShortcutBackend for BlockingBackend {
        fn register(&self, accelerator: &str) -> Result<(), ShortcutError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("register:{accelerator}"));
            if let Some(entered) = self.entered.lock().unwrap().take() {
                entered.send(()).unwrap();
            }
            self.release.lock().unwrap().recv().unwrap();
            Ok(())
        }
        fn unregister(&self, accelerator: &str) -> Result<(), ShortcutError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("unregister:{accelerator}"));
            Ok(())
        }
    }

    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let service = Arc::new(ShortcutService::new_for_platform(
        BlockingBackend {
            entered: Arc::new(Mutex::new(Some(entered_tx))),
            release: Arc::new(Mutex::new(release_rx)),
            calls: calls.clone(),
        },
        AcceleratorPlatform::Windows,
    ));
    let register_service = service.clone();
    let register = thread::spawn(move || register_service.register(DEFAULT_CAPTURE_SHORTCUT));
    entered_rx.recv().unwrap();
    let started = std::time::Instant::now();
    service.shutdown().unwrap();
    assert!(started.elapsed() < std::time::Duration::from_millis(50));
    release_tx.send(()).unwrap();
    assert!(register.join().unwrap().is_err());
    assert_eq!(service.current(), None);
    assert!(!service.status().accepting_triggers);
    assert_eq!(
        calls.lock().unwrap().as_slice(),
        [
            "register:Control+Shift+Space",
            "unregister:Control+Shift+Space"
        ]
    );
}

#[test]
fn production_dispatch_seam_is_non_blocking_and_carries_identity() {
    let dispatcher = PluginEventDispatcher::default();
    let (sender, receiver) = mpsc::channel();
    dispatcher.attach(sender);
    assert!(dispatcher.dispatch(PluginShortcutEvent {
        shortcut_identity: shortcut_identity("Control+Shift+Space"),
        event: ShortcutEvent::Pressed,
    }));
    let started = std::time::Instant::now();
    assert!(dispatcher.dispatch(PluginShortcutEvent {
        shortcut_identity: shortcut_identity("Control+Alt+Space"),
        event: ShortcutEvent::Pressed,
    }));
    assert!(started.elapsed() < std::time::Duration::from_millis(50));
    let delivered = [receiver.recv().unwrap(), receiver.recv().unwrap()];
    assert_eq!(
        delivered[0].shortcut_identity,
        shortcut_identity("Control+Shift+Space")
    );
    assert_eq!(delivered[0].event, ShortcutEvent::Pressed);
    assert_eq!(
        delivered[1].shortcut_identity,
        shortcut_identity("Control+Alt+Space")
    );
    assert_eq!(delivered[1].event, ShortcutEvent::Pressed);
    dispatcher.detach();
    assert!(!dispatcher.dispatch(PluginShortcutEvent {
        shortcut_identity: shortcut_identity("Control+Shift+Space"),
        event: ShortcutEvent::Released,
    }));
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
    assert_eq!(service.current(), None);
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
    assert_eq!(service.current(), None);
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
fn routing_checks_platform_identity_generation_recovery_and_shutdown() {
    let shortcut_backend = ShortcutFixture::default();
    let service =
        ShortcutService::new_for_platform(shortcut_backend.clone(), AcceleratorPlatform::Windows);
    service.register(DEFAULT_CAPTURE_SHORTCUT).unwrap();
    let capture_backend = FailingCaptureBackend::default();
    let router = CaptureEventRouter::new(
        service.clone(),
        CaptureTrigger::new(capture_backend.clone()),
    );

    assert_eq!(
        router.dispatch(
            shortcut_identity("Control+Alt+Space"),
            ShortcutEvent::Pressed
        ),
        TriggerOutcome::Ignored
    );
    assert!(matches!(
        router.dispatch(
            shortcut_identity("Control+Shift+Space"),
            ShortcutEvent::Pressed
        ),
        TriggerOutcome::Shown { .. }
    ));

    service.rebind("CommandOrControl+Alt+Space").unwrap();
    assert_eq!(
        router.dispatch(
            shortcut_identity("Control+Shift+Space"),
            ShortcutEvent::Pressed
        ),
        TriggerOutcome::Ignored
    );
    assert!(matches!(
        router.dispatch(
            shortcut_identity("Control+Alt+Space"),
            ShortcutEvent::Pressed
        ),
        TriggerOutcome::Shown { .. }
    ));
    assert_eq!(*capture_backend.creates.lock().unwrap(), 2);

    service.shutdown().unwrap();
    assert_eq!(
        router.dispatch(
            shortcut_identity("Control+Alt+Space"),
            ShortcutEvent::Released
        ),
        TriggerOutcome::Ignored
    );
    assert_eq!(
        router.dispatch(
            shortcut_identity("Control+Alt+Space"),
            ShortcutEvent::Pressed
        ),
        TriggerOutcome::Ignored
    );
    assert_eq!(*capture_backend.creates.lock().unwrap(), 2);
}

#[test]
fn shutdown_between_identity_match_and_activation_acceptance_suppresses_capture() {
    let service =
        ShortcutService::new_for_platform(ShortcutFixture::default(), AcceleratorPlatform::Windows);
    service.register(DEFAULT_CAPTURE_SHORTCUT).unwrap();
    let capture_backend = FailingCaptureBackend::default();
    let router = CaptureEventRouter::new(
        service.clone(),
        CaptureTrigger::new(capture_backend.clone()),
    );
    let matched = service
        .match_event(
            shortcut_identity("Control+Shift+Space"),
            ShortcutEvent::Pressed,
        )
        .expect("active binding should match before shutdown");
    let pause = Arc::new(Barrier::new(2));
    let dispatch_pause = pause.clone();
    let dispatch = thread::spawn(move || {
        dispatch_pause.wait();
        dispatch_pause.wait();
        router.dispatch_matched(matched, ShortcutEvent::Pressed)
    });
    pause.wait();

    service.shutdown().unwrap();
    pause.wait();

    assert_eq!(dispatch.join().unwrap(), TriggerOutcome::Ignored);
    assert_eq!(*capture_backend.creates.lock().unwrap(), 0);
}

#[test]
fn shutdown_does_not_wait_for_a_capture_accepted_before_shutdown() {
    #[derive(Clone)]
    struct BlockingAcceptedCapture {
        entered: Arc<Mutex<Option<mpsc::Sender<()>>>>,
        release: Arc<Mutex<mpsc::Receiver<()>>>,
    }

    impl CaptureBackend for BlockingAcceptedCapture {
        fn create(&self) -> Result<simple_notes_lib::domain::NoteId, CommandError> {
            if let Some(entered) = self.entered.lock().unwrap().take() {
                entered.send(()).unwrap();
            }
            self.release.lock().unwrap().recv().unwrap();
            Ok(simple_notes_lib::domain::NoteId::now_v7())
        }

        fn show(&self, _note_id: simple_notes_lib::domain::NoteId) -> Result<(), CommandError> {
            Ok(())
        }
    }

    let service =
        ShortcutService::new_for_platform(ShortcutFixture::default(), AcceleratorPlatform::Windows);
    service.register(DEFAULT_CAPTURE_SHORTCUT).unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let router = CaptureEventRouter::new(
        service.clone(),
        CaptureTrigger::new(BlockingAcceptedCapture {
            entered: Arc::new(Mutex::new(Some(entered_tx))),
            release: Arc::new(Mutex::new(release_rx)),
        }),
    );
    let dispatch = thread::spawn(move || {
        router.dispatch(
            shortcut_identity("Control+Shift+Space"),
            ShortcutEvent::Pressed,
        )
    });
    entered_rx.recv().unwrap();

    let started = std::time::Instant::now();
    service.shutdown().unwrap();
    assert!(started.elapsed() < std::time::Duration::from_millis(50));
    release_tx.send(()).unwrap();

    assert!(matches!(
        dispatch.join().unwrap(),
        TriggerOutcome::Shown { .. }
    ));
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
}
