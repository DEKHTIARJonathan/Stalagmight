/**
 * Shared tile configuration utility.
 *
 * Returns tile source parameters (URL template, attribution, size, zoom range)
 * for a given map tile provider. Used by both MapCanvas and GlobalViewMap
 * to avoid duplicating provider-specific configuration.
 *
 * Currently supports the 'esri' provider via the cavechef-tiles:// protocol
 * (see src-tauri/src/lib.rs for the native protocol handler with SQLite caching).
 */

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

/**
 * Get tile configuration for a map tile provider.
 *
 * @param provider - Provider name (default: 'esri')
 * @returns Tile configuration object
 * @throws Error if provider is unknown
 */
export function getTileConfig(provider: string = 'esri'): TileConfig {
  switch (provider) {
    case 'esri':
      return {
        tiles: ['cavechef-tiles://esri/{z}/{y}/{x}'],
        attribution: '&copy; Esri, Maxar, Earthstar Geographics',
        tileSize: 256,
        minZoom: 0,
        maxZoom: 22,
      };
    default:
      throw new Error(`Unknown tile provider: ${provider}`);
  }
}
