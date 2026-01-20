# fn-7-gba.1 Fix GridOverlay cleanup to check map style existence

## Description
# Fix GridOverlay Cleanup

## Problem

The `GridOverlay` component's cleanup effect tries to call `map.getLayer()` and `map.removeLayer()` after the map's style has been destroyed, causing a TypeError crash.

## Location

`src/components/Map/GridOverlay.tsx` lines 150-158:

```typescript
return () => {
  // Cleanup on unmount
  if (map.getLayer(layerId)) {    // ← crashes here
    map.removeLayer(layerId);
  }
  if (map.getSource(sourceId)) {
    map.removeSource(sourceId);
  }
  layerAdded.current = false;
};
```

## Fix

Add guard checks to verify the map and its style exist before cleanup operations:

```typescript
return () => {
  // Cleanup on unmount - check map style exists (may be destroyed during parent unmount)
  if (map && map.style) {
    if (map.getLayer(layerId)) {
      map.removeLayer(layerId);
    }
    if (map.getSource(sourceId)) {
      map.removeSource(sourceId);
    }
  }
  layerAdded.current = false;
};
```

Also add similar guard checks in:
- Line 117: `if (!map.getLayer(layerId))` check
- Line 119: `const surveyLayer = map.getLayer('survey-shots');`
- Line 138: `if (map.getLayer(layerId))`
- Line 141: `if (map.getSource(sourceId))`
- Line 167: `if (map.getLayer(layerId))`

## Verification

1. Open a project
2. Click Back button
3. App should return to Global View without error
4. No TypeScript errors: `pnpm tsc --noEmit`
## Acceptance
- [ ] Cleanup effect (lines 150-158) has guard for map.style
- [ ] All map.getLayer() calls are guarded
- [ ] All map.getSource() calls are guarded
- [ ] All map.removeLayer() calls are guarded
- [ ] All map.removeSource() calls are guarded
- [ ] Back button works without crash
- [ ] No console errors when clicking Back
- [ ] pnpm tsc --noEmit passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
