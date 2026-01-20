# Configurable Interaction Bounding Boxes for Shots and Stations

## Problem

The current interaction areas for stations (4px radius circles) and shots (2px wide lines) are too small to click accurately.

## Approach

Add hitbox layers with larger configurable sizes for improved click detection.

### Technical Implementation

#### 1. Hitbox Layers

- `survey-stations-hitbox`, `survey-shots-hitbox` with `opacity: 0.001`
- Ghost hitbox layers: **non-interactive** (debug visualization only, NOT in queries)
- **Satellite anchor update**: Change `satellite-tiles` insertion to anchor before `survey-shots-hitbox` (first layer in stack)

**Layer insertion order (deterministic scheme)**:

```typescript
// Step 1: Add shots hitbox (before ghost shots)
this.map.addLayer(shotsHitboxLayer, 'survey-ghost-shots');

// Step 2: Add stations hitbox BEFORE shots hitbox (so stations above shots)
this.map.addLayer(stationsHitboxLayer, 'survey-shots-hitbox');

// Step 3: Add ghost hitbox layers
this.map.addLayer(ghostShotsHitboxLayer, 'survey-shots-hitbox');
this.map.addLayer(ghostStationsHitboxLayer, 'survey-ghost-shots-hitbox');

// Step 4: Update satellite anchor (AFTER hitbox layers exist)
// Satellite insertion: before 'survey-shots-hitbox' (now lowest survey layer)

// Step 5: If satellite layer already exists, move it below hitboxes
if (this.map.getLayer('satellite-tiles')) {
  this.map.moveLayer('satellite-tiles', 'survey-shots-hitbox');
}
```

**Verification**: Add E2E test that verifies `map.getStyle().layers` order has station-hitbox above shot-hitbox.

This ensures **station hitboxes are above shot hitboxes** for correct hover priority.

#### 2. Hover UX Change (Intentional)

Hover triggers within hitbox area, not just visual glyph. **Intentional and acceptable**.

#### 3. Click/Contextmenu Handling

**Use a UNIFIED click handler** that queries both hitbox layers and resolves priority in one place:

1. **Stations take priority over shots** - always check stations first
2. Query both layers, resolve nearest station first
3. If no station hit, resolve nearest shot
4. If neither, treat as empty-click

**Label exclusion behavior change (intentional)**: Previously, clicking a label would prevent empty-click actions. After this change, clicking a label outside a hitbox will count as empty-click and trigger tool behavior. This is an intentional simplification - labels are not interactive targets.

```typescript
private handleMapClick = (e: MapLayerMouseEvent) => {
  // Query both hitbox layers
  const stationFeatures = this.map.queryRenderedFeatures(e.point, {
    layers: [this.stationsHitboxLayerId]
  });
  const shotFeatures = this.map.queryRenderedFeatures(e.point, {
    layers: [this.shotsHitboxLayerId]
  });

  // Stations take priority
  const nearestStation = this.resolveNearestStation(e, stationFeatures);
  if (nearestStation) {
    this.handleStationSelection(nearestStation, e);
    return;
  }

  // Then shots
  const nearestShot = this.resolveNearestShot(e, shotFeatures);
  if (nearestShot) {
    this.handleShotSelection(nearestShot, e);
    return;
  }

  // Empty click
  this.handleEmptyClick(e);
};
```

Same pattern for `handleContextMenu`.

#### 4. Query Sites (all must query hitbox layers, NOT ghost)

**Per-layer click handlers are REMOVED** in favor of unified handlers:

1. `SurveyLayer.handleMapClick` (UNIFIED) - queries both hitbox layers, station priority
2. `SurveyLayer.handleContextMenu` (UNIFIED) - queries both hitbox layers, station priority
3. `MapCanvas box select` - query `survey-stations-hitbox`
4. Hover handlers remain per-layer (mouseenter/mouseleave on each hitbox layer)

#### 5. Visual State Scaling

Stations (from `config.map.station.radius`): zeroDatum=radius*2, snapped=radius+3, hovered=radius+2, selected=radius+1
Shots (from `config.map.shot.width`): hovered=width+2, selected=width+1

**Priority order** (first matching wins in `updateVisualState()`):
1. **Snapped** - highest priority (radius+3)
2. **Zero datum** - second (radius*2)
3. **Hovered** - third (radius+2)
4. **Selected** - fourth (radius+1)
5. **Base** - default (radius)

```typescript
// Station radius with explicit priority
['case',
  ['==', stationIdExpr, this.snappedStationId ?? ''], baseRadius + 3,  // 1. Snapped
  ['==', ['get', 'isZeroDatum'], true], baseRadius * 2,                // 2. Zero datum
  ['==', stationIdExpr, this.hoveredStationId ?? ''], baseRadius + 2,  // 3. Hovered
  ['==', stationIdExpr, this.selectedStationId ?? ''], baseRadius + 1, // 4. Selected
  baseRadius                                                            // 5. Base
]
```

#### 6. Config Wiring

```typescript
// SurveyLayer.ts - with fallback defaults for when config is null/undefined
private static readonly DEFAULTS = {
  station: { radius: 4, hit_area: 10 },
  shot: { width: 2, hit_area: 8 },
};

public setConfig(config: Config): void {
  this.config = config;
  this.updateHitboxLayers();
  this.updateVisualState();
  this.updateDebugVisualization();
}

// All methods use fallback defaults:
private getStationRadius(): number {
  return this.config?.map?.station?.radius ?? SurveyLayer.DEFAULTS.station.radius;
}
private getStationHitArea(): number {
  return this.config?.map?.station?.hit_area ?? SurveyLayer.DEFAULTS.station.hit_area;
}
private getShotWidth(): number {
  return this.config?.map?.shot?.width ?? SurveyLayer.DEFAULTS.shot.width;
}
private getShotHitArea(): number {
  return this.config?.map?.shot?.hit_area ?? SurveyLayer.DEFAULTS.shot.hit_area;
}

// MapCanvas.tsx - add useEffect
useEffect(() => {
  if (surveyLayerRef.current && config) {
    surveyLayerRef.current.setConfig(config);
  }
}, [config]);
```

### Configuration Schema

Snake_case. All nested structs have `Default` impl + `#[serde(default)]`.

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

### Config Validation (Rust)

**Normalization Strategy**: Call `normalize()` ONLY inside `Config::load()` and `Config::save()`. Do NOT call it elsewhere to avoid double-normalization.

- `Config::load()` - calls `normalize()` after deserializing
- `Config::save()` - calls `normalize()` before serializing
- `update_config` and `reload_config` commands - use `load()` and `save()` which handle normalization internally

**Implementation:**

```rust
impl StationConfig {
    pub fn normalize(&mut self) {
        if !self.radius.is_finite() { self.radius = 4.0; }
        if !self.hit_area.is_finite() { self.hit_area = 10.0; }
        self.radius = self.radius.clamp(1.0, 50.0);
        self.hit_area = self.hit_area.clamp(1.0, 50.0).max(self.radius);
    }
}

impl ShotConfig {
    pub fn normalize(&mut self) {
        if !self.width.is_finite() { self.width = 2.0; }
        if !self.hit_area.is_finite() { self.hit_area = 8.0; }
        self.width = self.width.clamp(0.5, 20.0);
        self.hit_area = self.hit_area.clamp(0.5, 20.0).max(self.width);
    }
}
```

### Config Reload

**Rust command (add to `commands/config.rs` AND register in `lib.rs`):**

```rust
#[tauri::command]
pub fn reload_config(state: State<AppState>) -> Result<Config, String> {
    // Config::load() already calls normalize() internally
    let new_config = Config::load().map_err(|e| e.to_string())?;
    *state.config.lock().unwrap() = new_config.clone();
    Ok(new_config)
}
```

**Register in `src-tauri/src/lib.rs`:**
```rust
.invoke_handler(tauri::generate_handler![
    // ... existing ...
    commands::config::reload_config,
])
```

**Frontend (SettingsDialog):**

```typescript
const { setConfig } = useProjectStore();

const handleReloadConfig = async () => {
  const newConfig = await invoke<Config>('reload_config');
  const changes = computeConfigDiff(localConfig, newConfig);
  setLocalConfig(newConfig);
  setConfig(newConfig);  // Store action, doesn't persist
  // Show changes dialog
};
```

**Disabled when isDirty** - button disabled with tooltip "Save or discard local changes first"

### Migration Checklist

**Rust:**
- `src-tauri/src/config/mod.rs`: Add StationConfig, ShotConfig, MapSnapConfig, DebugConfig with Default impls
- `src-tauri/src/config/mod.rs`: Remove SnapConfig struct, config.snap field
- `src-tauri/src/config/defaults.rs`: Update defaults
- `src-tauri/src/lib.rs`: Register reload_config command

**TypeScript:**
- `src/types/config.ts`: Update types, remove SnapConfig
- `src/store/projectStore.ts`: Add setConfig action
- `src/components/Map/MapCanvas.tsx`: Update snap refs, add config useEffect
- `src/components/Dialogs/SettingsDialog.tsx`: Add reload button

**E2E:**
- `e2e-playwright/mocks/tauri-ipc.ts`: Update mock config
- Add test helper to expose station coordinates (dev/test only):
  ```typescript
  // In SurveyLayer.update() - called when stations change
  if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
    window.__E2E_TEST__ = window.__E2E_TEST__ || {};
    window.__E2E_TEST__.stations = this.getStationCoordinates();
    window.__E2E_TEST__.mapInstance = this.map;
  }
  ```
  **Update timing**: Set in `SurveyLayer.update()` after station data is updated, ensuring tests read current data.

**Docs:**
- `docs/configuration.md`: Update

## Acceptance Criteria

- [ ] Snake_case naming throughout
- [ ] Every nested config struct has Default impl + #[serde(default)]
- [ ] Config validation: is_finite(), clamp, hit_area >= radius/width
- [ ] Config::normalize() called ONLY in load() and save() (not elsewhere)
- [ ] Unified click/contextmenu handler queries both hitbox layers with station priority
- [ ] Hover uses standard layer events (intentional UX change documented)
- [ ] Label exclusion behavior change documented (clicking labels outside hitbox triggers empty-click)
- [ ] Ghost hitbox layers NOT in any queries
- [ ] Layer order: station hitboxes above shot hitboxes for correct hover priority
- [ ] Satellite tiles anchor updated to insert before survey-shots-hitbox (first layer)
- [ ] Visual scaling priority order: snapped > zeroDatum > hovered > selected > base
- [ ] Visual scaling: zeroDatum=radius*2, snapped=radius+3, hovered=radius+2, selected=radius+1
- [ ] Shot scaling: hovered=width+2, selected=width+1
- [ ] SurveyLayer has fallback defaults (radius=4, width=2, hit_area=10/8)
- [ ] SurveyLayer.setConfig() wired via MapCanvas useEffect
- [ ] reload_config command registered in lib.rs
- [ ] Store setConfig action (no persist)
- [ ] Reload button disabled when isDirty
- [ ] E2E test helper exposes station coordinates (guarded by dev/test mode, updated in SurveyLayer.update())
- [ ] E2E test verifies layer order (station-hitbox above shot-hitbox via map.getStyle().layers)
- [ ] All migration checklist items completed
