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
    pub fn open(cache_dir: &Path, max_mb: u32, ttl_days: u32) -> Result<Self> {
        // Ensure cache directory exists
        std::fs::create_dir_all(cache_dir).context("Failed to create cache directory")?;

        let db_path = cache_dir.join("tile_cache.db");
        let conn = Connection::open(&db_path).context("Failed to open tile cache database")?;

        // Enable incremental vacuum for better space reclamation
        conn.execute_batch(
            "PRAGMA auto_vacuum = INCREMENTAL;
             PRAGMA journal_mode = WAL;",
        )?;

        let cache = Self {
            conn,
            max_bytes: (max_mb as u64) * 1024 * 1024,
            ttl_seconds: (ttl_days as i64) * 24 * 60 * 60,
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
            max_bytes: (max_mb as u64) * 1024 * 1024,
            ttl_seconds: (ttl_days as i64) * 24 * 60 * 60,
        };
        cache.init_schema()?;
        Ok(cache)
    }

    /// Initialize the database schema
    fn init_schema(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
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
            CREATE INDEX IF NOT EXISTS idx_tiles_provider ON tiles(provider);
            "#,
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
    pub fn get(&mut self, provider: &str, z: u32, y: u32, x: u32) -> Option<TileEntry> {
        let now = Self::now();
        // A tile is fresh if it was fetched within the last ttl_seconds
        // Use strict < for staleness: tile is stale when fetched_at < now - ttl_seconds
        let min_fetched_at = now - self.ttl_seconds;

        // Query tile, filtering out expired entries (strictly greater than min)
        let result: Result<TileEntry, _> = self.conn.query_row(
            "SELECT data, content_type, size_bytes, fetched_at, accessed_at
             FROM tiles
             WHERE provider = ?1 AND z = ?2 AND y = ?3 AND x = ?4
               AND fetched_at > ?5",
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
            Ok(entry) => {
                // Update accessed_at timestamp
                let _ = self.conn.execute(
                    "UPDATE tiles SET accessed_at = ?1
                     WHERE provider = ?2 AND z = ?3 AND y = ?4 AND x = ?5",
                    params![now, provider, z, y, x],
                );
                Some(entry)
            }
            Err(_) => None,
        }
    }

    /// Store a tile in the cache.
    ///
    /// If storing this tile would exceed the cache size limit, LRU eviction is performed first.
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
        let size_bytes = data.len() as i64;

        // Ensure we have space (evict if needed)
        let stats = self.get_stats();
        if stats.total_bytes + (size_bytes as u64) > self.max_bytes {
            self.evict_lru()?;
        }

        // Insert or replace the tile
        self.conn.execute(
            "INSERT OR REPLACE INTO tiles (provider, z, y, x, data, content_type, size_bytes, fetched_at, accessed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![provider, z, y, x, data, content_type, size_bytes, now, now],
        )?;

        Ok(())
    }

    /// Evict least-recently-used tiles until cache is under the size limit.
    /// Also removes any expired tiles (TTL exceeded).
    ///
    /// Returns the number of bytes freed.
    pub fn evict_lru(&mut self) -> Result<u64> {
        let mut freed_bytes: u64 = 0;

        // First, always delete expired tiles
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

        // Then, if still over capacity, delete LRU tiles
        let stats = self.get_stats();
        if stats.total_bytes > self.max_bytes {
            let target_bytes = self.max_bytes * 80 / 100; // Evict to 80% capacity

            // Delete tiles one at a time, oldest accessed first
            loop {
                let current_stats = self.get_stats();
                if current_stats.total_bytes <= target_bytes {
                    break;
                }

                // Find and delete the least recently accessed tile
                let oldest: Result<(i64, i64), _> = self.conn.query_row(
                    "SELECT id, size_bytes FROM tiles ORDER BY accessed_at ASC LIMIT 1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                );

                match oldest {
                    Ok((id, size)) => {
                        self.conn
                            .execute("DELETE FROM tiles WHERE id = ?1", params![id])?;
                        freed_bytes += size as u64;
                    }
                    Err(_) => break, // No more tiles to delete
                }
            }
        }

        // Run incremental vacuum to reclaim space if we freed anything
        if freed_bytes > 0 {
            let _ = self.conn.execute("PRAGMA incremental_vacuum(100)", []);
        }

        Ok(freed_bytes)
    }

    /// Clear all tiles from the cache.
    pub fn clear_all(&mut self) -> Result<()> {
        self.conn.execute("DELETE FROM tiles", [])?;
        let _ = self.conn.execute("VACUUM", []);
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
            .query_row("SELECT COALESCE(SUM(size_bytes), 0) FROM tiles", [], |row| {
                row.get(0)
            })
            .unwrap_or(0);

        let provider_count: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(DISTINCT provider) FROM tiles",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        CacheStats {
            tile_count: tile_count as u64,
            total_bytes: total_bytes as u64,
            provider_count: provider_count as u64,
        }
    }

    /// Check if a tile exists and is fresh (not expired).
    pub fn has_fresh_tile(&self, provider: &str, z: u32, y: u32, x: u32) -> bool {
        let now = Self::now();
        let min_fetched_at = now - self.ttl_seconds;

        let count: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM tiles
                 WHERE provider = ?1 AND z = ?2 AND y = ?3 AND x = ?4
                   AND fetched_at > ?5",
                params![provider, z, y, x, min_fetched_at],
                |row| row.get(0),
            )
            .unwrap_or(0);

        count > 0
    }

    /// Check if a tile exists but is stale (expired TTL).
    pub fn has_stale_tile(&self, provider: &str, z: u32, y: u32, x: u32) -> bool {
        let now = Self::now();
        let min_fetched_at = now - self.ttl_seconds;

        let count: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM tiles
                 WHERE provider = ?1 AND z = ?2 AND y = ?3 AND x = ?4
                   AND fetched_at <= ?5",
                params![provider, z, y, x, min_fetched_at],
                |row| row.get(0),
            )
            .unwrap_or(0);

        count > 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    // Helper to create test tile data
    fn make_tile_data(size: usize) -> Vec<u8> {
        vec![0xFFu8; size]
    }

    // === Test 1: put and get roundtrip ===
    #[test]
    fn test_put_get_roundtrip() {
        let mut cache = TileCache::in_memory(100, 30).unwrap();

        let tile_data = b"fake jpeg data here";
        cache
            .put("esri", 10, 500, 250, tile_data, "image/jpeg")
            .unwrap();

        let entry = cache.get("esri", 10, 500, 250).expect("Should get cached tile");
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
        thread::sleep(Duration::from_millis(10)); // Ensure different timestamps

        cache.put("esri", 1, 0, 1, &tile2, "image/jpeg").unwrap();
        thread::sleep(Duration::from_millis(10));

        // This should trigger eviction
        cache.put("esri", 1, 0, 2, &tile3, "image/jpeg").unwrap();

        // Access tile2 to make it more recently used
        let _ = cache.get("esri", 1, 0, 1);

        // Trigger eviction
        let _freed = cache.evict_lru().unwrap();

        // The oldest tile (tile1) should have been evicted
        // tile2 was accessed more recently, tile3 is newest
        let stats = cache.get_stats();
        assert!(
            stats.total_bytes <= cache.max_bytes,
            "Cache should be under limit"
        );

        // tile1 (oldest, never accessed after put) should be gone
        assert!(
            cache.get("esri", 1, 0, 0).is_none(),
            "Oldest tile should be evicted"
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

        // Wait for TTL to expire (wait 2.5 seconds to be safe)
        thread::sleep(Duration::from_millis(2500));

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

    // === Test 8: concurrent access (multi-threaded) ===
    #[test]
    fn test_concurrent_access() {
        use std::sync::{Arc, Mutex};

        // Use a real temp directory for thread safety
        let temp_dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(Mutex::new(TileCache::open(temp_dir.path(), 100, 30).unwrap()));

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
        cache
            .put("esri", 10, 500, 250, &[], "image/jpeg")
            .unwrap();

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
            cache
                .put("test", 10, 0, i as u32, b"data", ct)
                .unwrap();
        }

        for (i, ct) in content_types.iter().enumerate() {
            let entry = cache.get("test", 10, 0, i as u32).unwrap();
            assert_eq!(
                &entry.content_type, *ct,
                "Content type should be preserved"
            );
        }
    }

    // === Test 12: accessed_at updates on get ===
    #[test]
    fn test_accessed_at_updates_on_get() {
        let mut cache = TileCache::in_memory(100, 30).unwrap();

        cache
            .put("esri", 10, 500, 250, b"tile data", "image/jpeg")
            .unwrap();

        let first_access = cache.get("esri", 10, 500, 250).unwrap();
        let first_accessed_at = first_access.accessed_at;

        // Wait a bit
        thread::sleep(Duration::from_millis(100));

        // Access again - accessed_at should update
        let second_access = cache.get("esri", 10, 500, 250).unwrap();
        let second_accessed_at = second_access.accessed_at;

        assert!(
            second_accessed_at >= first_accessed_at,
            "accessed_at should be updated on get"
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

        // Wait for TTL to expire (2.5 seconds to be safe)
        thread::sleep(Duration::from_millis(2500));

        // Eviction should remove expired tiles
        let freed = cache.evict_lru().unwrap();
        assert!(freed > 0, "Should have freed expired tiles");

        let stats = cache.get_stats();
        assert_eq!(stats.tile_count, 0, "All expired tiles should be removed");
    }
}
