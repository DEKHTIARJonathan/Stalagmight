# fn-4-7mg.9 Update E2E mock config in tauri-ipc.ts

## Description
Update the E2E mock configuration in `e2e-playwright/mocks/tauri-ipc.ts` to match the new config schema.

## Changes Required

The mock config used in E2E tests must mirror the new schema structure.

### Update mock config object

In `e2e-playwright/mocks/tauri-ipc.ts`, update the `get_config` mock response:

**Add new map sub-configs:**
```typescript
map: {
  // Existing fields...
  station: {
    radius: 4,
    hit_area: 10,
  },
  shot: {
    width: 2,
    hit_area: 8,
  },
  snap: {
    threshold: 10,
    enabled_draw: true,
    enabled_merge: true,
    enabled_measure: true,
  },
  // ... other existing map fields
}
```

**Add debug config:**
```typescript
debug: {
  map: {
    show_hitboxes: false,
    log_hit_detection: false,
  }
}
```

**Remove old fields:**
- Remove `display.station_size`
- Remove `display.line_thickness`
- Remove top-level `snap` object

### Helper functions

If there are any E2E helper functions that reference old config paths, update them:
- `config.snap.threshold_pixels` → `config.map.snap.threshold`
- `config.snap.enabled_draw` → `config.map.snap.enabled_draw`
- `config.display.station_size` → `config.map.station.radius`
- `config.display.line_thickness` → `config.map.shot.width`

## File to modify

- `e2e-playwright/mocks/tauri-ipc.ts`
## Acceptance
- [x] Mock config has `map.station.radius` and `map.station.hit_area`
- [x] Mock config has `map.shot.width` and `map.shot.hit_area`
- [x] Mock config has `map.snap.threshold` and `map.snap.enabled_*`
- [x] Mock config has `debug.map.show_hitboxes` and `debug.map.log_hit_detection`
- [x] Old fields removed: `display.station_size`, `display.line_thickness`, top-level `snap`
- [x] Any E2E helpers using old config paths updated
- [x] `pnpm test:ui` passes (tests can load mock config)
## Done summary
Mock config in tauri-ipc.ts already contains the new schema structure with map.station, map.shot, map.snap sub-configs and debug.map settings. No code changes needed as implementation was completed in fn-4-7mg.1 (commit 0a4841c).
## Evidence
- Commits: Pre-existing in 0a4841c (fn-4-7mg.1)
- Tests: pnpm test:ui
- PRs: