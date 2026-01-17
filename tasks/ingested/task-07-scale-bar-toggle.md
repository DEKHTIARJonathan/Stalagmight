# Task 07: Wire scale bar toggle to MapLibre control

## Overview
Connect the existing showScaleBar toggle in uiStore to the MapLibre ScaleControl visibility. The ScaleControl is already added to the map but needs to respond to the toggle state.

## Priority
Medium - Phase 2 (Map Display Features)

## Risk Level
Low

## Dependencies
None - can start immediately

## Files to Modify
- `src/components/Map/MapCanvas.tsx` - Wire toggle to ScaleControl
- `src/store/uiStore.ts` - Ensure showScaleBar state exists

## Specifications

### Scale Bar Position
- Fixed bottom-left of map canvas
- Standard MapLibre ScaleControl position

### Toggle Behavior
- showScaleBar: true → ScaleControl visible
- showScaleBar: false → ScaleControl hidden

### Persistence
- Toggle state persisted per project
- Store in project settings or uiStore with project context

### UI Requirements
- Toggle accessible from View menu or toolbar
- Add `data-testid="scale-bar-control"` to ScaleControl container if possible

## Acceptance Criteria
- [ ] ScaleControl visibility responds to toggle
- [ ] Scale bar shows in bottom-left when enabled
- [ ] Scale bar hidden when disabled
- [ ] Toggle state persists per project
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Playwright tests pass

## Test Requirements

### Playwright Tests (e2e-playwright/)
- Test scale bar visible when toggle enabled
- Test scale bar hidden when toggle disabled
- Test toggle changes visibility
- Test persistence across sessions (if applicable)

## Edge Cases
- Toggle while map is loading
- Toggle rapidly
- Map resize with scale bar visible

## Implementation Notes
- ScaleControl already exists in MapCanvas.tsx
- Just need to add/remove based on toggle state
- Use map.addControl() and map.removeControl() or CSS visibility
