# fn-7-gba.1 Fix GridOverlay cleanup to check map style existence

## Description
Fix GridOverlay cleanup to check map style existence before operations.

## Implementation

### 1. Create shared helper (src/components/Map/mapUtils.ts)

```typescript
import type maplibregl from 'maplibre-gl';

/**
 * Check if map instance has a live style (not destroyed).
 * Uses internal property access since maplibre-gl doesn't expose this publicly.
 */
export function hasLiveStyle(map: maplibregl.Map | null): boolean {
  return !!(map && (map as any).style);
}
```

### 2. Update GridOverlay.tsx cleanup (lines 150-158)

Import the helper:
```typescript
import { hasLiveStyle } from './mapUtils';
```

Update the cleanup effect to guard ALL map operations and wrap in try/catch:

```typescript
return () => {
  // Guard against map being destroyed (race condition on unmount)
  if (!hasLiveStyle(map)) {
    layerAdded.current = false;
    return;
  }
  
  try {
    if (map.getLayer(layerId)) {
      map.removeLayer(layerId);
    }
    if (map.getSource(sourceId)) {
      map.removeSource(sourceId);
    }
  } catch {
    // Map already destroyed during unmount, cleanup not needed
  }
  layerAdded.current = false;
};
```

**Important notes:**
- The cleanup runs even when `showGrid` is false because it unconditionally calls `map.getLayer()`
- Both `getLayer()` AND `getSource()` can throw - guard both
- The try/catch is essential because there's a race window between the style check and the actual call
- Use `(map as any).style` since it's not part of the public TypeScript surface
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
- [ ] `hasLiveStyle()` helper created in `src/components/Map/mapUtils.ts`
- [ ] Helper uses `(map as any).style` for internal access (with comment explaining why)
- [ ] GridOverlay cleanup imports `hasLiveStyle` from mapUtils
- [ ] GridOverlay cleanup guards with `if (!hasLiveStyle(map)) return`
- [ ] GridOverlay cleanup wraps map operations in try/catch
- [ ] Both `map.getLayer()` and `map.getSource()` calls are inside the try/catch
- [ ] layerAdded.current is reset in all code paths
- [ ] `pnpm tsc --noEmit` passes
## Done summary
Created hasLiveStyle() helper in mapUtils.ts and updated GridOverlay cleanup effect to guard against map destruction during unmount race conditions, preventing TypeError crashes when clicking Back button.
## Evidence
- Commits: ae5acc48c325c7ca9d294bdf6c7ff903e07733a3
- Tests: pnpm tsc --noEmit
- PRs: