# fn-5-jef.1 Wire showDepthGradient toggle to SurveyLayer

## Description
Wire up the `showDepthGradient` UI toggle to SurveyLayer.

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
- [ ] `showDepthGradient` extracted in MapCanvas
- [ ] `stats` (depth range) extracted from useProjectStore  
- [ ] `setShowDepthGradient(show, minDepth, maxDepth)` method added to SurveyLayer
- [ ] Depth range stored for use during feature building
- [ ] useEffect syncs toggle and depth range to layer
- [ ] Toggling triggers re-render (colors update)
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
