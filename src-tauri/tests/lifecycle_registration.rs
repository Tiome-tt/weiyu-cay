use simple_notes_lib::windows::lifecycle::{Effect, Intent, Participant};
use simple_notes_lib::windows::lifecycle_registry::LifecycleRegistry;

fn labels() -> Vec<String> {
    vec!["main".into(), "temporary-test".into()]
}

#[test]
fn startup_request_waits_for_each_listener_without_omitting_unready_windows() {
    let mut r = LifecycleRegistry::default();
    assert!(r.request(Intent::Exit, labels(), 0).unwrap().is_empty());
    let (main, _) = r.register("main").unwrap();
    let effects = r.set_ready("main", main, true).unwrap();
    assert_eq!(effects.len(), 1);
    assert!(matches!(effects[0], Effect::Flush { generation: 1, .. }));
    assert!(r
        .acknowledge(1, "main", main, true, labels(), 1)
        .unwrap()
        .is_empty());
    let (sticky, _) = r.register("temporary-test").unwrap();
    assert!(matches!(
        r.set_ready("temporary-test", sticky, true).unwrap()[0],
        Effect::Flush { generation: 1, .. }
    ));
    assert_eq!(
        r.acknowledge(1, "temporary-test", sticky, true, labels(), 2)
            .unwrap(),
        vec![Effect::Exit]
    );
}

#[test]
fn remount_cancels_pending_exit_and_old_cleanup_cannot_remove_new_listener() {
    let mut r = LifecycleRegistry::default();
    let (a, _) = r.register("main").unwrap();
    r.set_ready("main", a, true).unwrap();
    r.request(Intent::Exit, vec!["main".into()], 0).unwrap();
    let (b, effects) = r.register("main").unwrap();
    assert!(effects.contains(&Effect::Release {
        generation: 1,
        participant: Participant {
            label: "main".into(),
            registration: a
        }
    }));
    assert!(r.set_ready("main", a, true).is_err());
    r.set_ready("main", a, false).unwrap();
    r.set_ready("main", b, true).unwrap();
    let effects = r.request(Intent::Exit, vec!["main".into()], 1).unwrap();
    assert!(matches!(effects[0], Effect::Flush { generation: 2, .. }));
    assert!(r
        .acknowledge(1, "main", a, true, vec!["main".into()], 2)
        .unwrap()
        .is_empty());
    assert_eq!(
        r.acknowledge(2, "main", b, true, vec!["main".into()], 2)
            .unwrap(),
        vec![Effect::Exit]
    );
}

#[test]
fn window_created_before_last_ack_invalidates_snapshot() {
    let mut r = LifecycleRegistry::default();
    let (main, _) = r.register("main").unwrap();
    r.set_ready("main", main, true).unwrap();
    r.request(Intent::Exit, vec!["main".into()], 0).unwrap();
    let effects = r.acknowledge(1, "main", main, true, labels(), 1).unwrap();
    assert!(!effects.contains(&Effect::Exit));
    assert!(effects.contains(&Effect::ReportFailure { label: None }));
}

#[test]
fn readiness_replay_and_repeated_request_do_not_extend_deadline() {
    let mut r = LifecycleRegistry::default();
    r.request(Intent::Exit, vec!["main".into()], 0).unwrap();
    let (main, _) = r.register("main").unwrap();
    let effects = r.set_ready("main", main, true).unwrap();
    assert_eq!(r.set_ready("main", main, true).unwrap(), effects);
    r.request(Intent::Exit, vec!["main".into()], 9_000).unwrap();
    assert!(r
        .expire(10_000)
        .contains(&Effect::ReportFailure { label: None }));
    assert!(r.set_ready("main", main, true).unwrap().is_empty());
}

#[test]
fn late_ack_cannot_exit_even_if_native_timer_delivery_is_delayed() {
    let mut r = LifecycleRegistry::default();
    let (main, _) = r.register("main").unwrap();
    r.set_ready("main", main, true).unwrap();
    r.request(Intent::Exit, vec!["main".into()], 0).unwrap();
    let effects = r
        .acknowledge(1, "main", main, true, vec!["main".into()], 10_000)
        .unwrap();
    assert!(!effects.contains(&Effect::Exit));
    assert!(effects.contains(&Effect::ReportFailure { label: None }));
}
