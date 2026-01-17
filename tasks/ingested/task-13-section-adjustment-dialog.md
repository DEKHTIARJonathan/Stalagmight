# Task 13: Add per-section adjustment dialog

## Overview
Create a dialog to adjust section offset (dx/dy). Accessible from the SectionsPanel context menu. Adjustments apply live with undo support.

## Priority
Medium - Phase 3 (GPS & Placement)

## Risk Level
Medium

## Dependencies
- Task 14: Return section ID from create_section command (helpful but not blocking)

## Files to Modify
- `src/components/Dialogs/SectionAdjustDialog.tsx` - New dialog component
- `src/components/SingleSystemView/SectionsPanel.tsx` - Add context menu item

## Specifications

### Access Point
- Right-click context menu on section in SectionsPanel
- Menu item: "Adjust Position..." or similar

### Adjustment Controls
- dx (horizontal offset): number input
- dy (vertical offset): number input
- Values in current project units (meters/feet)

### Adjustment Mode
- Relative only: values are deltas from current position
- No absolute positioning in v1

### Apply Behavior
- Live updates: changes visible immediately on map
- Undo support: Ctrl+Z reverts adjustment
- No explicit reset button (use undo instead)

### Move Scope
- Merged groups move together
- Adjusting one section in a group moves the entire group

### Dialog UI
- Title: "Adjust Section Position"
- Section name displayed
- dx/dy input fields
- OK/Cancel buttons
- WCAG 2.1 AA accessible
- Add `data-testid` attributes:
  - `section-adjust-dialog`
  - `adjust-dx-input`
  - `adjust-dy-input`
  - `adjust-ok-button`
  - `adjust-cancel-button`

### ARIA Requirements
- `role="dialog"`
- `aria-modal="true"`
- `aria-labelledby` pointing to title

## Acceptance Criteria
- [ ] Context menu item visible in SectionsPanel
- [ ] Dialog opens on menu click
- [ ] dx/dy inputs functional
- [ ] Live preview on map
- [ ] OK applies changes
- [ ] Cancel reverts to original
- [ ] Undo (Ctrl+Z) reverts adjustment
- [ ] Merged groups move together
- [ ] Dialog accessible (WCAG 2.1 AA)
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Playwright tests pass

## Test Requirements

### Playwright Tests (e2e-playwright/)
- Test context menu item visible
- Test dialog opens
- Test dx/dy inputs work
- Test OK applies changes
- Test Cancel reverts changes
- Test Ctrl+Z undoes adjustment
- Test keyboard accessibility
- Test screen reader accessibility

## Edge Cases
- Adjust by zero (no change)
- Very large offset values
- Negative offset values
- Adjust merged section group
- Adjust while other operations pending

## Implementation Notes
- Dialog similar to existing dialogs in style
- May need new command for section adjustment
- Consider debouncing live updates for performance
