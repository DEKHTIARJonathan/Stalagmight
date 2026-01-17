# Task 11: Add "From Existing Station" placement option

## Overview
Add an option in the DMP Import Dialog to connect the imported section to an existing station in the project. Automatically merges the sections on import.

## Priority
High - Phase 3 (GPS & Placement)

## Risk Level
Medium

## Dependencies
- Requires an open project with existing stations

## Files to Modify
- `src/components/Dialogs/DmpImportDialog.tsx` - Add connection option and station selector

## Specifications

### Connection Options
- "New Section" (default): No connection, placed independently
- "From Existing Station": Connect to existing station

### Station Selection Methods
- Dropdown list of existing stations
- Click on station in preview map

### Preview Behavior
- Show preview of how sections will connect
- Connected sections displayed together
- Both merged on import

### Merge Behavior
- Auto-merge on import: connected stations become one
- New section positioned relative to connection point
- Existing section stays in place

### No Project Handling
- Disable "From Existing Station" option when no project open
- Gray out with tooltip explaining why

### Move Scope
- Merged groups move together
- Connection creates a group

### UI Requirements
- Radio buttons or toggle for placement mode
- Station dropdown populated from current project
- Preview shows connection
- Add `data-testid` attributes:
  - `placement-mode-selector`
  - `existing-station-dropdown`
  - `connection-preview`

## Acceptance Criteria
- [ ] Placement mode selector visible
- [ ] Station dropdown lists existing stations
- [ ] Can click station in preview to select
- [ ] Preview shows connected sections
- [ ] Import merges at connection point
- [ ] New section positioned correctly
- [ ] Option disabled when no project open
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Playwright tests pass

## Test Requirements

### Playwright Tests (e2e-playwright/)
- Test placement mode selector visible
- Test dropdown lists existing stations
- Test preview shows connection
- Test import creates merged station
- Test option disabled without project
- Test both dropdown and preview click selection

## Edge Cases
- No existing project (disable option)
- Empty project (no stations to connect to)
- Connect to already merged station
- Connect at first vs last station of new section
- Multiple sections in import file

## Implementation Notes
- Need to calculate offset for new section based on connection point
- May need changes to import command to support merge on import
- Preview needs access to current project data
