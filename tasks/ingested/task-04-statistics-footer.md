# Task 04: Add live statistics footer to DMP Import Dialog

## Overview
Add a statistics footer to the DMP Import Dialog that shows total length, depth range, and shot count for selected sections. Statistics update in real-time as the user selects/deselects sections.

## Priority
High - Phase 1 (Import Dialog Enhancements)

## Risk Level
Low

## Dependencies
None - can start immediately

## Files to Modify
- `src/components/Dialogs/DmpImportDialog.tsx` - Add statistics footer component

## Specifications

### Statistics Displayed
- Total length (sum of all shot lengths in selected sections)
- Shot count (number of shots in selected sections)
- Depth range (min to max depth across selected sections)

### Display Format
- Use units from config (meters/feet)
- Format: "Total: 123.4m | Shots: 45 | Depth: -12.3m to 5.6m"
- Show placeholder/zero values when no sections selected

### Update Behavior
- Debounced updates: 500ms delay after selection changes
- Prevents excessive recalculation during rapid selection
- Show loading indicator during calculation if needed

### UI Requirements
- Footer positioned at bottom of dialog, above action buttons
- Visually distinct from table content
- Text should be selectable (for copy/paste)
- Add `data-testid` attributes:
  - `stats-total-length`
  - `stats-shot-count`
  - `stats-depth-range`
  - `stats-footer`

## Acceptance Criteria
- [ ] Statistics footer visible in import dialog
- [ ] Correct total length calculation
- [ ] Correct shot count
- [ ] Correct depth range (min to max)
- [ ] Updates when sections selected/deselected
- [ ] Debounced 500ms for performance
- [ ] Uses correct units from config
- [ ] Text is selectable
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Playwright tests pass

## Test Requirements

### Playwright Tests (e2e-playwright/)
- Test statistics footer visible
- Test correct values with one section selected
- Test correct values with multiple sections selected
- Test updates on selection change
- Test zero/placeholder values with no selection
- Test unit display matches config

## Edge Cases
- No sections selected (show zeros or placeholder)
- All sections selected
- Sections with missing depth data
- Very large numbers (thousands of meters)
- Single shot section

## Implementation Notes
- Display only - no export functionality (user can select and copy)
- Basic stats: length, count, depth range
- Stats are calculated from selected sections only
