# fn-3-e6v.5 Clear selection and cancel operations when visibility changes

## Description
Clear selection and cancel in-progress operations when visibility changes.

## Files to Modify

### `src/store/uiStore.ts`

**Selection state (L50, L279):**
- `selection: Selection | null` - single selection
- `multiSelection: Selection[]` - multi-selection
- `clearSelection()` - clears both

**Operation state to clear:**
- `drawFromStation: StationId | null` (draw origin)
- `mergeStationA: StationId | null`, `mergeStationB: StationId | null` (merge targets)
- `measureStart: Coordinates | null`, `measureEnd: Coordinates | null` (measure points)
- `placementMode: boolean` (placement state)
- `snappedStation: StationId | null` (snap state)
- `hoveredStation: StationId | null`, `hoveredShot: ShotId | null` (hover state)

### `src/components/Map/MapCanvas.tsx`

Add useEffect hooks to respond to visibility changes:

```typescript
// Clear station-related state when stations hidden
useEffect(() => {
  if (!showStations) {
    // Clear station selections
    const stationSelections = multiSelection.filter(s => s.type === 'station');
    if (selection?.type === 'station' || stationSelections.length > 0) {
      clearStationSelections(); // new action or filter logic
    }
    // Cancel station-related operations
    cancelStationOperations(); // clears draw, merge, snap state
    // Clear hover
    if (hoveredStation) setHoveredStation(null);
    // Show toast if operation was canceled
    if (drawFromStation || mergeStationA || placementMode) {
      showToast('Operation canceled - stations hidden');
    }
  }
}, [showStations]);

// Similar for shots...
```

## Implementation Notes

- May need new action `clearStationSelections()` that filters `multiSelection` by type
- Or modify existing `clearSelection()` to accept optional type filter
- Check if any operation was in progress before showing cancellation toast
## Files to Modify
- `src/components/Map/MapCanvas.tsx` or relevant hook
- Potentially `src/hooks/useMapTools.ts`

## Implementation Details

### Clear Selection on Toggle
When `showStations` changes from true to false:
- Clear any selected stations from the selection state
- Keep any selected shots (if shots are still visible)

When `showShots` changes from true to false:
- Clear any selected shots from the selection state
- Keep any selected stations (if stations are still visible)

### Cancel In-Progress Operations
When visibility toggles change during an active tool operation:
- Cancel Draw operation (clear pending points)
- Cancel Merge operation (clear selected merge targets)
- Cancel Measure operation (clear measurement points)
- Show toast notification: "Operation canceled - [stations/shots] hidden"

## Depends On
- Task 3: Visibility toggle wiring must be in place
## Acceptance
- [ ] Selected stations cleared when `showStations` toggled off
- [ ] Selected shots cleared when `showShots` toggled off
- [ ] Mixed selections only clear the type being hidden
- [ ] `drawFromStation` cleared when stations hidden
- [ ] `mergeStationA` and `mergeStationB` cleared when stations hidden
- [ ] `measureStart`/`measureEnd` cleared if measuring to stations when hidden
- [ ] `placementMode` exited when visibility changes
- [ ] `snappedStation` cleared when stations hidden
- [ ] `hoveredStation` cleared when stations hidden
- [ ] `hoveredShot` cleared when shots hidden
- [ ] Toast "Operation canceled - stations hidden" shown if operation was active
- [ ] Toast "Operation canceled - shots hidden" shown if shot operation was active
- [ ] Clearing happens immediately on toggle change
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
