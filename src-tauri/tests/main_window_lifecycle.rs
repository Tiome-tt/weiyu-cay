use simple_notes_lib::error::CommandError;
use simple_notes_lib::windows::main::{
    mark_close_listener_ready_with_emit, CloseCompletion, CloseRequestDecision,
    MainWindowCloseCoordinator,
};

#[test]
fn startup_close_waits_until_the_renderer_listener_is_ready() {
    let coordinator = MainWindowCloseCoordinator::default();

    assert_eq!(
        coordinator.request_close(),
        CloseRequestDecision::WaitForRenderer { generation: 1 }
    );
    assert_eq!(coordinator.renderer_ready("listener-1"), Some(1));
}

#[test]
fn duplicate_close_reuses_one_generation_and_a_matching_nack_can_retry() {
    let coordinator = MainWindowCloseCoordinator::default();
    assert_eq!(coordinator.renderer_ready("listener-1"), None);

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
    coordinator.renderer_ready("listener-1");
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
    coordinator.renderer_ready("listener-1");
    assert_eq!(
        coordinator.request_close(),
        CloseRequestDecision::RequestFlush { generation: 1 }
    );

    coordinator.renderer_not_ready("listener-1");
    assert_eq!(
        coordinator.request_close(),
        CloseRequestDecision::WaitForRenderer { generation: 1 }
    );
    assert_eq!(coordinator.renderer_ready("listener-2"), Some(1));
}

#[test]
fn failed_ready_reemit_keeps_the_registered_listener_retryable() {
    let coordinator = MainWindowCloseCoordinator::default();
    assert_eq!(
        coordinator.request_close(),
        CloseRequestDecision::WaitForRenderer { generation: 1 }
    );

    assert!(
        mark_close_listener_ready_with_emit(&coordinator, "listener-1", |_| {
            Err(CommandError::io("injected event delivery failure"))
        })
        .is_err()
    );
    assert_eq!(
        coordinator.request_close(),
        CloseRequestDecision::RequestFlush { generation: 1 }
    );
}
