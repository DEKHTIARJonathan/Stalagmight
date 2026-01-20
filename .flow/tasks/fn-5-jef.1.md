# fn-5-jef.1 Wire showDepthGradient toggle to SurveyLayer

## Description
Wire `showDepthGradient` toggle to SurveyLayer by extending the existing update effect.

## Files to Modify

### `src/components/Map/MapCanvas.tsx`
**Extend existing survey data effect (around L580):**

Add `showDepthGradient` and stats depth values to dependencies. Use actual variable names from MapCanvas:
```typescript
// Add showDepthGradient and stats to dependencies
useEffect(() => {
  if (!surveyLayerRef.current || !project) return;
  surveyLayerRef.current.update(
    project.sections,
    stations,  // Actual variable name in MapCanvas
    project.station_merges,  // Actual variable name
    project.loop_closures,   // Actual variable name
    gpsOrigin,
    showDepthGradient,  // NEW parameter
    { min: stats?.min_depth ?? 0, max: stats?.max_depth ?? 50 }  // NEW parameter
  );
}, [project, stations, gpsOrigin, showDepthGradient, 
    stats?.min_depth, stats?.max_depth, mapLoaded]);
```

Extract from stores:
- `showDepthGradient` from useUIStore (add to existing destructure)
- `stats` from useProjectStore (already available as `project?.stats` or separate `stats`)

### `src/components/Map/SurveyLayer.tsx`
**Extend update() signature (L704):**
```typescript
update(
  sections: Section[],
  stations: Station[],
  stationMerges?: StationMerge[],
  loopClosures?: LoopClosure[],
  gpsOrigin?: GpsOrigin | null,
  showDepthGradient: boolean = false,  // NEW
  depthRange: { min: number; max: number } = { min: 0, max: 50 }  // NEW
): void
```

Store locally for use throughout the method:
```typescript
// At start of update()
const useDepthColors = showDepthGradient;
const range = depthRange;
```

## Why This Approach
Extending the existing effect is cleaner than adding a separate setter method because:
- Toggling triggers a full update (colors recalculate)
- No need to store previous update args
- Follows existing pattern for display changes
## Files to Modify

### `src/components/Map/MapCanvas.tsx`
**Extend existing survey data effect (around L580):**
```typescript
// Add showDepthGradient and stats to dependencies
useEffect(() => {
  if (!surveyLayerRef.current || !project) return;
  surveyLayerRef.current.update(
    project.sections,
    allStations,
    stationMerges,
    loopClosures,
    gpsOrigin,
    showDepthGradient,  // NEW parameter
    { min: stats?.min_depth ?? 0, max: stats?.max_depth ?? 50 }  // NEW parameter
  );
}, [project, allStations, stationMerges, loopClosures, gpsOrigin, 
    showDepthGradient, stats?.min_depth, stats?.max_depth, mapLoaded]);
```

Extract from stores:
- `showDepthGradient` from useUIStore
- `stats` from useProjectStore (already available)

### `src/components/Map/SurveyLayer.tsx`
**Extend update() signature (L704):**
```typescript
update(
  sections: Section[],
  stations: Station[],
  stationMerges?: StationMerge[],
  loopClosures?: LoopClosure[],
  gpsOrigin?: GpsOrigin | null,
  showDepthGradient: boolean = false,  // NEW
  depthRange: { min: number; max: number } = { min: 0, max: 50 }  // NEW
): void
```

Store locally for use throughout the method:
```typescript
this.currentShowDepthGradient = showDepthGradient;
this.currentDepthRange = depthRange;
```

## Why This Approach
Extending the existing effect is cleaner than adding a separate setter method because:
- Toggling triggers a full update (colors recalculate)
- No need to store previous update args
- Follows existing pattern for display changes
## Files to Modify

### `src/components/Map/MapCanvas.tsx`
- Extract `showDepthGradient` from useUIStore (L52-77 area)
- Extract `stats` from useProjectStore for depth range
- Add useEffect following pattern at L598-614 (showShotData sync):
```typescript
useEffect(() => {
  if (!surveyLayerRef.current) return;
  surveyLayerRef.current.setShowDepthGradient(
    showDepthGradient,
    stats?.min_depth ?? 0,
    stats?.max_depth ?? 50
  );
}, [showDepthGradient, stats?.min_depth, stats?.max_depth, mapLoaded]);
```

### `src/components/Map/SurveyLayer.tsx`
- Add private fields:
```typescript
private showDepthGradient = false;
private depthRange = { min: 0, max: 50 };
```
- Add setter method (follow pattern at L601-625):
```typescript
setShowDepthGradient(show: boolean, minDepth: number, maxDepth: number) {
  const changed = this.showDepthGradient !== show ||
                  this.depthRange.min !== minDepth ||
                  this.depthRange.max !== maxDepth;
  this.showDepthGradient = show;
  this.depthRange = { min: minDepth, max: maxDepth };
  if (changed) {
    this.update(...);  // Need to call update with current data
  }
}
```

**Challenge**: update() requires sections/stations/merges/closures but setter doesn't have access. Solution: store last data in private fields, or use a separate re-render method that only updates colors.
## Files to Modify

### `src/components/Map/MapCanvas.tsx`
- Extract `showDepthGradient` from useUIStore (around L52-77)
- Add `setShowDepthGradient()` call in useEffect that syncs display settings to SurveyLayer

### `src/components/Map/SurveyLayer.tsx`
- Add private field: `private showDepthGradient = false;`
- Add method: `setShowDepthGradient(show: boolean)` that stores value and triggers re-render if needed
- Method should call `this.update()` if the value changed

## Implementation Notes
- Follow existing pattern from `setShowStations()`, `setShowSectionNames()` etc.
- The toggle is already defined in uiStore and DisplayMenu - just needs wiring to the layer
## Acceptance
- [ ] `showDepthGradient` extracted in MapCanvas from useUIStore
- [ ] `stats` depth values available from useProjectStore
- [ ] `update()` signature extended with showDepthGradient and depthRange params
- [ ] Depth parameters used throughout update() method
- [ ] Effect dependency array includes showDepthGradient and stats depth values
- [ ] Variable names match actual MapCanvas code (stations, project.station_merges, etc.)
- [ ] Toggling triggers re-render with new colors
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
