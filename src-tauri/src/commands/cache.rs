//! Cache management IPC commands.
//!
//! Provides frontend access to tile cache statistics and management operations.

use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;
use tauri::State;

use crate::core::AppState;

/// Statistics for a single tile provider
#[derive(Debug, Clone, Serialize)]
pub struct ProviderStats {
    /// Number of tiles from this provider
    pub tiles: u64,
    /// Total size in bytes for this provider
    pub bytes: u64,
}

/// Cache statistics returned by the get_cache_stats command.
///
/// This is a frontend-facing struct that provides more detailed stats
/// than the internal TileCache CacheStats.
#[derive(Debug, Clone, Serialize)]
pub struct CacheStatsResponse {
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
/// If the cache is disabled or unavailable, returns zero stats.
#[tauri::command]
pub fn get_cache_stats(state: State<AppState>) -> CacheStatsResponse {
    let tile_cache = state.tile_cache();

    let guard = match tile_cache.lock() {
        Ok(g) => g,
        Err(_) => {
            tracing::warn!("Failed to acquire tile cache lock for stats");
            return CacheStatsResponse {
                total_tiles: 0,
                total_bytes: 0,
                providers: HashMap::new(),
            };
        }
    };

    let Some(cache) = guard.as_ref() else {
        // Cache is disabled
        return CacheStatsResponse {
            total_tiles: 0,
            total_bytes: 0,
            providers: HashMap::new(),
        };
    };

    let stats = cache.get_stats();

    // Get per-provider stats
    let provider_stats = cache.get_provider_stats();

    CacheStatsResponse {
        total_tiles: stats.tile_count,
        total_bytes: stats.total_bytes,
        providers: provider_stats
            .into_iter()
            .map(|(provider, (tiles, bytes))| (provider, ProviderStats { tiles, bytes }))
            .collect(),
    }
}

/// Clear the tile cache.
///
/// If `provider` is specified, only clears tiles from that provider.
/// If `provider` is None, clears all tiles.
#[tauri::command]
pub fn clear_tile_cache(state: State<AppState>, provider: Option<String>) -> Result<(), String> {
    let tile_cache = state.tile_cache();

    let mut guard = tile_cache
        .lock()
        .map_err(|_| "Failed to acquire tile cache lock".to_string())?;

    let Some(cache) = guard.as_mut() else {
        // Cache is disabled - nothing to clear
        return Ok(());
    };

    match provider {
        Some(p) => {
            tracing::info!(provider = %p, "Clearing tile cache for provider");
            cache.clear_provider(&p).map_err(|e| e.to_string())
        }
        None => {
            tracing::info!("Clearing all tile cache");
            cache.clear_all().map_err(|e| e.to_string())
        }
    }
}

/// Check network connectivity status.
///
/// Performs a lightweight connectivity check by attempting to reach a known endpoint.
/// Returns true if online, false if offline or check fails.
///
/// Note: This is a blocking operation with a short timeout. It's designed for
/// periodic status checks, not high-frequency polling.
#[tauri::command]
pub fn get_network_status() -> bool {
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
        Ok(response) => {
            let status = response.status();
            // Consider 2xx and 3xx as "online"
            status.is_success() || status.is_redirection()
        }
        Err(e) => {
            tracing::debug!(error = %e, "Network status check failed");
            false
        }
    }
}

#[cfg(test)]
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
    fn test_cache_stats_response_serializes() {
        let mut providers = HashMap::new();
        providers.insert(
            "esri".to_string(),
            ProviderStats {
                tiles: 50,
                bytes: 512 * 1024,
            },
        );

        let response = CacheStatsResponse {
            total_tiles: 50,
            total_bytes: 512 * 1024,
            providers,
        };

        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("\"total_tiles\":50"));
        assert!(json.contains("\"total_bytes\":524288"));
        assert!(json.contains("\"esri\""));
    }

    // Note: Integration tests for get_cache_stats and clear_tile_cache
    // require AppState which needs more complex setup. Those are covered
    // in the Playwright and WebdriverIO tests.
}
