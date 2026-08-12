use simple_notes_lib::error::CommandError;
use simple_notes_lib::windows::main::{
    mark_close_listener_ready_with_emit, CloseCompletion, CloseRequestDecision,
    MainWindowCloseCoordinator,
};

#[test]
fn startup_close_waits_until_the_renderer_listener_is_ready() {
    let coordinator = MainWindowCloseCoordinator::default();
    let token = coordinator.begin_renderer_registration().unwrap();

    assert_eq!(
        coordinator.request_close(),
        CloseRequestDecision::WaitForRenderer { generation: 1 }
    );
    assert_eq!(
        coordinator.renderer_ready(token),
        simple_notes_lib::windows::main::ListenerRegistrationDecision::Accepted {
            pending_generation: Some(1)
        }
    );
}

#[test]
fn duplicate_close_reuses_one_generation_and_a_matching_nack_can_retry() {
    let coordinator = MainWindowCloseCoordinator::default();
    let token = coordinator.begin_renderer_registration().unwrap();
    coordinator.renderer_ready(token);

    assert_eq!(
        coordinator.request_close(),
        CloseRequestDecision::RequestFlush { generation: 1 }
    );
    assert_eq!(
        coordinator.request_close(),
        CloseRequestDecision::RequestFlush { generation: 1 }
    );
    assert_eq!(coordinator.complete_close(1, false), CloseCompletion::Retry);
    assert_eq!(
        coordinator.request_close(),
        CloseRequestDecision::RequestFlush { generation: 2 }
    );
}

#[test]
fn stale_ack_or_nack_cannot_complete_a_newer_close_request() {
    let coordinator = MainWindowCloseCoordinator::default();
    let token = coordinator.begin_renderer_registration().unwrap();
    coordinator.renderer_ready(token);
    assert_eq!(
        coordinator.request_close(),
        CloseRequestDecision::RequestFlush { generation: 1 }
    );
    assert_eq!(coordinator.complete_close(1, false), CloseCompletion::Retry);
    assert_eq!(
        coordinator.request_close(),
        CloseRequestDecision::RequestFlush { generation: 2 }
    );

    assert_eq!(coordinator.complete_close(1, true), CloseCompletion::Stale);
    assert_eq!(coordinator.complete_close(1, false), CloseCompletion::Stale);
    assert_eq!(
        coordinator.request_close(),
        CloseRequestDecision::RequestFlush { generation: 2 }
    );
    assert_eq!(
        coordinator.complete_close(2, true),
        CloseCompletion::Approved
    );
    assert_eq!(coordinator.request_close(), CloseRequestDecision::AllowExit);
}

#[test]
fn pending_close_is_reissued_when_the_renderer_listener_remounts() {
    let coordinator = MainWindowCloseCoordinator::default();
    let token_1 = coordinator.begin_renderer_registration().unwrap();
    coordinator.renderer_ready(token_1);
    assert_eq!(
        coordinator.request_close(),
        CloseRequestDecision::RequestFlush { generation: 1 }
    );

    coordinator.renderer_not_ready(token_1);
    assert_eq!(
        coordinator.request_close(),
        CloseRequestDecision::WaitForRenderer { generation: 1 }
    );
    let token_2 = coordinator.begin_renderer_registration().unwrap();
    assert_eq!(
        coordinator.renderer_ready(token_2),
        simple_notes_lib::windows::main::ListenerRegistrationDecision::Accepted {
            pending_generation: Some(1)
        }
    );
}

#[test]
fn failed_ready_reemit_keeps_the_registered_listener_retryable() {
    let coordinator = MainWindowCloseCoordinator::default();
    let token = coordinator.begin_renderer_registration().unwrap();
    assert_eq!(
        coordinator.request_close(),
        CloseRequestDecision::WaitForRenderer { generation: 1 }
    );

    assert!(
        mark_close_listener_ready_with_emit(&coordinator, token, |_| {
            Err(CommandError::io("injected event delivery failure"))
        })
        .is_err()
    );
    assert_eq!(
        coordinator.request_close(),
        CloseRequestDecision::RequestFlush { generation: 1 }
    );
}

#[test]
fn delayed_old_ready_and_cleanup_cannot_replace_the_newer_listener() {
    let coordinator = MainWindowCloseCoordinator::default();
    let token_a = coordinator.begin_renderer_registration().unwrap();
    let token_b = coordinator.begin_renderer_registration().unwrap();
    assert!(token_b > token_a);
    coordinator.renderer_ready(token_b);

    // Registration A's delayed ready arrives after B is already current, then
    // A unmounts. Neither stale operation may replace or clear live B.
    assert_eq!(
        coordinator.renderer_ready(token_a),
        simple_notes_lib::windows::main::ListenerRegistrationDecision::Stale
    );
    coordinator.renderer_not_ready(token_a);

    assert_eq!(
        coordinator.request_close(),
        CloseRequestDecision::RequestFlush { generation: 1 }
    );
}
