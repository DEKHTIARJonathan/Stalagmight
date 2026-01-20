# fn-3-e6v.3 Wire visibility toggles in MapCanvas useEffect hooks

## Description
Wire up the visibility toggles in MapCanvas using useEffect hooks.

## File to Modify

### `src/components/Map/MapCanvas.tsx`

**Existing pattern (L517-528):**
```typescript
// Sync shot data labels visibility with SurveyLayer
useEffect(() => {
  if (!surveyLayerRef.current) return;
  surveyLayerRef.current.setShowShotLabels(showShotData);
}, [showShotData, mapLoaded]);
```

**State destructuring (~L66):**
Add `showStations` and `showShots` to the destructured state from uiStore.

## Implementation

Add after existing toggle sync hooks (~L534):

```typescript
// Sync stations visibility with SurveyLayer
useEffect(() => {
  if (!surveyLayerRef.current) return;
  surveyLayerRef.current.setShowStations(showStations);
}, [showStations, mapLoaded]);

// Sync shots visibility with SurveyLayer
useEffect(() => {
  if (!surveyLayerRef.current) return;
  surveyLayerRef.current.setShowShots(showShots);
}, [showShots, mapLoaded]);
```

**Important**: Include `mapLoaded` in dependency array to handle case where toggle changes before map is ready.
## File to Modify
- `src/components/Map/MapCanvas.tsx`

## Implementation Details

Add useEffect hooks following the pattern of existing hooks (lines 519-534):

```typescript
// Sync showStations toggle
useEffect(() => {
  if (surveyLayer.current) {
    surveyLayer.current.setShowStations(showStations);
  }
}, [showStations]);

// Sync showShots toggle
useEffect(() => {
  if (surveyLayer.current) {
    surveyLayer.current.setShowShots(showShots);
  }
}, [showShots]);
```

Also add `showStations` and `showShots` to the destructured state from uiStore.

## Depends On
- Task 1: showShots state must exist in uiStore
- Task 2: SurveyLayer methods must exist
## Acceptance
- [ ] `showStations` and `showShots` destructured from uiStore
- [ ] useEffect hook syncs `showStations` to `surveyLayerRef.current.setShowStations()`
- [ ] useEffect hook syncs `showShots` to `surveyLayerRef.current.setShowShots()`
- [ ] Both hooks include `mapLoaded` in dependency array
- [ ] Both hooks have null-check for `surveyLayerRef.current`
- [ ] Toggling "Stations" in Display menu hides/shows station markers on map
- [ ] Toggling "Shots" in Display menu hides/shows shot lines on map
- [ ] `pnpm tsc --noEmit` passes
## Done summary
Wired showStations and showShots visibility toggles in MapCanvas using useEffect hooks that sync with SurveyLayer methods, following the existing pattern for other display toggles.
## Evidence
- Commits: 1366e3146105b5c537052055b352a5326071de0d
- Tests: pnpm tsc --noEmit
- PRs: