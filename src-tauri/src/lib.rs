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
            commands::settings::setup(app)?;
            commands::storage::setup(app)?;
            let paths = app
                .state::<commands::settings::SettingsCommandState>()
                .paths()
                .clone();
            commands::settings::finalize_reopened_relocation(&paths)?;
            commands::notes::setup(app)?;
            commands::temporary::setup(app)?;
            commands::shortcuts::setup(app, shortcut_dispatcher.clone())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::notes::create_note,
            commands::notes::load_note,
            commands::notes::save_note,
            commands::notes::list_notes,
            commands::notes::move_note,
            commands::notes::trash_notes,
            commands::notes::list_trash,
            commands::notes::restore_trash,
            commands::notes::undo_trash,
            commands::notes::purge_expired_trash,
            commands::notes::resolve_link,
            commands::notes::backlinks,
            commands::notes::rename_target_labels,
            commands::assets::save_image,
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
            commands::settings::update_settings,
            commands::settings::reset_settings,
            commands::settings::get_storage_info,
            commands::settings::move_storage_root,
            commands::settings::restart_application,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|app_handle, event| {
        let lifecycle = match event {
            tauri::RunEvent::ExitRequested { .. } => {
                Some(windows::sticky::AppLifecycleEvent::ExitRequested)
            }
            tauri::RunEvent::Exit => Some(windows::sticky::AppLifecycleEvent::Exit),
            _ => None,
        };
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
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
