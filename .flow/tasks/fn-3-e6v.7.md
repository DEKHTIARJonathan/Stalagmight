# fn-3-e6v.7 Show snapped/origin stations during Draw/Merge/Measure

## Description
Show snapped/origin stations during Draw/Merge/Measure operations.

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
- [ ] Snapped station visible during Draw/Merge/Measure even when stations hidden
- [ ] Draw origin station visible during draw operation
- [ ] Visible exception stations use snapped visual style (cyan, larger)
- [ ] Exception stations return to hidden when operation completes
- [ ] Exception stations return to hidden when operation canceled
- [ ] Only specific exception stations shown, not all stations
- [ ] Works for merge (both stations A and B if snapped)
- [ ] Works for measure (start and end points if snapped to stations)
- [ ] Filter/exception logic doesn't break normal visibility toggle
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
