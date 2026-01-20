pub mod cache;
pub mod commands;
pub mod config;
pub mod core;
pub mod export;
pub mod logging;
pub mod models;
pub mod parsers;
pub mod persistence;

use std::time::Duration;
use tauri::{Emitter, Manager};

/// ESRI World Imagery tile server base URL
const ESRI_TILE_URL: &str = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile";

/// HTTP request timeout for tile fetches
const TILE_FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// Fetches a tile from the ESRI server
fn fetch_tile_from_network(z: u32, y: u32, x: u32) -> Result<(Vec<u8>, String), String> {
    let url = format!("{}/{}/{}/{}", ESRI_TILE_URL, z, y, x);
    tracing::debug!(url = %url, "Fetching tile from network");

    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(TILE_FETCH_TIMEOUT))
        .build()
        .new_agent();

    let response = agent
        .get(&url)
        .call()
        .map_err(|e| format!("Network error: {}", e))?;

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();

    let body = response
        .into_body()
        .read_to_vec()
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    Ok((body, content_type))
}

/// Parses tile coordinates from a URI path like /esri/z/y/x
fn parse_tile_path(path: &str) -> Option<(&str, u32, u32, u32)> {
    // Path format: /esri/{z}/{y}/{x} or /esri/{z}/{y}/{x}.jpg etc.
    let path = path.trim_start_matches('/');
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() < 4 {
        return None;
    }

    let provider = parts[0];
    let z: u32 = parts[1].parse().ok()?;
    let y: u32 = parts[2].parse().ok()?;
    // Remove any extension from x (e.g., "123.jpg" -> "123")
    let x_str = parts[3].split('.').next()?;
    let x: u32 = x_str.parse().ok()?;

    Some((provider, z, y, x))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _guard = logging::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol("cavechef-tiles", |ctx, request, responder| {
            let path = request.uri().path().to_string();
            let state = ctx.app_handle().state::<core::state::AppState>();
            let tile_cache = state.tile_cache().clone();

            std::thread::spawn(move || {
                // Parse the tile coordinates from the path
                let Some((provider, z, y, x)) = parse_tile_path(&path) else {
                    tracing::warn!(path = %path, "Invalid tile path format");
                    responder.respond(
                        http::Response::builder()
                            .status(http::StatusCode::BAD_REQUEST)
                            .header(http::header::CONTENT_TYPE, "text/plain")
                            .body("Invalid tile path format".as_bytes().to_vec())
                            .unwrap(),
                    );
                    return;
                };

                tracing::debug!(provider = %provider, z = z, y = y, x = x, "Processing tile request");

                // Check cache first
                let cached_tile = {
                    if let Ok(mut cache_guard) = tile_cache.lock() {
                        if let Some(cache) = cache_guard.as_mut() {
                            cache.get(provider, z, y, x)
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                };

                if let Some(entry) = cached_tile {
                    tracing::debug!(provider = %provider, z = z, y = y, x = x, "Cache hit");
                    responder.respond(
                        http::Response::builder()
                            .status(http::StatusCode::OK)
                            .header(http::header::CONTENT_TYPE, &entry.content_type)
                            .body(entry.data)
                            .unwrap(),
                    );
                    return;
                }

                // Cache miss - fetch from network
                tracing::debug!(provider = %provider, z = z, y = y, x = x, "Cache miss, fetching from network");
                match fetch_tile_from_network(z, y, x) {
                    Ok((data, content_type)) => {
                        // Store in cache
                        if let Ok(mut cache_guard) = tile_cache.lock() {
                            if let Some(cache) = cache_guard.as_mut() {
                                if let Err(e) = cache.put(provider, z, y, x, &data, &content_type) {
                                    tracing::warn!(error = %e, "Failed to cache tile");
                                }
                            }
                        }

                        responder.respond(
                            http::Response::builder()
                                .status(http::StatusCode::OK)
                                .header(http::header::CONTENT_TYPE, &content_type)
                                .body(data)
                                .unwrap(),
                        );
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, provider = %provider, z = z, y = y, x = x, "Failed to fetch tile");
                        // Return 404 for cache miss when offline
                        responder.respond(
                            http::Response::builder()
                                .status(http::StatusCode::NOT_FOUND)
                                .header(http::header::CONTENT_TYPE, "text/plain")
                                .body(format!("Tile not available: {}", e).into_bytes())
                                .unwrap(),
                        );
                    }
                }
            });
        })
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
            commands::section::create_section_and_merge,
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
