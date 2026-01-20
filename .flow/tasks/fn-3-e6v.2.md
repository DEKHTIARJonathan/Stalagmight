# fn-3-e6v.2 Implement setShowStations and setShowShots in SurveyLayer

## Description
Implement `setShowStations()` and `setShowShots()` methods in SurveyLayer class.

## File to Modify

### `src/components/Map/SurveyLayer.tsx`

**Layer IDs (L44-50):**
- `shotsLayerId = 'survey-shots'`
- `stationsLayerId = 'survey-stations'`
- `mergesLayerId = 'survey-merges'`
- `loopClosuresLayerId = 'survey-loop-closures'`

**Existing pattern (L600-625):**
```typescript
setShowShotLabels(show: boolean) {
  this.map.setLayoutProperty(
    this.shotLabelsLayerId,
    'visibility',
    show ? 'visible' : 'none'
  );
}
```

## Implementation

Add after existing visibility methods (~L625):

```typescript
setShowStations(visible: boolean): void {
  if (!this.map) return;
  const visibility = visible ? 'visible' : 'none';
  this.map.setLayoutProperty(this.stationsLayerId, 'visibility', visibility);
  // Also hide related layers that reference stations
  this.map.setLayoutProperty(this.mergesLayerId, 'visibility', visibility);
  this.map.setLayoutProperty(this.loopClosuresLayerId, 'visibility', visibility);
}

setShowShots(visible: boolean): void {
  if (!this.map) return;
  this.map.setLayoutProperty(this.shotsLayerId, 'visibility', visible ? 'visible' : 'none');
}
```

**Note**: When stations hidden, also hide `survey-merges` and `survey-loop-closures` as they visually reference stations.
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
- [ ] `setShowStations` also controls `survey-merges` and `survey-loop-closures` visibility
- [ ] Methods use `setLayoutProperty` with `'visible'` or `'none'`
- [ ] Methods have null-check for `this.map`
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
