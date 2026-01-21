pub mod cache;
pub mod commands;
pub mod config;
pub mod core;
pub mod export;
pub mod logging;
pub mod models;
pub mod parsers;
pub mod persistence;

use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

use cache::TileCache;

/// ESRI World Imagery tile server base URL
const ESRI_TILE_URL: &str = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile";

/// HTTP request timeout for tile fetches
const TILE_FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// Allowed content types for tile responses (whitelist for security)
const ALLOWED_CONTENT_TYPES: &[&str] = &["image/jpeg", "image/jpg", "image/png"];

/// Default content type when upstream doesn't provide one or it's invalid
const DEFAULT_CONTENT_TYPE: &str = "image/jpeg";

/// Supported tile providers
const SUPPORTED_PROVIDERS: &[&str] = &["esri"];

/// Fetches a tile from the network based on provider
fn fetch_tile_from_network(provider: &str, z: u32, y: u32, x: u32) -> Result<(Vec<u8>, String), String> {
    // Route to appropriate provider URL
    let url = match provider {
        "esri" => format!("{}/{}/{}/{}", ESRI_TILE_URL, z, y, x),
        _ => return Err(format!("Unknown provider: {}", provider)),
    };

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
    // Validate provider
    if !SUPPORTED_PROVIDERS.contains(&provider) {
        tracing::warn!(provider = %provider, "Unknown tile provider requested");
        return build_error_response(
            http::StatusCode::BAD_REQUEST,
            &format!("Unknown provider: {}. Supported: {:?}", provider, SUPPORTED_PROVIDERS),
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
    // Validate provider
    if !SUPPORTED_PROVIDERS.contains(&provider) {
        return Err(format!(
            "Unknown provider: {}. Supported: {:?}",
            provider, SUPPORTED_PROVIDERS
        ));
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
            commands::project::cancel_loading,
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

    // === Provider validation tests ===

    #[test]
    fn test_supported_providers_includes_esri() {
        assert!(SUPPORTED_PROVIDERS.contains(&"esri"));
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

    #[test]
    fn test_handle_tile_request_unknown_provider_returns_400() {
        let cache = make_test_cache();
        let response = handle_tile_request("unknown_provider", 10, 500, 250, &cache);
        assert_eq!(response.status(), http::StatusCode::BAD_REQUEST);
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
}
