/**
 * Tile protocol utilities.
 *
 * NOTE: The actual tile fetching is handled by Tauri's native protocol handler
 * registered in src-tauri/src/lib.rs via register_asynchronous_uri_scheme_protocol.
 * This returns binary data directly without JSON serialization overhead.
 *
 * Stats are tracked in Rust via atomic counters and exposed via the
 * `get_tile_fetch_stats` IPC command.
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * Tile fetch statistics from the Rust native protocol handler.
 */
export interface TileFetchStats {
  /** Number of tile requests currently in flight */
  inFlight: number;
  /** Average latency of completed tile fetches in ms */
  avgLatencyMs: number;
  /** Last tile fetch latency in ms */
  lastLatencyMs: number;
  /** Total tiles fetched since app start */
  totalFetched: number;
  /** Total fetch errors (after retries exhausted) */
  totalErrors: number;
}

/**
 * Get current tile fetch statistics from the Rust backend.
 * Returns real-time metrics from the native tile protocol handler.
 */
export async function getTileFetchStats(): Promise<TileFetchStats> {
  const stats = await invoke<{
    in_flight: number;
    avg_latency_ms: number;
    last_latency_ms: number;
    total_fetched: number;
    total_errors: number;
  }>('get_tile_fetch_stats');
  return {
    inFlight: stats.in_flight,
    avgLatencyMs: stats.avg_latency_ms,
    lastLatencyMs: stats.last_latency_ms,
    totalFetched: stats.total_fetched,
    totalErrors: stats.total_errors,
  };
}

/**
 * Reset tile fetch statistics (no-op — Rust counters are cumulative).
 */
export function resetTileFetchStats(): void {
  // No-op - Rust atomic counters are cumulative and don't support reset
}

/**
 * Register the stalagmight-tiles:// protocol for MapLibre.
 *
 * This is now a no-op. Tile requests go directly to Tauri's native protocol
 * handler which returns binary data efficiently without JSON serialization.
 *
 * Kept for API compatibility with existing code that calls register/unregister.
 */
export function registerTileProtocol(): void {
  // No-op - Tauri's native protocol handles stalagmight-tiles:// URLs directly
  // WebView routes these to register_asynchronous_uri_scheme_protocol in Rust
}

/**
 * Unregister the stalagmight-tiles:// protocol.
 * No-op since we don't register a JS-side protocol anymore.
 */
export function unregisterTileProtocol(): void {
  // No-op - nothing to unregister
}

/**
 * Force unregister the protocol regardless of ref count.
 * No-op since we don't register a JS-side protocol anymore.
 */
export function forceUnregisterTileProtocol(): void {
  // No-op - nothing to unregister
}
