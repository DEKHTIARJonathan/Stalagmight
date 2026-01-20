# fn-3-e6v.2 Implement setShowStations and setShowShots in SurveyLayer

## Description
Implement `setShowStations()` and `setShowShots()` methods in SurveyLayer class.

## File to Modify
- `src/components/Map/SurveyLayer.tsx`

## Implementation Details

### setShowStations(visible: boolean)
Add method similar to existing `setShowSectionNames()` pattern (line 610):
```typescript
setShowStations(visible: boolean): void {
  if (!this.map) return;
  this.map.setLayoutProperty(this.stationsLayerId, 'visibility', visible ? 'visible' : 'none');
}
```

### setShowShots(visible: boolean)
Add method to control shot layer visibility:
```typescript
setShowShots(visible: boolean): void {
  if (!this.map) return;
  this.map.setLayoutProperty(this.shotsLayerId, 'visibility', visible ? 'visible' : 'none');
}
```

Note: `this.shotsLayerId` is `'survey-shots'` (private property at line 44).
Note: `this.stationsLayerId` is `'survey-stations'` (private property at line 45).

## Depends On
Nothing - can be done in parallel with Task 1.
## Acceptance
- [ ] `setShowStations(visible: boolean)` method exists on SurveyLayer
- [ ] `setShowShots(visible: boolean)` method exists on SurveyLayer
- [ ] Methods use MapLibre `setLayoutProperty` for visibility control
- [ ] Methods handle case where map is not yet initialized (guard check)
- [ ] TypeScript compiles without errors
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
