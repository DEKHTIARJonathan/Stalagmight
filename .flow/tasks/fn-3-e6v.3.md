# fn-3-e6v.3 Wire visibility toggles in MapCanvas useEffect hooks

## Description
Wire up the visibility toggles in MapCanvas using useEffect hooks.

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
- [ ] useEffect hook syncs `showStations` toggle to SurveyLayer
- [ ] useEffect hook syncs `showShots` toggle to SurveyLayer
- [ ] Toggling "Stations" in Display menu hides/shows station markers on map
- [ ] Toggling "Shots" in Display menu hides/shows shot lines on map
- [ ] Visibility changes apply immediately without requiring map interaction
- [ ] TypeScript compiles without errors
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
