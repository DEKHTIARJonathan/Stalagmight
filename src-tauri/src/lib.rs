pub mod cache;
pub mod commands;
pub mod config;
pub mod core;
pub mod export;
pub mod logging;
pub mod models;
pub mod parsers;
pub mod persistence;
#[cfg(test)]
pub mod test_helpers;
pub mod tile_providers;

use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

use cache::TileCache;

/// HTTP request timeout for tile fetches
const TILE_FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// Allowed content types for tile responses (whitelist for security)
const ALLOWED_CONTENT_TYPES: &[&str] = &["image/jpeg", "image/jpg", "image/png"];

/// Default content type when upstream doesn't provide one or it's invalid
const DEFAULT_CONTENT_TYPE: &str = "image/jpeg";

/// Fetches a tile from the network based on provider
fn fetch_tile_from_network(provider: &str, z: u32, y: u32, x: u32) -> Result<(Vec<u8>, String), String> {
    // Look up provider in registry
    let tile_provider = tile_providers::get_provider(provider)
        .ok_or_else(|| format!("Unknown provider: {}", provider))?;
    let url = tile_providers::expand_url(tile_provider, z, y, x);

    tracing::debug!(url = %url, provider = %provider, "Fetching tile from network");

    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(TILE_FETCH_TIMEOUT))
        .build()
        .new_agent();

    let response = agent
        .get(&url)
        .call()
        .map_err(|e| format!("Network error: {}", e))?;

    // Sanitize content type - only allow whitelisted image types
    let raw_content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or(DEFAULT_CONTENT_TYPE);

    let content_type = sanitize_content_type(raw_content_type);

    let body = response
        .into_body()
        .read_to_vec()
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    Ok((body, content_type))
}

/// Sanitize content type to only allow whitelisted image types
fn sanitize_content_type(raw: &str) -> String {
    // Extract the base content type (before any ; parameters like charset)
    let base = raw.split(';').next().unwrap_or(raw).trim().to_lowercase();

    if ALLOWED_CONTENT_TYPES.contains(&base.as_str()) {
        base
    } else {
        DEFAULT_CONTENT_TYPE.to_string()
    }
}

/// Parses tile coordinates from a URI.
/// Supports both path-based (/esri/z/y/x) and host-based (esri/{z}/{y}/{x}) formats.
///
/// Path-based: `cavechef-tiles://localhost/esri/10/500/250`
/// Host-based: `cavechef-tiles://esri/10/500/250`
///
/// Returns None for malformed URIs.
fn parse_tile_uri(uri: &http::Uri) -> Option<(String, u32, u32, u32)> {
    let path = uri.path().trim_start_matches('/');
    let mut segments = path.split('/');

    // Try path-based format first: /esri/{z}/{y}/{x}
    let first = segments.next()?;

    // Check if first segment is a provider or a number (z coordinate)
    if let Ok(z) = first.parse::<u32>() {
        // Host-based format: provider is in host, path is /{z}/{y}/{x}
        // Host is REQUIRED for this format - reject malformed URIs without host
        let host = uri.host()?;
        if host.is_empty() || host == "localhost" {
            // No valid provider in host, reject
            return None;
        }
        let provider = host.to_string();

        let y: u32 = segments.next()?.parse().ok()?;
        let x_str = segments.next()?.split('.').next()?;
        let x: u32 = x_str.parse().ok()?;

        Some((provider, z, y, x))
    } else {
        // Path-based format: /esri/{z}/{y}/{x}
        let provider = first.to_string();
        let z: u32 = segments.next()?.parse().ok()?;
        let y: u32 = segments.next()?.parse().ok()?;
        let x_str = segments.next()?.split('.').next()?;
        let x: u32 = x_str.parse().ok()?;

        Some((provider, z, y, x))
    }
}

/// Build a successful HTTP response with proper error handling
fn build_ok_response(data: Vec<u8>, content_type: &str) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(http::StatusCode::OK)
        .header(http::header::CONTENT_TYPE, content_type)
        .header(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(data)
        .unwrap_or_else(|_| {
            // Fallback response if builder fails
            http::Response::builder()
                .status(http::StatusCode::INTERNAL_SERVER_ERROR)
                .header(http::header::CONTENT_TYPE, "text/plain")
                .header(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(b"Internal error building response".to_vec())
                .unwrap()
        })
}

/// Build an error HTTP response with proper error handling
fn build_error_response(status: http::StatusCode, message: &str) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, "text/plain")
        .header(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(message.as_bytes().to_vec())
        .unwrap_or_else(|_| {
            http::Response::builder()
                .status(http::StatusCode::INTERNAL_SERVER_ERROR)
                .header(http::header::CONTENT_TYPE, "text/plain")
                .header(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(b"Internal error".to_vec())
                .unwrap()
        })
}

/// Handle a tile request - check cache, fetch from network, return response
fn handle_tile_request(
    provider: &str,
    z: u32,
    y: u32,
    x: u32,
    tile_cache: &Arc<Mutex<Option<TileCache>>>,
) -> http::Response<Vec<u8>> {
    handle_tile_request_with_fetcher(provider, z, y, x, tile_cache, fetch_tile_from_network)
}

/// Internal implementation that accepts a fetch function for testability.
/// The fetch function signature: (provider, z, y, x) -> Result<(data, content_type), error_message>
fn handle_tile_request_with_fetcher<F>(
    provider: &str,
    z: u32,
    y: u32,
    x: u32,
    tile_cache: &Arc<Mutex<Option<TileCache>>>,
    fetch_fn: F,
) -> http::Response<Vec<u8>>
where
    F: FnOnce(&str, u32, u32, u32) -> Result<(Vec<u8>, String), String>,
{
    // Validate provider against registry
    if tile_providers::get_provider(provider).is_none() {
        tracing::warn!(provider = %provider, "Unknown tile provider requested");
        return build_error_response(
            http::StatusCode::BAD_REQUEST,
            &format!("Unknown provider: {}", provider),
        );
    }

    // Check cache first (fresh tiles)
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
        tracing::debug!(provider = %provider, z = z, y = y, x = x, "Cache hit (fresh)");
        return build_ok_response(entry.data, &entry.content_type);
    }

    // Cache miss - fetch from network
    tracing::debug!(provider = %provider, z = z, y = y, x = x, "Cache miss, fetching from network");
    match fetch_fn(provider, z, y, x) {
        Ok((data, content_type)) => {
            // Store in cache
            if let Ok(mut cache_guard) = tile_cache.lock() {
                if let Some(cache) = cache_guard.as_mut() {
                    if let Err(e) = cache.put(provider, z, y, x, &data, &content_type) {
                        tracing::warn!(error = %e, "Failed to cache tile");
                    }
                }
            }

            build_ok_response(data, &content_type)
        }
        Err(e) => {
            tracing::warn!(error = %e, provider = %provider, z = z, y = y, x = x, "Network fetch failed");

            // Try to serve stale cached tile as offline fallback
            let stale_tile = {
                if let Ok(cache_guard) = tile_cache.lock() {
                    if let Some(cache) = cache_guard.as_ref() {
                        cache.get_stale(provider, z, y, x)
                    } else {
                        None
                    }
                } else {
                    None
                }
            };

            if let Some(entry) = stale_tile {
                tracing::info!(provider = %provider, z = z, y = y, x = x, "Serving stale cached tile as offline fallback");
                return build_ok_response(entry.data, &entry.content_type);
            }

            // No cached tile at all - return 404
            build_error_response(
                http::StatusCode::NOT_FOUND,
                &format!("Tile not available: {}", e),
            )
        }
    }
}

/// Fetch a tile and return its bytes directly.
/// Used by the `fetch_tile` IPC command.
pub fn tile_fetch_impl(
    provider: &str,
    z: u32,
    y: u32,
    x: u32,
    tile_cache: &Arc<Mutex<Option<TileCache>>>,
) -> Result<Vec<u8>, String> {
    // Validate provider against registry
    if tile_providers::get_provider(provider).is_none() {
        return Err(format!("Unknown provider: {}", provider));
    }

    // Check cache first (fresh tiles)
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
        tracing::debug!(provider = %provider, z = z, y = y, x = x, "Cache hit (fresh)");
        return Ok(entry.data);
    }

    // Cache miss - fetch from network
    tracing::debug!(provider = %provider, z = z, y = y, x = x, "Cache miss, fetching from network");
    match fetch_tile_from_network(provider, z, y, x) {
        Ok((data, content_type)) => {
            // Store in cache
            if let Ok(mut cache_guard) = tile_cache.lock() {
                if let Some(cache) = cache_guard.as_mut() {
                    if let Err(e) = cache.put(provider, z, y, x, &data, &content_type) {
                        tracing::warn!(error = %e, "Failed to cache tile");
                    }
                }
            }
            Ok(data)
        }
        Err(e) => {
            tracing::warn!(error = %e, provider = %provider, z = z, y = y, x = x, "Network fetch failed");

            // Try to serve stale cached tile as offline fallback
            let stale_tile = {
                if let Ok(cache_guard) = tile_cache.lock() {
                    if let Some(cache) = cache_guard.as_ref() {
                        cache.get_stale(provider, z, y, x)
                    } else {
                        None
                    }
                } else {
                    None
                }
            };

            if let Some(entry) = stale_tile {
                tracing::info!(provider = %provider, z = z, y = y, x = x, "Serving stale cached tile as offline fallback");
                return Ok(entry.data);
            }

            // No cached tile at all
            Err(format!("Tile not available: {}", e))
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _guard = logging::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol("cavechef-tiles", |ctx, request, responder| {
            let uri = request.uri().clone();
            let state = ctx.app_handle().state::<core::state::AppState>();
            let tile_cache = state.tile_cache();

            // Use Tauri's async runtime with spawn_blocking for bounded concurrency
            // This uses a threadpool instead of spawning unbounded threads
            tauri::async_runtime::spawn(async move {
                // Parse the tile coordinates from the URI
                let Some((provider, z, y, x)) = parse_tile_uri(&uri) else {
                    tracing::warn!(uri = %uri, "Invalid tile URI format");
                    responder.respond(build_error_response(
                        http::StatusCode::BAD_REQUEST,
                        "Invalid tile URI format. Expected: /esri/{z}/{y}/{x} or esri/{z}/{y}/{x}",
                    ));
                    return;
                };

                tracing::debug!(provider = %provider, z = z, y = y, x = x, "Processing tile request");

                // Run the blocking tile fetch in the blocking threadpool
                let response = tauri::async_runtime::spawn_blocking(move || {
                    handle_tile_request(&provider, z, y, x, &tile_cache)
                })
                .await
                .unwrap_or_else(|e| {
                    tracing::error!(error = %e, "Tile request task panicked");
                    build_error_response(
                        http::StatusCode::INTERNAL_SERVER_ERROR,
                        "Internal error processing tile request",
                    )
                });

                responder.respond(response);
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

            // Set app handle on state for event emission
            let state = app.state::<core::state::AppState>();
            state.set_app_handle(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Cache commands
            commands::cache::get_cache_stats,
            commands::cache::clear_tile_cache,
            commands::cache::get_network_status,
            commands::cache::fetch_tile,
            commands::cache::get_tile_providers,
            // Project commands
            commands::project::create_project,
            commands::project::open_project,
            commands::project::save_project,
            commands::project::close_project,
            commands::project::get_project_state,
            commands::project::list_recent_projects,
            commands::project::remove_from_recent_projects,
            commands::project::merge_projects,
            commands::project::load_project_full,
            commands::project::create_project_full,
            commands::project::cancel_loading,
            // Section commands
            commands::section::create_section,
            commands::section::update_section,
            commands::section::delete_section,
            commands::section::get_section,
            commands::section::move_section,
            commands::section::move_segment,
            commands::section::execute_batch,
            commands::section::get_connected_section_ids,
            commands::section::get_anchored_section_ids,
            commands::section::create_section_and_merge,
            commands::section::get_section_relationships,
            // Shot commands
            commands::shot::create_shot,
            commands::shot::update_shot,
            commands::shot::delete_shot,
            commands::shot::set_shot_virtual,
            commands::shot::delete_shot_and_split,
            commands::shot::delete_last_shot_and_section,
            // Station commands
            commands::station::merge_stations,
            commands::station::unmerge_stations,
            commands::station::set_zero_datum,
            commands::station::remove_zero_datum,
            commands::station::move_station,
            commands::station::check_merge_connectivity,
            commands::station::create_loop_closure,
            // Undo/Redo
            commands::history::undo,
            commands::history::redo,
            commands::history::can_undo,
            commands::history::can_redo,
            commands::history::get_undo_stack,
            commands::history::get_redo_stack,
            commands::history::undo_to,
            commands::history::redo_to,
            // Import/Export
            commands::import::import_dmp,
            commands::import::calculate_file_hash,
            commands::import::check_duplicate_import,
            commands::import::track_imported_file,
            commands::export::export_csv,
            commands::export::export_json,
            commands::export::export_image,
            commands::export::get_depth_preset_colors,
            // Config
            commands::config::get_config,
            commands::config::update_config,
            commands::config::reload_config,
            commands::config::update_panel_sizes,
            // Display settings (per-project)
            commands::config::load_display_settings,
            commands::config::save_display_setting,
            commands::config::get_display_setting,
            // Validation
            commands::validation::get_project_warnings,
            commands::validation::resolve_warning,
            commands::validation::unresolve_warning,
            // Survey geometry
            commands::survey_geometry::get_survey_geometry,
            commands::survey_geometry::get_survey_geometry_for_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    // === parse_tile_uri tests ===

    #[test]
    fn test_parse_tile_uri_path_based() {
        let uri: http::Uri = "cavechef-tiles://localhost/esri/10/500/250"
            .parse()
            .unwrap();
        let result = parse_tile_uri(&uri);
        assert_eq!(result, Some(("esri".to_string(), 10, 500, 250)));
    }

    #[test]
    fn test_parse_tile_uri_path_based_with_extension() {
        let uri: http::Uri = "cavechef-tiles://localhost/esri/10/500/250.jpg"
            .parse()
            .unwrap();
        let result = parse_tile_uri(&uri);
        assert_eq!(result, Some(("esri".to_string(), 10, 500, 250)));
    }

    #[test]
    fn test_parse_tile_uri_host_based() {
        let uri: http::Uri = "cavechef-tiles://esri/10/500/250".parse().unwrap();
        let result = parse_tile_uri(&uri);
        assert_eq!(result, Some(("esri".to_string(), 10, 500, 250)));
    }

    #[test]
    fn test_parse_tile_uri_malformed_no_host() {
        // Malformed URI with numeric first segment but no valid host
        let uri: http::Uri = "cavechef-tiles://localhost/10/500/250".parse().unwrap();
        let result = parse_tile_uri(&uri);
        // First segment is "10" which parses as z, host is "localhost" which is rejected
        assert_eq!(result, None);
    }

    #[test]
    fn test_parse_tile_uri_invalid_coordinates() {
        let uri: http::Uri = "cavechef-tiles://localhost/esri/abc/500/250"
            .parse()
            .unwrap();
        let result = parse_tile_uri(&uri);
        assert_eq!(result, None);
    }

    #[test]
    fn test_parse_tile_uri_too_few_segments() {
        let uri: http::Uri = "cavechef-tiles://localhost/esri/10/500".parse().unwrap();
        let result = parse_tile_uri(&uri);
        assert_eq!(result, None);
    }

    #[test]
    fn test_parse_tile_uri_empty_path() {
        let uri: http::Uri = "cavechef-tiles://localhost/".parse().unwrap();
        let result = parse_tile_uri(&uri);
        assert_eq!(result, None);
    }

    fn expect(provider: &str, z: u32, y: u32, x: u32) -> Option<(String, u32, u32, u32)> {
        Some((provider.to_string(), z, y, x))
    }

    macro_rules! parse_case {
        ($name:ident, $uri:expr, $expected:expr) => {
            #[test]
            fn $name() {
                let uri: http::Uri = $uri.parse().unwrap();
                let result = parse_tile_uri(&uri);
                assert_eq!(result, $expected);
            }
        };
    }

    parse_case!(
        test_parse_tile_uri_path_based_png_extension,
        "cavechef-tiles://localhost/esri/10/500/250.png",
        expect("esri", 10, 500, 250)
    );
    parse_case!(
        test_parse_tile_uri_path_based_jpeg_extension,
        "cavechef-tiles://localhost/esri/10/500/250.jpeg",
        expect("esri", 10, 500, 250)
    );
    parse_case!(
        test_parse_tile_uri_path_based_leading_zeros,
        "cavechef-tiles://localhost/esri/01/002/0003",
        expect("esri", 1, 2, 3)
    );
    parse_case!(
        test_parse_tile_uri_path_based_uppercase_provider,
        "cavechef-tiles://localhost/ESRI/10/500/250",
        expect("ESRI", 10, 500, 250)
    );
    parse_case!(
        test_parse_tile_uri_path_based_provider_with_dash,
        "cavechef-tiles://localhost/esri-v2/10/500/250",
        expect("esri-v2", 10, 500, 250)
    );
    parse_case!(
        test_parse_tile_uri_path_based_provider_with_dot,
        "cavechef-tiles://localhost/esri.v1/10/500/250",
        expect("esri.v1", 10, 500, 250)
    );
    parse_case!(
        test_parse_tile_uri_path_based_extra_segments,
        "cavechef-tiles://localhost/esri/10/500/250/extra",
        expect("esri", 10, 500, 250)
    );
    parse_case!(
        test_parse_tile_uri_path_based_trailing_slash,
        "cavechef-tiles://localhost/esri/10/500/250/",
        expect("esri", 10, 500, 250)
    );
    parse_case!(
        test_parse_tile_uri_path_based_query,
        "cavechef-tiles://localhost/esri/10/500/250?token=abc",
        expect("esri", 10, 500, 250)
    );
    parse_case!(
        test_parse_tile_uri_path_based_zero_coords,
        "cavechef-tiles://localhost/esri/0/0/0",
        expect("esri", 0, 0, 0)
    );
    parse_case!(
        test_parse_tile_uri_path_based_large_coords,
        "cavechef-tiles://localhost/esri/4294967295/4294967295/4294967295",
        expect("esri", 4294967295, 4294967295, 4294967295)
    );
    parse_case!(
        test_parse_tile_uri_path_based_with_port,
        "cavechef-tiles://localhost:1234/esri/10/500/250",
        expect("esri", 10, 500, 250)
    );
    parse_case!(
        test_parse_tile_uri_path_based_x_double_extension,
        "cavechef-tiles://localhost/esri/10/500/250.png.jpg",
        expect("esri", 10, 500, 250)
    );
    parse_case!(
        test_parse_tile_uri_path_based_x_trailing_dot,
        "cavechef-tiles://localhost/esri/10/500/250.",
        expect("esri", 10, 500, 250)
    );
    parse_case!(
        test_parse_tile_uri_path_based_x_decimal_truncates,
        "cavechef-tiles://localhost/esri/10/500/250.5",
        expect("esri", 10, 500, 250)
    );
    parse_case!(
        test_parse_tile_uri_path_based_invalid_y,
        "cavechef-tiles://localhost/esri/10/abc/250",
        None
    );
    parse_case!(
        test_parse_tile_uri_path_based_invalid_x,
        "cavechef-tiles://localhost/esri/10/500/abc",
        None
    );
    parse_case!(
        test_parse_tile_uri_path_based_invalid_z,
        "cavechef-tiles://localhost/esri/abc/500/250",
        None
    );
    parse_case!(
        test_parse_tile_uri_path_based_negative_z,
        "cavechef-tiles://localhost/esri/-1/500/250",
        None
    );
    parse_case!(
        test_parse_tile_uri_path_based_negative_y,
        "cavechef-tiles://localhost/esri/10/-1/250",
        None
    );
    parse_case!(
        test_parse_tile_uri_path_based_negative_x,
        "cavechef-tiles://localhost/esri/10/500/-1",
        None
    );
    parse_case!(
        test_parse_tile_uri_path_based_missing_x_trailing_slash,
        "cavechef-tiles://localhost/esri/10/500/",
        None
    );
    parse_case!(
        test_parse_tile_uri_path_based_only_provider,
        "cavechef-tiles://localhost/esri",
        None
    );
    parse_case!(
        test_parse_tile_uri_path_based_provider_and_z,
        "cavechef-tiles://localhost/esri/10",
        None
    );
    parse_case!(
        test_parse_tile_uri_path_based_double_slash,
        "cavechef-tiles://localhost/esri//500/250",
        None
    );
    parse_case!(
        test_parse_tile_uri_path_based_z_float,
        "cavechef-tiles://localhost/esri/10.5/500/250",
        None
    );
    parse_case!(
        test_parse_tile_uri_path_based_y_float,
        "cavechef-tiles://localhost/esri/10/500.1/250",
        None
    );
    parse_case!(
        test_parse_tile_uri_host_based_png_extension,
        "cavechef-tiles://esri/10/500/250.png",
        expect("esri", 10, 500, 250)
    );
    parse_case!(
        test_parse_tile_uri_host_based_uppercase_provider,
        "cavechef-tiles://ESRI/10/500/250",
        expect("ESRI", 10, 500, 250)
    );
    parse_case!(
        test_parse_tile_uri_host_based_provider_with_dot,
        "cavechef-tiles://esri.v1/10/500/250",
        expect("esri.v1", 10, 500, 250)
    );
    parse_case!(
        test_parse_tile_uri_host_based_provider_numeric,
        "cavechef-tiles://123/10/500/250",
        expect("123", 10, 500, 250)
    );
    parse_case!(
        test_parse_tile_uri_host_based_with_port,
        "cavechef-tiles://esri:1234/10/500/250",
        expect("esri", 10, 500, 250)
    );
    parse_case!(
        test_parse_tile_uri_host_based_extra_segments,
        "cavechef-tiles://esri/10/500/250/extra",
        expect("esri", 10, 500, 250)
    );
    parse_case!(
        test_parse_tile_uri_host_based_trailing_slash,
        "cavechef-tiles://esri/10/500/250/",
        expect("esri", 10, 500, 250)
    );
    parse_case!(
        test_parse_tile_uri_host_based_query,
        "cavechef-tiles://esri/10/500/250?x=1",
        expect("esri", 10, 500, 250)
    );
    parse_case!(
        test_parse_tile_uri_host_based_zero_coords,
        "cavechef-tiles://esri/0/0/0",
        expect("esri", 0, 0, 0)
    );
    parse_case!(
        test_parse_tile_uri_host_based_large_coords,
        "cavechef-tiles://esri/4294967295/4294967295/4294967295",
        expect("esri", 4294967295, 4294967295, 4294967295)
    );
    parse_case!(
        test_parse_tile_uri_host_based_missing_y,
        "cavechef-tiles://esri/10",
        None
    );
    parse_case!(
        test_parse_tile_uri_host_based_missing_x,
        "cavechef-tiles://esri/10/500",
        None
    );
    parse_case!(
        test_parse_tile_uri_host_based_invalid_y,
        "cavechef-tiles://esri/10/abc/250",
        None
    );
    parse_case!(
        test_parse_tile_uri_host_based_invalid_x,
        "cavechef-tiles://esri/10/500/abc",
        None
    );
    parse_case!(
        test_parse_tile_uri_host_based_negative_x,
        "cavechef-tiles://esri/10/500/-1",
        None
    );
    parse_case!(
        test_parse_tile_uri_host_based_negative_y,
        "cavechef-tiles://esri/10/-1/250",
        None
    );
    parse_case!(
        test_parse_tile_uri_host_based_negative_z,
        "cavechef-tiles://esri/-1/500/250",
        None
    );
    parse_case!(
        test_parse_tile_uri_host_based_z_float,
        "cavechef-tiles://esri/10.5/500/250",
        None
    );
    parse_case!(
        test_parse_tile_uri_host_based_numeric_first_segment_non_localhost,
        "cavechef-tiles://tiles/10/20/30",
        expect("tiles", 10, 20, 30)
    );

    // === sanitize_content_type tests ===

    #[test]
    fn test_sanitize_content_type_valid_jpeg() {
        assert_eq!(sanitize_content_type("image/jpeg"), "image/jpeg");
    }

    #[test]
    fn test_sanitize_content_type_valid_png() {
        assert_eq!(sanitize_content_type("image/png"), "image/png");
    }

    #[test]
    fn test_sanitize_content_type_with_charset() {
        assert_eq!(
            sanitize_content_type("image/jpeg; charset=utf-8"),
            "image/jpeg"
        );
    }

    #[test]
    fn test_sanitize_content_type_invalid_returns_default() {
        assert_eq!(sanitize_content_type("text/html"), DEFAULT_CONTENT_TYPE);
    }

    #[test]
    fn test_sanitize_content_type_uppercase_normalized() {
        assert_eq!(sanitize_content_type("IMAGE/JPEG"), "image/jpeg");
    }

    #[test]
    fn test_sanitize_content_type_application_octet_stream() {
        // Should fall back to default for non-image types
        assert_eq!(
            sanitize_content_type("application/octet-stream"),
            DEFAULT_CONTENT_TYPE
        );
    }

    macro_rules! sanitize_case {
        ($name:ident, $input:expr, $expected:expr) => {
            #[test]
            fn $name() {
                assert_eq!(sanitize_content_type($input), $expected);
            }
        };
    }

    sanitize_case!(
        test_sanitize_content_type_valid_jpg,
        "image/jpg",
        "image/jpg"
    );
    sanitize_case!(
        test_sanitize_content_type_uppercase_png,
        "IMAGE/PNG",
        "image/png"
    );
    sanitize_case!(
        test_sanitize_content_type_mixed_case_jpeg,
        "Image/Jpeg",
        "image/jpeg"
    );
    sanitize_case!(
        test_sanitize_content_type_trim_spaces,
        " image/jpeg ",
        "image/jpeg"
    );
    sanitize_case!(
        test_sanitize_content_type_png_with_charset,
        "image/png; charset=utf-8",
        "image/png"
    );
    sanitize_case!(
        test_sanitize_content_type_jpg_with_charset,
        "image/jpg; charset=utf-8",
        "image/jpg"
    );
    sanitize_case!(
        test_sanitize_content_type_jpeg_multi_params,
        "image/jpeg;param=1;param2=2",
        "image/jpeg"
    );
    sanitize_case!(
        test_sanitize_content_type_invalid_text_plain,
        "text/plain",
        DEFAULT_CONTENT_TYPE
    );
    sanitize_case!(
        test_sanitize_content_type_invalid_gif,
        "image/gif",
        DEFAULT_CONTENT_TYPE
    );
    sanitize_case!(
        test_sanitize_content_type_empty_string,
        "",
        DEFAULT_CONTENT_TYPE
    );
    sanitize_case!(
        test_sanitize_content_type_whitespace_only,
        "   ",
        DEFAULT_CONTENT_TYPE
    );
    sanitize_case!(
        test_sanitize_content_type_uppercase_jpg_with_param,
        "IMAGE/JPG;foo=bar",
        "image/jpg"
    );
    sanitize_case!(
        test_sanitize_content_type_uppercase_png_with_param,
        "IMAGE/PNG;foo=bar",
        "image/png"
    );
    sanitize_case!(
        test_sanitize_content_type_no_space_before_charset,
        "image/jpeg;charset=utf-8",
        "image/jpeg"
    );
    sanitize_case!(
        test_sanitize_content_type_charset_uppercase,
        "image/jpeg; charset=UTF-8",
        "image/jpeg"
    );
    sanitize_case!(
        test_sanitize_content_type_charset_with_spaces,
        "image/jpeg; charset=utf-8 ; q=0.9",
        "image/jpeg"
    );
    sanitize_case!(
        test_sanitize_content_type_uppercase_charset,
        "IMAGE/JPEG;CHARSET=UTF-8",
        "image/jpeg"
    );
    sanitize_case!(
        test_sanitize_content_type_jpg_multi_params,
        "image/jpg;foo=bar;baz=qux",
        "image/jpg"
    );
    sanitize_case!(
        test_sanitize_content_type_png_trailing_semicolon,
        "image/png;",
        "image/png"
    );
    sanitize_case!(
        test_sanitize_content_type_leading_semicolon,
        ";charset=utf-8",
        DEFAULT_CONTENT_TYPE
    );
    sanitize_case!(
        test_sanitize_content_type_invalid_json,
        "application/json",
        DEFAULT_CONTENT_TYPE
    );
    sanitize_case!(
        test_sanitize_content_type_invalid_avif,
        "image/avif",
        DEFAULT_CONTENT_TYPE
    );
    sanitize_case!(
        test_sanitize_content_type_invalid_short_jpeg,
        "image/jpe",
        DEFAULT_CONTENT_TYPE
    );
    sanitize_case!(
        test_sanitize_content_type_jpg_space_before_semicolon,
        "image/jpg ; charset=utf-8",
        "image/jpg"
    );
    sanitize_case!(
        test_sanitize_content_type_jpeg_space_before_semicolon,
        "image/jpeg ; charset=utf-8",
        "image/jpeg"
    );

    // === Provider validation tests ===

    #[test]
    fn test_registry_contains_esri() {
        assert!(tile_providers::get_provider("esri").is_some());
    }

    #[test]
    fn test_registry_unknown_provider_returns_none() {
        assert!(tile_providers::get_provider("unknown").is_none());
    }

    #[test]
    fn test_allowed_content_types() {
        assert!(ALLOWED_CONTENT_TYPES.contains(&"image/jpeg"));
        assert!(ALLOWED_CONTENT_TYPES.contains(&"image/png"));
        assert!(!ALLOWED_CONTENT_TYPES.contains(&"text/html"));
    }

    // === handle_tile_request tests (with real cache, no network) ===

    fn make_test_cache() -> Arc<Mutex<Option<TileCache>>> {
        let cache = TileCache::in_memory(10, 30).unwrap();
        Arc::new(Mutex::new(Some(cache)))
    }

    fn assert_cors_header(response: &http::Response<Vec<u8>>) {
        assert_eq!(
            response
                .headers()
                .get(http::header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .unwrap(),
            "*"
        );
    }

    #[test]
    fn test_handle_tile_request_unknown_provider_returns_400() {
        let cache = make_test_cache();
        let response = handle_tile_request("unknown_provider", 10, 500, 250, &cache);
        assert_eq!(response.status(), http::StatusCode::BAD_REQUEST);
        assert_eq!(response.headers().get("content-type").unwrap(), "text/plain");
        assert!(std::str::from_utf8(response.body()).unwrap().contains("Unknown provider"));
        assert_cors_header(&response);
    }

    #[test]
    fn test_handle_tile_request_cache_hit_returns_200() {
        let cache = make_test_cache();

        // Pre-populate cache
        {
            let mut guard = cache.lock().unwrap();
            let c = guard.as_mut().unwrap();
            c.put("esri", 10, 500, 250, b"fake_tile_data", "image/jpeg")
                .unwrap();
        }

        let response = handle_tile_request("esri", 10, 500, 250, &cache);
        assert_eq!(response.status(), http::StatusCode::OK);
        assert_eq!(response.body(), b"fake_tile_data");
        assert_eq!(response.headers().get("content-type").unwrap(), "image/jpeg");
        assert_cors_header(&response);
    }

    #[test]
    fn test_handle_tile_request_cache_hit_content_type() {
        let cache = make_test_cache();

        // Pre-populate cache with PNG
        {
            let mut guard = cache.lock().unwrap();
            let c = guard.as_mut().unwrap();
            c.put("esri", 10, 500, 250, b"png_data", "image/png").unwrap();
        }

        let response = handle_tile_request("esri", 10, 500, 250, &cache);
        assert_eq!(response.status(), http::StatusCode::OK);
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "image/png"
        );
        assert_cors_header(&response);
    }

    #[test]
    fn test_handle_tile_request_cache_miss_network_fails_returns_404() {
        // With no cached tile and network failing, should return 404
        let cache = make_test_cache();

        // Mock fetch that always fails
        let mock_fetch = |_: &str, _: u32, _: u32, _: u32| -> Result<(Vec<u8>, String), String> {
            Err("Network unavailable".to_string())
        };

        let response =
            handle_tile_request_with_fetcher("esri", 10, 500, 250, &cache, mock_fetch);
        assert_eq!(response.status(), http::StatusCode::NOT_FOUND);
        assert_eq!(response.headers().get("content-type").unwrap(), "text/plain");
        assert!(std::str::from_utf8(response.body()).unwrap().contains("Tile not available"));
        assert_cors_header(&response);
    }

    #[test]
    fn test_handle_tile_request_cache_miss_network_succeeds_returns_200() {
        // Cache miss but network fetch succeeds
        let cache = make_test_cache();

        // Mock fetch that returns tile data
        let mock_fetch = |_: &str, _: u32, _: u32, _: u32| -> Result<(Vec<u8>, String), String> {
            Ok((b"fetched_tile_data".to_vec(), "image/jpeg".to_string()))
        };

        let response =
            handle_tile_request_with_fetcher("esri", 10, 500, 250, &cache, mock_fetch);
        assert_eq!(response.status(), http::StatusCode::OK);
        assert_eq!(response.body(), b"fetched_tile_data");
        assert_eq!(response.headers().get("content-type").unwrap(), "image/jpeg");
        assert_cors_header(&response);
    }

    #[test]
    fn test_handle_tile_request_fetched_tile_is_cached() {
        // Verify that a successfully fetched tile is stored in cache
        let cache = make_test_cache();

        // Mock fetch
        let mock_fetch = |_: &str, _: u32, _: u32, _: u32| -> Result<(Vec<u8>, String), String> {
            Ok((b"new_tile".to_vec(), "image/png".to_string()))
        };

        let _ = handle_tile_request_with_fetcher("esri", 15, 100, 200, &cache, mock_fetch);

        // Check that tile is now in cache
        let cached = {
            let mut guard = cache.lock().unwrap();
            guard.as_mut().unwrap().get("esri", 15, 100, 200)
        };
        assert!(cached.is_some());
        assert_eq!(cached.unwrap().data, b"new_tile");
    }

    #[test]
    fn test_handle_tile_request_with_no_cache_network_succeeds() {
        // Cache is None (disabled) but network works
        let cache = Arc::new(Mutex::new(None));

        let mock_fetch = |_: &str, _: u32, _: u32, _: u32| -> Result<(Vec<u8>, String), String> {
            Ok((b"tile_data".to_vec(), "image/jpeg".to_string()))
        };

        let response =
            handle_tile_request_with_fetcher("esri", 10, 500, 250, &cache, mock_fetch);
        assert_eq!(response.status(), http::StatusCode::OK);
        assert_eq!(response.body(), b"tile_data");
        assert_eq!(response.headers().get("content-type").unwrap(), "image/jpeg");
        assert_cors_header(&response);
    }

    #[test]
    fn test_handle_tile_request_with_no_cache_network_fails() {
        // Cache is None (disabled) and network fails -> 404
        let cache = Arc::new(Mutex::new(None));

        let mock_fetch = |_: &str, _: u32, _: u32, _: u32| -> Result<(Vec<u8>, String), String> {
            Err("Connection refused".to_string())
        };

        let response =
            handle_tile_request_with_fetcher("esri", 10, 500, 250, &cache, mock_fetch);
        assert_eq!(response.status(), http::StatusCode::NOT_FOUND);
        assert_eq!(response.headers().get("content-type").unwrap(), "text/plain");
        assert!(std::str::from_utf8(response.body()).unwrap().contains("Tile not available"));
        assert_cors_header(&response);
    }

    #[test]
    fn test_handle_tile_request_cache_miss_network_fails_uses_stale_tile() {
        let cache = Arc::new(Mutex::new(Some(TileCache::in_memory(1, 0).unwrap())));

        {
            let mut guard = cache.lock().unwrap();
            guard
                .as_mut()
                .unwrap()
                .put("esri", 1, 2, 3, b"stale_tile", "image/png")
                .unwrap();
        }

        let mock_fetch = |_: &str, _: u32, _: u32, _: u32| -> Result<(Vec<u8>, String), String> {
            Err("Network down".to_string())
        };

        let response = handle_tile_request_with_fetcher("esri", 1, 2, 3, &cache, mock_fetch);
        assert_eq!(response.status(), http::StatusCode::OK);
        assert_eq!(response.body(), b"stale_tile");
        assert_eq!(response.headers().get("content-type").unwrap(), "image/png");
        assert_cors_header(&response);
    }

    // === tile_fetch_impl tests ===

    #[test]
    fn test_tile_fetch_impl_unknown_provider_errors() {
        let cache = make_test_cache();
        let err = tile_fetch_impl("unknown", 1, 2, 3, &cache).unwrap_err();
        assert!(err.contains("Unknown provider"));
    }

    #[test]
    fn test_tile_fetch_impl_cache_hit_returns_bytes() {
        let cache = make_test_cache();
        {
            let mut guard = cache.lock().unwrap();
            let c = guard.as_mut().unwrap();
            c.put("esri", 1, 2, 3, b"tile_bytes", "image/png")
                .unwrap();
        }
        let data = tile_fetch_impl("esri", 1, 2, 3, &cache).unwrap();
        assert_eq!(data, b"tile_bytes");
    }

    // === Response builder tests ===

    #[test]
    fn test_build_ok_response() {
        let response = build_ok_response(b"test_data".to_vec(), "image/jpeg");
        assert_eq!(response.status(), http::StatusCode::OK);
        assert_eq!(response.body(), b"test_data");
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "image/jpeg"
        );
    }

    #[test]
    fn test_build_error_response() {
        let response = build_error_response(http::StatusCode::BAD_REQUEST, "test error");
        assert_eq!(response.status(), http::StatusCode::BAD_REQUEST);
        assert_eq!(response.body(), b"test error");
    }

    #[test]
    fn test_build_ok_response_fallback_on_invalid_content_type() {
        let response = build_ok_response(b"data".to_vec(), "invalid\r\nheader");
        assert_eq!(response.status(), http::StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(response.body(), b"Internal error building response");
    }

    #[test]
    fn test_fetch_tile_from_network_unknown_provider_errors() {
        let result = fetch_tile_from_network("unknown", 0, 0, 0);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unknown provider"));
    }

    // === Registry-based fetch tests ===

    #[test]
    fn test_fetch_tile_from_network_valid_provider_uses_registry_url() {
        // Verify that fetch_tile_from_network for a valid provider constructs the
        // correct URL via registry lookup. We can't test the actual network call,
        // but we verify the function doesn't error on provider lookup.
        let provider = tile_providers::get_provider("esri").unwrap();
        let url = tile_providers::expand_url(provider, 10, 500, 250);
        assert_eq!(
            url,
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/10/500/250"
        );
    }

    #[test]
    fn test_handle_tile_request_valid_provider_uses_registry() {
        // With a mock fetcher, verify that a valid provider passes registry validation
        let cache = make_test_cache();
        let mock_fetch = |_: &str, _: u32, _: u32, _: u32| -> Result<(Vec<u8>, String), String> {
            Ok((b"tile_data".to_vec(), "image/jpeg".to_string()))
        };
        let response = handle_tile_request_with_fetcher("esri", 1, 2, 3, &cache, mock_fetch);
        assert_eq!(response.status(), http::StatusCode::OK);
    }

    // === Config normalization tests ===

    #[test]
    fn test_map_config_normalize_unknown_provider_to_esri() {
        let mut map_config = config::MapConfig {
            satellite_provider: "nonexistent_provider".to_string(),
            satellite_enabled: true,
            satellite_gps_origin: config::GpsOrigin {
                latitude: 24.55,
                longitude: -81.78,
            },
            zoom_default: 15,
            zoom_min: 1,
            zoom_max: 22,
            zoom_step: 1.0,
            controls: config::MapControlsConfig {
                pan_speed: 1.0,
                zoom_speed: 1.0,
                invert_scroll: false,
            },
            station: Default::default(),
            shot: Default::default(),
            snap: Default::default(),
            animation: Default::default(),
        };
        map_config.normalize();
        assert_eq!(map_config.satellite_provider, "esri");
    }

    #[test]
    fn test_map_config_normalize_valid_provider_unchanged() {
        let mut map_config = config::MapConfig {
            satellite_provider: "esri".to_string(),
            satellite_enabled: true,
            satellite_gps_origin: config::GpsOrigin {
                latitude: 24.55,
                longitude: -81.78,
            },
            zoom_default: 15,
            zoom_min: 1,
            zoom_max: 22,
            zoom_step: 1.0,
            controls: config::MapControlsConfig {
                pan_speed: 1.0,
                zoom_speed: 1.0,
                invert_scroll: false,
            },
            station: Default::default(),
            shot: Default::default(),
            snap: Default::default(),
            animation: Default::default(),
        };
        map_config.normalize();
        assert_eq!(map_config.satellite_provider, "esri");
    }

    // === get_tile_providers IPC tests ===

    #[test]
    fn test_get_tile_providers_returns_non_empty() {
        let providers = tile_providers::get_all_provider_info();
        assert!(!providers.is_empty());
    }

    #[test]
    fn test_get_tile_providers_esri_available() {
        let providers = tile_providers::get_all_provider_info();
        let esri = providers.iter().find(|p| p.name == "esri").unwrap();
        assert!(esri.available);
    }

    #[test]
    fn test_get_tile_providers_response_serializes() {
        let providers = tile_providers::get_all_provider_info();
        let json = serde_json::to_value(&providers).unwrap();
        let arr = json.as_array().unwrap();
        assert!(!arr.is_empty());
        let esri = arr.iter().find(|v| v["name"] == "esri").unwrap();
        assert_eq!(esri["available"], true);
        assert!(esri.get("display_label").is_some());
        assert!(esri.get("url_template").is_some());
        assert!(esri.get("tile_size").is_some());
    }
}
