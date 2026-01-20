# fn-3-e6v.2 Implement setShowStations and setShowShots in SurveyLayer

## Description
Implement visibility methods, highlight layer, and cleanup in SurveyLayer.

## File: `src/components/Map/SurveyLayer.tsx`

### 1. Add highlight layer (~L280)

```typescript
private stationsHighlightLayerId = 'survey-stations-highlight';

// In initialization:
this.map.addLayer({
  id: this.stationsHighlightLayerId,
  type: 'circle',
  source: 'survey-data',
  filter: ['==', 'station_ref', '__none__'], // Match nothing initially
  paint: {
    'circle-radius': 7,
    'circle-color': '#00ffcc',
    'circle-stroke-width': 4,
    'circle-stroke-color': '#00ffcc',
  }
});
```

### 2. Visibility methods (~L625)

```typescript
setShowStations(visible: boolean): void {
  if (!this.map) return;
  const visibility = visible ? 'visible' : 'none';
  this.map.setLayoutProperty(this.stationsLayerId, 'visibility', visibility);
  this.map.setLayoutProperty(this.mergesLayerId, 'visibility', visibility);
  this.map.setLayoutProperty(this.loopClosuresLayerId, 'visibility', visibility);
}

setShowShots(visible: boolean): void {
  if (!this.map) return;
  this.map.setLayoutProperty(this.shotsLayerId, 'visibility', visible ? 'visible' : 'none');
}

setShowVirtualShots(visible: boolean): void {
  if (!this.map) return;
  if (visible) {
    this.map.setFilter(this.shotsLayerId, null);
  } else {
    this.map.setFilter(this.shotsLayerId, ['!=', ['get', 'isVirtual'], true]);
  }
}

// Uses station_ref (existing property in station features)
setHighlightedStations(stationRefs: string[]): void {
  if (!this.map) return;
  this.map.setFilter(this.stationsHighlightLayerId,
    stationRefs.length > 0
      ? ['in', ['get', 'station_ref'], ['literal', stationRefs]]
      : ['==', 'station_ref', '__none__']
  );
}
```

### 3. Cleanup methods

```typescript
clearStationHover(): void {
  this.hoveredStationId = null;
  this.updateVisualState();
}

clearShotHover(): void {
  this.hoveredShotId = null;
  this.updateVisualState();
}

clearSnappedStation(): void {
  this.snappedStationId = null;
  this.setHighlightedStations([]);
  this.updateVisualState();
}

// Comprehensive cleanup for visibility toggle changes
clearAllInteractionState(): void {
  this.hoveredStationId = null;
  this.hoveredShotId = null;
  this.snappedStationId = null;
  this.selectedStationId = null;
  this.selectedShotId = null;
  this.setHighlightedStations([]);
  this.updateVisualState();
}
```
## File to Modify: `src/components/Map/SurveyLayer.tsx`

### 1. Add station `id` property to features

In `update()` method where station features are created, add compound id:
```typescript
features.push({
  type: 'Feature',
  properties: {
    id: \`\${sectionId}:\${stationIndex}\`, // NEW: compound id for highlight filtering
    sectionId,
    stationIndex,
    // ... other existing properties
  },
  geometry: { type: 'Point', coordinates: [...] }
});
```

### 2. Add highlight layer in initialization

Add after existing layers (~L280):
```typescript
private stationsHighlightLayerId = 'survey-stations-highlight';

// In initialization:
this.map.addLayer({
  id: this.stationsHighlightLayerId,
  type: 'circle',
  source: 'survey-data',
  filter: ['==', 'id', '__none__'], // Match nothing initially
  paint: {
    'circle-radius': 7,
    'circle-color': '#00ffcc',
    'circle-stroke-width': 4,
    'circle-stroke-color': '#00ffcc',
  }
});
```

### 3. Add visibility methods (~L625)

```typescript
setShowStations(visible: boolean): void {
  if (!this.map) return;
  const visibility = visible ? 'visible' : 'none';
  this.map.setLayoutProperty(this.stationsLayerId, 'visibility', visibility);
  this.map.setLayoutProperty(this.mergesLayerId, 'visibility', visibility);
  this.map.setLayoutProperty(this.loopClosuresLayerId, 'visibility', visibility);
}

setShowShots(visible: boolean): void {
  if (!this.map) return;
  this.map.setLayoutProperty(this.shotsLayerId, 'visibility', visible ? 'visible' : 'none');
}

setShowVirtualShots(visible: boolean): void {
  if (!this.map) return;
  // Use FILTER to remove virtual shots from hit-testing
  if (visible) {
    this.map.setFilter(this.shotsLayerId, null);
  } else {
    this.map.setFilter(this.shotsLayerId, ['!=', ['get', 'isVirtual'], true]);
  }
}

setHighlightedStations(stationIds: string[]): void {
  if (!this.map) return;
  this.map.setFilter(this.stationsHighlightLayerId,
    stationIds.length > 0
      ? ['in', ['get', 'id'], ['literal', stationIds]]
      : ['==', 'id', '__none__']
  );
}
```

### 4. Add cleanup methods

```typescript
clearStationHover(): void {
  this.hoveredStationId = null;
  this.updateVisualState();
}

clearShotHover(): void {
  this.hoveredShotId = null;
  this.updateVisualState();
}

clearSnappedStation(): void {
  this.snappedStationId = null;
  this.setHighlightedStations([]);
  this.updateVisualState();
}

clearAllInteractionState(): void {
  this.hoveredStationId = null;
  this.hoveredShotId = null;
  this.snappedStationId = null;
  this.setHighlightedStations([]);
  this.updateVisualState();
}
```
## File to Modify

### `src/components/Map/SurveyLayer.tsx`

**Layer IDs (L44-50):**
- `shotsLayerId = 'survey-shots'`
- `stationsLayerId = 'survey-stations'`
- `mergesLayerId = 'survey-merges'`
- `loopClosuresLayerId = 'survey-loop-closures'`
- **NEW**: `stationsHighlightLayerId = 'survey-stations-highlight'`

## Implementation

### 1. Add highlight layer in initialization

Add after existing layers (~L280):
```typescript
// Highlight layer for snapped/active stations (always visible)
this.map.addLayer({
  id: this.stationsHighlightLayerId,
  type: 'circle',
  source: 'survey-data',
  filter: ['==', 'id', '__none__'], // Match nothing initially
  paint: {
    'circle-radius': 7,
    'circle-color': '#00ffcc',
    'circle-stroke-width': 4,
    'circle-stroke-color': '#00ffcc',
  }
});
```

### 2. Add visibility methods (~L625)

```typescript
setShowStations(visible: boolean): void {
  if (!this.map) return;
  const visibility = visible ? 'visible' : 'none';
  this.map.setLayoutProperty(this.stationsLayerId, 'visibility', visibility);
  this.map.setLayoutProperty(this.mergesLayerId, 'visibility', visibility);
  this.map.setLayoutProperty(this.loopClosuresLayerId, 'visibility', visibility);
}

setShowShots(visible: boolean): void {
  if (!this.map) return;
  this.map.setLayoutProperty(this.shotsLayerId, 'visibility', visible ? 'visible' : 'none');
}

setShowVirtualShots(visible: boolean): void {
  if (!this.map) return;
  // Use filter to hide virtual shots while keeping regular shots
  if (visible) {
    this.map.setFilter(this.shotsLayerId, null); // Show all
  } else {
    this.map.setFilter(this.shotsLayerId, ['!=', ['get', 'isVirtual'], true]);
  }
}

setHighlightedStations(stationIds: string[]): void {
  if (!this.map) return;
  this.map.setFilter(this.stationsHighlightLayerId,
    stationIds.length > 0
      ? ['in', ['get', 'id'], ['literal', stationIds]]
      : ['==', 'id', '__none__']
  );
}

clearStationHover(): void {
  this.hoveredStationId = null;
  this.updateVisualState();
}

clearShotHover(): void {
  this.hoveredShotId = null;
  this.updateVisualState();
}
```
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
- [ ] `survey-stations-highlight` layer created with cyan styling
- [ ] Highlight layer filter uses `station_ref` property (existing in features)
- [ ] `setShowStations(visible)` controls stations, merges, loop-closures
- [ ] `setShowShots(visible)` controls shots layer
- [ ] `setShowVirtualShots(visible)` uses FILTER to exclude virtual shots
- [ ] `setHighlightedStations(stationRefs)` uses station_ref filter
- [ ] `clearStationHover()`, `clearShotHover()` methods exist
- [ ] `clearSnappedStation()` clears snap AND highlight layer
- [ ] `clearAllInteractionState()` clears ALL internal IDs (hover, selected, snapped)
- [ ] All methods have null-check for `this.map`
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
