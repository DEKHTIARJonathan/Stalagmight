# Configurable Interaction Bounding Boxes for Shots and Stations

## Problem

The current interaction areas for stations (4px radius circles) and shots (2px wide lines) are too small to click accurately.

## Approach

Add hitbox layers with larger configurable sizes for improved click/hover detection.

### Technical Implementation

1. **Hitbox Layers**:
   - `survey-stations-hitbox`, `survey-shots-hitbox`
   - Ghost hitbox layers **non-interactive** (not queried, only visual for debug)
   - Use `opacity: 0.001` with transparent color

2. **Layer Order**: Hitboxes first, then visual, then labels. Satellite anchors on `survey-stations-hitbox`.

3. **Event Handling**:
   - **Click/contextmenu**: Query hitbox layers, use nearest-to-click resolution
   - **Hover**: Keep using `mouseenter`/`mouseleave` on hitbox layers (MapLibre gives topmost feature). **Nearest resolution is for CLICK ONLY** - hover uses standard per-layer behavior.
   - Update global empty-click handler to query hitbox layers

4. **Nearest-to-Click Resolution** (click/contextmenu ONLY):
   - Stations: project point, compute distance
   - Shots: distance-to-line-segment in screen space

5. **Visual Sizing**:
   - Base from config, explicit scaling rules
   - Zero datum: `radius * 2`, Snapped: `radius + 3`

6. **Debug Mode**: Set both color and opacity. Ghost hitboxes visible in debug but NOT interactive.

### Configuration Schema

**Use snake_case consistently** (matches existing config pattern):

```toml
[map.station]
radius = 4.0            # f64, 1.0-50.0
hit_area = 10.0         # f64, 1.0-50.0, >= radius

[map.shot]
width = 2.0             # f64, 0.5-20.0
hit_area = 8.0          # f64, 0.5-20.0, >= width

[map.snap]
threshold = 10.0        # f64, 1.0-50.0
enabled_draw = true
enabled_merge = true
enabled_measure = true

[debug.map]
show_hitboxes = false
log_hit_detection = false
```

**Rust struct naming**: Use snake_case field names to match TOML:
```rust
pub struct StationConfig {
    pub radius: f64,
    pub hit_area: f64,  // snake_case matches TOML key
}
```

**TypeScript**: Use snake_case to match Rust serialization:
```typescript
interface StationConfig {
  radius: number;
  hit_area: number;  // Match Rust/TOML
}
```

### Default Implementations

**Every nested config struct MUST have `Default` impl**:

```rust
impl Default for StationConfig {
    fn default() -> Self {
        Self { radius: 4.0, hit_area: 10.0 }
    }
}
impl Default for ShotConfig {
    fn default() -> Self {
        Self { width: 2.0, hit_area: 8.0 }
    }
}
impl Default for MapSnapConfig {
    fn default() -> Self {
        Self {
            threshold: 10.0,
            enabled_draw: true,
            enabled_merge: true,
            enabled_measure: true,
        }
    }
}
impl Default for DebugConfig {
    fn default() -> Self {
        Self { map: MapDebugConfig::default() }
    }
}
impl Default for MapDebugConfig {
    fn default() -> Self {
        Self { show_hitboxes: false, log_hit_detection: false }
    }
}
```

### Config Reload

**Don't call `update_config` on reload** (that would save/persist). Only update store state:

```typescript
const handleReloadConfig = async () => {
  const newConfig = await invoke<Config>('reload_config');
  const changes = computeConfigDiff(localConfig, newConfig);

  setLocalConfig(newConfig);
  // Update store directly without persisting
  projectStore.setState({ config: newConfig });

  // Show diff dialog
};
```

### Migration Checklist

**All consumers of removed fields that must be updated:**

1. `config.snap.threshold_pixels`:
   - `src/components/Map/MapCanvas.tsx:88-97` (checkSnapToStation)
   - `src/components/Map/MapCanvas.tsx:141` (checkPlacementSnap)

2. `config.snap.enabled_*`:
   - `src/components/Map/MapCanvas.tsx:89-91` (shouldSnap check)

3. `display.station_size`:
   - `src/types/config.ts:42` (interface)
   - `src/types/config.ts:164` (defaultConfig)
   - `src-tauri/src/config/mod.rs` (struct)
   - `src-tauri/src/config/defaults.rs` (default)

4. `display.line_thickness`:
   - `src/types/config.ts:43` (interface)
   - `src/types/config.ts:165` (defaultConfig)
   - `src-tauri/src/config/mod.rs` (struct)
   - `src-tauri/src/config/defaults.rs` (default)

5. E2E mock:
   - `e2e-playwright/mocks/tauri-ipc.ts` (mock config)

6. Documentation:
   - `docs/configuration.md`

### Ghost Hitbox Layers

Ghost layers are **NOT interactive**:
- Don't include in click/contextmenu queries
- Only visible when `debug.map.show_hitboxes` is true
- Purpose: visual debugging only during merge preview

## Quick Commands

```bash
pnpm tsc --noEmit
pnpm test:ui
cargo test --manifest-path src-tauri/Cargo.toml
```

## Acceptance Criteria

- [ ] Snake_case naming throughout (Rust fields, TOML keys, TS interfaces)
- [ ] Every nested config struct has `Default` impl
- [ ] Nearest-to-click resolution for CLICK/CONTEXTMENU only (not hover)
- [ ] Hover uses standard mouseenter/mouseleave (no nearest resolution)
- [ ] Ghost hitbox layers are non-interactive
- [ ] Config reload updates store without persisting (no `update_config`)
- [ ] All migration checklist items updated
- [ ] f64 for all size fields
