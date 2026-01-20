# fn-5-jef.1 Wire showDepthGradient toggle to SurveyLayer

## Description
Wire up the `showDepthGradient` UI toggle to SurveyLayer.

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
- [ ] `setShowDepthGradient()` method added to SurveyLayer
- [ ] useEffect syncs toggle state to layer
- [ ] Toggling calls `update()` to re-render
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
