/**
 * Shared tile configuration utility.
 *
 * Returns tile source parameters (URL template, attribution, size, zoom range)
 * for a given map tile provider. Used by both MapCanvas and GlobalViewMap
 * to avoid duplicating provider-specific configuration.
 *
 * The frontend uses the cavechef-tiles:// custom protocol for all tile URLs.
 * This routes through the Rust backend for SQLite caching and offline support.
 * The actual provider URL template is only used by the backend internally.
 */

import type { TileProviderInfo } from '../types/tile';

export interface TileConfig {
  /** Tile URL templates (MapLibre raster source format) */
  tiles: string[];
  /** Attribution HTML string */
  attribution: string;
  /** Tile size in pixels */
  tileSize: number;
  /** Minimum supported zoom level */
  minZoom: number;
  /** Maximum supported zoom level */
  maxZoom: number;
}

/** Default hardcoded values for fallback when no metadata available */
const DEFAULT_PROVIDER_METADATA: Record<string, Omit<TileConfig, 'tiles'>> = {
  esri: {
    attribution: '&copy; Esri, Maxar, Earthstar Geographics',
    tileSize: 256,
    minZoom: 0,
    maxZoom: 22,
  },
};

/**
 * Get tile configuration for a map tile provider.
 *
 * @param provider - Provider name (default: 'esri')
 * @param metadata - Optional provider metadata from backend IPC (get_tile_providers).
 *                   If provided, uses metadata fields (attribution, tile_size, min_zoom, max_zoom).
 *                   The url_template is NOT used - frontend always uses cavechef-tiles:// protocol.
 * @returns Tile configuration object
 * @throws Error if provider is unknown and no metadata provided
 */
export function getTileConfig(provider: string = 'esri', metadata?: TileProviderInfo): TileConfig {
  // Always use cavechef-tiles:// protocol for frontend tile URLs
  // This routes through Rust backend for caching and offline support
  const tiles = [`cavechef-tiles://${provider}/{z}/{y}/{x}`];

  // If metadata provided from backend, use it (except url_template)
  if (metadata) {
    return {
      tiles,
      attribution: metadata.attribution,
      tileSize: metadata.tile_size,
      minZoom: metadata.min_zoom,
      maxZoom: metadata.max_zoom,
    };
  }

  // Fall back to hardcoded defaults for known providers
  const defaults = DEFAULT_PROVIDER_METADATA[provider];
  if (defaults) {
    return {
      tiles,
      ...defaults,
    };
  }

  throw new Error(`Unknown tile provider: ${provider}`);
}
