//! [#576 B35(j)] Size accounting of the tile cache: what `put` holds against
//! `max_bytes`, checked against what is actually on disk.
//!
//! Every tile here is synthetic bytes; no imagery and no fixture is read.

use rusqlite::params;

use super::TileCache;

/// Push one stored tile to an exact `accessed_at`, so LRU order is decided by
/// the test rather than by which second the puts happened to land in.
fn set_accessed_at(cache: &TileCache, provider: &str, z: u32, y: u32, x: u32, accessed_at: i64) {
    cache
        .conn
        .execute(
            "UPDATE tiles SET accessed_at = ?1
             WHERE provider = ?2 AND z = ?3 AND y = ?4 AND x = ?5",
            params![accessed_at, provider, z, y, x],
        )
        .unwrap();
}

#[test]
fn replacing_the_lru_tile_with_a_bigger_one_stays_under_the_cap() {
    // The cache is exactly full: A (400 B, least recently used) + B (600 B).
    // A comes back at 600 B. Eviction must not count A's bytes twice - once as
    // "being replaced" and once as "evicted" - or the insert lands 200 B over.
    let mut cache = TileCache::in_memory(1, 30).unwrap();
    cache.max_bytes = 1000;
    cache
        .put_granted("esri", 1, 0, 0, &[0xAA; 400], "image/jpeg")
        .unwrap();
    cache
        .put_granted("esri", 1, 0, 1, &[0xBB; 600], "image/jpeg")
        .unwrap();
    set_accessed_at(&cache, "esri", 1, 0, 0, TileCache::now() - 100);
    assert_eq!(cache.get_stats().total_bytes, 1000, "precondition: full");

    cache
        .put_granted("esri", 1, 0, 0, &[0xCC; 600], "image/jpeg")
        .unwrap();

    let total = cache.get_stats().total_bytes;
    assert!(
        total <= cache.max_bytes,
        "after replacing the LRU tile the cache holds {total} bytes; the cap is {}",
        cache.max_bytes
    );
    // The new copy is what was asked for.
    let entry = cache.get("esri", 1, 0, 0).unwrap();
    assert_eq!(entry.data, vec![0xCC; 600]);
}
