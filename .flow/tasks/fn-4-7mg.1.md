# fn-4-7mg.1 Update config schema (Rust + TypeScript)

## Description
Update the configuration schema in both Rust backend and TypeScript frontend.

## CRITICAL: Snap Config Migration

Current state has duplication:
- `map.snap_threshold_pixels` in `MapConfig` (vestigial, unused)
- `[snap]` section with `threshold_pixels`, `enabled_*` (authoritative, used by MapCanvas)

**Resolution**:
1. Remove `snap_threshold_pixels` from `MapConfig` (both Rust and TS)
2. Remove entire `SnapConfig` struct and `snap` field from top-level `Config`
3. Add `map.snap` sub-config with threshold and enabled flags
4. Update all consumers to use `config.map.snap.*`
5. Add test asserting no remaining `config.snap` references

## Config Path

Use `Config::config_path()` which returns platform-specific path via `directories::ProjectDirs`. Do NOT hardcode paths.

## Rust Changes (`src-tauri/src/config/`)

### mod.rs - Add new structs

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StationConfig {
    #[serde(default = "default_station_radius")]
    pub radius: f64,
    #[serde(default = "default_station_hit_area")]
    pub hit_area: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShotConfig {
    #[serde(default = "default_shot_width")]
    pub width: f64,
    #[serde(default = "default_shot_hit_area")]
    pub hit_area: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapSnapConfig {
    #[serde(default = "default_snap_threshold")]
    pub threshold: f64,
    #[serde(default = "default_true")]
    pub enabled_draw: bool,
    #[serde(default = "default_true")]
    pub enabled_merge: bool,
    #[serde(default = "default_true")]
    pub enabled_measure: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugConfig {
    #[serde(default)]
    pub map: MapDebugConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MapDebugConfig {
    #[serde(default)]
    pub show_hitboxes: bool,
    #[serde(default)]
    pub log_hit_detection: bool,
}
```

### Update MapConfig

```rust
pub struct MapConfig {
    // Remove: pub snap_threshold_pixels: f64,  // VESTIGIAL - remove

    #[serde(default)]
    pub station: StationConfig,
    #[serde(default)]
    pub shot: ShotConfig,
    #[serde(default)]
    pub snap: MapSnapConfig,
    // ... other existing fields
}
```

### Update Config

```rust
pub struct Config {
    // Remove: pub snap: SnapConfig,  // Remove entire field
    #[serde(default)]
    pub debug: DebugConfig,
    // ... other fields
}
```

### defaults.rs - Add defaults

```rust
fn default_station_radius() -> f64 { 4.0 }
fn default_station_hit_area() -> f64 { 10.0 }
fn default_shot_width() -> f64 { 2.0 }
fn default_shot_hit_area() -> f64 { 8.0 }
fn default_snap_threshold() -> f64 { 10.0 }
```

### Validation

- Check `is_finite()` before clamping
- Station radius: clamp 1.0-50.0
- Station hitArea: clamp 1.0-50.0, must be >= radius
- Shot width: clamp 0.5-20.0
- Shot hitArea: clamp 0.5-20.0, must be >= width
- Snap threshold: clamp 1.0-50.0

### Remove old

- Remove `SnapConfig` struct entirely
- Remove `snap` field from `Config`
- Remove `snap_threshold_pixels` from `MapConfig`
- Remove `display.station_size` from `DisplayConfig`
- Remove `display.line_thickness` from `DisplayConfig`

## TypeScript Changes (`src/types/config.ts`)

Mirror all Rust changes. Update `defaultConfig`.

## Add Test

Add test asserting no remaining `config.snap` consumers:

```rust
#[test]
fn test_no_legacy_snap_references() {
    // Compile-time check: SnapConfig struct should not exist
    // Runtime check: config.snap path should not be used
}
```

Search codebase for `config.snap` and update all references to `config.map.snap`.
## Rust Changes (`src-tauri/src/config/`)

### mod.rs - Add new structs

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StationConfig {
    #[serde(default = "default_station_radius")]
    pub radius: f64,  // Visual size, pixels
    #[serde(default = "default_station_hit_area")]
    pub hit_area: f64,  // Clickable area, pixels
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShotConfig {
    #[serde(default = "default_shot_width")]
    pub width: f64,  // Visual width, pixels
    #[serde(default = "default_shot_hit_area")]
    pub hit_area: f64,  // Clickable area, pixels
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapSnapConfig {
    #[serde(default = "default_snap_threshold")]
    pub threshold: f64,
    #[serde(default = "default_true")]
    pub enabled_draw: bool,
    #[serde(default = "default_true")]
    pub enabled_merge: bool,
    #[serde(default = "default_true")]
    pub enabled_measure: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugConfig {
    #[serde(default)]
    pub map: MapDebugConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MapDebugConfig {
    #[serde(default)]
    pub show_hitboxes: bool,
    #[serde(default)]
    pub log_hit_detection: bool,
}
```

### Update MapConfig

```rust
pub struct MapConfig {
    // Existing fields...
    #[serde(default)]
    pub station: StationConfig,
    #[serde(default)]
    pub shot: ShotConfig,
    #[serde(default)]
    pub snap: MapSnapConfig,
}
```

### Update Config

```rust
pub struct Config {
    // ... existing ...
    #[serde(default)]
    pub debug: DebugConfig,
}
```

### defaults.rs - Add defaults

```rust
fn default_station_radius() -> f64 { 4.0 }
fn default_station_hit_area() -> f64 { 10.0 }
fn default_shot_width() -> f64 { 2.0 }
fn default_shot_hit_area() -> f64 { 8.0 }
fn default_snap_threshold() -> f64 { 10.0 }
```

### Validation (in validation or config module)

- Check `is_finite()` before clamping
- Station radius: clamp 1.0-50.0
- Station hitArea: clamp 1.0-50.0, must be >= radius
- Shot width: clamp 0.5-20.0
- Shot hitArea: clamp 0.5-20.0, must be >= width
- Snap threshold: clamp 1.0-50.0

### Remove old fields

- Remove `display.station_size` from DisplayConfig
- Remove `display.line_thickness` from DisplayConfig
- Remove entire `SnapConfig` struct and `snap` field from Config

## TypeScript Changes (`src/types/config.ts`)

Mirror all Rust changes:
- Add `StationConfig`, `ShotConfig`, `MapSnapConfig` interfaces
- Add `DebugConfig`, `MapDebugConfig` interfaces
- Update `MapConfig` interface
- Update `Config` interface
- Update `defaultConfig` object
- Remove `display.station_size`, `display.line_thickness`
- Remove `SnapConfig` and `snap` from Config

## Files to modify

- `src-tauri/src/config/mod.rs`: L162-206 (MapConfig), add new structs
- `src-tauri/src/config/defaults.rs`: L46-58 (DisplayConfig::default), L90-106 (MapConfig::default), L172-180 (remove SnapConfig::default)
- `src/types/config.ts`: L65-77 (MapConfig), L124-129 (remove SnapConfig), L146-253 (defaultConfig)
## Changes Required

### Rust (`src-tauri/src/config/`)

1. **Update `MapConfig` struct** to add nested `station`, `shot`, and `snap` sub-configs
2. **Add new structs**: `StationConfig`, `ShotConfig`, `MapSnapConfig`
3. **Add `DebugConfig` struct** with `MapDebugConfig` nested inside
4. **Update defaults** in `defaults.rs`
5. **Remove old settings**: `display.station_size`, `display.line_thickness`, entire `snap` section

### TypeScript (`src/types/config.ts`)

Mirror all Rust changes:
1. Add `StationConfig`, `ShotConfig`, `MapSnapConfig`, `DebugConfig`, `MapDebugConfig` interfaces
2. Update `MapConfig` interface
3. Update `defaultConfig` object
4. Remove old interfaces/defaults

### New Config Structure

```toml
[map.station]
radius = 4              # Visual size (1-50px)
hitArea = 10            # Clickable area (1-50px)

[map.shot]
width = 2               # Visual width (0.5-20px)
hitArea = 8             # Clickable area (0.5-20px)

[map.snap]
threshold = 10          # Snap radius (1-50px)
enabledDraw = true
enabledMerge = true
enabledMeasure = true

[debug.map]
showHitboxes = false
logHitDetection = false
```

### Validation

Add validation for bounds:
- Station radius/hitArea: 1.0 to 50.0
- Shot width/hitArea: 0.5 to 20.0
- Snap threshold: 1.0 to 50.0
## Acceptance
- [ ] Rust `StationConfig` struct with radius and hit_area fields
- [ ] Rust `ShotConfig` struct with width and hit_area fields
- [ ] Rust `MapSnapConfig` struct with threshold and enabled_* fields
- [ ] Rust `DebugConfig` and `MapDebugConfig` structs
- [ ] Rust `MapConfig` updated with station, shot, snap sub-configs
- [ ] Rust `Config` updated with debug field
- [ ] All fields have `#[serde(default)]` for forward compatibility
- [ ] Rust defaults: station.radius=4, station.hitArea=10, shot.width=2, shot.hitArea=8, snap.threshold=10
- [ ] Rust validation: is_finite() checks, clamp bounds, hitArea >= visual size
- [ ] REMOVED: `SnapConfig` struct entirely
- [ ] REMOVED: `config.snap` field from Config
- [ ] REMOVED: `map.snap_threshold_pixels` from MapConfig (vestigial)
- [ ] REMOVED: `display.station_size` and `display.line_thickness`
- [ ] TypeScript interfaces mirror Rust structs exactly
- [ ] TypeScript `defaultConfig` matches Rust defaults
- [ ] Test added asserting no `config.snap` consumers remain
- [ ] All `config.snap.*` references updated to `config.map.snap.*`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
