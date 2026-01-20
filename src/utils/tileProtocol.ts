import maplibregl from 'maplibre-gl';

/**
 * Protocol registration state.
 * Uses a ref count so multiple components can safely use the protocol
 * without accidentally unregistering it while another is still active.
 */
let protocolRefCount = 0;
let isRegistered = false;

/**
 * Register the cavechef-tiles:// protocol for MapLibre.
 * This protocol routes tile requests through our custom fetch handler
 * which integrates with the Tauri backend for caching.
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
    try {
      const response = await fetch(params.url, { signal: abortController.signal });

      if (!response.ok) {
        // Return error for non-2xx status codes
        throw new Error(`Tile fetch failed: ${response.status} ${response.statusText} for ${params.url}`);
      }

      return { data: await response.arrayBuffer() };
    } catch (error) {
      // Handle abort gracefully (user scrolled away, etc.)
      if (error instanceof Error && error.name === 'AbortError') {
        throw error; // Let MapLibre handle abort
      }

      // Log other errors but don't spam (MapLibre will retry)
      console.debug('[tileProtocol] Tile fetch error:', error);
      throw error;
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
