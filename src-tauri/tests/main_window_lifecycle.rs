use simple_notes_lib::windows::lifecycle::Intent;
use simple_notes_lib::windows::main::{main_close_action, MainCloseAction};
use simple_notes_lib::windows::{
    lifecycle::Phase,
    main::{authorize_lifecycle_window_label, lifecycle_mutations_allowed},
};

#[test]
fn lifecycle_registration_accepts_only_editor_window_labels() {
    assert!(authorize_lifecycle_window_label("main").is_ok());
    assert!(
        authorize_lifecycle_window_label("temporary-019c0000-0000-7000-8000-000000000001").is_ok()
    );
    assert!(authorize_lifecycle_window_label("settings").is_err());
    assert!(authorize_lifecycle_window_label("temporary-invalid").is_err());
}

#[test]
fn main_close_action_preserves_platform_semantics_and_never_hides_without_recovery() {
    assert_eq!(
        main_close_action(false, false, true, true),
        MainCloseAction::Prompt
    );
    assert_eq!(
        main_close_action(false, true, true, true),
        MainCloseAction::Lifecycle(Intent::Hide)
    );
    assert_eq!(
        main_close_action(false, true, false, true),
        MainCloseAction::Lifecycle(Intent::Exit)
    );
    assert_eq!(
        main_close_action(false, true, true, false),
        MainCloseAction::Prompt
    );
    assert_eq!(
        main_close_action(true, false, true, false),
        MainCloseAction::Lifecycle(Intent::Hide)
    );
}

#[test]
fn sticky_identity_cannot_be_confused_by_a_valid_uuid_suffix() {
    assert!(
        authorize_lifecycle_window_label("other-019c0000-0000-7000-8000-000000000001").is_err()
    );
}

#[test]
fn new_content_is_gated_only_during_terminal_lifecycle_phases() {
    for phase in [Phase::Visible, Phase::PreparingHide, Phase::Hidden] {
        assert!(lifecycle_mutations_allowed(phase));
    }
    for phase in [Phase::PreparingExit, Phase::Exiting] {
        assert!(!lifecycle_mutations_allowed(phase));
    }
}
