# Satellite Map Display with Tile Caching - Implementation Plan

## Execution Instructions

**IMPORTANT**: After every compaction, describe your progress in detail before the compaction and store the details into `./docs/plans/2026-01-20-04-00_satellite_map_tile_caching/progress_{ts}.md`, where `{ts}` is the current Unix timestamp. You do not need to include code but you should at least reference files.

## Reference Documents

Before implementing, read these documents for context:
- `/home/ubuntu/projects/CaveChef/CLAUDE.md` - Project commands, critical rules (no `cd`!)
- `/home/ubuntu/projects/CaveChef/docs/SPEC.md` - Section 2.6 (Offline Support), 6.4 (Map Features), 13.5 (Tile Caching)
- `/home/ubuntu/projects/CaveChef/docs/TESTING.md` - Test patterns for Playwright, WebdriverIO, Rust
- `/home/ubuntu/projects/CaveChef/docs/architecture.md` - State flow, key files

---

## Executive Summary

Implement robust satellite map tile caching in CaveChef with comprehensive testing. The implementation covers:
1. **Backend tile cache** in Rust using SQLite storage
2. **Custom tile protocol** for cache-first tile serving
3. **Offline support** with graceful degradation
4. **Exhaustive tests** at all three layers (Playwright, WebdriverIO, Rust)

---

## Part 1: Architecture Decisions

### 1.1 Cache Storage: SQLite

**Rationale**: CaveChef already uses rusqlite. Single file simplifies backup, atomic ops ensure integrity, built-in LRU via indexed access timestamps.

**Schema**:
```sql
CREATE TABLE tiles (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    z INTEGER NOT NULL, y INTEGER NOT NULL, x INTEGER NOT NULL,
    data BLOB NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'image/jpeg',
    size_bytes INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    accessed_at INTEGER NOT NULL,
    UNIQUE(provider, z, y, x)
);
CREATE INDEX idx_tiles_accessed ON tiles(accessed_at);
```

### 1.2 Tile Request Flow: Custom Protocol Handler

```
MapLibre requests: cavechef-tiles://esri/{z}/{y}/{x}
    ↓
Tauri Protocol Handler (Rust)
    ├── Cache Hit → Return cached tile
    └── Cache Miss → Fetch ESRI → Cache → Return
```

### 1.3 Cache Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `tile_cache_enabled` | true | Enable/disable caching |
| `tile_cache_max_mb` | 500 | Max cache size (per SPEC.md) |
| `tile_ttl_days` | 30 | Tile expiration |

---

## Part 2: Implementation Tasks

### Phase 1: Rust Backend Infrastructure

#### Task 1.1: Add Cache Configuration
**File**: `src-tauri/src/config/mod.rs`

Add `CacheConfig` struct:
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheConfig {
    pub tile_cache_enabled: bool,
    pub tile_cache_max_mb: u32,
    pub tile_ttl_days: u32,
}
```

Update `Config` struct to include `pub cache: CacheConfig`.

#### Task 1.2: Create Tile Cache Module
**New Files**:
- `src-tauri/src/cache/mod.rs` - Module exports
- `src-tauri/src/cache/tiles.rs` - Core implementation

Implement `TileCache` struct:
```rust
impl TileCache {
    pub fn open(cache_dir: &Path, max_mb: u32, ttl_days: u32) -> Result<Self>;
    pub fn get(&self, provider: &str, z: u32, y: u32, x: u32) -> Option<TileEntry>;
    pub fn put(&self, provider: &str, z: u32, y: u32, x: u32, data: &[u8], content_type: &str) -> Result<()>;
    pub fn evict_lru(&self) -> Result<()>;
    pub fn clear_all(&self) -> Result<()>;
    pub fn clear_provider(&self, provider: &str) -> Result<()>;
    pub fn get_stats(&self) -> CacheStats;
}
```

#### Task 1.3: Register Protocol Handler
**File**: `src-tauri/src/lib.rs`

Register `cavechef-tiles://` protocol:
```rust
.register_uri_scheme_protocol("cavechef-tiles", |app, request| {
    // Parse: cavechef-tiles://esri/{z}/{y}/{x}
    // Check cache → fetch if miss → cache → return
})
```

#### Task 1.4: Add IPC Commands
**New File**: `src-tauri/src/commands/cache.rs`

```rust
#[tauri::command]
pub fn get_cache_stats(state: State<AppState>) -> Result<CacheStats, String>;

#[tauri::command]
pub fn clear_tile_cache(state: State<AppState>, provider: Option<String>) -> Result<(), String>;

#[tauri::command]
pub fn get_network_status() -> bool;
```

Register in `lib.rs` with other commands.

### Phase 2: Frontend Integration

#### Task 2.1: Update Satellite Tile URL
**File**: `src/components/Map/MapCanvas.tsx` (lines 654-681)

Change `getSatelliteTileConfig`:
```typescript
const getSatelliteTileConfig = useCallback(() => {
    return {
        tiles: ['cavechef-tiles://esri/{z}/{y}/{x}'],
        attribution: '&copy; Esri, Maxar, Earthstar Geographics',
        tileSize: 256,
    };
}, []);
```

#### Task 2.2: Network Status Hook
**New File**: `src/hooks/useNetworkStatus.ts`

```typescript
export function useNetworkStatus() {
    const [isOnline, setIsOnline] = useState(navigator.onLine);
    useEffect(() => {
        const handleOnline = () => setIsOnline(true);
        const handleOffline = () => setIsOnline(false);
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, []);
    return isOnline;
}
```

#### Task 2.3: Offline Indicator Component
**New File**: `src/components/common/OfflineIndicator.tsx`

Display offline status in status bar.

#### Task 2.4: Cache Settings UI
**File**: `src/components/Dialogs/SettingsDialog.tsx`

Add "Cache" tab with:
- Cache statistics display (`data-testid="cache-stats"`)
- Clear cache button (`data-testid="clear-cache-button"`)
- Cache size configuration

#### Task 2.5: TypeScript Types
**File**: `src/types/config.ts`

Add `CacheConfig` interface matching Rust struct.

### Phase 3: Testing

#### Task 3.1: Update Tauri IPC Mocks
**File**: `e2e-playwright/mocks/tauri-ipc.ts`

Add mock handlers:
```typescript
case 'get_cache_stats':
    return { total_tiles: 150, total_bytes: 25600000, providers: { esri: {...} } };
case 'clear_tile_cache':
    return { success: true };
case 'get_network_status':
    return true;
```

#### Task 3.2: Playwright Tests
**New File**: `e2e-playwright/satellite-display.spec.ts`

Test categories:
1. **Toggle Behavior** (5 tests)
   - Toggle on via display menu
   - Toggle off via display menu
   - Persist toggle state
   - Rapid toggle stress test
   - Toggle with keyboard shortcut

2. **Layer Properties** (3 tests)
   - Layer below survey data
   - Correct opacity (0.7)
   - Source attribution

3. **Offline Mode** (3 tests)
   - Show offline indicator
   - Graceful tile load failures
   - Serve cached tiles offline

4. **Cache Status** (3 tests)
   - Display stats in settings
   - Clear cache via UI
   - Cache size display

#### Task 3.3: Edge Case Playwright Tests
**New File**: `e2e-playwright/satellite-edge-cases.spec.ts`

Tests:
- Toggle during map animation
- Toggle during zoom
- Network failure mid-load
- Cache full scenario
- Rapid zoom stress test
- State preservation across project switch

#### Task 3.4: WebdriverIO Full App Tests
**New File**: `e2e/specs/satellite-display.spec.ts`

Tests with real backend:
- Enable satellite and verify cache population
- Serve cached tiles on re-enable
- Clear cache via settings
- Verify cache stats IPC

#### Task 3.5: Rust Unit Tests
**File**: `src-tauri/src/cache/tiles.rs` (bottom)

```rust
#[cfg(test)]
mod tests {
    // Test: cache put and get
    // Test: cache miss returns None
    // Test: LRU eviction
    // Test: TTL expiration
    // Test: clear_all
    // Test: clear_provider
    // Test: cache_stats
    // Test: concurrent access (threaded)
    // Test: different providers isolation
}
```

---

## Part 3: Test Coverage Matrix

| Feature | Playwright | WebdriverIO | Rust Unit |
|---------|:----------:|:-----------:|:---------:|
| Toggle on/off | ✓ | ✓ | - |
| Layer visibility | ✓ | ✓ | - |
| Layer ordering | ✓ | ✓ | - |
| Tile URL correctness | ✓ | - | - |
| Cache hit/miss | - | ✓ | ✓ |
| LRU eviction | - | - | ✓ |
| Cache size limits | - | - | ✓ |
| Offline mode | ✓ | ✓ | ✓ |
| Network detection | ✓ | ✓ | - |
| Cache statistics | ✓ | ✓ | ✓ |
| Manual cache clear | ✓ | ✓ | ✓ |
| TTL expiration | - | - | ✓ |
| Rapid toggle stress | ✓ | ✓ | - |
| Concurrent requests | - | - | ✓ |

---

## Part 4: File Changes Summary

### New Files
| File | Purpose |
|------|---------|
| `src-tauri/src/cache/mod.rs` | Cache module exports |
| `src-tauri/src/cache/tiles.rs` | TileCache implementation + tests |
| `src-tauri/src/commands/cache.rs` | Cache IPC commands |
| `src/hooks/useNetworkStatus.ts` | Network status hook |
| `src/components/common/OfflineIndicator.tsx` | Offline UI indicator |
| `e2e-playwright/satellite-display.spec.ts` | Playwright satellite tests |
| `e2e-playwright/satellite-edge-cases.spec.ts` | Edge case tests |
| `e2e/specs/satellite-display.spec.ts` | WebdriverIO satellite tests |

### Modified Files
| File | Changes |
|------|---------|
| `src-tauri/src/config/mod.rs` | Add CacheConfig struct |
| `src-tauri/src/config/defaults.rs` | Add cache defaults |
| `src-tauri/src/lib.rs` | Register protocol, commands |
| `src-tauri/src/core/state.rs` | Add TileCache to AppState |
| `src/components/Map/MapCanvas.tsx` | Update tile URL (lines 654-681) |
| `src/types/config.ts` | Add CacheConfig type |
| `src/components/Dialogs/SettingsDialog.tsx` | Add Cache tab |
| `e2e-playwright/mocks/tauri-ipc.ts` | Add cache mock handlers |

---

## Part 5: Verification

### Pre-Push Checklist
```bash
pnpm tsc --noEmit
pnpm test:ui
cargo test --manifest-path src-tauri/Cargo.toml
```

### Manual Verification Steps
1. Start dev server: `./scripts/dev.sh`
2. Create new project
3. Toggle satellite ON in Display menu
4. Verify tiles load (map shows satellite imagery)
5. Check Settings → Cache tab shows statistics
6. Toggle satellite OFF, verify layer removed
7. Toggle ON again, verify tiles load from cache (faster)
8. Disconnect network, verify cached tiles still work
9. Clear cache in settings, verify stats reset

---

## Part 6: Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Cache corruption | SQLite ACID; integrity check on startup |
| Memory exhaustion | Stream tile reads; limit concurrent fetches |
| Protocol blocking | Async fetch with timeout; serve stale if hung |
| False offline detection | Combine `navigator.onLine` + network probe |
| Rate limiting | Respect cache headers; implement backoff |

---

## Implementation Order

1. **Config** (Task 1.1) - Foundation for cache settings
2. **Tile Cache Module** (Task 1.2) - Core caching logic + Rust tests
3. **Protocol Handler** (Task 1.3) - Wire cache to tile requests
4. **IPC Commands** (Task 1.4) - Expose cache management
5. **Frontend Integration** (Tasks 2.1-2.5) - Connect UI to cache
6. **Update Mocks** (Task 3.1) - Enable Playwright testing
7. **Playwright Tests** (Tasks 3.2-3.3) - Fast UI tests
8. **WebdriverIO Tests** (Task 3.4) - Full app verification
9. **Rust Tests** (Task 3.5) - Already in Task 1.2, ensure complete

**Estimated Test Count**: ~40 Playwright tests, ~10 WebdriverIO tests, ~15 Rust unit tests
