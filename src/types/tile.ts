// Tile provider types for frontend
// Matches the Rust TileProviderInfo struct from tile_providers.rs

/**
 * Tile provider information returned by the get_tile_providers IPC command.
 * Contains all TileProvider fields plus a computed `available` flag.
 */
export interface TileProviderInfo {
  /** Short identifier (e.g. "esri") */
  name: string;
  /** Human-readable label (e.g. "ESRI World Imagery") */
  display_label: string;
  /** URL template with {z}, {y}, {x} placeholders (used by backend only) */
  url_template: string;
  /** Attribution text */
  attribution: string;
  /** Tile pixel size (typically 256) */
  tile_size: number;
  /** Minimum zoom level */
  min_zoom: number;
  /** Maximum zoom level */
  max_zoom: number;
  /** Expected content type hint (e.g. "image/jpeg") */
  content_type_hint: string;
  /** Environment variable name holding an API key, if required */
  api_key_env: string | null;
  /** HTTP header name used for authentication, if required */
  auth_header: string | null;
  /** True when no API key is required, or the required env var is set */
  available: boolean;
}
