# Task 09: Implement station index labels on map

## Overview
Render station numbers (0, 1, 2...) near station dots on the map. Add a showStationLabels toggle to uiStore and implement zoom-dependent visibility.

## Priority
Medium - Phase 2 (Map Display Features)

## Risk Level
Medium

## Dependencies
None - can start immediately

## Files to Modify
- `src/components/Map/SurveyLayer.tsx` - Add station index rendering
- `src/store/uiStore.ts` - Add showStationLabels toggle

## Specifications

### Label Content
- Station index number (0, 1, 2, 3...)
- Index is position within section, not global ID

### Label Position
- Near station dot, offset to avoid overlap
- Consistent offset direction (e.g., top-right of dot)

### Zoom-Dependent Visibility
- Labels only visible at higher zoom levels
- Prevents clutter when zoomed out
- Threshold configurable or smart auto-detection

### Toggle Behavior
- showStationLabels: true → Labels visible (zoom-dependent)
- showStationLabels: false → Labels always hidden

### Persistence
- Toggle state persisted per project

### Label Style
- Small font size (10-12px)
- White or light color with dark outline for contrast
- Semi-transparent background optional

### UI Requirements
- Add toggle to View menu or toolbar
- Add `data-testid` attributes for testing

## Acceptance Criteria
- [ ] Station index labels visible when enabled + zoomed in
- [ ] Labels hidden when zoomed out (even if enabled)
- [ ] Labels hidden when toggle disabled
- [ ] Correct index numbers displayed
- [ ] Labels don't overlap station dots
- [ ] showStationLabels toggle added to uiStore
- [ ] Toggle state persists per project
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Playwright tests pass

## Test Requirements

### Playwright Tests (e2e-playwright/)
- Test station labels visible at high zoom
- Test station labels hidden at low zoom
- Test toggle disables labels
- Test correct index numbers
- Test labels positioned near stations

## Edge Cases
- Many stations close together
- Station at map edge
- Zoom threshold boundary
- Section with single station
- Merged stations (same position)

## Implementation Notes
- May use MapLibre symbol layer with minzoom property
- Consider performance with many stations
- Index within section, not global station ID
