# Task 23: Wire grid overlay toggle

## Overview
Connect the showGrid toggle to actual grid rendering on the map canvas. Add a grid layer that displays distance lines.

## Priority
Medium - Phase 6 (Export & Polish)

## Risk Level
Low

## Dependencies
None - can start immediately

## Files to Modify
- `src/components/Map/MapCanvas.tsx` - Add grid layer rendering
- `src/store/uiStore.ts` - Ensure showGrid toggle exists

## Specifications

### Grid Scope
- Show grid in both map view and export
- Grid lines at regular intervals

### Grid Spacing
- Multiple options via dropdown
- Options: 1m, 5m, 10m, 25m, 50m, 100m
- Or: Auto-calculate based on zoom

### Grid Style
- Lines only (no distance labels in v1)
- Subtle color that doesn't obscure map
- Consider semi-transparent lines

### Toggle Behavior
- showGrid: true → Grid visible
- showGrid: false → Grid hidden

### Grid Calculation
- Based on map coordinates (meters)
- Aligned to nice numbers (not arbitrary)

### UI Requirements
- Grid spacing selector (dropdown)
- Grid visible in export when enabled
- Add `data-testid` attributes:
  - `grid-overlay`
  - `grid-spacing-selector`

## Acceptance Criteria
- [ ] Grid layer renders on map
- [ ] Toggle controls visibility
- [ ] Grid spacing options available
- [ ] Grid lines at regular intervals
- [ ] Grid appears in export when enabled
- [ ] Grid doesn't obscure map content
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Playwright tests pass

## Test Requirements

### Playwright Tests (e2e-playwright/)
- Test grid visible when enabled
- Test grid hidden when disabled
- Test grid spacing selector
- Test different spacing options

## Edge Cases
- Very zoomed in (dense grid)
- Very zoomed out (sparse grid)
- Grid with no data on map
- Grid with large project

## Implementation Notes
- Low risk: straightforward overlay
- May use MapLibre layer or custom canvas
- Consider performance with many grid lines
- Lines only - no distance labels in v1
