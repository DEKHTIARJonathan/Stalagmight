# PRD: Add Manual Map Placement Mode

## Overview

**Task ID:** 11
**Priority:** High
**Phase:** 3 - GPS & Placement
**Estimated Complexity:** Medium

### Summary

Interactive map placement mode where users click on the map to position a section, with station snapping by default (Shift to disable) and immediate confirmation on click.

## Background

Manual placement allows users to visually position sections on the map by clicking. This is used from the Per-Section Adjustment Dialog when "Manual Map Placement" is selected.

## Requirements

### Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| F1 | Show section outline following cursor | Must |
| F2 | Snap to nearby stations by default | Must |
| F3 | Hold Shift to disable snapping | Must |
| F4 | Click to immediately confirm placement | Must |
| F5 | ESC to cancel placement mode | Must |
| F6 | Fixed orientation (no rotation) | Must |
| F7 | Return control to adjustment dialog after placement | Must |

### Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NF1 | Cursor preview should be smooth (60fps) | Should |
| NF2 | Snap detection should be instant | Must |

## User Decisions

- Snap to station by default, hold modifier key to disable snapping
- Fixed orientation (no rotation)
- Immediate confirm on click (no additional dialog)
- Snap targets: Stations only (not shot midpoints or lines)

## Technical Specification

### Files to Modify

| File | Changes |
|------|---------|
| `src/components/Map/MapCanvas.tsx` | Add placement mode rendering and handlers |
| `src/store/uiStore.ts` | Add placement mode state |

### Implementation Details

1. **UI Store state:**
   ```typescript
   interface UiState {
     // ... existing state
     placementMode: {
       active: boolean;
       section: ImportedSection | null;
       onComplete: ((offset: { x: number; y: number }) => void) | null;
       onCancel: (() => void) | null;
     };
   }

   const startPlacementMode = (
     section: ImportedSection,
     onComplete: (offset: { x: number; y: number }) => void,
     onCancel: () => void
   ) => {
     set({
       placementMode: {
         active: true,
         section,
         onComplete,
         onCancel,
       },
     });
   };

   const exitPlacementMode = () => {
     set({
       placementMode: {
         active: false,
         section: null,
         onComplete: null,
         onCancel: null,
       },
     });
   };
   ```

2. **Cursor preview rendering:**
   ```typescript
   // In MapCanvas.tsx
   const PlacementPreview: React.FC<{
     section: ImportedSection;
     cursorPosition: { lng: number; lat: number };
     snappedStation: Station | null;
   }> = ({ section, cursorPosition, snappedStation }) => {
     const previewCoords = snappedStation
       ? { x: snappedStation.x, y: snappedStation.y }
       : mapCoordsToMeters(cursorPosition.lng, cursorPosition.lat);

     // Build GeoJSON for section at preview position
     const previewGeoJSON = buildSectionGeoJSON(section, previewCoords);

     return (
       <Source id="placement-preview" type="geojson" data={previewGeoJSON}>
         <Layer
           id="placement-preview-lines"
           type="line"
           paint={{
             'line-color': section.color,
             'line-width': 2,
             'line-dasharray': [4, 2],
           }}
         />
         <Layer
           id="placement-preview-points"
           type="circle"
           paint={{
             'circle-radius': 4,
             'circle-color': section.color,
             'circle-opacity': 0.7,
           }}
         />
       </Source>
     );
   };
   ```

3. **Snap detection:**
   ```typescript
   const findSnapTarget = (
     cursorMeters: { x: number; y: number },
     stations: Station[],
     snapThreshold: number // in meters
   ): Station | null => {
     let closest: Station | null = null;
     let closestDist = Infinity;

     for (const station of stations) {
       const dist = Math.hypot(
         station.x - cursorMeters.x,
         station.y - cursorMeters.y
       );
       if (dist < snapThreshold && dist < closestDist) {
         closest = station;
         closestDist = dist;
       }
     }

     return closest;
   };
   ```

4. **Mouse handlers:**
   ```typescript
   const handleMouseMove = (e: MapMouseEvent) => {
     if (!placementMode.active) return;

     const shiftPressed = e.originalEvent.shiftKey;
     const cursorMeters = mapCoordsToMeters(e.lngLat.lng, e.lngLat.lat);

     let snappedStation: Station | null = null;
     if (!shiftPressed) {
       snappedStation = findSnapTarget(cursorMeters, allStations, snapThreshold);
     }

     setCursorPosition(e.lngLat);
     setSnappedStation(snappedStation);
   };

   const handleClick = (e: MapMouseEvent) => {
     if (!placementMode.active) return;

     const shiftPressed = e.originalEvent.shiftKey;
     const cursorMeters = mapCoordsToMeters(e.lngLat.lng, e.lngLat.lat);

     let finalPosition = cursorMeters;
     if (!shiftPressed) {
       const snapped = findSnapTarget(cursorMeters, allStations, snapThreshold);
       if (snapped) {
         finalPosition = { x: snapped.x, y: snapped.y };
       }
     }

     // Call onComplete callback
     placementMode.onComplete?.(finalPosition);
     exitPlacementMode();
   };

   const handleKeyDown = (e: KeyboardEvent) => {
     if (e.key === 'Escape' && placementMode.active) {
       placementMode.onCancel?.();
       exitPlacementMode();
     }
   };
   ```

## UI/UX Specification

### Cursor Preview

```
                        ●──●
                        │    <- Dashed outline in section color
                        ●──●
                        ↑
                    [Cursor]
```

### Snap Indicator

When snapping to a station:
- Preview snaps to station position
- Station highlighted with pulsing ring
- Cursor shows "snap" indicator

### Status Bar

```
┌─────────────────────────────────────────────────────────────────┐
│ Placement Mode: Click to place section. Hold Shift to disable  │
│ snapping. Press ESC to cancel.                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Snap Visual

```
     ●══════●                Existing station
     ║      ║                ↓
     ●══════●────[◎]←────●──●     ← Preview snapped
             snap ring    │
                         ●──●
```

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Click outside map bounds | Ignore click |
| No stations to snap to | Works without snapping |
| Overlapping stations | Snap to closest |
| Map pan/zoom during placement | Preview follows cursor correctly |
| Rapid clicks | Ignore after first click |

## Testing

### Manual Tests

1. Enter placement mode from adjustment dialog
2. Move cursor, verify preview follows
3. Move near station, verify snap indicator
4. Hold Shift, verify snapping disabled
5. Click to place, verify position correct
6. Press ESC, verify mode cancelled
7. Verify dialog regains control after placement

### Automated Tests

```typescript
describe('Manual placement mode', () => {
  it('shows preview following cursor', () => {});
  it('snaps to nearby stations', () => {});
  it('disables snapping with Shift', () => {});
  it('confirms on click', () => {});
  it('cancels on ESC', () => {});
});
```

## Dependencies

- Task 10 (Per-Section Dialog) triggers this mode

## Acceptance Criteria

- [ ] Section outline follows cursor
- [ ] Snaps to stations by default
- [ ] Shift disables snapping
- [ ] Click immediately confirms placement
- [ ] ESC cancels and returns to dialog
- [ ] Fixed orientation (no rotation support)
- [ ] Status bar shows instructions
- [ ] Map tools work after exiting placement mode
