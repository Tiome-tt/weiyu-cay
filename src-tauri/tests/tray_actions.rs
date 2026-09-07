use simple_notes_lib::windows::tray::{
    parse_tray_action, NavigationAction, NavigationQueue, TrayAction, TRAY_MENU_ORDER,
};

#[test]
fn tray_menu_ids_map_only_to_the_approved_actions() {
    assert_eq!(parse_tray_action("open"), Some(TrayAction::Open));
    assert_eq!(
        parse_tray_action("new-temporary"),
        Some(TrayAction::NewTemporary)
    );
    assert_eq!(
        parse_tray_action("temporary-inbox"),
        Some(TrayAction::TemporaryInbox)
    );
    assert_eq!(parse_tray_action("settings"), Some(TrayAction::Settings));
    assert_eq!(parse_tray_action("exit"), Some(TrayAction::Exit));
    assert_eq!(parse_tray_action("delete-note"), None);
    assert_eq!(parse_tray_action("../settings"), None);
}

#[test]
fn navigation_waits_for_the_main_listener_and_replays_only_the_latest_action() {
    let mut queue = NavigationQueue::default();
    assert_eq!(queue.submit(NavigationAction::Settings), None);
    assert_eq!(queue.submit(NavigationAction::TemporaryInbox), None);
    assert_eq!(
        queue.set_ready(true),
        Some(NavigationAction::TemporaryInbox)
    );
    assert_eq!(
        queue.submit(NavigationAction::Settings),
        Some(NavigationAction::Settings)
    );
    assert_eq!(queue.set_ready(false), None);
}

#[test]
fn windows_keeps_the_recovery_tray_visible_while_macos_respects_its_menu_bar_setting() {
    use simple_notes_lib::windows::tray::desired_visibility;

    assert!(desired_visibility(false, false));
    assert!(desired_visibility(false, true));
    assert!(!desired_visibility(true, false));
    assert!(desired_visibility(true, true));
}

#[test]
fn tray_menu_order_keeps_destructive_exit_last() {
    assert_eq!(
        TRAY_MENU_ORDER,
        [
            Some(TrayAction::Open),
            Some(TrayAction::NewTemporary),
            Some(TrayAction::TemporaryInbox),
            None,
            Some(TrayAction::Settings),
            None,
            Some(TrayAction::Exit),
        ]
    );
}
