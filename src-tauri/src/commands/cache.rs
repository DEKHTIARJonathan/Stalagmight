//! Cache management IPC commands.
//!
//! Provides frontend access to tile cache statistics and management operations.

use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;
use ts_rs::TS;
use tauri::State;

use crate::core::AppState;

/// Statistics for a single tile provider
#[derive(Debug, Clone, Serialize, TS)]
pub struct ProviderStats {
    /// Number of tiles from this provider
    pub tiles: u64,
    /// Total size in bytes for this provider
    pub bytes: u64,
}

/// Cache statistics returned by the get_cache_stats command.
///
/// Matches the spec-defined CacheStats struct with per-provider breakdown.
#[derive(Debug, Clone, Serialize, TS)]
pub struct CacheStats {
    /// Total number of tiles across all providers
    pub total_tiles: u64,
    /// Total size in bytes across all providers
    pub total_bytes: u64,
    /// Per-provider statistics
    pub providers: HashMap<String, ProviderStats>,
}

/// Get cache statistics.
///
/// Returns overall cache stats plus per-provider breakdown.
/// Returns an error if the cache lock is poisoned.
/// If the cache is disabled, returns zero stats (not an error).
#[tauri::command]
pub fn get_cache_stats(state: State<AppState>) -> Result<CacheStats, String> {
    get_cache_stats_impl(state.inner())
}

pub(crate) fn get_cache_stats_impl(state: &AppState) -> Result<CacheStats, String> {
    let tile_cache = state.tile_cache();

    let guard = tile_cache
        .lock()
        .map_err(|_| "Failed to acquire tile cache lock".to_string())?;

    let Some(cache) = guard.as_ref() else {
        // Cache is disabled - return zero stats (this is not an error condition)
        return Ok(CacheStats {
            total_tiles: 0,
            total_bytes: 0,
            providers: HashMap::new(),
        });
    };

    // Get per-provider stats and derive totals from them for consistency
    let provider_stats = cache.get_provider_stats();

    // Derive totals from provider map to ensure internal consistency
    let (total_tiles, total_bytes) = provider_stats
        .values()
        .fold((0u64, 0u64), |(tiles, bytes), (t, b)| (tiles + t, bytes + b));

    Ok(CacheStats {
        total_tiles,
        total_bytes,
        providers: provider_stats
            .into_iter()
            .map(|(provider, (tiles, bytes))| (provider, ProviderStats { tiles, bytes }))
            .collect(),
    })
}

/// Clear the tile cache.
///
/// If `provider` is specified, only clears tiles from that provider.
/// If `provider` is None, clears all tiles.
#[tauri::command]
pub fn clear_tile_cache(state: State<AppState>, provider: Option<String>) -> Result<(), String> {
    clear_tile_cache_impl(state.inner(), provider)
}

pub(crate) fn clear_tile_cache_impl(
    state: &AppState,
    provider: Option<String>,
) -> Result<(), String> {
    let tile_cache = state.tile_cache();

    let mut guard = tile_cache
        .lock()
        .map_err(|_| "Failed to acquire tile cache lock".to_string())?;

    let Some(cache) = guard.as_mut() else {
        // Cache is disabled - nothing to clear
        return Ok(());
    };

    if let Some(p) = provider {
        tracing::info!(
            provider = %p,
            purpose = "refresh cached map tiles",
            "Clearing tile cache for provider"
        );
        cache.clear_provider(&p).map_err(|e| e.to_string())
    } else {
        tracing::info!(
            purpose = "free disk space or refresh cached tiles",
            "Clearing all tile cache"
        );
        cache.clear_all().map_err(|e| e.to_string())
    }
}

/// Fetch a map tile, using cache when available.
///
/// This is the IPC command for fetching tiles from the frontend.
/// It checks the cache first, fetches from network on miss, and caches the result.
/// Returns the raw tile bytes on success.
#[tauri::command]
pub async fn fetch_tile(
    state: State<'_, AppState>,
    provider: String,
    z: u32,
    y: u32,
    x: u32,
) -> Result<Vec<u8>, String> {
    fetch_tile_impl(state.inner(), provider, z, y, x).await
}

pub(crate) async fn fetch_tile_impl(
    state: &AppState,
    provider: String,
    z: u32,
    y: u32,
    x: u32,
) -> Result<Vec<u8>, String> {
    use crate::tile_fetch_impl;

    let tile_cache = state.tile_cache();
    let tilemap_cache = state.tilemap_cache();
    let tile_fetch_stats = state.tile_fetch_stats();

    // Run blocking I/O in a separate thread
    let result = tauri::async_runtime::spawn_blocking(move || {
        tile_fetch_impl(&provider, z, y, x, &tile_cache, &tilemap_cache, &tile_fetch_stats)
    })
    .await
    .map_err(|e| format!("Tile fetch task failed: {e}"))?;

    result
}

/// Get list of all registered tile providers with availability info.
///
/// Returns a Vec of TileProviderInfo structs from the static registry.
/// Each entry includes provider metadata and a computed `available` flag
/// indicating whether any required API key environment variable is set.
/// No app state access needed — the registry is static.
#[tauri::command]
pub fn get_tile_providers() -> Vec<crate::tile_providers::TileProviderInfo> {
    crate::tile_providers::get_all_provider_info()
}

/// Tile fetch statistics returned by the get_tile_fetch_stats command.
#[derive(Debug, Clone, Serialize, TS)]
pub struct TileFetchStatsResponse {
    /// Number of tile requests currently in flight
    pub in_flight: u64,
    /// Average latency of completed tile fetches in ms
    pub avg_latency_ms: u64,
    /// Last tile fetch latency in ms
    pub last_latency_ms: u64,
    /// Total tiles successfully fetched
    pub total_fetched: u64,
    /// Total fetch errors (after retries exhausted)
    pub total_errors: u64,
}

/// Get current tile fetch statistics.
///
/// Returns real-time metrics from the native tile protocol handler including
/// in-flight count, latency, and error counts.
#[tauri::command]
pub fn get_tile_fetch_stats(state: State<AppState>) -> TileFetchStatsResponse {
    get_tile_fetch_stats_impl(state.inner())
}

pub(crate) fn get_tile_fetch_stats_impl(state: &AppState) -> TileFetchStatsResponse {
    let stats = state.tile_fetch_stats();
    let snap = stats.snapshot();
    let avg_latency_ms = if snap.total_fetched > 0 {
        snap.total_latency_ms / snap.total_fetched
    } else {
        0
    };
    TileFetchStatsResponse {
        in_flight: snap.in_flight,
        avg_latency_ms,
        last_latency_ms: snap.last_latency_ms,
        total_fetched: snap.total_fetched,
        total_errors: snap.total_errors,
    }
}

/// Check network connectivity status.
///
/// Performs a lightweight connectivity check by attempting to reach a known endpoint.
/// Returns true if the network is reachable (regardless of HTTP status code),
/// false only for transport errors (DNS failure, connection refused, timeout).
///
/// Note: This is a blocking operation with a short timeout. It's designed for
/// periodic status checks, not high-frequency polling.
#[tauri::command]
pub async fn get_network_status() -> bool {
    // Run blocking HTTP check off the main thread
    tauri::async_runtime::spawn_blocking(get_network_status_impl)
        .await
        .unwrap_or(false)
}

pub(crate) fn get_network_status_impl() -> bool {
    // Use a well-known, highly available endpoint for connectivity check.
    // We use an ESRI endpoint since that's what our tile provider uses,
    // which gives us provider-specific status rather than general internet.
    const CHECK_URL: &str = "https://server.arcgisonline.com/ArcGIS/rest/services";
    const TIMEOUT: Duration = Duration::from_secs(5);

    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .build()
        .new_agent();

    // HEAD request is lightweight - we only care about reachability
    match agent.head(CHECK_URL).call() {
        Ok(_) => {
            // Any successful response means network is reachable
            true
        }
        Err(ureq::Error::StatusCode(code)) => {
            // HTTP error (4xx, 5xx) - network IS reachable, server responded
            tracing::debug!(
                status = code,
                purpose = "check tile provider availability",
                "Network reachable but tile server returned error status"
            );
            true
        }
        Err(e) => {
            // Transport error (DNS, connection, timeout) - network is NOT reachable
            tracing::debug!(
                error = %e,
                purpose = "check tile provider availability",
                "Network status check failed due to transport error"
            );
            false
        }
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_stats_serializes() {
        let stats = ProviderStats {
            tiles: 100,
            bytes: 1024 * 1024,
        };
        let json = serde_json::to_string(&stats).unwrap();
        assert!(json.contains("\"tiles\":100"));
        assert!(json.contains("\"bytes\":1048576"));
    }

    #[test]
    fn test_cache_stats_serializes() {
        let mut providers = HashMap::new();
        providers.insert(
            "esri".to_string(),
            ProviderStats {
                tiles: 50,
                bytes: 512 * 1024,
            },
        );

        let stats = CacheStats {
            total_tiles: 50,
            total_bytes: 512 * 1024,
            providers,
        };

        let json = serde_json::to_string(&stats).unwrap();
        assert!(json.contains("\"total_tiles\":50"));
        assert!(json.contains("\"total_bytes\":524288"));
        assert!(json.contains("\"esri\""));
    }

    // Note: Integration tests for get_cache_stats and clear_tile_cache
    // require AppState which needs more complex setup. Those are covered
    // in the Playwright and WebdriverIO tests.

    #[test]
    fn test_get_tile_providers_command() {
        let providers = get_tile_providers();
        assert!(!providers.is_empty());
        let esri = providers.iter().find(|p| p.name == "esri");
        assert!(esri.is_some());
        assert!(esri.unwrap().available);
    }

    #[test]
    fn test_get_tile_providers_serializes_correctly() {
        let providers = get_tile_providers();
        let json = serde_json::to_value(&providers).unwrap();
        let arr = json.as_array().unwrap();
        assert!(!arr.is_empty());
        // Verify expected fields exist in the response
        let esri = arr.iter().find(|v| v["name"] == "esri").unwrap();
        assert!(esri.get("available").is_some());
        assert!(esri.get("display_label").is_some());
        assert!(esri.get("url_template").is_some());
        assert!(esri.get("attribution").is_some());
        assert!(esri.get("tile_size").is_some());
        assert!(esri.get("min_zoom").is_some());
        assert!(esri.get("max_zoom").is_some());
    }
}
