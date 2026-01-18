pub mod commands;
pub mod config;
pub mod core;
pub mod export;
pub mod logging;
pub mod models;
pub mod parsers;
pub mod persistence;

use tauri::{Manager, Emitter};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _guard = logging::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            // Intercept window close requests to allow the frontend to show confirmation dialogs
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Prevent the default close behavior
                api.prevent_close();
                // Emit the close-requested event so the frontend can handle it
                if let Err(e) = window.emit("tauri://close-requested", ()) {
                    tracing::error!("Failed to emit close-requested event: {}", e);
                    // If we can't emit the event, allow the close to proceed
                    // by destroying the window
                    if let Err(destroy_err) = window.destroy() {
                        tracing::error!("Failed to destroy window: {}", destroy_err);
                    }
                }
            }
        })
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
            commands::project::remove_from_recent_projects,
            commands::project::merge_projects,
            // Section commands
            commands::section::create_section,
            commands::section::update_section,
            commands::section::delete_section,
            commands::section::get_section,
            commands::section::move_section,
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
            commands::station::move_station,
            // Undo/Redo
            commands::history::undo,
            commands::history::redo,
            commands::history::can_undo,
            commands::history::can_redo,
            // Import/Export
            commands::import::import_dmp,
            commands::import::calculate_file_hash,
            commands::import::check_duplicate_import,
            commands::import::track_imported_file,
            commands::export::export_csv,
            commands::export::export_json,
            commands::export::export_image,
            // Config
            commands::config::get_config,
            commands::config::update_config,
            commands::config::update_panel_sizes,
            // Display settings (per-project)
            commands::config::load_display_settings,
            commands::config::save_display_setting,
            commands::config::get_display_setting,
            // Validation
            commands::validation::get_project_warnings,
            commands::validation::resolve_warning,
            commands::validation::unresolve_warning,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
