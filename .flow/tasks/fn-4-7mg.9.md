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
    hitArea: 10,
  },
  shot: {
    width: 2,
    hitArea: 8,
  },
  snap: {
    threshold: 10,
    enabledDraw: true,
    enabledMerge: true,
    enabledMeasure: true,
  },
  // ... other existing map fields
}
```

**Add debug config:**
```typescript
debug: {
  map: {
    showHitboxes: false,
    logHitDetection: false,
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
- `config.snap.enabled_draw` → `config.map.snap.enabledDraw`
- `config.display.station_size` → `config.map.station.radius`
- `config.display.line_thickness` → `config.map.shot.width`

## File to modify

- `e2e-playwright/mocks/tauri-ipc.ts`
## Acceptance
- [ ] Mock config has `map.station.radius` and `map.station.hitArea`
- [ ] Mock config has `map.shot.width` and `map.shot.hitArea`
- [ ] Mock config has `map.snap.threshold` and `map.snap.enabled*`
- [ ] Mock config has `debug.map.showHitboxes` and `debug.map.logHitDetection`
- [ ] Old fields removed: `display.station_size`, `display.line_thickness`, top-level `snap`
- [ ] Any E2E helpers using old config paths updated
- [ ] `pnpm test:ui` passes (tests can load mock config)
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
