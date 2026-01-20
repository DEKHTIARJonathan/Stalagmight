# fn-3-e6v.7 Show snapped/origin stations during Draw/Merge/Measure

## Description
Show snapped/origin stations during Draw/Merge/Measure using highlight layer.

## File to Modify: `src/components/Map/MapCanvas.tsx`

### Understanding Station IDs

Station features now have compound `id` property: `${sectionId}:${stationIndex}`

The `snappedStation`, `drawFromStation`, etc. state may use a different format (e.g., just the index or a StationId type). Need to ensure the format matches.

**Option A**: If state already uses `${sectionId}:${stationIndex}` format, use directly.
**Option B**: If state uses different format, convert when calling `setHighlightedStations`.

### Implementation

```typescript
// Helper to convert station state to highlight id
const getHighlightId = (sectionId: string, stationIndex: number): string => {
  return \`\${sectionId}:\${stationIndex}\`;
};

// Update highlight layer when snap/draw state changes
useEffect(() => {
  if (!surveyLayerRef.current) return;
  
  const highlightIds: string[] = [];
  
  // Add snapped station
  if (snappedStation) {
    // Convert from state format to compound id format
    highlightIds.push(getHighlightId(snappedStation.sectionId, snappedStation.index));
  }
  
  // Add draw origin
  if (drawFromStation) {
    const id = getHighlightId(drawFromStation.sectionId, drawFromStation.index);
    if (!highlightIds.includes(id)) highlightIds.push(id);
  }
  
  // Add merge stations
  if (mergeStationA) {
    const id = getHighlightId(mergeStationA.sectionId, mergeStationA.index);
    if (!highlightIds.includes(id)) highlightIds.push(id);
  }
  if (mergeStationB) {
    const id = getHighlightId(mergeStationB.sectionId, mergeStationB.index);
    if (!highlightIds.includes(id)) highlightIds.push(id);
  }
  
  surveyLayerRef.current.setHighlightedStations(highlightIds);
}, [snappedStation, drawFromStation, mergeStationA, mergeStationB, mapLoaded]);
```

### How It Works

1. User hides stations via Display menu
2. `survey-stations` layer becomes invisible
3. User starts Draw tool, moves cursor near station
4. Snap detection finds station (iterates array directly)
5. `snappedStation` state is set
6. useEffect triggers, converts to compound id, calls `setHighlightedStations`
7. `survey-stations-highlight` layer filter updates to show that station
8. Snapped station visible via highlight layer (cyan, larger)
9. User completes operation
10. State clears, highlight clears
## Key Insight

When `survey-stations` layer visibility is `none`, we CANNOT make individual stations visible by changing their style. Instead, we use a dedicated `survey-stations-highlight` layer that is ALWAYS visible and shows only the currently snapped/active stations.

## Files to Modify

### `src/components/Map/MapCanvas.tsx`

**Sync highlight layer with snap/draw state:**

```typescript
// Update highlight layer when snapped station or draw origin changes
useEffect(() => {
  if (!surveyLayerRef.current) return;
  
  const highlightIds: string[] = [];
  if (snappedStation) highlightIds.push(snappedStation);
  if (drawFromStation && !highlightIds.includes(drawFromStation)) {
    highlightIds.push(drawFromStation);
  }
  // For merge, both stations should be highlighted
  if (mergeStationA && !highlightIds.includes(mergeStationA)) {
    highlightIds.push(mergeStationA);
  }
  if (mergeStationB && !highlightIds.includes(mergeStationB)) {
    highlightIds.push(mergeStationB);
  }
  
  surveyLayerRef.current.setHighlightedStations(highlightIds);
}, [snappedStation, drawFromStation, mergeStationA, mergeStationB, mapLoaded]);

// Clear highlights when stations become visible (no longer needed)
useEffect(() => {
  if (showStations && surveyLayerRef.current) {
    // Optional: could clear highlights when main layer is visible
    // Or keep them for consistency
  }
}, [showStations]);
```

**Snap logic remains unchanged** at L103-115 - it iterates `stations` array directly, so snap WILL find hidden stations. This is intentional.

## How It Works

1. User hides stations via Display menu
2. `survey-stations` layer becomes invisible
3. User starts Draw tool
4. User moves cursor near a station
5. Snap detection finds station (iterates array, not layer)
6. `snappedStation` state is set
7. useEffect triggers, calls `setHighlightedStations([snappedStation])`
8. `survey-stations-highlight` layer filter updates
9. Snapped station is now visible via highlight layer (cyan, larger)
10. User clicks to complete draw
11. `snappedStation` clears
12. useEffect triggers, `setHighlightedStations([])` 
13. Highlight disappears
## Key Insight

**Snap logic bypasses layer visibility**: The `checkSnapToStation` function at MapCanvas.tsx L103-115 iterates over the `stations` array directly, NOT through `queryRenderedFeatures`. This means snap WILL find hidden stations - this is intentional.

The challenge is to make the snapped station VISIBLE even when stations layer is hidden.

## Files to Modify

### `src/components/Map/SurveyLayer.tsx`

**Approach**: Use MapLibre filter expressions to show specific stations while hiding others.

Instead of simple visibility toggle, use a filter:
```typescript
setShowStations(visible: boolean, exceptIds?: string[]): void {
  if (!this.map) return;
  
  if (visible) {
    // Show all stations
    this.map.setLayoutProperty(this.stationsLayerId, 'visibility', 'visible');
    this.map.setFilter(this.stationsLayerId, null); // clear filter
  } else if (exceptIds && exceptIds.length > 0) {
    // Hide all except specific IDs
    this.map.setLayoutProperty(this.stationsLayerId, 'visibility', 'visible');
    this.map.setFilter(this.stationsLayerId, ['in', ['get', 'id'], ['literal', exceptIds]]);
  } else {
    // Hide all
    this.map.setLayoutProperty(this.stationsLayerId, 'visibility', 'none');
    this.map.setFilter(this.stationsLayerId, null);
  }
}
```

**Alternative approach**: Maintain separate "exception" layer for temporarily visible stations.

### `src/components/Map/MapCanvas.tsx`

When snap state changes, update the exception list:
```typescript
useEffect(() => {
  if (!showStations && surveyLayerRef.current) {
    const exceptIds: string[] = [];
    if (snappedStation) exceptIds.push(snappedStation);
    if (drawFromStation) exceptIds.push(drawFromStation);
    surveyLayerRef.current.setShowStations(false, exceptIds);
  }
}, [showStations, snappedStation, drawFromStation]);
```

## Visual State

Snapped stations should use the snapped visual style:
- Cyan color (#00ffcc)
- 7px radius
- 4px stroke width

This is already handled by `updateVisualState()` at L533-580 when `snappedStation` is set.
## Files to Modify
- `src/components/Map/SurveyLayer.tsx` (visual state updates)
- `src/hooks/useMapTools.ts` or tool handlers

## Implementation Details

### Snap Indicator Exception
When stations are hidden but user is using Draw/Merge/Measure tools:
- If cursor snaps to a station position, show the FULL station marker temporarily
- Not just the snap ring - the actual station circle becomes visible
- Use the snapped visual state (cyan #00ffcc, 7px radius, 4px stroke)

### Draw Tool Origin
When starting a Draw operation from an existing station:
- The origin station becomes visible for the duration of the draw
- Returns to hidden when draw completes or is canceled

### Implementation Approach
Modify the visual state update logic in `SurveyLayer.updateVisualState()`:
- Check if station is in snap/draw-origin state
- If so, override the hidden visibility for that specific station
- Use filter expressions to show specific stations while hiding others

Alternative approach:
- Maintain a "temporarily visible stations" set
- Union with snap/origin state
- Apply as exception to visibility rule

## Depends On
- Task 3: Base visibility must work first
## Acceptance
- [ ] useEffect watches snappedStation, drawFromStation, mergeStationA/B
- [ ] Station IDs converted to compound format `${sectionId}:${stationIndex}`
- [ ] Compound ID format matches `id` property in station features
- [ ] `setHighlightedStations()` called with correct IDs
- [ ] Snapped station visible during Draw even when stations layer hidden
- [ ] Draw origin station visible during draw operation
- [ ] Both merge stations highlighted during merge operation
- [ ] Multiple stations can be highlighted simultaneously
- [ ] Highlight clears when operation completes (IDs array becomes empty)
- [ ] Highlight clears when operation canceled
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
