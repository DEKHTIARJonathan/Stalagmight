# Display Toggle Visibility & Selection Behavior

## Problem

Display toggles don't actually hide elements or prevent selection.

## Adding `showShots` - Complete Checklist

1. **`src/store/uiStore.ts`:**
   - Add `showShots: boolean` to UIState
   - Add to DisplayToggleKey union
   - Add `showShots: true` to defaults
   - Add to `resetDisplaySettings()`
   - **Update `loadDisplaySettings`:**
     ```typescript
     const displayState: Partial<UIState> = {};
     let sawShowShots = false;
     for (const [key, value] of Object.entries(map)) {
       if (key === 'showShots') {
         displayState.showShots = value === 'true';
         sawShowShots = true;
       }
       // ... existing key handling
     }
     // Fallback for missing showShots
     if (!sawShowShots) {
       displayState.showShots = true;
     }
     set(displayState);
     ```

2. **DisplayMenu, MapCanvas, mocks** - as before

## Station Highlight Layer Ordering

**Insert ABOVE stations layer, BELOW labels:**
```typescript
// In initializeLayers(), after survey-stations, before station-labels
this.map.addLayer({
  id: 'survey-stations-highlight',
  type: 'circle',
  source: 'survey-data-stations',
  filter: ['==', ['get', 'sectionId'], -9999],
  paint: { ... }
}, 'station-labels');  // beforeId ensures it's below labels
```

## Selection Entry Points - Guard Placement

**Context menu guard BEFORE selection:**
```typescript
// In handleContextMenu, at TOP before any setSelection
if (target.type === 'station' && !showStations) {
  showToast("Enable 'Stations' in Display menu...", 'stations-hidden');
  return;  // Return before setSelection
}
if (target.type === 'shot' && !showShots) {
  showToast("Enable 'Shots' in Display menu...", 'shots-hidden');
  return;
}
// Then proceed with selection and menu opening
```

## Ghost Merge Preview

Call `setGhostSection(null)` when stations hidden.

## Virtual Shot Hover

Add `setHoveredShot(null)` in effect.

## Highlight Wiring

Convert StationRef to string ID format.

## Toggle Cascade

_prev values in-memory only.

## Toast System

Per-key throttle, Portal, z-index 99999.

## Acceptance Criteria

- [ ] `loadDisplaySettings` uses `sawShowShots` flag for fallback
- [ ] Context menu guard placed BEFORE setSelection calls
- [ ] Highlight layer inserted with `beforeId` for ordering above stations, below labels
- [ ] E2E and unit tests pass
