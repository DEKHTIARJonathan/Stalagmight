# Configurable Interaction Bounding Boxes for Shots and Stations

## Problem

The current interaction areas for stations (4px radius circles) and shots (2px wide lines) are too small to click accurately. Users must position their mouse precisely to select, delete, or interact with survey elements, which is frustrating and slows down workflow.

## Approach

Implement "hitbox" layers rendered beneath visual layers with larger configurable sizes.

### Technical Implementation

1. **Hitbox Layers**: Add MapLibre layers using same GeoJSON source as visual layers:
   - `survey-stations-hitbox`: Circle layer, radius from `map.station.hitArea`
   - `survey-shots-hitbox`: Line layer, width from `map.shot.hitArea`
   - Ghost hitbox layers for merge preview
   - **Use `opacity: 0.001`** (not 0) to ensure `queryRenderedFeatures` works
   - Transparent color (`rgba(0,0,0,0)`) with non-zero opacity

2. **Layer Order**: Hitbox layers FIRST, then visual layers, then labels. Satellite insertion anchors on `survey-stations-hitbox`.

3. **Event Handling**: Move ALL handlers to hitbox layers including global empty-click handler.

4. **Nearest-to-Click Resolution**:
   - For stations: Project point to screen, compute distance to click
   - **For shots**: Compute distance-to-line-segment in screen space (project segment endpoints, find perpendicular distance or endpoint distance, whichever is smaller)
   - Use same resolver for click, hover, context menu

5. **Visual Sizing with State Scaling**:
   - Base radius from `config.map.station.radius` (default 4.0)
   - **Zero datum**: `radius * 2` (8px at default)
   - **Snapped**: `radius + 3` (7px at default)
   - **Hovered**: `radius + 2` for selection feedback
   - Apply same delta pattern to shots with `config.map.shot.width`

6. **Debug Mode**: When `showHitboxes` true, set BOTH color alpha AND layer opacity to 1.

### Configuration Schema

**Use `f64` for all size values to support fractional values (0.5-20 for shots):**

```toml
[map.station]
radius = 4.0            # Visual size (f64, 1.0-50.0)
hit_area = 10.0         # Clickable area (f64, 1.0-50.0, >= radius)

[map.shot]
width = 2.0             # Visual width (f64, 0.5-20.0)
hit_area = 8.0          # Clickable area (f64, 0.5-20.0, >= width)

[map.snap]
threshold = 10.0        # Snap radius (f64, 1.0-50.0)
enabled_draw = true
enabled_merge = true
enabled_measure = true

[debug.map]
show_hitboxes = false
log_hit_detection = false  # Logs only on CLICK/CONTEXTMENU, not hover
```

**Config file**: Use `Config::config_path()` (platform-specific via `directories::ProjectDirs`).

**Migration**:
1. Remove `SnapConfig` struct and `config.snap` field
2. Remove `map.snap_threshold_pixels` (vestigial)
3. Remove `display.station_size`, `display.line_thickness`
4. Add `#[serde(default)]` on: `MapConfig.station`, `MapConfig.shot`, `MapConfig.snap`, `Config.debug`, `DebugConfig.map`

### Config Reload

**API Contract** - `reload_config` returns only the new config:
```rust
#[tauri::command]
pub fn reload_config(state: State<AppState>) -> Result<Config, String> {
    let new_config = Config::load()?;
    *state.config.lock().unwrap() = new_config.clone();
    Ok(new_config)
}
```

**Diffing done client-side** (simpler, more flexible):
```typescript
const handleReloadConfig = async () => {
  const newConfig = await invoke<Config>('reload_config');
  const changes = computeConfigDiff(localConfig, newConfig);  // Frontend diff
  setLocalConfig(newConfig);
  updateConfig(newConfig);
  showChangesDialog(changes);
};
```

**Live-applied settings** (this feature):
- `map.station.*`, `map.shot.*`, `map.snap.*`, `debug.map.*`

**Require restart** (out of scope):
- `display.default_background`, `display.grid_color`, etc.

**UX**: Disable reload button when `isDirty`.

### Debug Logging Scope

`debug.map.logHitDetection` logs **only on click and contextmenu**, NOT on hover/mousemove (prevents spam):
```typescript
private handleStationClick = (e: MapLayerMouseEvent) => {
  if (this.config?.debug?.map?.logHitDetection) {
    console.log('[HitDetection] Station click', { ... });
  }
};
// NO logging in mouseenter/mousemove handlers
```

## Edge Cases

- **Overlapping hitboxes**: Nearest-to-click wins (stations first, then shots)
- **Shot distance**: Use perpendicular distance to line segment, not just endpoints
- **Config reload**: Only hitbox/visual settings applied live; other settings require restart
- **Performance**: O(N) snap acceptable for now; can optimize later

## Quick Commands

```bash
pnpm tsc --noEmit
pnpm test:ui
cargo test --manifest-path src-tauri/Cargo.toml
```

## Acceptance Criteria

- [ ] All size fields use `f64` (Rust) / `number` (TS) with float defaults
- [ ] Hitbox layers use `opacity: 0.001`
- [ ] Visual state scaling: zeroDatum = radius*2, snapped = radius+3
- [ ] Shot selection uses distance-to-line-segment in screen space
- [ ] `reload_config` returns Config only; diffing done client-side
- [ ] `logHitDetection` logs only click/contextmenu (not hover)
- [ ] `#[serde(default)]` on all nested config structs for migration
- [ ] Satellite layer anchors on `survey-stations-hitbox`
- [ ] Global empty-click handler queries hitbox layers
- [ ] E2E tests use mock station coords or expose test helper
- [ ] TypeScript and Rust config types synchronized
