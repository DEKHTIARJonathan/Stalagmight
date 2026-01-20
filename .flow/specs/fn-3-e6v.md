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
     // Keep existing type and loop structure (L377-388)
     const displayState: Partial<Record<DisplayToggleKey, boolean>> = {};
     let gridSpacing: number | undefined;
     for (const [key, value] of Object.entries(settings)) {
       if (key.startsWith('show')) {
         displayState[key as DisplayToggleKey] = value === 'true';
       }
       // ... existing gridSpacing handling
     }

     // ADD FALLBACK HERE - BEFORE the set() guard check (before L389)
     // If showShots wasn't in saved settings, default to true
     if (displayState.showShots === undefined) {
       displayState.showShots = true;
     }

     // Existing guard (L389) now works correctly - displayState.showShots
     // ensures Object.keys(displayState).length > 0
     if (Object.keys(displayState).length > 0 || gridSpacing !== undefined) {
       set({ ...displayState, ...(gridSpacing !== undefined ? { gridSpacing } : {}) });
     }
     ```

2. **DisplayMenu, MapCanvas, mocks** - as before

## Station Highlight Layer Ordering

**Insert immediately AFTER stations layer (NO beforeId needed):**

Layer order in initializeLayers(): loop-closures → shots → stations → highlight → shot-labels → section-labels → station-labels

Since station-labels is added AFTER the highlight layer, it naturally renders on top.

```typescript
// In initializeLayers(), RIGHT AFTER the stations layer (L271)
// DO NOT use beforeId - station-labels doesn't exist yet at this point
this.map.addLayer({
  id: 'survey-stations-highlight',
  type: 'circle',
  source: this.sourceId + '-stations',  // same source as stations
  filter: ['==', ['get', 'sectionId'], -9999],  // filter to nothing initially
  paint: {
    'circle-radius': 7,
    'circle-color': '#00ffcc',
    'circle-stroke-width': 4,
    'circle-stroke-color': '#00ffcc',
  }
});
// Station-labels added later (L355) renders on top naturally
```

## Selection Entry Points - Guard Placement

**Context menu guard BEFORE selection:**
```typescript
// In handleContextMenu, at TOP before any setSelection
// First handle null target case
if (!target) return;

// Then guard hidden elements
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

- [ ] `loadDisplaySettings` fallback for showShots placed BEFORE set() guard check
- [ ] Context menu guard with null check placed BEFORE setSelection calls
- [ ] Highlight layer inserted immediately AFTER stations (no beforeId - labels added later render on top)
- [ ] E2E and unit tests pass
