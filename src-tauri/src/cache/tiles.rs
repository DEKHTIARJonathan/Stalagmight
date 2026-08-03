//! SQLite-based tile cache for offline satellite imagery.
//!
//! Provides persistent storage for map tiles with LRU eviction and TTL-based expiration.
//!
//! # Nothing is stored without an explicit grant
//!
//! A tile is written to disk ONLY if its response carried a `Cache-Control`
//! that says how long it may be kept (`max-age`, or `no-cache` for "keep but
//! always revalidate"). A response with no directive is served and discarded.
//!
//! That is a deliberately narrow reading. Silence is not permission: the app
//! stores third-party imagery only where the provider's own headers say it may,
//! and only for as long as they say. Esri answers every tile with
//! `max-age=86400`, so its tiles cache; a provider that says nothing gets no
//! disk at all until it does.
//!
//! # Two clocks, two jobs
//!
//! A cached tile is governed by two independent deadlines, and conflating them
//! would break either the terms we cache under or the offline story:
//!
//! - **Freshness** (`get`) - may this tile be served *instead of* asking the
//!   provider? Bounded by BOTH the configured TTL and the provider's own
//!   `Cache-Control: max-age` (`expires_at`), whichever expires first. Esri's
//!   tiles come back with `max-age=86400`, so a 30-day configured TTL cannot
//!   make us treat a two-day-old tile as current.
//! - **Retention** (`get_stale`, eviction) - may this tile stay on disk at all?
//!   Bounded by the configured TTL alone.
//!
//! The gap between them is deliberate: past `max-age` a tile stops being served
//! as fresh, so every request goes to the network first, but the copy survives to
//! answer if that request fails. That is `stale-if-error` (RFC 5861), and it is
//! what keeps a map usable in a cave with no signal without ever presenting
//! expired imagery as current.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Ceiling on a provider's `max-age`, in seconds (one year).
///
/// `max-age` arrives off the network, so it is an untrusted number that this
/// module then adds to the clock. Without a ceiling, `max-age=<i64::MAX>`
/// overflows the addition: a debug build panics *inside* the tile-cache mutex,
/// poisoning it and silently disabling caching for the rest of the session,
/// while a release build wraps to a negative expiry the tile can never satisfy.
/// A year is far beyond any real basemap grant (Esri sends a day), so clamping
/// here costs nothing legitimate.
const MAX_GRANT_SECONDS: i64 = 365 * 24 * 60 * 60;

/// Freshness directives read off a tile response.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CachePolicy {
    /// Seconds the provider says the tile may be served without revalidating,
    /// from `Cache-Control: max-age`.
    ///
    /// `None` means the provider said nothing, and is treated as NO PERMISSION
    /// TO STORE - not as "cache it indefinitely". This is the gate the whole
    /// module hangs off; see the note at the top.
    pub max_age_seconds: Option<i64>,
    /// The provider forbade storing this response at all (`no-store`).
    pub no_store: bool,
}

impl CachePolicy {
    /// Seconds of storage the provider granted, or `None` for no permission.
    ///
    /// **The single gate.** Both write paths - `put` for a fetched body and
    /// `refresh_validated` for a `304` - ask this and nothing else. They used to
    /// carry the rule separately and drifted: the revalidation path never
    /// checked `no_store`, so a provider revoking permission on a 304 had its
    /// tile kept AND its retention extended.
    pub fn granted_seconds(&self) -> Option<i64> {
        self.max_age_seconds.filter(|_| !self.no_store)
    }

    /// Whether the provider granted permission to write this response to disk.
    pub fn permits_storage(&self) -> bool {
        self.granted_seconds().is_some()
    }
}

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
    /// Unix timestamp the provider's `max-age` runs out, if it sent one.
    /// `None` = the provider said nothing, so only the configured TTL applies.
    pub expires_at: Option<i64>,
    /// Validator from the response this tile came in, for a conditional
    /// re-fetch. `None` = no `ETag`, so revalidation is not possible and a
    /// re-fetch has to pull the whole body.
    pub etag: Option<String>,
}

impl TileEntry {
    /// The freshness this entry has LEFT, as a policy a derived tile can inherit.
    ///
    /// Overzoomed tiles are crops of a parent, and re-deriving one must not hand
    /// it a longer life than the imagery it came from - so the remaining seconds
    /// travel with it rather than the original `max-age`.
    pub fn remaining_policy(&self, now: i64) -> CachePolicy {
        CachePolicy {
            max_age_seconds: self.expires_at.map(|at| at.saturating_sub(now).max(0)),
            no_store: false,
        }
    }
}

/// Parse the freshness directives out of a `Cache-Control` header value.
///
/// Only the two directives that change what this cache may do are read;
/// everything else (`public`, `must-revalidate`, ...) is inert here. `no-cache`
/// maps to `max_age_seconds: Some(0)` - store it, never serve it as fresh, which
/// is exactly the stale-if-error shape the rest of the module is built around.
pub fn parse_cache_control(header: &str) -> CachePolicy {
    let mut policy = CachePolicy::default();
    for directive in header.split(',') {
        let directive = directive.trim().to_ascii_lowercase();
        if directive == "no-store" {
            policy.no_store = true;
        } else if directive == "no-cache" {
            policy.max_age_seconds = Some(0);
        } else if let Some(value) = directive.strip_prefix("max-age=") {
            // A negative or unparseable max-age is treated as "said nothing"
            // rather than as zero: guessing "immediately stale" from a malformed
            // header would silently disable caching for a whole provider.
            if let Ok(seconds) = value.trim().parse::<i64>() {
                if seconds >= 0 {
                    // Clamped: this number is remote input and gets added to the
                    // clock below. See MAX_GRANT_SECONDS.
                    policy.max_age_seconds = Some(seconds.min(MAX_GRANT_SECONDS));
                }
            }
        }
    }
    policy
}

/// Current Unix timestamp, on the same clock the cache stamps entries with.
pub fn now() -> i64 {
    TileCache::now()
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
    /// Default time-to-live in seconds, for providers with no override
    ttl_seconds: i64,
    /// Per-provider TTL overrides, in seconds
    provider_ttl_seconds: HashMap<String, i64>,
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
            provider_ttl_seconds: HashMap::new(),
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
            provider_ttl_seconds: HashMap::new(),
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

        // Added after the table shipped, so existing caches need the columns
        // bolted on. SQLite has no `ADD COLUMN IF NOT EXISTS`, hence the probe.
        // Both are nullable with no default: NULL means "this row predates the
        // column", which for `expires_at` reads as "the provider said nothing"
        // and leaves those tiles governed by the configured TTL alone - the
        // behaviour they were cached under.
        let existing: Vec<String> = {
            let mut stmt = self.conn.prepare("PRAGMA table_info(tiles)")?;
            let names = stmt
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?;
            names
        };
        if !existing.iter().any(|c| c == "expires_at") {
            self.conn
                .execute("ALTER TABLE tiles ADD COLUMN expires_at INTEGER", [])?;
        }
        if !existing.iter().any(|c| c == "etag") {
            self.conn
                .execute("ALTER TABLE tiles ADD COLUMN etag TEXT", [])?;
        }

        Ok(())
    }

    /// Replace the per-provider TTL overrides.
    ///
    /// Separate from the constructor so the existing `open`/`in_memory`
    /// signatures (and their call sites) stay put, and so a config reload can
    /// re-apply them without rebuilding the cache.
    pub fn set_provider_ttls(&mut self, ttl_days_by_provider: &HashMap<String, u32>) {
        self.provider_ttl_seconds = ttl_days_by_provider
            .iter()
            .map(|(provider, days)| (provider.clone(), i64::from(*days) * 24 * 60 * 60))
            .collect();
    }

    /// Retention TTL for a provider, in seconds - its override, else the default.
    fn ttl_for(&self, provider: &str) -> i64 {
        self.provider_ttl_seconds
            .get(provider)
            .copied()
            .unwrap_or(self.ttl_seconds)
    }

    /// Delete every tile past its own provider's retention TTL.
    ///
    /// One statement per overridden provider plus one for everything else,
    /// rather than a single global cutoff: with per-provider TTLs a single cutoff
    /// would either evict a provider's tiles early or keep another's past its
    /// configured life. Retention only - `expires_at` is not consulted, so tiles
    /// past the provider's max-age survive here to serve `get_stale`.
    fn delete_retired(&self) -> Result<u64> {
        let now = Self::now();
        let mut deleted = 0u64;

        for (provider, ttl) in &self.provider_ttl_seconds {
            deleted += self.conn.execute(
                "DELETE FROM tiles WHERE provider = ?1 AND fetched_at <= ?2",
                params![provider, now - ttl],
            )? as u64;
        }

        // Everything with no override, against the default TTL. Building the
        // NOT IN list from the same map keeps the two branches disjoint.
        let overridden: Vec<&String> = self.provider_ttl_seconds.keys().collect();
        if overridden.is_empty() {
            deleted += self.conn.execute(
                "DELETE FROM tiles WHERE fetched_at <= ?1",
                params![now - self.ttl_seconds],
            )? as u64;
        } else {
            let placeholders = vec!["?"; overridden.len()].join(",");
            let sql = format!(
                "DELETE FROM tiles WHERE fetched_at <= ?1 AND provider NOT IN ({placeholders})"
            );
            let mut args: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(overridden.len() + 1);
            let cutoff = now - self.ttl_seconds;
            args.push(&cutoff);
            for provider in &overridden {
                args.push(provider);
            }
            deleted += self.conn.execute(&sql, args.as_slice())? as u64;
        }

        Ok(deleted)
    }

    /// Get the current Unix timestamp
    pub(crate) fn now() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }

    /// Get a tile from the cache, if it may still be served *without* asking the
    /// provider.
    ///
    /// Fresh means inside BOTH deadlines (see the module docs): the configured
    /// retention TTL, and the provider's own `Cache-Control: max-age` recorded in
    /// `expires_at`. A tile past `max-age` is not returned here even though it is
    /// still on disk - `get_stale` is the path that reaches it, and only when the
    /// network has already failed.
    ///
    /// Updates the `accessed_at` timestamp on cache hit.
    ///
    /// Note: Returns `None` on DB errors (logged at warn level).
    pub fn get(&mut self, provider: &str, z: u32, y: u32, x: u32) -> Option<TileEntry> {
        let now = Self::now();
        // A tile is fresh if it was fetched within the last ttl_seconds
        // Use strict < for staleness: tile is stale when fetched_at <= now - ttl_seconds
        let min_fetched_at = now - self.ttl_for(provider);

        // Update accessed_at first and return tile data in one query
        // This ensures the returned accessed_at is current
        let result: Result<TileEntry, rusqlite::Error> = self.conn.query_row(
            "UPDATE tiles SET accessed_at = ?1
             WHERE provider = ?2 AND z = ?3 AND y = ?4 AND x = ?5
               AND fetched_at > ?6
               AND expires_at IS NOT NULL AND expires_at > ?1
             RETURNING data, content_type, size_bytes, fetched_at, accessed_at, expires_at, etag",
            params![now, provider, z, y, x, min_fetched_at],
            |row| {
                Ok(TileEntry {
                    data: row.get(0)?,
                    content_type: row.get(1)?,
                    size_bytes: row.get::<_, i64>(2)? as u64,
                    fetched_at: row.get(3)?,
                    accessed_at: row.get(4)?,
                    expires_at: row.get(5)?,
                    etag: row.get(6)?,
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

    /// Get a stale tile from the cache - one `get` declined to serve.
    ///
    /// This is the offline fallback, reached only after a network fetch has
    /// already failed. "Stale" is the exact complement of `get`'s freshness, so
    /// it covers BOTH ways a tile can stop being current: past the configured
    /// retention TTL, or past the provider's own `max-age`. Covering only the
    /// first left tiles inside the TTL but beyond `max-age` reachable by neither
    /// path - cached, retained, and permanently invisible.
    ///
    /// Does NOT update `accessed_at` since we're serving stale data.
    ///
    /// Returns `None` if the tile is not cached at all (fresh or stale).
    pub fn get_stale(&self, provider: &str, z: u32, y: u32, x: u32) -> Option<TileEntry> {
        let now = Self::now();
        let min_fetched_at = now - self.ttl_for(provider);

        // The complement of `get`'s predicate: too old, OR past its max-age.
        let result: Result<TileEntry, rusqlite::Error> = self.conn.query_row(
            "SELECT data, content_type, size_bytes, fetched_at, accessed_at, expires_at, etag FROM tiles
             WHERE provider = ?1 AND z = ?2 AND y = ?3 AND x = ?4
               AND (fetched_at <= ?5 OR expires_at IS NULL OR expires_at <= ?6)",
            params![provider, z, y, x, min_fetched_at, now],
            |row| {
                Ok(TileEntry {
                    data: row.get(0)?,
                    content_type: row.get(1)?,
                    size_bytes: row.get::<_, i64>(2)? as u64,
                    fetched_at: row.get(3)?,
                    accessed_at: row.get(4)?,
                    expires_at: row.get(5)?,
                    etag: row.get(6)?,
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
        policy: CachePolicy,
        etag: Option<&str>,
    ) -> Result<()> {
        let now = Self::now();
        let new_size = data.len() as u64;

        // No grant, no disk. `no-store` is an explicit refusal; a missing
        // `max-age` is simply silence, and this cache does not read silence as
        // consent. Either way any copy we already hold goes with it - a provider
        // that stops granting should not leave us holding yesterday's grant.
        let Some(max_age) = policy.granted_seconds() else {
            self.conn.execute(
                "DELETE FROM tiles WHERE provider = ?1 AND z = ?2 AND y = ?3 AND x = ?4",
                params![provider, z, y, x],
            )?;
            return Ok(());
        };

        let expires_at = now.saturating_add(max_age);

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
        self.delete_retired()?;

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
            "INSERT OR REPLACE INTO tiles (provider, z, y, x, data, content_type, size_bytes, fetched_at, accessed_at, expires_at, etag)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![provider, z, y, x, data, content_type, new_size as i64, now, now, Some(expires_at), etag],
        )?;

        Ok(())
    }

    /// Re-stamp a tile the provider just confirmed is still current (a `304`).
    ///
    /// Moves both clocks forward without touching the bytes: `expires_at` from
    /// the freshly-returned directives, and `fetched_at` because the copy WAS
    /// just validated - it is current imagery, not an old file being kept alive.
    /// That is what lets a revalidating client hold a tile indefinitely while
    /// the provider keeps saying it has not changed.
    ///
    /// Returns whether a row was actually updated.
    pub fn refresh_validated(
        &mut self,
        provider: &str,
        z: u32,
        y: u32,
        x: u32,
        policy: CachePolicy,
    ) -> Result<bool> {
        let now = Self::now();

        // Same gate as `put`. A revalidation is still a grant decision: if the
        // provider answered the 304 without permission (or with `no-store`),
        // the copy goes rather than having its life extended.
        let Some(max_age) = policy.granted_seconds() else {
            self.conn.execute(
                "DELETE FROM tiles WHERE provider = ?1 AND z = ?2 AND y = ?3 AND x = ?4",
                params![provider, z, y, x],
            )?;
            return Ok(false);
        };

        let expires_at = now.saturating_add(max_age);
        let updated = self.conn.execute(
            "UPDATE tiles SET fetched_at = ?1, accessed_at = ?1, expires_at = ?2
             WHERE provider = ?3 AND z = ?4 AND y = ?5 AND x = ?6",
            params![now, Some(expires_at), provider, z, y, x],
        )?;
        Ok(updated > 0)
    }

    /// Push a tile past its provider `max-age` without touching retention.
    /// Lets a test reach the revalidation window without sleeping through it.
    #[cfg(test)]
    pub fn expire_max_age_for_test(
        &mut self,
        provider: &str,
        z: u32,
        y: u32,
        x: u32,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE tiles SET expires_at = ?1
                 WHERE provider = ?2 AND z = ?3 AND y = ?4 AND x = ?5",
            params![Self::now() - 1, provider, z, y, x],
        )?;
        Ok(())
    }

    /// `put` with a generous grant already supplied, for the tests that predate
    /// provider cache directives.
    ///
    /// They exercise LRU, sizing, retention and provider isolation - none of
    /// which the directives touch - so they need a tile that actually lands on
    /// disk. Since the cache stores only on an explicit grant, "no directives"
    /// is no longer a way to store anything; the gate itself has its own tests.
    #[cfg(test)]
    pub fn put_granted(
        &mut self,
        provider: &str,
        z: u32,
        y: u32,
        x: u32,
        data: &[u8],
        content_type: &str,
    ) -> Result<()> {
        self.put(
            provider,
            z,
            y,
            x,
            data,
            content_type,
            CachePolicy {
                max_age_seconds: Some(30 * 24 * 60 * 60),
                no_store: false,
            },
            None,
        )
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

        // First, always delete tiles past their provider's retention TTL.
        // Measured as a before/after delta rather than a pre-computed SUM: with
        // per-provider cutoffs the deleting statement is no longer a single
        // predicate a SUM could mirror, and the delta cannot drift from it.
        let bytes_before = self.get_stats().total_bytes;
        self.delete_retired()?;
        freed_bytes += bytes_before.saturating_sub(self.get_stats().total_bytes);

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
    pub fn get_provider_stats(&self) -> HashMap<String, (u64, u64)> {
        let mut result = HashMap::new();

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
        let min_fetched_at = now - self.ttl_for(provider);

        // Mirrors `get`'s predicate exactly - a divergence here would report a
        // tile as servable that `get` then declines to serve.
        match self.conn.query_row(
            "SELECT COUNT(*) FROM tiles
             WHERE provider = ?1 AND z = ?2 AND y = ?3 AND x = ?4
               AND fetched_at > ?5
               AND expires_at IS NOT NULL AND expires_at > ?6",
            params![provider, z, y, x, min_fetched_at, now],
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
        let min_fetched_at = now - self.ttl_for(provider);

        // Mirrors `get_stale` exactly - both are "present but not fresh".
        match self.conn.query_row(
            "SELECT COUNT(*) FROM tiles
             WHERE provider = ?1 AND z = ?2 AND y = ?3 AND x = ?4
               AND (fetched_at <= ?5 OR expires_at IS NULL OR expires_at <= ?6)",
            params![provider, z, y, x, min_fetched_at, now],
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
            .put_granted("esri", 10, 500, 250, tile_data, "image/jpeg")
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
            .put_granted("esri", 10, 500, 251, b"other tile", "image/png")
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

        cache
            .put_granted("esri", 1, 0, 0, &tile1, "image/jpeg")
            .unwrap();
        cache
            .put_granted("esri", 1, 0, 1, &tile2, "image/jpeg")
            .unwrap();
        cache
            .put_granted("esri", 1, 0, 2, &tile3, "image/jpeg")
            .unwrap();

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
            .put_granted("esri", 10, 500, 250, b"tile data", "image/jpeg")
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

        cache
            .put_granted("esri", 1, 0, 0, b"tile1", "image/jpeg")
            .unwrap();
        cache
            .put_granted("osm", 2, 1, 1, b"tile2", "image/png")
            .unwrap();
        cache
            .put_granted("mapbox", 3, 2, 2, b"tile3", "image/jpeg")
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

        cache
            .put_granted("esri", 1, 0, 0, b"esri1", "image/jpeg")
            .unwrap();
        cache
            .put_granted("esri", 1, 0, 1, b"esri2", "image/jpeg")
            .unwrap();
        cache
            .put_granted("osm", 1, 0, 0, b"osm1", "image/png")
            .unwrap();

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

        cache
            .put_granted("esri", 1, 0, 0, &tile1, "image/jpeg")
            .unwrap();
        cache
            .put_granted("esri", 1, 0, 1, &tile2, "image/jpeg")
            .unwrap();
        cache
            .put_granted("osm", 1, 0, 0, &tile3, "image/png")
            .unwrap();

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
                    .put_granted("esri", 10, i, 0, &tile_data, "image/jpeg")
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
            .put_granted("esri", 10, 500, 250, b"esri data", "image/jpeg")
            .unwrap();
        cache
            .put_granted("osm", 10, 500, 250, b"osm data", "image/png")
            .unwrap();
        cache
            .put_granted("mapbox", 10, 500, 250, b"mapbox data", "image/webp")
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
            .put_granted("esri", 10, 500, 250, &[], "image/jpeg")
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
                .put_granted("test", 10, 0, i as u32, b"data", ct)
                .unwrap();
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
            .put_granted("esri", 10, 500, 250, b"tile data", "image/jpeg")
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
            .put_granted("esri", 10, 500, 250, b"original data", "image/jpeg")
            .unwrap();
        cache
            .put_granted("esri", 10, 500, 250, b"updated data!!!", "image/png")
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
        cache
            .put_granted("esri", 10, 0, 0, b"fresh", "image/jpeg")
            .unwrap();
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

        cache
            .put_granted("esri", 10, 0, 0, b"tile1", "image/jpeg")
            .unwrap();
        cache
            .put_granted("esri", 10, 0, 1, b"tile2", "image/jpeg")
            .unwrap();

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

        cache
            .put_granted("esri", 1, 0, 0, &tile1, "image/jpeg")
            .unwrap();
        cache
            .put_granted("esri", 1, 0, 1, &tile2, "image/jpeg")
            .unwrap();

        // Set explicit timestamps
        set_accessed_at(&cache, "esri", 1, 0, 0, TileCache::now() - 100);
        set_accessed_at(&cache, "esri", 1, 0, 1, TileCache::now());

        // This put should trigger eviction to make space
        cache
            .put_granted("esri", 1, 0, 2, &tile3, "image/jpeg")
            .unwrap();

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
        let result = cache.put_granted("esri", 1, 0, 0, &oversized, "image/jpeg");

        assert!(result.is_err(), "Oversized tile should be rejected");
    }

    // === Test 18: LRU eviction has deterministic tie-breaking ===
    #[test]
    fn test_lru_deterministic_tiebreaker() {
        let mut cache = TileCache::in_memory(1, 30).unwrap();
        cache.max_bytes = 500; // 500 bytes capacity

        // Add tiles with same timestamp - 3 * 200 = 600 bytes exceeds 500
        let tile = make_tile_data(200);
        cache
            .put_granted("esri", 1, 0, 0, &tile, "image/jpeg")
            .unwrap();
        cache
            .put_granted("esri", 1, 0, 1, &tile, "image/jpeg")
            .unwrap();
        cache
            .put_granted("esri", 1, 0, 2, &tile, "image/jpeg")
            .unwrap();

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

        cache
            .put_granted("esri", 1, 0, 0, &tile100, "image/jpeg")
            .unwrap();
        cache
            .put_granted("esri", 1, 0, 1, &tile200, "image/jpeg")
            .unwrap();
        cache
            .put_granted("osm", 1, 0, 0, &tile150, "image/png")
            .unwrap();

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

    // === Cache-Control (Esri sends `max-age=86400` on every tile) ===

    #[test]
    fn parses_the_header_esri_actually_sends() {
        let policy = parse_cache_control("max-age=86400");
        assert_eq!(policy.max_age_seconds, Some(86_400));
        assert!(!policy.no_store);
    }

    #[test]
    fn parses_directives_case_insensitively_and_among_others() {
        let policy = parse_cache_control("Public, MAX-AGE=600, must-revalidate");
        assert_eq!(policy.max_age_seconds, Some(600));
        assert!(!policy.no_store);
    }

    #[test]
    fn treats_no_cache_as_store_but_never_fresh() {
        // Keeping it is what lets it answer offline; serving it as current is
        // what the directive forbids.
        let policy = parse_cache_control("no-cache");
        assert_eq!(policy.max_age_seconds, Some(0));
        assert!(!policy.no_store);
    }

    #[test]
    fn reads_no_store() {
        assert!(parse_cache_control("no-store").no_store);
    }

    #[test]
    fn ignores_a_malformed_max_age_rather_than_reading_it_as_zero() {
        // Reading garbage as "immediately stale" would silently kill caching for
        // a whole provider; "said nothing" leaves the configured TTL in charge.
        assert_eq!(parse_cache_control("max-age=banana").max_age_seconds, None);
        assert_eq!(parse_cache_control("max-age=-5").max_age_seconds, None);
        assert_eq!(parse_cache_control("").max_age_seconds, None);
    }

    #[test]
    fn max_age_expiry_stops_a_tile_being_served_as_fresh() {
        let mut cache = TileCache::in_memory(10, 30).unwrap();
        let policy = CachePolicy {
            max_age_seconds: Some(60),
            no_store: false,
        };
        cache
            .put(
                "esri",
                1,
                2,
                3,
                b"tile",
                "image/jpeg",
                policy,
                Some("W/\"abc\""),
            )
            .unwrap();

        assert!(cache.get("esri", 1, 2, 3).is_some());

        // Walk the stored expiry into the past - the configured 30-day TTL is
        // untouched, so only the provider's max-age can be doing the work here.
        cache
            .conn
            .execute(
                "UPDATE tiles SET expires_at = ?1",
                params![TileCache::now() - 1],
            )
            .unwrap();

        assert!(
            cache.get("esri", 1, 2, 3).is_none(),
            "past max-age the tile must not be served as current"
        );
        assert!(
            cache.get_stale("esri", 1, 2, 3).is_some(),
            "but it must survive to answer offline (stale-if-error)"
        );
        assert!(!cache.has_fresh_tile("esri", 1, 2, 3));
        assert!(cache.has_stale_tile("esri", 1, 2, 3));
    }

    #[test]
    fn a_provider_that_grants_nothing_gets_no_disk() {
        // Silence is not consent. Without a Cache-Control saying how long the
        // tile may be kept, it is served and dropped - the configured TTL is a
        // ceiling on a grant, never a substitute for one.
        let mut cache = TileCache::in_memory(10, 30).unwrap();
        cache
            .put(
                "other",
                1,
                2,
                3,
                b"tile",
                "image/jpeg",
                CachePolicy::default(),
                None,
            )
            .unwrap();

        assert!(cache.get("other", 1, 2, 3).is_none());
        assert!(cache.get_stale("other", 1, 2, 3).is_none());
        assert_eq!(cache.get_stats().tile_count, 0);
    }

    #[test]
    fn losing_the_grant_drops_the_copy_we_were_holding_under_it() {
        // A provider that stops sending a grant should not leave us sitting on
        // yesterday's. The re-fetch that carried no directive evicts it.
        let mut cache = TileCache::in_memory(10, 30).unwrap();
        cache
            .put_granted("esri", 1, 2, 3, b"granted", "image/jpeg")
            .unwrap();
        assert!(cache.get("esri", 1, 2, 3).is_some());

        cache
            .put(
                "esri",
                1,
                2,
                3,
                b"ungranted",
                "image/jpeg",
                CachePolicy::default(),
                None,
            )
            .unwrap();

        assert_eq!(cache.get_stats().tile_count, 0);
    }

    #[test]
    fn no_cache_is_a_grant_to_store_even_though_it_is_never_fresh() {
        // "Keep it, but always ask" is still permission to keep it - and that
        // stored copy is what answers when the network is gone.
        let mut cache = TileCache::in_memory(10, 30).unwrap();
        cache
            .put(
                "esri",
                1,
                2,
                3,
                b"tile",
                "image/jpeg",
                parse_cache_control("no-cache"),
                None,
            )
            .unwrap();

        assert!(
            cache.get("esri", 1, 2, 3).is_none(),
            "never served as fresh"
        );
        assert!(
            cache.get_stale("esri", 1, 2, 3).is_some(),
            "but retained for stale-if-error"
        );
    }

    #[test]
    fn permits_storage_is_the_gate_the_cache_actually_applies() {
        assert!(parse_cache_control("max-age=86400").permits_storage());
        assert!(parse_cache_control("no-cache").permits_storage());
        assert!(!parse_cache_control("no-store").permits_storage());
        assert!(!parse_cache_control("public").permits_storage());
        assert!(!CachePolicy::default().permits_storage());
    }

    #[test]
    fn no_store_is_not_written_and_drops_any_prior_copy() {
        let mut cache = TileCache::in_memory(10, 30).unwrap();
        cache
            .put_granted("esri", 1, 2, 3, b"first", "image/jpeg")
            .unwrap();
        assert!(cache.get("esri", 1, 2, 3).is_some());

        cache
            .put(
                "esri",
                1,
                2,
                3,
                b"second",
                "image/jpeg",
                CachePolicy {
                    max_age_seconds: None,
                    no_store: true,
                },
                None,
            )
            .unwrap();

        assert!(cache.get("esri", 1, 2, 3).is_none());
        assert!(cache.get_stale("esri", 1, 2, 3).is_none());
    }

    #[test]
    fn remaining_policy_carries_what_is_left_never_the_original_grant() {
        // An overzoomed crop inherits this; handing it the full max-age would
        // let a derived tile outlive the imagery it was cut from.
        let now = 1_000;
        let entry = TileEntry {
            data: vec![],
            content_type: "image/jpeg".to_string(),
            size_bytes: 0,
            fetched_at: now - 100,
            accessed_at: now,
            expires_at: Some(now + 25),
            etag: None,
        };
        assert_eq!(entry.remaining_policy(now).max_age_seconds, Some(25));
        // Never negative: an already-expired parent yields an immediately-stale child.
        assert_eq!(entry.remaining_policy(now + 100).max_age_seconds, Some(0));
    }

    // === Per-provider TTL ===

    #[test]
    fn a_provider_override_shortens_retention_without_touching_others() {
        let mut cache = TileCache::in_memory(10, 30).unwrap();
        cache.set_provider_ttls(&HashMap::from([("esri".to_string(), 1u32)]));

        cache
            .put_granted("esri", 1, 0, 0, b"a", "image/jpeg")
            .unwrap();
        cache
            .put_granted("other", 1, 0, 0, b"b", "image/jpeg")
            .unwrap();

        // Age both by two days: past esri's 1-day override, inside the 30-day default.
        let two_days_ago = TileCache::now() - 2 * 24 * 60 * 60;
        cache
            .conn
            .execute("UPDATE tiles SET fetched_at = ?1", params![two_days_ago])
            .unwrap();

        assert!(cache.get("esri", 1, 0, 0).is_none(), "past its own TTL");
        assert!(
            cache.get("other", 1, 0, 0).is_some(),
            "still inside the default"
        );
    }

    #[test]
    fn eviction_retires_each_provider_on_its_own_clock() {
        let mut cache = TileCache::in_memory(10, 30).unwrap();
        cache.set_provider_ttls(&HashMap::from([("esri".to_string(), 1u32)]));
        cache
            .put_granted("esri", 1, 0, 0, b"a", "image/jpeg")
            .unwrap();
        cache
            .put_granted("other", 1, 0, 0, b"b", "image/jpeg")
            .unwrap();
        let two_days_ago = TileCache::now() - 2 * 24 * 60 * 60;
        cache
            .conn
            .execute("UPDATE tiles SET fetched_at = ?1", params![two_days_ago])
            .unwrap();

        cache.evict_lru().unwrap();

        // A single global cutoff would have taken both, or neither.
        assert!(!cache.has_stale_tile("esri", 1, 0, 0));
        assert!(cache.get("other", 1, 0, 0).is_some());
    }

    #[test]
    fn schema_migration_is_idempotent_on_an_existing_cache() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut cache = TileCache::open(dir.path(), 10, 30).unwrap();
            cache
                .put_granted("esri", 1, 2, 3, b"tile", "image/jpeg")
                .unwrap();
        }
        // Re-opening runs init_schema again; the ADD COLUMNs must not double-apply.
        let mut reopened = TileCache::open(dir.path(), 10, 30).unwrap();
        assert!(reopened.get("esri", 1, 2, 3).is_some());
    }

    // === Conditional revalidation (Esri answers If-None-Match with a 304) ===

    #[test]
    fn the_validator_is_stored_and_readable_for_a_conditional_refetch() {
        let mut cache = TileCache::in_memory(10, 30).unwrap();
        cache
            .put(
                "esri",
                1,
                2,
                3,
                b"tile",
                "image/jpeg",
                CachePolicy {
                    max_age_seconds: Some(60),
                    no_store: false,
                },
                Some("\"sjii0vvv1sqvf\""),
            )
            .unwrap();
        let entry = cache.get("esri", 1, 2, 3).unwrap();
        assert_eq!(entry.etag.as_deref(), Some("\"sjii0vvv1sqvf\""));
    }

    #[test]
    fn a_validator_survives_into_the_stale_window_where_it_is_actually_needed() {
        // Revalidation only happens once a tile is PAST max-age, so the etag has
        // to still be readable from the stale path - that is what supplies
        // If-None-Match.
        let mut cache = TileCache::in_memory(10, 30).unwrap();
        cache
            .put(
                "esri",
                1,
                2,
                3,
                b"tile",
                "image/jpeg",
                CachePolicy {
                    max_age_seconds: Some(60),
                    no_store: false,
                },
                Some("\"abc\""),
            )
            .unwrap();
        cache
            .conn
            .execute(
                "UPDATE tiles SET expires_at = ?1",
                params![TileCache::now() - 1],
            )
            .unwrap();

        assert!(cache.get("esri", 1, 2, 3).is_none());
        let stale = cache.get_stale("esri", 1, 2, 3).unwrap();
        assert_eq!(stale.etag.as_deref(), Some("\"abc\""));
    }

    #[test]
    fn revalidation_makes_a_stale_tile_fresh_again_without_new_bytes() {
        let mut cache = TileCache::in_memory(10, 30).unwrap();
        cache
            .put(
                "esri",
                1,
                2,
                3,
                b"original bytes",
                "image/jpeg",
                CachePolicy {
                    max_age_seconds: Some(60),
                    no_store: false,
                },
                Some("\"abc\""),
            )
            .unwrap();
        cache
            .conn
            .execute(
                "UPDATE tiles SET expires_at = ?1",
                params![TileCache::now() - 1],
            )
            .unwrap();
        assert!(cache.get("esri", 1, 2, 3).is_none(), "precondition: stale");

        let refreshed = cache
            .refresh_validated(
                "esri",
                1,
                2,
                3,
                CachePolicy {
                    max_age_seconds: Some(86_400),
                    no_store: false,
                },
            )
            .unwrap();
        assert!(refreshed);

        let entry = cache
            .get("esri", 1, 2, 3)
            .expect("a 304 puts the tile back in the fresh window");
        // The bytes are untouched - that is the entire saving.
        assert_eq!(entry.data, b"original bytes");
        assert!(entry.expires_at.unwrap() > TileCache::now());
    }

    #[test]
    fn revalidating_a_tile_we_do_not_have_reports_it_rather_than_inventing_a_row() {
        let mut cache = TileCache::in_memory(10, 30).unwrap();
        let refreshed = cache
            .refresh_validated("esri", 9, 9, 9, CachePolicy::default())
            .unwrap();
        assert!(!refreshed);
        assert!(cache.get_stale("esri", 9, 9, 9).is_none());
    }

    // === Remote max-age is untrusted arithmetic input ===

    #[test]
    fn an_absurd_max_age_is_clamped_rather_than_overflowing_the_clock() {
        // `max-age` comes off the network and is then ADDED to the clock. Left
        // unbounded, i64::MAX panics the addition in a debug build - inside the
        // tile-cache mutex, which poisons it and silently kills caching for the
        // session - and wraps to a negative expiry in release.
        let policy = parse_cache_control(&format!("max-age={}", i64::MAX));
        assert_eq!(policy.max_age_seconds, Some(MAX_GRANT_SECONDS));

        let ordinary = parse_cache_control("max-age=86400");
        assert_eq!(
            ordinary.max_age_seconds,
            Some(86_400),
            "a real grant must pass through untouched"
        );
    }

    #[test]
    fn a_hostile_max_age_neither_panics_nor_makes_the_tile_unservable() {
        let mut cache = TileCache::in_memory(10, 30).unwrap();
        // Straight past the parser, as a hand-built policy - the belt to the
        // clamp's braces, and the shape the existing tests already construct.
        cache
            .put(
                "esri",
                1,
                2,
                3,
                b"tile",
                "image/jpeg",
                CachePolicy {
                    max_age_seconds: Some(i64::MAX),
                    no_store: false,
                },
                None,
            )
            .unwrap();

        let entry = cache
            .get("esri", 1, 2, 3)
            .expect("a saturated expiry is far-future, so the tile stays servable");
        assert!(entry.expires_at.unwrap() > TileCache::now());
    }

    #[test]
    fn a_saturated_parent_hands_a_child_a_bounded_grant() {
        // remaining_policy subtracts; an i64::MAX expiry must not wrap it.
        let entry = TileEntry {
            data: vec![],
            content_type: "image/jpeg".to_string(),
            size_bytes: 0,
            fetched_at: 0,
            accessed_at: 0,
            expires_at: Some(i64::MAX),
            etag: None,
        };
        assert_eq!(entry.remaining_policy(0).max_age_seconds, Some(i64::MAX));
        assert_eq!(
            entry.remaining_policy(i64::MIN).max_age_seconds,
            Some(i64::MAX),
            "saturating, not wrapping"
        );
    }

    // === One grant gate, applied on BOTH write paths ===

    #[test]
    fn revalidation_that_revokes_the_grant_drops_the_copy() {
        // The 304 path used to skip this check entirely: a provider answering
        // "still current, but stop storing it" had its tile kept AND its
        // retention extended, the exact opposite of what put() promises.
        let mut cache = TileCache::in_memory(10, 30).unwrap();
        cache
            .put_granted("esri", 1, 2, 3, b"tile", "image/jpeg")
            .unwrap();
        assert!(cache.get("esri", 1, 2, 3).is_some());

        let refreshed = cache
            .refresh_validated(
                "esri",
                1,
                2,
                3,
                CachePolicy {
                    max_age_seconds: Some(86_400),
                    no_store: true,
                },
            )
            .unwrap();

        assert!(!refreshed, "nothing was refreshed - the row is gone");
        assert_eq!(cache.get_stats().tile_count, 0);
    }

    #[test]
    fn a_304_carrying_no_grant_at_all_also_drops_the_copy() {
        // Silence on a revalidation is silence, same as on a fetch.
        let mut cache = TileCache::in_memory(10, 30).unwrap();
        cache
            .put_granted("esri", 1, 2, 3, b"tile", "image/jpeg")
            .unwrap();

        let refreshed = cache
            .refresh_validated("esri", 1, 2, 3, CachePolicy::default())
            .unwrap();

        assert!(!refreshed);
        assert_eq!(cache.get_stats().tile_count, 0);
    }

    #[test]
    fn granted_seconds_is_the_one_gate_both_paths_ask() {
        assert_eq!(
            parse_cache_control("max-age=86400").granted_seconds(),
            Some(86_400)
        );
        assert_eq!(parse_cache_control("no-cache").granted_seconds(), Some(0));
        assert_eq!(parse_cache_control("no-store").granted_seconds(), None);
        assert_eq!(
            parse_cache_control("no-store, max-age=86400").granted_seconds(),
            None,
            "no-store beats a max-age sent alongside it"
        );
        assert_eq!(CachePolicy::default().granted_seconds(), None);
    }
}
