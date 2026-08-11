pub mod commands;
pub mod domain;
pub mod error;
pub mod platform;
pub mod shortcuts;
pub mod storage;
pub mod windows;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shortcut_dispatcher = commands::shortcuts::PluginEventDispatcher::default();
    let plugin_dispatcher = shortcut_dispatcher.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |_app, shortcut, event| {
                    let event = match event.state {
                        tauri_plugin_global_shortcut::ShortcutState::Pressed => {
                            shortcuts::ShortcutEvent::Pressed
                        }
                        tauri_plugin_global_shortcut::ShortcutState::Released => {
                            shortcuts::ShortcutEvent::Released
                        }
                    };
                    let _ = plugin_dispatcher.dispatch(commands::shortcuts::PluginShortcutEvent {
                        shortcut_identity: shortcuts::ShortcutIdentity::from_shortcut(shortcut),
                        event,
                    });
                })
                .build(),
        )
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            app.manage(windows::main::MainWindowCloseCoordinator::default());
            commands::settings::setup(app)?;
            commands::updates::setup(app);
            let readiness = storage::recovery::StartupRecoveryReadiness::new();
            commands::storage::setup(app, readiness.clone())?;
            let paths = app
                .state::<commands::settings::SettingsCommandState>()
                .paths()
                .clone();
            let startup_recovery =
                storage::recovery::StartupRecoveryState::initialize(paths.clone(), readiness);
            app.manage(startup_recovery);
            commands::notes::setup(app)?;
            commands::temporary::setup(app)?;
            if app
                .state::<commands::storage::StorageCommandState>()
                .readiness()
                .ensure_ready()
                .is_ok()
            {
                commands::settings::finalize_reopened_relocation(&paths)?;
            }
            commands::shortcuts::setup(app, shortcut_dispatcher.clone())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::notes::create_note,
            commands::notes::load_note,
            commands::notes::save_note,
            commands::notes::list_notes,
            commands::notes::rename_note,
            commands::notes::move_note,
            commands::notes::trash_notes,
            commands::notes::list_trash,
            commands::notes::restore_trash,
            commands::notes::undo_trash,
            commands::notes::purge_expired_trash,
            commands::notes::resolve_link,
            commands::notes::list_link_targets,
            commands::notes::backlinks,
            commands::notes::rename_target_labels,
            commands::assets::save_image,
            commands::assets::read_image_asset,
            commands::external::open_external_link,
            commands::folders::list_folders,
            commands::folders::create_folder,
            commands::folders::rename_folder,
            commands::folders::move_folder,
            commands::folders::delete_empty_folder,
            commands::search::search_notes,
            commands::search::update_note_tags,
            commands::temporary::create_temporary,
            commands::temporary::load_temporary,
            commands::temporary::save_temporary,
            commands::temporary::list_temporary,
            commands::temporary::convert_temporary,
            commands::temporary::delete_temporary,
            commands::temporary::undo_delete,
            commands::temporary::show_temporary_window,
            commands::temporary::hide_temporary_window,
            commands::temporary::set_temporary_always_on_top,
            commands::shortcuts::get_capture_shortcut,
            commands::shortcuts::rebind_capture_shortcut,
            commands::settings::load_settings,
            commands::settings::load_sticky_settings,
            commands::settings::update_settings,
            commands::settings::reset_settings,
            commands::settings::get_storage_info,
            commands::storage::startup_recovery_report,
            commands::storage::retry_startup_recovery,
            commands::updates::check_for_update,
            commands::updates::install_pending_update,
            commands::updates::restart_after_update,
            commands::settings::move_storage_root,
            commands::settings::restart_application,
            commands::export::export_library,
            windows::main::complete_main_window_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|app_handle, event| {
        let coordinator = app_handle.state::<windows::main::MainWindowCloseCoordinator>();
        let lifecycle = match event {
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } if label == windows::main::MAIN_WINDOW_LABEL => {
                match windows::main::request_renderer_flush(app_handle, &coordinator) {
                    windows::main::CloseRequestDecision::AllowExit => {}
                    windows::main::CloseRequestDecision::RequestFlush
                    | windows::main::CloseRequestDecision::WaitForFlush => api.prevent_close(),
                }
                None
            }
            tauri::RunEvent::ExitRequested { code, api, .. }
                if code != Some(tauri::RESTART_EXIT_CODE) =>
            {
                match windows::main::request_renderer_flush(app_handle, &coordinator) {
                    windows::main::CloseRequestDecision::AllowExit => {
                        Some(windows::sticky::AppLifecycleEvent::ExitRequested)
                    }
                    windows::main::CloseRequestDecision::RequestFlush
                    | windows::main::CloseRequestDecision::WaitForFlush => {
                        api.prevent_exit();
                        None
                    }
                }
            }
            tauri::RunEvent::ExitRequested { .. } => {
                Some(windows::sticky::AppLifecycleEvent::ExitRequested)
            }
            tauri::RunEvent::Exit => Some(windows::sticky::AppLifecycleEvent::Exit),
            _ => None,
        };
        if lifecycle.is_some() {
            if let Some(state) = app_handle.try_state::<commands::shortcuts::CaptureShortcutState>()
            {
                state.shutdown();
            }
        }
        if let (Some(lifecycle), Some(state)) = (
            lifecycle,
            app_handle.try_state::<commands::temporary::TemporaryCommandState>(),
        ) {
            state.mark_lifecycle(lifecycle);
        }
    });
}
