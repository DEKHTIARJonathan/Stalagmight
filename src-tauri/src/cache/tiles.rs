//! SQLite-based tile cache for offline satellite imagery.
//!
//! Provides persistent storage for map tiles with LRU eviction and TTL-based expiration.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Entry returned from the cache
#[derive(Debug, Clone)]
pub struct TileEntry {
    /// Raw tile image data
    pub data: Vec<u8>,
    /// MIME content type (e.g., "image/jpeg", "image/png")
    pub content_type: String,
    /// Size in bytes
    pub size_bytes: u64,
    /// Unix timestamp when tile was fetched
    pub fetched_at: i64,
    /// Unix timestamp when tile was last accessed
    pub accessed_at: i64,
}

/// Cache statistics
#[derive(Debug, Clone, Default)]
pub struct CacheStats {
    /// Total number of tiles in cache
    pub tile_count: u64,
    /// Total size of cached tiles in bytes
    pub total_bytes: u64,
    /// Number of distinct providers
    pub provider_count: u64,
}

/// SQLite-based tile cache with LRU eviction
pub struct TileCache {
    conn: Connection,
    /// Maximum cache size in bytes
    max_bytes: u64,
    /// Time-to-live in seconds
    ttl_seconds: i64,
}

impl TileCache {
    /// Open or create a tile cache at the given directory.
    ///
    /// # Arguments
    /// * `cache_dir` - Directory to store the cache database
    /// * `max_mb` - Maximum cache size in megabytes
    /// * `ttl_days` - Time-to-live for cached tiles in days
    ///
    /// Note: `PRAGMA auto_vacuum = INCREMENTAL` only takes effect on newly created databases.
    /// For existing databases, the vacuum mode is already set.
    pub fn open(cache_dir: &Path, max_mb: u32, ttl_days: u32) -> Result<Self> {
        // Ensure cache directory exists
        std::fs::create_dir_all(cache_dir).context("Failed to create cache directory")?;

        let db_path = cache_dir.join("tile_cache.db");
        let is_new = !db_path.exists();
        let conn = Connection::open(&db_path).context("Failed to open tile cache database")?;

        // Set pragmas (auto_vacuum only effective on new DBs)
        conn.execute_batch(
            "PRAGMA auto_vacuum = INCREMENTAL;
             PRAGMA journal_mode = WAL;",
        )?;

        // Run initial vacuum on new databases to apply auto_vacuum setting
        if is_new {
            let _ = conn.execute("VACUUM", []);
        }

        let cache = Self {
            conn,
            max_bytes: u64::from(max_mb) * 1024 * 1024,
            ttl_seconds: i64::from(ttl_days) * 24 * 60 * 60,
        };

        cache.init_schema()?;
        Ok(cache)
    }

    /// Create an in-memory cache (for testing)
    #[cfg(test)]
    pub fn in_memory(max_mb: u32, ttl_days: u32) -> Result<Self> {
        let conn = Connection::open_in_memory().context("Failed to create in-memory cache")?;
        let cache = Self {
            conn,
            max_bytes: u64::from(max_mb) * 1024 * 1024,
            ttl_seconds: i64::from(ttl_days) * 24 * 60 * 60,
        };
        cache.init_schema()?;
        Ok(cache)
    }

    /// Initialize the database schema
    fn init_schema(&self) -> Result<()> {
        self.conn.execute_batch(
            r"
            CREATE TABLE IF NOT EXISTS tiles (
                id INTEGER PRIMARY KEY,
                provider TEXT NOT NULL,
                z INTEGER NOT NULL,
                y INTEGER NOT NULL,
                x INTEGER NOT NULL,
                data BLOB NOT NULL,
                content_type TEXT NOT NULL DEFAULT 'image/jpeg',
                size_bytes INTEGER NOT NULL,
                fetched_at INTEGER NOT NULL,
                accessed_at INTEGER NOT NULL,
                UNIQUE(provider, z, y, x)
            );
            CREATE INDEX IF NOT EXISTS idx_tiles_accessed ON tiles(accessed_at);
            ",
        )?;
        Ok(())
    }

    /// Get the current Unix timestamp
    fn now() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }

    /// Get a tile from the cache.
    ///
    /// Returns `None` if the tile is not cached or has expired (TTL exceeded).
    /// Updates the `accessed_at` timestamp on cache hit.
    ///
    /// Note: Returns `None` on DB errors (logged at warn level).
    pub fn get(&mut self, provider: &str, z: u32, y: u32, x: u32) -> Option<TileEntry> {
        let now = Self::now();
        // A tile is fresh if it was fetched within the last ttl_seconds
        // Use strict < for staleness: tile is stale when fetched_at <= now - ttl_seconds
        let min_fetched_at = now - self.ttl_seconds;

        // Update accessed_at first and return tile data in one query
        // This ensures the returned accessed_at is current
        let result: Result<TileEntry, rusqlite::Error> = self.conn.query_row(
            "UPDATE tiles SET accessed_at = ?1
             WHERE provider = ?2 AND z = ?3 AND y = ?4 AND x = ?5
               AND fetched_at > ?6
             RETURNING data, content_type, size_bytes, fetched_at, accessed_at",
            params![now, provider, z, y, x, min_fetched_at],
            |row| {
                Ok(TileEntry {
                    data: row.get(0)?,
                    content_type: row.get(1)?,
                    size_bytes: row.get::<_, i64>(2)? as u64,
                    fetched_at: row.get(3)?,
                    accessed_at: row.get(4)?,
                })
            },
        );

        match result {
            Ok(entry) => Some(entry),
            Err(rusqlite::Error::QueryReturnedNoRows) => None, // Cache miss
            Err(e) => {
                // Log actual DB errors but don't propagate - treat as miss
                tracing::warn!(
                    provider,
                    z,
                    y,
                    x,
                    error = %e,
                    "Database error during tile cache lookup"
                );
                None
            }
        }
    }

    /// Get a stale tile from the cache (TTL expired but still present).
    ///
    /// This is useful for serving offline fallbacks when network requests fail.
    /// Unlike `get()`, this returns tiles that have expired TTL but are still in cache.
    /// Does NOT update `accessed_at` since we're serving stale data.
    ///
    /// Returns `None` if the tile is not cached at all (fresh or stale).
    pub fn get_stale(&self, provider: &str, z: u32, y: u32, x: u32) -> Option<TileEntry> {
        let now = Self::now();
        let min_fetched_at = now - self.ttl_seconds;

        // Get tiles that ARE stale (fetched_at <= min_fetched_at)
        let result: Result<TileEntry, rusqlite::Error> = self.conn.query_row(
            "SELECT data, content_type, size_bytes, fetched_at, accessed_at FROM tiles
             WHERE provider = ?1 AND z = ?2 AND y = ?3 AND x = ?4
               AND fetched_at <= ?5",
            params![provider, z, y, x, min_fetched_at],
            |row| {
                Ok(TileEntry {
                    data: row.get(0)?,
                    content_type: row.get(1)?,
                    size_bytes: row.get::<_, i64>(2)? as u64,
                    fetched_at: row.get(3)?,
                    accessed_at: row.get(4)?,
                })
            },
        );

        match result {
            Ok(entry) => Some(entry),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => {
                tracing::warn!(
                    provider,
                    z,
                    y,
                    x,
                    error = %e,
                    "Database error during stale tile lookup"
                );
                None
            }
        }
    }

    /// Store a tile in the cache.
    ///
    /// If storing this tile would exceed the cache size limit, expired tiles are removed
    /// first, then LRU eviction is performed until there's space. Tiles larger than
    /// max_bytes are rejected.
    pub fn put(
        &mut self,
        provider: &str,
        z: u32,
        y: u32,
        x: u32,
        data: &[u8],
        content_type: &str,
    ) -> Result<()> {
        let now = Self::now();
        let new_size = data.len() as u64;

        // Reject tiles larger than the entire cache
        if new_size > self.max_bytes {
            anyhow::bail!(
                "Tile size ({} bytes) exceeds max cache size ({} bytes)",
                new_size,
                self.max_bytes
            );
        }

        // First, clear expired tiles to free space before checking existing size
        // This ensures we don't count an expired tile that's about to be deleted
        let min_fetched_at = now - self.ttl_seconds;
        self.conn.execute(
            "DELETE FROM tiles WHERE fetched_at <= ?1",
            params![min_fetched_at],
        )?;

        // Check if we're replacing an existing (non-expired) tile
        let existing_size: i64 = match self.conn.query_row(
            "SELECT size_bytes FROM tiles WHERE provider = ?1 AND z = ?2 AND y = ?3 AND x = ?4",
            params![provider, z, y, x],
            |row| row.get(0),
        ) {
            Ok(size) => size,
            Err(rusqlite::Error::QueryReturnedNoRows) => 0,
            Err(e) => return Err(e.into()), // Propagate actual DB errors
        };

        // Calculate space needed (new size minus existing size we're replacing)
        let space_needed = new_size.saturating_sub(existing_size as u64);

        // Evict LRU tiles until we have space
        let mut stats = self.get_stats();
        while stats.total_bytes + space_needed > self.max_bytes {
            let freed = self.evict_one_lru()?;
            if freed == 0 {
                // No more tiles to evict (shouldn't happen if new_size <= max_bytes)
                break;
            }
            stats = self.get_stats();
        }

        // Insert or replace the tile
        self.conn.execute(
            "INSERT OR REPLACE INTO tiles (provider, z, y, x, data, content_type, size_bytes, fetched_at, accessed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![provider, z, y, x, data, content_type, new_size as i64, now, now],
        )?;

        Ok(())
    }

    /// Evict a single least-recently-used tile.
    /// Returns the number of bytes freed (0 if cache is empty).
    fn evict_one_lru(&self) -> Result<u64> {
        // Find and delete the least recently accessed tile
        // Use id as tie-breaker for deterministic behavior when timestamps match
        let oldest: Result<(i64, i64), _> = self.conn.query_row(
            "SELECT id, size_bytes FROM tiles ORDER BY accessed_at ASC, id ASC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        );

        match oldest {
            Ok((id, size)) => {
                self.conn
                    .execute("DELETE FROM tiles WHERE id = ?1", params![id])?;
                Ok(size as u64)
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(0),
            Err(e) => Err(e.into()),
        }
    }

    /// Evict least-recently-used tiles until cache is under the size limit.
    /// Also removes any expired tiles (TTL exceeded).
    ///
    /// Returns the number of bytes freed.
    pub fn evict_lru(&mut self) -> Result<u64> {
        let mut freed_bytes: u64 = 0;

        // First, always delete expired tiles (batch delete for efficiency)
        // A tile is stale when fetched_at <= now - ttl_seconds
        let min_fetched_at = Self::now() - self.ttl_seconds;
        let expired_bytes: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(SUM(size_bytes), 0) FROM tiles WHERE fetched_at <= ?1",
                params![min_fetched_at],
                |row| row.get(0),
            )
            .unwrap_or(0);

        self.conn.execute(
            "DELETE FROM tiles WHERE fetched_at <= ?1",
            params![min_fetched_at],
        )?;
        freed_bytes += expired_bytes as u64;

        // Then, if still over capacity, delete LRU tiles using batch approach
        let stats = self.get_stats();
        if stats.total_bytes > self.max_bytes {
            let target_bytes = self.max_bytes; // Evict until under limit

            // Batch select tiles to evict (more efficient than repeated queries)
            let mut to_delete: Vec<(i64, i64)> = Vec::new();
            let mut accumulated_bytes: u64 = 0;
            let bytes_to_free = stats.total_bytes.saturating_sub(target_bytes);

            {
                let mut stmt = self
                    .conn
                    .prepare("SELECT id, size_bytes FROM tiles ORDER BY accessed_at ASC, id ASC")?;
                let mut rows = stmt.query([])?;

                while let Some(row) = rows.next()? {
                    if accumulated_bytes >= bytes_to_free {
                        break;
                    }
                    let id: i64 = row.get(0)?;
                    let size: i64 = row.get(1)?;
                    to_delete.push((id, size));
                    accumulated_bytes += size as u64;
                }
            }

            // Delete in batch
            for (id, size) in to_delete {
                self.conn
                    .execute("DELETE FROM tiles WHERE id = ?1", params![id])?;
                freed_bytes += size as u64;
            }
        }

        // Run incremental vacuum to reclaim space if we freed anything
        if freed_bytes > 0 {
            let _ = self.conn.execute("PRAGMA incremental_vacuum(100)", []);
        }

        Ok(freed_bytes)
    }

    /// Clear all tiles from the cache.
    ///
    /// Uses incremental vacuum instead of full VACUUM to avoid blocking
    /// the database connection for extended periods on large caches.
    pub fn clear_all(&mut self) -> Result<()> {
        self.conn.execute("DELETE FROM tiles", [])?;
        // Use incremental vacuum (non-blocking) instead of full VACUUM
        // to prevent UI freezes when clearing large caches
        let _ = self.conn.execute("PRAGMA incremental_vacuum(100)", []);
        Ok(())
    }

    /// Clear tiles from a specific provider.
    pub fn clear_provider(&mut self, provider: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM tiles WHERE provider = ?1", params![provider])?;
        let _ = self.conn.execute("PRAGMA incremental_vacuum(100)", []);
        Ok(())
    }

    /// Get cache statistics.
    pub fn get_stats(&self) -> CacheStats {
        let tile_count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM tiles", [], |row| row.get(0))
            .unwrap_or(0);

        let total_bytes: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(SUM(size_bytes), 0) FROM tiles",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let provider_count: i64 = self
            .conn
            .query_row("SELECT COUNT(DISTINCT provider) FROM tiles", [], |row| {
                row.get(0)
            })
            .unwrap_or(0);

        CacheStats {
            tile_count: tile_count as u64,
            total_bytes: total_bytes as u64,
            provider_count: provider_count as u64,
        }
    }

    /// Get per-provider statistics.
    ///
    /// Returns a map of provider name to (tile_count, total_bytes).
    pub fn get_provider_stats(&self) -> std::collections::HashMap<String, (u64, u64)> {
        let mut result = std::collections::HashMap::new();

        let query_result: Result<(), rusqlite::Error> = (|| {
            let mut stmt = self.conn.prepare(
                "SELECT provider, COUNT(*), COALESCE(SUM(size_bytes), 0) FROM tiles GROUP BY provider",
            )?;
            let mut rows = stmt.query([])?;

            while let Some(row) = rows.next()? {
                let provider: String = row.get(0)?;
                let count: i64 = row.get(1)?;
                let bytes: i64 = row.get(2)?;
                result.insert(provider, (count as u64, bytes as u64));
            }
            Ok(())
        })();

        if let Err(e) = query_result {
            tracing::warn!(error = %e, "Failed to get provider stats");
        }

        result
    }

    /// Check if a tile exists and is fresh (not expired).
    ///
    /// Returns `false` on DB errors (logs at warn level).
    pub fn has_fresh_tile(&self, provider: &str, z: u32, y: u32, x: u32) -> bool {
        let now = Self::now();
        let min_fetched_at = now - self.ttl_seconds;

        match self.conn.query_row(
            "SELECT COUNT(*) FROM tiles
             WHERE provider = ?1 AND z = ?2 AND y = ?3 AND x = ?4
               AND fetched_at > ?5",
            params![provider, z, y, x, min_fetched_at],
            |row| row.get::<_, i64>(0),
        ) {
            Ok(count) => count > 0,
            Err(e) => {
                tracing::warn!(
                    provider,
                    z,
                    y,
                    x,
                    error = %e,
                    "Database error checking fresh tile"
                );
                false
            }
        }
    }

    /// Check if a tile exists but is stale (expired TTL).
    ///
    /// Returns `false` on DB errors (logs at warn level).
    pub fn has_stale_tile(&self, provider: &str, z: u32, y: u32, x: u32) -> bool {
        let now = Self::now();
        let min_fetched_at = now - self.ttl_seconds;

        match self.conn.query_row(
            "SELECT COUNT(*) FROM tiles
             WHERE provider = ?1 AND z = ?2 AND y = ?3 AND x = ?4
               AND fetched_at <= ?5",
            params![provider, z, y, x, min_fetched_at],
            |row| row.get::<_, i64>(0),
        ) {
            Ok(count) => count > 0,
            Err(e) => {
                tracing::warn!(
                    provider,
                    z,
                    y,
                    x,
                    error = %e,
                    "Database error checking stale tile"
                );
                false
            }
        }
    }
}

#[cfg(test)]
#[expect(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::thread;
    // Helper to create test tile data
    fn make_tile_data(size: usize) -> Vec<u8> {
        vec![0xFFu8; size]
    }

    // Helper to set accessed_at directly in DB for deterministic LRU testing
    fn set_accessed_at(
        cache: &TileCache,
        provider: &str,
        z: u32,
        y: u32,
        x: u32,
        accessed_at: i64,
    ) {
        cache
            .conn
            .execute(
                "UPDATE tiles SET accessed_at = ?1 WHERE provider = ?2 AND z = ?3 AND y = ?4 AND x = ?5",
                params![accessed_at, provider, z, y, x],
            )
            .unwrap();
    }

    // Helper to set fetched_at directly in DB for deterministic TTL testing
    fn set_fetched_at(cache: &TileCache, provider: &str, z: u32, y: u32, x: u32, fetched_at: i64) {
        cache
            .conn
            .execute(
                "UPDATE tiles SET fetched_at = ?1 WHERE provider = ?2 AND z = ?3 AND y = ?4 AND x = ?5",
                params![fetched_at, provider, z, y, x],
            )
            .unwrap();
    }

    // Helper to get accessed_at directly from DB
    fn get_accessed_at_from_db(cache: &TileCache, provider: &str, z: u32, y: u32, x: u32) -> i64 {
        cache
            .conn
            .query_row(
                "SELECT accessed_at FROM tiles WHERE provider = ?1 AND z = ?2 AND y = ?3 AND x = ?4",
                params![provider, z, y, x],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn drop_tiles_table(cache: &TileCache) {
        cache.conn.execute("DROP TABLE tiles", []).unwrap();
    }

    // === Test 1: put and get roundtrip ===
    #[test]
    fn test_put_get_roundtrip() {
        let mut cache = TileCache::in_memory(100, 30).unwrap();

        let tile_data = b"fake jpeg data here";
        cache
            .put("esri", 10, 500, 250, tile_data, "image/jpeg")
            .unwrap();

        let entry = cache
            .get("esri", 10, 500, 250)
            .expect("Should get cached tile");
        assert_eq!(entry.data, tile_data);
        assert_eq!(entry.content_type, "image/jpeg");
        assert_eq!(entry.size_bytes, tile_data.len() as u64);
    }

    // === Test 2: cache miss returns None ===
    #[test]
    fn test_cache_miss_returns_none() {
        let mut cache = TileCache::in_memory(100, 30).unwrap();

        // Try to get a tile that was never cached
        let result = cache.get("esri", 10, 500, 250);
        assert!(result.is_none());

        // Add a different tile and confirm the original is still missing
        cache
            .put("esri", 10, 500, 251, b"other tile", "image/png")
            .unwrap();
        let result = cache.get("esri", 10, 500, 250);
        assert!(result.is_none());
    }

    // === Test 3: LRU eviction (exceed max_mb, verify oldest evicted) ===
    #[test]
    fn test_lru_eviction() {
        // Create a tiny cache (1 KB)
        let mut cache = TileCache::in_memory(1, 30).unwrap();
        cache.max_bytes = 1024; // Override to 1KB for testing

        // Add tiles that will exceed capacity
        // Each tile is ~400 bytes, so 3 tiles = 1200 bytes > 1024 bytes
        let tile1 = make_tile_data(400);
        let tile2 = make_tile_data(400);
        let tile3 = make_tile_data(400);

        cache.put("esri", 1, 0, 0, &tile1, "image/jpeg").unwrap();
        cache.put("esri", 1, 0, 1, &tile2, "image/jpeg").unwrap();
        cache.put("esri", 1, 0, 2, &tile3, "image/jpeg").unwrap();

        // Set explicit timestamps to make LRU deterministic
        // tile1 is oldest, tile2 is middle, tile3 is newest
        let base_time = TileCache::now();
        set_accessed_at(&cache, "esri", 1, 0, 0, base_time - 100); // oldest
        set_accessed_at(&cache, "esri", 1, 0, 1, base_time - 50); // middle
        set_accessed_at(&cache, "esri", 1, 0, 2, base_time); // newest

        // Trigger eviction explicitly
        let _freed = cache.evict_lru().unwrap();

        // The oldest tile (tile1) should have been evicted
        let stats = cache.get_stats();
        assert!(
            stats.total_bytes <= cache.max_bytes,
            "Cache should be under limit after eviction"
        );

        // tile1 (oldest) should be gone
        assert!(
            cache.get("esri", 1, 0, 0).is_none(),
            "Oldest tile should be evicted"
        );

        // tile2 and tile3 should still exist
        assert!(
            cache.get("esri", 1, 0, 1).is_some(),
            "Middle tile should remain"
        );
        assert!(
            cache.get("esri", 1, 0, 2).is_some(),
            "Newest tile should remain"
        );
    }

    // === Test 4: TTL expiration (stale tiles not returned) ===
    #[test]
    fn test_ttl_expiration() {
        // Create cache with very short TTL
        let mut cache = TileCache::in_memory(100, 30).unwrap();
        cache.ttl_seconds = 2; // 2 second TTL

        cache
            .put("esri", 10, 500, 250, b"tile data", "image/jpeg")
            .unwrap();

        // Tile should be fresh immediately after put
        let result = cache.get("esri", 10, 500, 250);
        assert!(result.is_some(), "Tile should be fresh right after put");

        // Force the tile to be stale without sleeping
        let stale_time = TileCache::now() - cache.ttl_seconds - 1;
        set_fetched_at(&cache, "esri", 10, 500, 250, stale_time);

        // Should return None because TTL has expired
        let result = cache.get("esri", 10, 500, 250);
        assert!(
            result.is_none(),
            "Stale tile should not be returned by get()"
        );

        // But has_stale_tile should return true
        assert!(
            cache.has_stale_tile("esri", 10, 500, 250),
            "Should detect stale tile"
        );
    }

    // === Test 5: clear_all removes all tiles ===
    #[test]
    fn test_clear_all() {
        let mut cache = TileCache::in_memory(100, 30).unwrap();

        cache.put("esri", 1, 0, 0, b"tile1", "image/jpeg").unwrap();
        cache.put("osm", 2, 1, 1, b"tile2", "image/png").unwrap();
        cache
            .put("mapbox", 3, 2, 2, b"tile3", "image/jpeg")
            .unwrap();

        let stats_before = cache.get_stats();
        assert_eq!(stats_before.tile_count, 3);

        cache.clear_all().unwrap();

        let stats_after = cache.get_stats();
        assert_eq!(stats_after.tile_count, 0);
        assert_eq!(stats_after.total_bytes, 0);
    }

    // === Test 6: clear_provider only removes specified provider ===
    #[test]
    fn test_clear_provider() {
        let mut cache = TileCache::in_memory(100, 30).unwrap();

        cache.put("esri", 1, 0, 0, b"esri1", "image/jpeg").unwrap();
        cache.put("esri", 1, 0, 1, b"esri2", "image/jpeg").unwrap();
        cache.put("osm", 1, 0, 0, b"osm1", "image/png").unwrap();

        cache.clear_provider("esri").unwrap();

        // ESRI tiles should be gone
        assert!(cache.get("esri", 1, 0, 0).is_none());
        assert!(cache.get("esri", 1, 0, 1).is_none());

        // OSM tile should remain
        assert!(cache.get("osm", 1, 0, 0).is_some());

        let stats = cache.get_stats();
        assert_eq!(stats.tile_count, 1);
    }

    // === Test 7: cache_stats returns correct counts ===
    #[test]
    fn test_cache_stats() {
        let mut cache = TileCache::in_memory(100, 30).unwrap();

        assert_eq!(cache.get_stats().tile_count, 0);
        assert_eq!(cache.get_stats().total_bytes, 0);
        assert_eq!(cache.get_stats().provider_count, 0);

        let tile1 = make_tile_data(100);
        let tile2 = make_tile_data(200);
        let tile3 = make_tile_data(150);

        cache.put("esri", 1, 0, 0, &tile1, "image/jpeg").unwrap();
        cache.put("esri", 1, 0, 1, &tile2, "image/jpeg").unwrap();
        cache.put("osm", 1, 0, 0, &tile3, "image/png").unwrap();

        let stats = cache.get_stats();
        assert_eq!(stats.tile_count, 3);
        assert_eq!(stats.total_bytes, 450);
        assert_eq!(stats.provider_count, 2);
    }

    #[test]
    fn test_get_returns_none_on_db_error() {
        let mut cache = TileCache::in_memory(100, 30).unwrap();
        drop_tiles_table(&cache);

        let entry = cache.get("esri", 1, 2, 3);
        assert!(entry.is_none());
    }

    #[test]
    fn test_get_stale_returns_none_on_db_error() {
        let cache = TileCache::in_memory(100, 30).unwrap();
        drop_tiles_table(&cache);

        let entry = cache.get_stale("esri", 1, 2, 3);
        assert!(entry.is_none());
    }

    #[test]
    fn test_has_fresh_tile_returns_false_on_db_error() {
        let cache = TileCache::in_memory(100, 30).unwrap();
        drop_tiles_table(&cache);

        assert!(!cache.has_fresh_tile("esri", 1, 2, 3));
    }

    #[test]
    fn test_has_stale_tile_returns_false_on_db_error() {
        let cache = TileCache::in_memory(100, 30).unwrap();
        drop_tiles_table(&cache);

        assert!(!cache.has_stale_tile("esri", 1, 2, 3));
    }

    #[test]
    fn test_get_provider_stats_returns_empty_on_db_error() {
        let cache = TileCache::in_memory(100, 30).unwrap();
        drop_tiles_table(&cache);

        let stats = cache.get_provider_stats();
        assert!(stats.is_empty());
    }

    #[test]
    fn test_evict_lru_returns_error_when_table_missing() {
        let mut cache = TileCache::in_memory(100, 30).unwrap();
        drop_tiles_table(&cache);

        let result = cache.evict_lru();
        assert!(result.is_err());
    }

    // === Test 8: concurrent access (multi-threaded) ===
    // Note: This test uses a Mutex to serialize access, primarily testing
    // that TileCache is Send. For true concurrent SQLite access, separate
    // connections would be needed.
    #[test]
    fn test_concurrent_access() {
        use std::sync::{Arc, Mutex};

        // Use a real temp directory for thread safety
        let temp_dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(Mutex::new(
            TileCache::open(temp_dir.path(), 100, 30).unwrap(),
        ));

        let mut handles = vec![];

        // Spawn multiple threads writing different tiles
        for i in 0..10 {
            let cache_clone = Arc::clone(&cache);
            let handle = thread::spawn(move || {
                let tile_data = make_tile_data(50);
                let mut cache = cache_clone.lock().unwrap();
                cache
                    .put("esri", 10, i, 0, &tile_data, "image/jpeg")
                    .unwrap();
            });
            handles.push(handle);
        }

        // Wait for all threads
        for handle in handles {
            handle.join().unwrap();
        }

        // Verify all tiles were cached
        let cache = cache.lock().unwrap();
        let stats = cache.get_stats();
        assert_eq!(stats.tile_count, 10);
    }

    // === Test 9: different providers isolation ===
    #[test]
    fn test_provider_isolation() {
        let mut cache = TileCache::in_memory(100, 30).unwrap();

        // Same z/y/x but different providers
        cache
            .put("esri", 10, 500, 250, b"esri data", "image/jpeg")
            .unwrap();
        cache
            .put("osm", 10, 500, 250, b"osm data", "image/png")
            .unwrap();
        cache
            .put("mapbox", 10, 500, 250, b"mapbox data", "image/webp")
            .unwrap();

        let esri = cache.get("esri", 10, 500, 250).unwrap();
        let osm = cache.get("osm", 10, 500, 250).unwrap();
        let mapbox = cache.get("mapbox", 10, 500, 250).unwrap();

        assert_eq!(esri.data, b"esri data");
        assert_eq!(osm.data, b"osm data");
        assert_eq!(mapbox.data, b"mapbox data");

        assert_eq!(esri.content_type, "image/jpeg");
        assert_eq!(osm.content_type, "image/png");
        assert_eq!(mapbox.content_type, "image/webp");
    }

    // === Test 10: zero-byte tile handling ===
    #[test]
    fn test_zero_byte_tile() {
        let mut cache = TileCache::in_memory(100, 30).unwrap();

        // Store an empty tile (valid "no data" marker)
        cache.put("esri", 10, 500, 250, &[], "image/jpeg").unwrap();

        let entry = cache.get("esri", 10, 500, 250).unwrap();
        assert!(entry.data.is_empty());
        assert_eq!(entry.size_bytes, 0);
    }

    // === Test 11: content-type preservation ===
    #[test]
    fn test_content_type_preservation() {
        let mut cache = TileCache::in_memory(100, 30).unwrap();

        let content_types = [
            "image/jpeg",
            "image/jpg",
            "image/png",
            "image/webp",
            "application/octet-stream",
        ];

        for (i, ct) in content_types.iter().enumerate() {
            cache.put("test", 10, 0, i as u32, b"data", ct).unwrap();
        }

        for (i, ct) in content_types.iter().enumerate() {
            let entry = cache.get("test", 10, 0, i as u32).unwrap();
            assert_eq!(&entry.content_type, *ct, "Content type should be preserved");
        }
    }

    // === Test 12: accessed_at updates on get ===
    #[test]
    fn test_accessed_at_updates_on_get() {
        let mut cache = TileCache::in_memory(100, 30).unwrap();

        cache
            .put("esri", 10, 500, 250, b"tile data", "image/jpeg")
            .unwrap();

        // Force accessed_at to an older value without sleeping
        let base_time = TileCache::now();
        set_accessed_at(&cache, "esri", 10, 500, 250, base_time - 10);
        let first_accessed_at = get_accessed_at_from_db(&cache, "esri", 10, 500, 250);

        // Access the tile - this should update accessed_at
        let entry = cache.get("esri", 10, 500, 250).unwrap();

        // Verify the returned entry has the updated accessed_at
        assert!(
            entry.accessed_at > first_accessed_at,
            "Returned accessed_at should be updated (got {}, expected > {})",
            entry.accessed_at,
            first_accessed_at
        );

        // Also verify DB was updated
        let db_accessed_at = get_accessed_at_from_db(&cache, "esri", 10, 500, 250);
        assert!(
            db_accessed_at > first_accessed_at,
            "DB accessed_at should be updated"
        );
    }

    // === Test 13: put overwrites existing tile ===
    #[test]
    fn test_put_overwrites_existing() {
        let mut cache = TileCache::in_memory(100, 30).unwrap();

        cache
            .put("esri", 10, 500, 250, b"original data", "image/jpeg")
            .unwrap();
        cache
            .put("esri", 10, 500, 250, b"updated data!!!", "image/png")
            .unwrap();

        let entry = cache.get("esri", 10, 500, 250).unwrap();
        assert_eq!(entry.data, b"updated data!!!");
        assert_eq!(entry.content_type, "image/png");

        // Should still be just one tile
        let stats = cache.get_stats();
        assert_eq!(stats.tile_count, 1);
    }

    // === Test 14: has_fresh_tile and has_stale_tile ===
    #[test]
    fn test_has_fresh_and_stale_tile() {
        let mut cache = TileCache::in_memory(100, 30).unwrap();

        // Fresh tile with long TTL
        cache.put("esri", 10, 0, 0, b"fresh", "image/jpeg").unwrap();
        assert!(cache.has_fresh_tile("esri", 10, 0, 0));
        assert!(!cache.has_stale_tile("esri", 10, 0, 0));

        // Non-existent tile
        assert!(!cache.has_fresh_tile("esri", 10, 0, 1));
        assert!(!cache.has_stale_tile("esri", 10, 0, 1));
    }

    // === Test 15: eviction respects TTL ===
    #[test]
    fn test_evict_removes_expired() {
        let mut cache = TileCache::in_memory(100, 30).unwrap();
        cache.ttl_seconds = 2; // 2 second TTL

        cache.put("esri", 10, 0, 0, b"tile1", "image/jpeg").unwrap();
        cache.put("esri", 10, 0, 1, b"tile2", "image/jpeg").unwrap();

        // Verify tiles are present
        let stats_before = cache.get_stats();
        assert_eq!(stats_before.tile_count, 2);

        // Force tiles to be stale without sleeping
        let stale_time = TileCache::now() - cache.ttl_seconds - 1;
        set_fetched_at(&cache, "esri", 10, 0, 0, stale_time);
        set_fetched_at(&cache, "esri", 10, 0, 1, stale_time);

        // Eviction should remove expired tiles
        let freed = cache.evict_lru().unwrap();
        assert!(freed > 0, "Should have freed expired tiles");

        let stats = cache.get_stats();
        assert_eq!(stats.tile_count, 0, "All expired tiles should be removed");
    }

    // === Test 16: put enforces max_bytes limit ===
    #[test]
    fn test_put_enforces_max_bytes() {
        let mut cache = TileCache::in_memory(1, 30).unwrap();
        cache.max_bytes = 500; // 500 bytes max

        // Add tiles that together exceed limit
        let tile1 = make_tile_data(200);
        let tile2 = make_tile_data(200);
        let tile3 = make_tile_data(200);

        cache.put("esri", 1, 0, 0, &tile1, "image/jpeg").unwrap();
        cache.put("esri", 1, 0, 1, &tile2, "image/jpeg").unwrap();

        // Set explicit timestamps
        set_accessed_at(&cache, "esri", 1, 0, 0, TileCache::now() - 100);
        set_accessed_at(&cache, "esri", 1, 0, 1, TileCache::now());

        // This put should trigger eviction to make space
        cache.put("esri", 1, 0, 2, &tile3, "image/jpeg").unwrap();

        let stats = cache.get_stats();
        assert!(
            stats.total_bytes <= cache.max_bytes,
            "Cache should never exceed max_bytes after put"
        );

        // The oldest tile should have been evicted
        assert!(
            cache.get("esri", 1, 0, 0).is_none(),
            "Oldest tile should be evicted"
        );
    }

    // === Test 17: tile larger than cache is rejected ===
    #[test]
    fn test_oversized_tile_rejected() {
        let mut cache = TileCache::in_memory(1, 30).unwrap();
        cache.max_bytes = 100; // 100 bytes max

        let oversized = make_tile_data(200); // Larger than cache
        let result = cache.put("esri", 1, 0, 0, &oversized, "image/jpeg");

        assert!(result.is_err(), "Oversized tile should be rejected");
    }

    // === Test 18: LRU eviction has deterministic tie-breaking ===
    #[test]
    fn test_lru_deterministic_tiebreaker() {
        let mut cache = TileCache::in_memory(1, 30).unwrap();
        cache.max_bytes = 500; // 500 bytes capacity

        // Add tiles with same timestamp - 3 * 200 = 600 bytes exceeds 500
        let tile = make_tile_data(200);
        cache.put("esri", 1, 0, 0, &tile, "image/jpeg").unwrap();
        cache.put("esri", 1, 0, 1, &tile, "image/jpeg").unwrap();
        cache.put("esri", 1, 0, 2, &tile, "image/jpeg").unwrap();

        // Set all to same timestamp
        let same_time = TileCache::now();
        set_accessed_at(&cache, "esri", 1, 0, 0, same_time);
        set_accessed_at(&cache, "esri", 1, 0, 1, same_time);
        set_accessed_at(&cache, "esri", 1, 0, 2, same_time);

        // Force eviction - should evict to under max_bytes (500)
        cache.evict_lru().unwrap();

        let stats = cache.get_stats();
        // Should have evicted at least one tile to get under 500 bytes
        assert!(
            stats.total_bytes <= cache.max_bytes,
            "Cache should be under limit after eviction, got {} bytes",
            stats.total_bytes
        );

        // With deterministic tie-breaking (by id), lower id tiles should be evicted first
        // Tile at (1,0,0) has lowest id, should be evicted first
        assert!(
            cache.get("esri", 1, 0, 0).is_none(),
            "Tile with lowest id should be evicted first when timestamps tie"
        );
    }

    // === Test 19: get_provider_stats returns per-provider breakdown ===
    #[test]
    fn test_get_provider_stats() {
        let mut cache = TileCache::in_memory(100, 30).unwrap();

        // Add tiles from multiple providers
        let tile100 = make_tile_data(100);
        let tile200 = make_tile_data(200);
        let tile150 = make_tile_data(150);

        cache.put("esri", 1, 0, 0, &tile100, "image/jpeg").unwrap();
        cache.put("esri", 1, 0, 1, &tile200, "image/jpeg").unwrap();
        cache.put("osm", 1, 0, 0, &tile150, "image/png").unwrap();

        let provider_stats = cache.get_provider_stats();

        // Should have 2 providers
        assert_eq!(provider_stats.len(), 2);

        // ESRI: 2 tiles, 300 bytes
        let esri = provider_stats.get("esri").unwrap();
        assert_eq!(esri.0, 2, "ESRI should have 2 tiles");
        assert_eq!(esri.1, 300, "ESRI should have 300 bytes");

        // OSM: 1 tile, 150 bytes
        let osm = provider_stats.get("osm").unwrap();
        assert_eq!(osm.0, 1, "OSM should have 1 tile");
        assert_eq!(osm.1, 150, "OSM should have 150 bytes");
    }

    // === Test 20: get_provider_stats returns empty for empty cache ===
    #[test]
    fn test_get_provider_stats_empty_cache() {
        let cache = TileCache::in_memory(100, 30).unwrap();

        let provider_stats = cache.get_provider_stats();
        assert!(provider_stats.is_empty());
    }
}
