# Task 62: Tile Caching

## Overview
Implement offline satellite tile caching for viewed map areas. Auto-cache tiles as user views them with configurable cache size limit.

## Priority
Medium-High - Phase H (Polish)

## Risk Level
Medium-High

## Dependencies
- Task 54: Network error handling (related)

## Files to Modify
- `src-tauri/src/cache/mod.rs` - New tile cache module
- `src-tauri/src/commands/cache.rs` - Cache commands
- `src/components/Map/MapCanvas.tsx` - Cache integration
- `src-tauri/src/config/mod.rs` - Cache settings

## Specifications

### Caching Strategy
- Auto-cache tiles as user views them
- No explicit "download area" feature
- LRU eviction when cache full

### Cache Location
```rust
fn cache_dir() -> PathBuf {
    data_dir().join("tile_cache")
}
```

### Cache Structure
```
tile_cache/
├── satellite/
│   ├── 12/
│   │   ├── 1234/
│   │   │   ├── 5678.png
│   │   │   └── 5679.png
│   └── ...
└── cache_index.json
```

### Cache Index
```json
{
  "entries": [
    {
      "url": "https://tiles.example.com/12/1234/5678.png",
      "path": "satellite/12/1234/5678.png",
      "size": 45678,
      "lastAccessed": "2024-01-15T10:30:00Z"
    }
  ],
  "totalSize": 256000000,
  "maxSize": 524288000
}
```

### Size Limits
- Default max: 500 MB
- Configurable in settings
- Minimum: 100 MB
- Maximum: 2 GB

### Configuration
```toml
# config.toml
[cache]
tile_cache_max_mb = 500
tile_cache_enabled = true
```

### Tauri Integration
```rust
#[tauri::command]
fn cache_tile(url: String, data: Vec<u8>) -> Result<()> {
    // Store tile in cache
}

#[tauri::command]
fn get_cached_tile(url: String) -> Result<Option<Vec<u8>>> {
    // Retrieve from cache
}

#[tauri::command]
fn clear_tile_cache() -> Result<()> {
    // Clear all cached tiles
}

#[tauri::command]
fn get_cache_stats() -> CacheStats {
    // Return size, count, etc.
}
```

### MapLibre Integration
Custom tile source that checks cache first:
```typescript
// Custom protocol or fetch interceptor
const cachedFetch = async (url: string) => {
  const cached = await invoke('get_cached_tile', { url });
  if (cached) return cached;

  const response = await fetch(url);
  const data = await response.arrayBuffer();
  await invoke('cache_tile', { url, data: Array.from(new Uint8Array(data)) });
  return data;
};
```

### LRU Eviction
```rust
fn evict_if_needed(&mut self) {
    while self.total_size > self.max_size {
        if let Some(oldest) = self.entries.iter().min_by_key(|e| e.last_accessed) {
            self.remove(oldest.url.clone());
        }
    }
}
```

### Cache Management UI
In Settings > Display or separate Cache tab:
- Current cache size: "256 MB / 500 MB"
- Clear cache button
- Max size slider

## Acceptance Criteria
- [ ] Tiles cached automatically on view
- [ ] Cached tiles served when offline
- [ ] LRU eviction working
- [ ] Cache size configurable
- [ ] Clear cache button works
- [ ] Cache stats displayed
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Rust Tests
1. Test cache_tile stores tile to disk
2. Test get_cached_tile retrieves cached tile
3. Test get_cached_tile returns None for miss
4. Test LRU eviction removes oldest tile
5. Test eviction triggers when over max size
6. Test clear_tile_cache removes all tiles
7. Test get_cache_stats returns correct size
8. Test cache index updated on cache/evict

### Playwright Tests (Mocked IPC)
1. Test cache settings UI shows current size
2. Test max size slider configurable
3. Test "Clear Cache" button works
4. Test cache enabled/disabled toggle

### WebdriverIO Tests (Full App)
1. Test tiles cached as user pans map
2. Test cached tiles load when offline
3. Test cache size respects limit
4. Test cache persists through restart
5. Test clear cache frees disk space
6. Test cache works on all platforms

## Edge Cases
- Corrupted cached tile
- Cache directory deleted
- Disk full during cache
- Concurrent cache writes
- Very large single tile
