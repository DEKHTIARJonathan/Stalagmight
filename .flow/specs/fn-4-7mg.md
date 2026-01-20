# Configurable Interaction Bounding Boxes for Shots and Stations

## Problem

The current interaction areas for stations (4px radius circles) and shots (2px wide lines) are too small to click accurately.

## Approach

Add hitbox layers with larger configurable sizes for improved click detection.

### Technical Implementation

#### 1. Hitbox Layers

- `survey-stations-hitbox`, `survey-shots-hitbox` with `opacity: 0.001`
- Ghost hitbox layers: **non-interactive** (debug visualization only, NOT in queries)
- **Layer order**: Insert hitbox layers before `survey-ghost-shots` (same anchor as visual layers)
- **Satellite anchor update**: Change `satellite-tiles` insertion to anchor before `survey-stations-hitbox` (first hitbox layer)

#### 2. Hover UX Change (Intentional)

Hover triggers within hitbox area, not just visual glyph. **Intentional and acceptable**.

#### 3. Click/Contextmenu Handling

**ALWAYS query hitbox layers and use nearest resolver** (don't rely on `e.features[0]`).

**Label exclusion behavior change (intentional)**: Previously, clicking a label would prevent empty-click actions. After this change, clicking a label outside a hitbox will count as empty-click and trigger tool behavior. This is an intentional simplification - labels are not interactive targets.

```typescript
private handleStationClick = (e: MapLayerMouseEvent) => {
  // Query hitbox layer explicitly
  const features = this.map.queryRenderedFeatures(e.point, {
    layers: [this.stationsHitboxLayerId]
  });
  const nearest = this.resolveNearestStation(e, features);
  if (!nearest) return;
  // ...
};
```

#### 4. Query Sites (all must query hitbox layers, NOT ghost)

1. `SurveyLayer.handleStationClick` - query `survey-stations-hitbox`
2. `SurveyLayer.handleShotClick` - query `survey-shots-hitbox`
3. `SurveyLayer global empty-click` - query both hitbox layers
4. `SurveyLayer.handleContextMenu` - query both hitbox layers
5. `MapCanvas box select` - query `survey-stations-hitbox`

#### 5. Visual State Scaling

Stations (from `config.map.station.radius`): zeroDatum=radius*2, snapped=radius+3, hovered=radius+2, selected=radius+1
Shots (from `config.map.shot.width`): hovered=width+2, selected=width+1

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

**Add `Config::normalize()` and call it from these locations:**
- `Config::load()` - after deserializing
- `Config::save()` - before serializing
- `commands::config::update_config()` - after applying updates, before saving

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
    let mut new_config = Config::load().map_err(|e| e.to_string())?;
    new_config.normalize();
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
  // In SurveyLayer.ts or MapCanvas.tsx
  if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
    window.__E2E_TEST__ = window.__E2E_TEST__ || {};
    window.__E2E_TEST__.stations = stationCoordinates;
  }
  ```

**Docs:**
- `docs/configuration.md`: Update

## Acceptance Criteria

- [ ] Snake_case naming throughout
- [ ] Every nested config struct has Default impl + #[serde(default)]
- [ ] Config validation: is_finite(), clamp, hit_area >= radius/width
- [ ] Config::normalize() called in load(), save(), and update_config()
- [ ] Click/contextmenu use queryRenderedFeatures + nearest resolver (not e.features[0])
- [ ] Hover uses standard layer events (intentional UX change documented)
- [ ] Label exclusion behavior change documented (clicking labels outside hitbox triggers empty-click)
- [ ] Ghost hitbox layers NOT in any queries
- [ ] Satellite tiles anchor updated to insert before survey-stations-hitbox
- [ ] Visual scaling: zeroDatum=radius*2, snapped=radius+3, hovered=radius+2, selected=radius+1
- [ ] Shot scaling: hovered=width+2, selected=width+1
- [ ] SurveyLayer has fallback defaults (radius=4, width=2, hit_area=10/8)
- [ ] SurveyLayer.setConfig() wired via MapCanvas useEffect
- [ ] reload_config command registered in lib.rs
- [ ] Store setConfig action (no persist)
- [ ] Reload button disabled when isDirty
- [ ] E2E test helper exposes station coordinates (guarded by dev/test mode)
- [ ] All migration checklist items completed
