# fn-4-7mg.1 Update config schema (Rust + TypeScript)

## Description
Update the configuration schema in both Rust backend and TypeScript frontend to support the new hitbox settings.

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
- [ ] Rust `MapConfig` struct updated with `station`, `shot`, `snap` sub-configs
- [ ] Rust `DebugConfig` struct added with `map` sub-config
- [ ] Rust defaults updated with correct values
- [ ] TypeScript interfaces mirror Rust structs exactly
- [ ] TypeScript `defaultConfig` matches Rust defaults
- [ ] Old settings removed from both Rust and TypeScript
- [ ] Validation bounds implemented in Rust
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
