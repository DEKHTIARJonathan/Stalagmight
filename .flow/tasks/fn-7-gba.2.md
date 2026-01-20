# fn-7-gba.2 Audit and fix all map overlay components for cleanup issues

## Description
# Audit and Fix All Map Overlay Components

## Objective

After fixing GridOverlay, audit all other map overlay components for similar cleanup issues where they might access the map after it's been destroyed.

## Components to Audit

1. **SurveyLayer.ts** (`src/components/Map/SurveyLayer.ts`)
   - Check `destroy()` method
   - Check any useEffect cleanup functions that use the map

2. **PlacementOverlay.tsx** (`src/components/Map/PlacementOverlay.tsx`)
   - Check for any map access during unmount

3. **MapCanvas.tsx** (`src/components/Map/MapCanvas.tsx`)
   - Check all useEffect cleanup functions
   - Ensure proper cleanup order

## Pattern to Look For

Any code that calls these methods without checking `map.style`:
- `map.getLayer()`
- `map.getSource()`
- `map.removeLayer()`
- `map.removeSource()`
- `map.setPaintProperty()`
- `map.setLayoutProperty()`
- Any other MapLibre style operations

## Fix Pattern

```typescript
// Before
if (map.getLayer(layerId)) {
  map.removeLayer(layerId);
}

// After
if (map && map.style && map.getLayer(layerId)) {
  map.removeLayer(layerId);
}
```

## Verification

1. Click Back from various states (dirty, clean, during loading)
2. No console errors
3. All tests pass
## Acceptance
- [ ] SurveyLayer.ts audited and fixed if needed
- [ ] PlacementOverlay.tsx audited and fixed if needed
- [ ] MapCanvas.tsx audited and fixed if needed
- [ ] All map style operations are guarded
- [ ] No console errors during any Back navigation scenario
- [ ] pnpm tsc --noEmit passes
- [ ] pnpm test:ui passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
