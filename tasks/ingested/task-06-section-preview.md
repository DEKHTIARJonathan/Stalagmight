# Task 06: Add section preview to DMP Import Dialog

## Overview
Add a live MapLibre-based preview of the selected section shape in the DMP Import Dialog. The preview updates as the user selects different sections and supports basic zoom/pan interaction.

## Priority
High - Phase 1 (Import Dialog Enhancements)

## Risk Level
Medium

## Dependencies
None - can start immediately

## Files to Modify
- `src/components/Dialogs/DmpImportDialog.tsx` - Add preview panel
- `src/components/Dialogs/SectionPreview.tsx` - New component for MapLibre preview

## Specifications

### Preview Scope
- Two-step import process:
  1. Load DMP file, select sections to import
  2. Per-section placement (shown in preview)
- Preview shows currently selected section

### Preview Size
- 250x250 pixels fixed size
- Positioned to the right of the import table

### Rendering Engine
- MapLibre-based (not SVG)
- Reuse existing map rendering components where possible
- Dark background matching app theme

### Interaction
- Zoom: Mouse wheel
- Pan: Click and drag
- Fit to view: Auto-fit section on selection

### Display Elements
- Station dots (required)
- Shot lines connecting stations
- Minimal view (no labels, no overlays in preview)

### UI Requirements
- Preview panel with border/background
- Loading state while rendering
- Add `data-testid` attributes:
  - `section-preview`
  - `section-preview-canvas`

## Acceptance Criteria
- [ ] Preview panel visible in import dialog
- [ ] Shows selected section shape
- [ ] Updates when different section selected
- [ ] Zoom with mouse wheel works
- [ ] Pan with click-drag works
- [ ] Auto-fits section on selection
- [ ] Station dots visible
- [ ] Shot lines visible
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Playwright tests pass

## Test Requirements

### Playwright Tests (e2e-playwright/)
- Test preview panel visible
- Test preview updates on section selection
- Test preview shows stations and shots
- Test zoom interaction
- Test pan interaction

## Edge Cases
- Single-shot section (just two stations)
- Very large section (many stations)
- Section with no stations (error state)
- Section with overlapping stations
- Rapid section switching

## Implementation Notes
- Consider performance with large sections
- May need debouncing for rapid selection changes
- Reuse SurveyLayer rendering logic if possible
- Preview should be a minimal MapLibre instance
