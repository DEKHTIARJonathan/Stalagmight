import maplibregl from 'maplibre-gl';
import { invoke } from '@tauri-apps/api/core';

/**
 * Protocol registration state.
 * Uses a ref count so multiple components can safely use the protocol
 * without accidentally unregistering it while another is still active.
 */
let protocolRefCount = 0;
let isRegistered = false;

/**
 * Tile fetch statistics for developer monitoring.
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

// Stats tracking state
let inFlightCount = 0;
let totalFetched = 0;
let totalErrors = 0;
const recentLatencies: number[] = [];
const MAX_LATENCY_SAMPLES = 20;

/**
 * Get current tile fetch statistics.
 */
export function getTileFetchStats(): TileFetchStats {
  const avgLatency = recentLatencies.length > 0
    ? recentLatencies.reduce((a, b) => a + b, 0) / recentLatencies.length
    : 0;

  return {
    inFlight: inFlightCount,
    avgLatencyMs: Math.round(avgLatency * 10) / 10,
    lastLatencyMs: recentLatencies.length > 0 ? recentLatencies[recentLatencies.length - 1]! : 0,
    totalFetched,
    totalErrors,
  };
}

/**
 * Reset tile fetch statistics.
 */
export function resetTileFetchStats(): void {
  inFlightCount = 0;
  totalFetched = 0;
  totalErrors = 0;
  recentLatencies.length = 0;
}

/**
 * Parse a cavechef-tiles:// URL to extract provider, z, y, x.
 * Supports both formats:
 * - cavechef-tiles://esri/{z}/{y}/{x}
 * - cavechef-tiles://localhost/esri/{z}/{y}/{x}
 */
function parseTileUrl(url: string): { provider: string; z: number; y: number; x: number } | null {
  try {
    // Remove protocol prefix
    const path = url.replace('cavechef-tiles://', '');

    // Split by /
    const parts = path.split('/').filter(Boolean);

    // Handle both formats: esri/z/y/x or localhost/esri/z/y/x
    let provider: string;
    let z: number, y: number, x: number;

    if (parts[0] === 'localhost') {
      // localhost/esri/z/y/x format
      if (parts.length < 5) return null;
      const p1 = parts[1];
      const p2 = parts[2];
      const p3 = parts[3];
      const p4 = parts[4];
      if (!p1 || !p2 || !p3 || !p4) return null;
      provider = p1;
      z = parseInt(p2, 10);
      y = parseInt(p3, 10);
      x = parseInt(p4, 10);
    } else {
      // esri/z/y/x format
      if (parts.length < 4) return null;
      const p0 = parts[0];
      const p1 = parts[1];
      const p2 = parts[2];
      const p3 = parts[3];
      if (!p0 || !p1 || !p2 || !p3) return null;
      provider = p0;
      z = parseInt(p1, 10);
      y = parseInt(p2, 10);
      x = parseInt(p3, 10);
    }

    if (isNaN(z) || isNaN(y) || isNaN(x)) return null;

    return { provider, z, y, x };
  } catch {
    return null;
  }
}

/**
 * Register the cavechef-tiles:// protocol for MapLibre.
 * This protocol routes tile requests through Tauri's invoke API
 * which integrates with the backend for caching.
 *
 * Uses reference counting to safely handle multiple MapCanvas instances.
 * Call unregisterTileProtocol when the component unmounts.
 */
export function registerTileProtocol(): void {
  protocolRefCount++;

  if (isRegistered) {
    // Already registered, just increment ref count
    return;
  }

  maplibregl.addProtocol('cavechef-tiles', async (params, abortController) => {
    // Parse the tile URL
    const parsed = parseTileUrl(params.url);
    if (!parsed) {
      throw new Error(`Invalid tile URL format: ${params.url}`);
    }

    const { provider, z, y, x } = parsed;

    // Track in-flight requests
    inFlightCount++;
    const startTime = performance.now();

    try {
      // Check for abort before starting
      if (abortController.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      // Call the Tauri backend to fetch the tile
      const data = await invoke<number[]>('fetch_tile', { provider, z, y, x });

      // Check for abort after fetch
      if (abortController.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      // Record successful fetch latency
      const latency = performance.now() - startTime;
      recentLatencies.push(latency);
      if (recentLatencies.length > MAX_LATENCY_SAMPLES) {
        recentLatencies.shift();
      }
      totalFetched++;

      // Convert number array to ArrayBuffer
      const arrayBuffer = new Uint8Array(data).buffer;
      return { data: arrayBuffer };
    } catch (error) {
      // Handle abort gracefully (user scrolled away, etc.)
      if (error instanceof Error && error.name === 'AbortError') {
        throw error; // Let MapLibre handle abort
      }

      // Track errors
      totalErrors++;

      // Log other errors but don't spam (MapLibre will retry)
      console.debug('[tileProtocol] Tile fetch error:', error);
      throw error;
    } finally {
      // Always decrement in-flight count
      inFlightCount--;
    }
  });

  isRegistered = true;
}

/**
 * Unregister the cavechef-tiles:// protocol.
 * Only actually removes the protocol when ref count reaches 0.
 */
export function unregisterTileProtocol(): void {
  protocolRefCount--;

  if (protocolRefCount > 0) {
    // Other components still using it
    return;
  }

  if (protocolRefCount < 0) {
    console.warn('[tileProtocol] Unregister called more times than register');
    protocolRefCount = 0;
    return;
  }

  if (isRegistered) {
    try {
      maplibregl.removeProtocol('cavechef-tiles');
    } catch (error) {
      // Protocol might not exist if MapLibre wasn't fully initialized
      console.debug('[tileProtocol] Failed to remove protocol:', error);
    }
    isRegistered = false;
  }
}

/**
 * Force unregister the protocol regardless of ref count.
 * Use this only during app shutdown.
 */
export function forceUnregisterTileProtocol(): void {
  protocolRefCount = 0;
  if (isRegistered) {
    try {
      maplibregl.removeProtocol('cavechef-tiles');
    } catch (error) {
      console.debug('[tileProtocol] Failed to remove protocol:', error);
    }
    isRegistered = false;
  }
}
