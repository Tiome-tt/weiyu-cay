use simple_notes_lib::windows::main::{CloseRequestDecision, MainWindowCloseCoordinator};

#[test]
fn native_close_waits_for_one_renderer_ack_and_a_failed_flush_can_retry() {
    let coordinator = MainWindowCloseCoordinator::default();

    assert_eq!(
        coordinator.request_close(),
        CloseRequestDecision::RequestFlush
    );
    assert_eq!(
        coordinator.request_close(),
        CloseRequestDecision::WaitForFlush
    );
    assert!(!coordinator.complete_close(false));
    assert_eq!(
        coordinator.request_close(),
        CloseRequestDecision::RequestFlush
    );
    assert!(coordinator.complete_close(true));
    assert_eq!(coordinator.request_close(), CloseRequestDecision::AllowExit);
    assert_eq!(coordinator.request_close(), CloseRequestDecision::AllowExit);
}
