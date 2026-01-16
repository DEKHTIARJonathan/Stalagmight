# PRD: Wire Scale Bar Toggle in Display Menu

## Overview

**Task ID:** 6
**Priority:** High
**Phase:** 2 - Map Display Features
**Estimated Complexity:** Low

### Summary

Connect the existing `showScaleBar` toggle in the Display Menu to actually show/hide the MapLibre ScaleControl on the map.

## Background

The Display Menu has a toggle for "Scale Bar" but it's not wired to the actual MapLibre ScaleControl. This task connects the UI toggle to the map control.

## Requirements

### Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| F1 | Scale bar visible by default | Must |
| F2 | Toggle in Display Menu shows/hides scale bar | Must |
| F3 | Position: Bottom-left of map | Must |
| F4 | Units follow config setting (metric/imperial) | Must |
| F5 | Configurable per-export whether scale bar appears | Must |
| F6 | Persist visibility state | Should |

### Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NF1 | Toggle should not cause map reload | Must |
| NF2 | No duplicate scale controls | Must |

## User Decisions

- Visible by default
- Position: Bottom-left
- Units: Follow config setting
- Configurable per-export whether scale bar appears in exported images

## Technical Specification

### Files to Modify

| File | Changes |
|------|---------|
| `src/components/Map/MapCanvas.tsx` | Add/remove ScaleControl based on state |
| `src/store/uiStore.ts` | Verify `showScaleBar` state exists |

### Implementation Details

1. **Track ScaleControl reference:**
   ```typescript
   // In MapCanvas.tsx
   const scaleControlRef = useRef<maplibregl.ScaleControl | null>(null);
   ```

2. **Effect to manage scale control:**
   ```typescript
   useEffect(() => {
     if (!map) return;

     if (showScaleBar && !scaleControlRef.current) {
       // Add scale control
       const control = new maplibregl.ScaleControl({
         maxWidth: 100,
         unit: config.general.units === 'metric' ? 'metric' : 'imperial',
       });
       map.addControl(control, 'bottom-left');
       scaleControlRef.current = control;
     } else if (!showScaleBar && scaleControlRef.current) {
       // Remove scale control
       map.removeControl(scaleControlRef.current);
       scaleControlRef.current = null;
     }
   }, [map, showScaleBar, config.general.units]);
   ```

3. **Unit updates:**
   ```typescript
   useEffect(() => {
     if (scaleControlRef.current && map) {
       // ScaleControl doesn't support unit change, recreate
       map.removeControl(scaleControlRef.current);
       const control = new maplibregl.ScaleControl({
         maxWidth: 100,
         unit: config.general.units === 'metric' ? 'metric' : 'imperial',
       });
       map.addControl(control, 'bottom-left');
       scaleControlRef.current = control;
     }
   }, [config.general.units]);
   ```

4. **Export integration:**
   ```typescript
   // In export logic
   interface ImageExportOptions {
     includeScaleBar: boolean;
   }

   const exportImage = async (options: ImageExportOptions) => {
     if (!options.includeScaleBar && scaleControlRef.current) {
       map.removeControl(scaleControlRef.current);
     }
     // ... capture
     if (!options.includeScaleBar && showScaleBar) {
       // Re-add if it was visible
       map.addControl(scaleControlRef.current, 'bottom-left');
     }
   };
   ```

## UI/UX Specification

### Display Menu Item

```
Display ▼
├─ [ ] Grid
├─ [x] Scale Bar        <- Toggle this
├─ [ ] Section Names
└─ [ ] Station Labels
```

### Scale Bar Appearance

- **Position**: Bottom-left corner
- **Style**: MapLibre default (simple ruler with distance)
- **Units**: "m" or "ft" based on config

### Export Dialog Addition

```
Export Options
├─ Format: [PNG ▼]
├─ Resolution: [1920x1080 ▼]
└─ [x] Include scale bar in export
```

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Toggle rapidly | Debounce or ignore intermediate states |
| Unit change while visible | Recreate control with new units |
| Map not loaded yet | Wait for map load before adding |
| Multiple maps (GlobalView) | Each map manages own scale control |

## Testing

### Manual Tests

1. Open map, verify scale bar visible by default
2. Toggle off in Display Menu, verify disappears
3. Toggle on, verify reappears in same position
4. Change units in settings, verify scale bar updates
5. Export with "include scale bar" checked/unchecked

### Automated Tests

```typescript
describe('MapCanvas scale bar', () => {
  it('shows scale bar by default', () => {});
  it('hides scale bar when toggled off', () => {});
  it('does not duplicate controls', () => {});
  it('updates units when config changes', () => {});
});
```

## Dependencies

- None (uses existing uiStore state)

## Acceptance Criteria

- [ ] Scale bar visible by default on map load
- [ ] Display Menu toggle shows/hides scale bar
- [ ] Position is bottom-left
- [ ] Units match config (metric/imperial)
- [ ] No duplicate scale controls on rapid toggle
- [ ] Export dialog has "include scale bar" option
- [ ] Scale bar export option works correctly
