pub mod commands;
pub mod config;
pub mod core;
pub mod export;
pub mod logging;
pub mod models;
pub mod parsers;
pub mod persistence;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _guard = logging::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            tracing::info!("CaveChef starting up");

            // Initialize app state
            let app_state = core::state::AppState::new()?;
            app.manage(app_state);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Project commands
            commands::project::create_project,
            commands::project::open_project,
            commands::project::save_project,
            commands::project::close_project,
            commands::project::get_project_state,
            commands::project::list_recent_projects,
            // Section commands
            commands::section::create_section,
            commands::section::update_section,
            commands::section::delete_section,
            commands::section::get_section,
            // Shot commands
            commands::shot::create_shot,
            commands::shot::update_shot,
            commands::shot::delete_shot,
            commands::shot::set_shot_virtual,
            // Station commands
            commands::station::merge_stations,
            commands::station::unmerge_stations,
            commands::station::set_zero_datum,
            commands::station::remove_zero_datum,
            // Undo/Redo
            commands::history::undo,
            commands::history::redo,
            commands::history::can_undo,
            commands::history::can_redo,
            // Import/Export
            commands::import::import_dmp,
            commands::export::export_csv,
            commands::export::export_json,
            commands::export::export_image,
            // Config
            commands::config::get_config,
            commands::config::update_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
