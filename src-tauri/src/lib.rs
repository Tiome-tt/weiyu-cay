pub mod commands;
pub mod domain;
pub mod error;
pub mod platform;
pub mod storage;
pub mod windows;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            commands::notes::setup(app)?;
            commands::folders::setup(app)?;
            commands::temporary::setup(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::notes::create_note,
            commands::notes::load_note,
            commands::notes::save_note,
            commands::notes::list_notes,
            commands::notes::move_note,
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
            commands::temporary::show_temporary_window,
            commands::temporary::hide_temporary_window,
            commands::temporary::set_temporary_always_on_top,
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
        if let (Some(lifecycle), Some(state)) = (
            lifecycle,
            app_handle.try_state::<commands::temporary::TemporaryCommandState>(),
        ) {
            state.mark_lifecycle(lifecycle);
        }
    });
}
