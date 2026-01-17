# Task 21: Add multi-select and merge UI in GlobalView

## Overview
Enable multi-select in GlobalView to select two systems, then merge them via right-click context menu. Create a merge dialog for confirmation and options.

## Priority
Medium - Phase 5 (Project Merge)

## Risk Level
Medium

## Dependencies
- Task 19: MergeProjects command
- Task 20: merge_projects IPC handler

## Files to Modify
- `src/components/GlobalView/GlobalView.tsx` - Add multi-select and context menu
- `src/components/Dialogs/MergeProjectsDialog.tsx` - New merge confirmation dialog

## Specifications

### Multi-Select
- Shift+click: Range select (if list view)
- Ctrl+click: Toggle individual selection
- Maximum: Two projects for merge

### Merge Access
- Right-click context menu only
- Menu item: "Merge Systems..."
- Only visible when exactly 2 systems selected

### Merge Count
- Two projects only per merge
- If more selected, merge disabled or first two used

### Merge Order
- First selected project is primary
- Second selected project appends to first
- Or: user chooses order in dialog

### Merge Dialog
- Confirmation with project names shown
- Shows which project is primary (sections kept)
- Shows which project appends
- Output path selector
- Merge button / Cancel button

### Dialog UI
- Title: "Merge Systems"
- Show both project names
- Order selector (which is primary)
- Output file path input
- WCAG 2.1 AA accessible
- Add `data-testid` attributes:
  - `merge-dialog`
  - `merge-primary-project`
  - `merge-secondary-project`
  - `merge-output-path`
  - `merge-confirm-button`
  - `merge-cancel-button`

### ARIA Requirements
- `role="dialog"`
- `aria-modal="true"`
- `aria-labelledby` pointing to title

## Acceptance Criteria
- [ ] Multi-select works with Ctrl+click
- [ ] Right-click menu shows "Merge Systems"
- [ ] Menu item only visible with 2 selections
- [ ] Merge dialog opens on menu click
- [ ] Dialog shows both project names
- [ ] Can select merge order
- [ ] Can specify output path
- [ ] Merge button calls merge_projects
- [ ] Success: opens merged project
- [ ] Error: shows error message
- [ ] Dialog accessible (WCAG 2.1 AA)
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Playwright tests pass

## Test Requirements

### Playwright Tests (e2e-playwright/)
- Test multi-select with Ctrl+click
- Test right-click menu with 2 selections
- Test menu hidden with 1 or 0 selections
- Test dialog opens
- Test dialog shows correct projects
- Test merge order selection
- Test merge confirmation
- Test merge cancel
- Test keyboard accessibility

## Edge Cases
- Select more than 2 projects
- Select 0 or 1 projects (menu disabled)
- Merge same project to itself (prevent)
- Cancel during merge
- Merge failure

## Implementation Notes
- Follow existing dialog patterns
- Multi-select state in GlobalView component
- Context menu similar to existing menus
