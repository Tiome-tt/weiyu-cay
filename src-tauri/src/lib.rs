pub mod commands;
pub mod domain;
pub mod error;
pub mod platform;
pub mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            commands::notes::setup(app)?;
            commands::folders::setup(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::notes::create_note,
            commands::notes::load_note,
            commands::notes::save_note,
            commands::notes::list_notes,
            commands::notes::move_note,
            commands::assets::save_image,
            commands::folders::list_folders,
            commands::folders::create_folder,
            commands::folders::rename_folder,
            commands::folders::move_folder,
            commands::folders::delete_empty_folder,
            commands::search::search_notes,
            commands::search::update_note_tags,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
