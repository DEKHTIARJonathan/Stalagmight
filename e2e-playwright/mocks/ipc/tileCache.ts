import type { MockCommandFamily } from './types';

/**
 * Tile-cache and network commands of the Playwright IPC mock, with their reset hooks.
 *
 * Split out of `../tauri-ipc.ts` unchanged (#576 E8). Runs IN THE PAGE: `setupTauriMocks`
 * serializes this factory with `Function.prototype.toString` into its init script, so it
 * may use only `ctx` and browser globals - never an import (type-only imports are erased).
 */
export const tileCacheCommands: MockCommandFamily = (ctx) => {
  // Cache mock state - tracks cache operations for verification
  // Use explicit types so providers can be empty and keys can be deleted
  interface MockProviderStats {
    tiles: bigint;
    bytes: bigint;
  }
  interface MockCacheStats {
    total_tiles: bigint;
    total_bytes: bigint;
    providers: Record<string, MockProviderStats>;
  }
  const defaultCacheStats: MockCacheStats = {
    total_tiles: 150n,
    total_bytes: 25600000n, // ~25MB
    providers: {
      esri: { tiles: 150n, bytes: 25600000n },
    },
  };
  let mockCacheStats: MockCacheStats = {
    total_tiles: defaultCacheStats.total_tiles,
    total_bytes: defaultCacheStats.total_bytes,
    providers: { ...defaultCacheStats.providers },
  };
  let mockNetworkStatus = true; // Online by default

  // Expose reset function for tests via window
  (window as unknown as Record<string, unknown>).__MOCK_CACHE_RESET__ = () => {
    mockCacheStats = {
      total_tiles: defaultCacheStats.total_tiles,
      total_bytes: defaultCacheStats.total_bytes,
      providers: { ...defaultCacheStats.providers },
    };
    mockNetworkStatus = true;
  };
  (window as unknown as Record<string, unknown>).__MOCK_SET_NETWORK_STATUS__ = (status: boolean) => {
    mockNetworkStatus = status;
  };
  (window as unknown as Record<string, unknown>).__MOCK_GET_CACHE_STATS__ = () => mockCacheStats;

  return (cmd, args) => {
    switch (cmd) {
      // Cache commands
      case 'get_cache_stats':
        console.log('[Mock IPC] get_cache_stats called');
        return mockCacheStats;

      case 'clear_tile_cache': {
        // Normalize provider: could be string, null, or undefined from frontend
        const provider = typeof args?.provider === 'string' ? args.provider : undefined;
        console.log('[Mock IPC] clear_tile_cache called, provider:', provider);
        if (provider) {
          // Clear specific provider
          delete mockCacheStats.providers[provider];
          // Recalculate totals
          let totalTiles = 0n;
          let totalBytes = 0n;
          for (const p of Object.values(mockCacheStats.providers)) {
            totalTiles += p.tiles;
            totalBytes += p.bytes;
          }
          mockCacheStats.total_tiles = totalTiles;
          mockCacheStats.total_bytes = totalBytes;
        } else {
          // Clear all
          mockCacheStats = { total_tiles: 0n, total_bytes: 0n, providers: {} };
        }
        return null; // Tauri serializes () as null
      }

      case 'get_network_status':
        console.log('[Mock IPC] get_network_status called');
        return mockNetworkStatus;

      case 'get_tile_providers':
        // Return TileProviderInfo[] matching Rust struct shape
        console.log('[Mock IPC] get_tile_providers called');
        return [
          {
            name: 'esri',
            display_label: 'ESRI World Imagery',
            url_template: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            attribution: 'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community',
            attribution_notice: 'Powered by Esri',
            attribution_url: 'https://www.esri.com',
            service_info_url:
              'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer?f=json',
            tile_size: 256,
            min_zoom: 1,
            max_zoom: 22,
            content_type_hint: 'image/jpeg',
            api_key_env: null,
            auth_header: null,
            available: true,
          },
        ];

      case 'get_tile_attribution':
        // Mirrors the offline path of the real command: specs run with no
        // network, so the backend would answer with its compiled-in source
        // names and live: false. Asserting on THAT is the point - the map
        // must still be attributed when the fetch cannot happen.
        console.log('[Mock IPC] get_tile_attribution called');
        return {
          provider: (args?.provider as string) ?? 'esri',
          text: 'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community',
          notice: 'Powered by Esri',
          notice_url: 'https://www.esri.com',
          live: false,
        };

      default:
        return ctx.unhandled;
    }
  };
};
