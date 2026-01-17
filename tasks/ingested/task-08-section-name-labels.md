# Task 08: Implement section name labels on map

## Overview
Render section names on the map at section start positions. Labels should use the section's color and include a white halo for readability. Respect the showSectionNames toggle in uiStore.

## Priority
Medium - Phase 2 (Map Display Features)

## Risk Level
Medium

## Dependencies
None - can start immediately

## Files to Modify
- `src/components/Map/SurveyLayer.tsx` - Add section name rendering
- `src/store/uiStore.ts` - Add showSectionNames toggle if not present

## Specifications

### Label Position
- Display at first station of each section
- Offset slightly to avoid overlapping station dot

### Label Style
- Text color matches section color
- White halo/outline for contrast and readability
- Font size: 12-14px (readable but not overwhelming)

### Toggle Behavior
- showSectionNames: true → Labels visible
- showSectionNames: false → Labels hidden

### Persistence
- Toggle state persisted per project

### UI Requirements
- Labels should not overlap (consider collision detection for v2)
- Add appropriate ARIA labels if needed
- Labels should scale appropriately with zoom

## Acceptance Criteria
- [ ] Section names visible on map when enabled
- [ ] Labels positioned at first station
- [ ] Labels use section color + white halo
- [ ] Labels hidden when toggle disabled
- [ ] Toggle state persists per project
- [ ] Labels readable at various zoom levels
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Playwright tests pass

## Test Requirements

### Playwright Tests (e2e-playwright/)
- Test section labels visible when enabled
- Test section labels hidden when disabled
- Test label positioned at first station
- Test label color matches section
- Test toggle changes visibility

## Edge Cases
- Very long section names
- Sections with same start point (merged)
- Many sections causing label overlap
- Single-shot sections
- Unicode characters in section names

## Implementation Notes
- May use MapLibre symbol layer or custom rendering
- Consider using text-halo-width and text-halo-color in MapLibre
- Labels at first station (not midpoint as originally discussed)
