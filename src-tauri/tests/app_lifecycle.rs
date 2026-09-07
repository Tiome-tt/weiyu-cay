use simple_notes_lib::windows::lifecycle::{
    Effect, Intent, LifecycleCoordinator, Participant, Phase,
};

#[test]
fn lifecycle_intents_use_the_renderer_wire_format() {
    assert_eq!(serde_json::to_value(Intent::Hide).unwrap(), "hide");
    assert_eq!(serde_json::to_value(Intent::Exit).unwrap(), "exit");
    assert_eq!(serde_json::to_value(Intent::Restart).unwrap(), "restart");
    assert_eq!(serde_json::to_value(Intent::Relocate).unwrap(), "relocate");
}

#[test]
fn relocation_holds_every_editor_barrier_until_it_is_cancelled_or_restarted() {
    let mut c = LifecycleCoordinator::new();
    c.request(Intent::Relocate, vec![main_window(), sticky()], 0);
    assert!(c.acknowledge(1, &main_window(), true).is_empty());
    assert_eq!(
        c.acknowledge(1, &sticky(), true),
        vec![Effect::Prepared { generation: 1 }]
    );
    assert_eq!(c.phase(), Phase::PreparingExit);
    assert!(c.expire(10_000).is_empty());

    let effects = c.commit_prepared_relocation();
    assert_eq!(effects, vec![Effect::Restart]);
    assert_eq!(c.phase(), Phase::Exiting);
}

#[test]
fn cancelling_a_prepared_relocation_releases_all_editors_without_restarting() {
    let mut c = LifecycleCoordinator::new();
    c.request(Intent::Relocate, vec![main_window(), sticky()], 0);
    c.acknowledge(1, &main_window(), true);
    c.acknowledge(1, &sticky(), true);

    let effects = c.cancel(1);
    for participant in [main_window(), sticky()] {
        assert!(effects.contains(&Effect::Release {
            generation: 1,
            participant,
        }));
    }
    assert!(!effects.contains(&Effect::Restart));
    assert_eq!(c.phase(), Phase::Visible);
}

fn main_window() -> Participant {
    Participant {
        label: "main".into(),
        registration: 1,
    }
}
fn sticky() -> Participant {
    Participant {
        label: "temporary-test".into(),
        registration: 2,
    }
}

#[test]
fn hidden_sticky_must_acknowledge_before_exit() {
    let mut c = LifecycleCoordinator::new();
    c.request(Intent::Exit, vec![main_window(), sticky()], 0);
    assert!(!c
        .acknowledge(1, &main_window(), true)
        .contains(&Effect::Exit));
    assert!(c.acknowledge(1, &sticky(), true).contains(&Effect::Exit));
    assert_eq!(c.phase(), Phase::Exiting);
}

#[test]
fn hiding_only_waits_for_main_and_never_authorizes_exit() {
    let mut c = LifecycleCoordinator::new();
    let effects = c.request(Intent::Hide, vec![main_window(), sticky()], 0);
    assert_eq!(
        effects,
        vec![Effect::Flush {
            generation: 1,
            intent: Intent::Hide,
            participant: main_window(),
        }]
    );
    let effects = c.acknowledge(1, &main_window(), true);
    assert!(effects.contains(&Effect::HideMain { generation: 1 }));
    assert!(!effects.contains(&Effect::Release {
        generation: 1,
        participant: main_window()
    }));
    assert!(!effects.contains(&Effect::Exit));
    assert_eq!(c.phase(), Phase::PreparingHide);
    let effects = c.confirm_hide(1, true);
    assert!(effects.contains(&Effect::Release {
        generation: 1,
        participant: main_window()
    }));
    assert_eq!(c.phase(), Phase::Hidden);
    assert_eq!(c.activate(), vec![Effect::ShowMain]);
    assert_eq!(c.phase(), Phase::Visible);
    assert!(!c
        .request(Intent::Exit, vec![main_window()], 10)
        .contains(&Effect::Exit));
}

#[test]
fn failed_native_hide_restores_visible_state_and_releases_the_barrier() {
    let mut c = LifecycleCoordinator::new();
    c.request(Intent::Hide, vec![main_window()], 0);
    assert_eq!(
        c.acknowledge(1, &main_window(), true),
        vec![Effect::HideMain { generation: 1 }]
    );

    let effects = c.confirm_hide(1, false);
    assert!(effects.contains(&Effect::Release {
        generation: 1,
        participant: main_window(),
    }));
    assert!(effects.contains(&Effect::ShowMain));
    assert!(effects.contains(&Effect::ReportFailure { label: None }));
    assert_eq!(c.phase(), Phase::Visible);
}

#[test]
fn invalid_acknowledgments_cannot_complete_exit() {
    let mut c = LifecycleCoordinator::new();
    c.request(Intent::Exit, vec![main_window(), sticky()], 0);
    let forged = Participant {
        label: "main".into(),
        registration: 99,
    };
    assert!(c.acknowledge(1, &forged, true).is_empty());
    assert!(c.acknowledge(99, &main_window(), true).is_empty());
    assert!(c.acknowledge(1, &main_window(), true).is_empty());
    assert!(c.acknowledge(1, &main_window(), true).is_empty());
    assert!(c.acknowledge(1, &sticky(), true).contains(&Effect::Exit));
    assert!(c.acknowledge(1, &sticky(), true).is_empty());
}

#[test]
fn failed_save_releases_every_participant_and_allows_retry() {
    let mut c = LifecycleCoordinator::new();
    c.request(Intent::Exit, vec![main_window(), sticky()], 0);
    let effects = c.acknowledge(1, &sticky(), false);
    for participant in [main_window(), sticky()] {
        assert!(effects.contains(&Effect::Release {
            generation: 1,
            participant
        }));
    }
    assert!(effects.contains(&Effect::ShowMain));
    assert!(effects.contains(&Effect::ReportFailure {
        label: Some(sticky().label)
    }));
    assert_eq!(c.phase(), Phase::Visible);
    c.request(Intent::Exit, vec![main_window()], 1);
    assert!(c.acknowledge(1, &main_window(), true).is_empty());
    assert!(c
        .acknowledge(2, &main_window(), true)
        .contains(&Effect::Exit));
}

#[test]
fn deadline_cancels_instead_of_exiting_and_ignores_late_ack() {
    let mut c = LifecycleCoordinator::new();
    c.request(Intent::Exit, vec![main_window(), sticky()], 50);
    assert!(c.expire(10_049).is_empty());
    let effects = c.expire(10_050);
    assert!(effects.contains(&Effect::Release {
        generation: 1,
        participant: sticky()
    }));
    assert!(!effects.contains(&Effect::Exit));
    assert_eq!(c.phase(), Phase::Visible);
    assert!(c.acknowledge(1, &main_window(), true).is_empty());
    assert!(c.expire(50_000).is_empty());
}

#[test]
fn activating_while_preparing_hide_cancels_the_hidden_outcome() {
    let mut c = LifecycleCoordinator::new();
    c.request(Intent::Hide, vec![main_window()], 0);
    let effects = c.activate();
    assert!(effects.contains(&Effect::Release {
        generation: 1,
        participant: main_window()
    }));
    assert!(effects.contains(&Effect::ShowMain));
    assert!(!c
        .acknowledge(1, &main_window(), true)
        .contains(&Effect::HideMain { generation: 1 }));
}

#[test]
fn exit_supersedes_hide_but_repeated_exit_does_not_restart_deadline() {
    let mut c = LifecycleCoordinator::new();
    c.request(Intent::Hide, vec![main_window()], 0);
    let effects = c.request(Intent::Exit, vec![main_window(), sticky()], 100);
    assert!(effects.contains(&Effect::Release {
        generation: 1,
        participant: main_window()
    }));
    assert!(effects.contains(&Effect::Flush {
        generation: 2,
        intent: Intent::Exit,
        participant: sticky(),
    }));
    assert!(c
        .request(Intent::Exit, vec![main_window(), sticky()], 500)
        .is_empty());
    assert!(c.request(Intent::Hide, vec![main_window()], 600).is_empty());
    assert!(!c.expire(10_100).is_empty());
}

#[test]
fn changed_window_registration_cancels_the_snapshot() {
    let mut c = LifecycleCoordinator::new();
    c.request(Intent::Exit, vec![main_window()], 0);
    let replacement = Participant {
        label: "main".into(),
        registration: 3,
    };
    let effects = c.request(Intent::Exit, vec![replacement], 10);
    assert!(effects.contains(&Effect::Release {
        generation: 1,
        participant: main_window()
    }));
    assert_eq!(c.phase(), Phase::Visible);
    assert!(!c
        .acknowledge(1, &main_window(), true)
        .contains(&Effect::Exit));
}

#[test]
fn empty_or_unready_main_does_not_exit() {
    let mut c = LifecycleCoordinator::new();
    assert!(!c.request(Intent::Exit, vec![], 0).contains(&Effect::Exit));
    let unready = Participant {
        label: "main".into(),
        registration: 0,
    };
    assert!(!c
        .request(Intent::Exit, vec![unready.clone()], 1)
        .contains(&Effect::Exit));
    assert!(!c.acknowledge(1, &unready, true).contains(&Effect::Exit));
}

#[test]
fn restart_is_distinct_from_exit_and_cancel_is_generation_scoped() {
    let mut c = LifecycleCoordinator::new();
    c.request(Intent::Restart, vec![main_window()], 0);
    assert!(c.cancel(999).is_empty());
    let effects = c.acknowledge(1, &main_window(), true);
    assert!(effects.contains(&Effect::Restart));
    assert!(!effects.contains(&Effect::Exit));
    assert!(c.request(Intent::Hide, vec![main_window()], 1).is_empty());
}

#[test]
fn competing_terminal_intents_still_validate_the_window_snapshot() {
    for (first, second) in [
        (Intent::Exit, Intent::Restart),
        (Intent::Restart, Intent::Exit),
    ] {
        let mut c = LifecycleCoordinator::new();
        c.request(first, vec![main_window()], 0);
        let effects = c.request(second, vec![main_window(), sticky()], 1);
        assert!(effects.contains(&Effect::ReportFailure { label: None }));
        assert!(c.acknowledge(1, &main_window(), true).is_empty());
    }
}

#[test]
fn cancelling_exit_from_hidden_restores_visible_window() {
    let mut c = LifecycleCoordinator::new();
    c.request(Intent::Hide, vec![main_window()], 0);
    c.acknowledge(1, &main_window(), true);
    c.confirm_hide(1, true);
    c.request(Intent::Exit, vec![main_window()], 1);
    assert!(c.cancel(2).contains(&Effect::ShowMain));
    assert_eq!(c.phase(), Phase::Visible);
}
