/**
 * Tile protocol utilities.
 *
 * NOTE: The actual tile fetching is handled by Tauri's native protocol handler
 * registered in src-tauri/src/lib.rs via register_asynchronous_uri_scheme_protocol.
 * This returns binary data directly without JSON serialization overhead.
 *
 * The previous JS-side protocol handler (maplibregl.addProtocol) was removed
 * because it caused severe performance issues:
 * - Tauri IPC serializes Vec<u8> as JSON array of numbers
 * - A 50KB tile = 50,000 JSON numbers to parse
 * - Multiple tiles arriving = 1+ second frame hiccups
 *
 * Stats tracking is no longer available on the frontend since requests
 * go directly through WebView → Tauri protocol → binary response.
 */

/**
 * Tile fetch statistics interface (kept for API compatibility).
 * Note: Stats are no longer tracked since tiles go through native protocol.
 */
export interface TileFetchStats {
  /** Number of tile requests currently in flight */
  inFlight: number;
  /** Average latency of recent tile fetches in ms */
  avgLatencyMs: number;
  /** Last tile fetch latency in ms */
  lastLatencyMs: number;
  /** Total tiles fetched since registration */
  totalFetched: number;
  /** Total fetch errors since registration */
  totalErrors: number;
}

/**
 * Get current tile fetch statistics.
 * Returns zeros since stats are no longer tracked (native protocol handles tiles).
 */
export function getTileFetchStats(): TileFetchStats {
  return {
    inFlight: 0,
    avgLatencyMs: 0,
    lastLatencyMs: 0,
    totalFetched: 0,
    totalErrors: 0,
  };
}

/**
 * Reset tile fetch statistics (no-op, kept for API compatibility).
 */
export function resetTileFetchStats(): void {
  // No-op - stats not tracked with native protocol
}

/**
 * Register the cavechef-tiles:// protocol for MapLibre.
 *
 * This is now a no-op. Tile requests go directly to Tauri's native protocol
 * handler which returns binary data efficiently without JSON serialization.
 *
 * Kept for API compatibility with existing code that calls register/unregister.
 */
export function registerTileProtocol(): void {
  // No-op - Tauri's native protocol handles cavechef-tiles:// URLs directly
  // WebView routes these to register_asynchronous_uri_scheme_protocol in Rust
}

/**
 * Unregister the cavechef-tiles:// protocol.
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
