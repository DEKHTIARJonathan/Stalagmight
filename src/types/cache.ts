// Cache-related types for frontend

/**
 * Statistics for a single tile provider.
 * Matches the Rust ProviderStats struct from cache.rs.
 */
export interface ProviderStats {
  /** Number of tiles from this provider */
  tiles: number;
  /** Total size in bytes for this provider */
  bytes: number;
}

/**
 * Cache statistics returned by the get_cache_stats IPC command.
 * Matches the Rust CacheStats struct from cache.rs.
 */
export interface CacheStats {
  /** Total number of tiles across all providers */
  total_tiles: number;
  /** Total size in bytes across all providers */
  total_bytes: number;
  /** Per-provider statistics */
  providers: Record<string, ProviderStats>;
}
