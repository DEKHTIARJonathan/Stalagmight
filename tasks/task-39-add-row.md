# Task 39: Add Row to Data Table

## Overview
Allow adding new shots directly in the data table via an "Add Shot" button. New row inserted at user-chosen position with blank values.

## Priority
Medium - Phase C (Data Table)

## Risk Level
Medium

## Dependencies
- Task 38: Inline editing (for editing new row values)

## Files to Modify
- `src/components/SingleSystemView/DataTable.tsx` - Add button and row insertion
- `src-tauri/src/core/command.rs` - AddShot command
- `src-tauri/src/core/state.rs` - Execute shot addition
- `src-tauri/src/models/section.rs` - Insert shot at position

## Specifications

### Add Button Location
- Below data table
- "Add Shot" button with + icon
- Also available in context menu

### Insert Position
- User chooses position:
  - "Add at end" (default)
  - "Add after selected" (if row selected)
  - "Add at beginning"
- Context menu shows position options

### New Row Template
- Blank row (not copy of previous)
- All numeric fields empty
- Auto-generates next station name

### After Insert
- New row appears in table
- First editable cell focused
- Row highlighted briefly

### Undo Support
- AddShot is a Command
- Ctrl+Z removes added row

### Station Name Generation
- If last station was "A5", new is "A6"
- If pattern unclear, prompt user
- Station names are sequential within section

## Acceptance Criteria
- [ ] Add button visible below table
- [ ] Position selection works
- [ ] New row appears correctly
- [ ] First cell auto-focused
- [ ] Undo removes added row
- [ ] Station name generated correctly
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Rust Tests
1. Test AddShot command creates new shot
2. Test AddShot inserts at end of section
3. Test AddShot inserts after specified position
4. Test AddShot inserts at beginning
5. Test station name generation follows pattern (A5 → A6)
6. Test AddShot creates undo entry

### Playwright Tests (Mocked IPC)
1. Test "Add Shot" button visible below table
2. Test clicking add button shows position options
3. Test "Add at end" creates row at bottom
4. Test "Add after selected" creates row after selection
5. Test "Add at beginning" creates row at top
6. Test new row has empty/default values
7. Test first editable cell auto-focused
8. Test new row briefly highlighted

### WebdriverIO Tests (Full App)
1. Test added shot persists to database
2. Test undo removes added shot
3. Test added shot appears on map
4. Test station name generated correctly
5. Test concurrent adds handled properly

## Edge Cases
- Add to empty section
- Add when at max shots
- Add with no row selected
- Concurrent adds
