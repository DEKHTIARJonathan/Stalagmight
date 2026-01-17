# Task 38: Inline Editing in Data Table

## Overview
Enable direct editing of shot values in data table cells. Double-click to edit, Enter to confirm, Escape to cancel, Tab to move to next cell.

## Priority
High - Phase C (Data Table)

## Risk Level
High

## Dependencies
- Existing DataTable component

## Files to Modify
- `src/components/common/Table.tsx` - Add inline edit mode
- `src/components/SingleSystemView/DataTable.tsx` - Wire up editing
- `src-tauri/src/core/command.rs` - UpdateShot command
- `src-tauri/src/core/state.rs` - Execute shot updates

## Specifications

### Edit Triggers
- Double-click cell to enter edit mode
- F2 key when cell is focused
- Start typing when cell is focused

### Edit Behavior
- Cell becomes input field
- Original value pre-selected
- Cursor at end of value

### Commit/Cancel
- Enter: Commit change + move down
- Tab: Commit change + move right
- Shift+Tab: Commit change + move left
- Escape: Cancel edit, restore original
- Click outside: Commit change

### Validation
- On blur only (not on keystroke)
- Invalid values show error state
- Cannot commit invalid values
- Error message shown below cell

### Undo Integration
- Each cell edit is a Command
- Ctrl+Z undoes cell edit (not just text change)
- Both command undo and cell-level undo available

### Editable Fields
- Azimuth, Length, Depth
- L/R/U/D values
- Comment
- NOT: Station names (computed)

### Visual Feedback
- No dirty indicator (changes save transparently)
- Cell border changes when in edit mode
- Error state: red border + error message

## Acceptance Criteria
- [ ] Double-click enters edit mode
- [ ] Enter commits and moves down
- [ ] Escape cancels edit
- [ ] Tab navigation works
- [ ] Validation on blur
- [ ] Undo/redo works for edits
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Rust Tests
1. Test UpdateShot command executes successfully
2. Test UpdateShot validates azimuth range (0-360)
3. Test UpdateShot validates length (positive)
4. Test UpdateShot creates undo entry
5. Test UpdateShot inverse command works

### Playwright Tests (Mocked IPC)
1. Test double-click enters edit mode
2. Test F2 key enters edit mode
3. Test typing in focused cell enters edit mode
4. Test Enter commits and moves down
5. Test Tab commits and moves right
6. Test Shift+Tab commits and moves left
7. Test Escape cancels edit and restores value
8. Test click outside commits change
9. Test validation error shows below cell
10. Test invalid values cannot be committed

### WebdriverIO Tests (Full App)
1. Test cell edit persists to database
2. Test undo reverts cell edit
3. Test redo restores cell edit
4. Test edited value reflects on map
5. Test rapid edits handled correctly

## Edge Cases
- Editing while row is selected
- Rapid edits (debouncing)
- Edit during pending save
- Very long values
