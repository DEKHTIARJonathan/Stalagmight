# Task 40: Delete Row from Data Table

## Overview
Allow deleting shots from data table via row selection and Delete key. Support multi-row selection and handle split warnings for middle shots.

## Priority
High - Phase C (Data Table)

## Risk Level
High

## Dependencies
- Existing DataTable component

## Files to Modify
- `src/components/SingleSystemView/DataTable.tsx` - Delete handling
- `src-tauri/src/core/command.rs` - DeleteShot(s) command
- `src-tauri/src/core/state.rs` - Execute shot deletion
- `src-tauri/src/models/section.rs` - Remove shot logic

## Specifications

### Selection Modes
- Single row: Click row
- Multi-row: Shift+Click for range
- Multi-row: Ctrl+Click for individual
- Select all: Ctrl+A

### Delete Trigger
- Delete or Backspace key
- Context menu "Delete"
- No delete button (keyboard/menu only)

### Confirmation
- Always confirm before delete
- Show count of rows to delete
- "Delete X shots?" dialog

### Split Warning
- When deleting middle shot(s):
  - Warn that section will split
  - Show preview of resulting sections
  - "This will split the section into 2 parts"
- User can cancel or proceed

### Endpoint Handling
- First/last shot: Same handling as middle
- Deleting all shots: Confirm, then empty section

### Merge Warning
- If deleted shots affect merged stations:
  - Warn that merge will be broken
  - "This shot is part of a merge. Deleting will break the connection."
  - User chooses: Delete anyway / Cancel

### Batch Delete
- No limit on batch size
- Single confirmation for batch
- Single undo for entire batch

### Undo Support
- DeleteShot(s) is a Command
- Ctrl+Z restores deleted rows
- Restores merges if they were broken

## Acceptance Criteria
- [ ] Delete key triggers delete
- [ ] Confirmation dialog shown
- [ ] Multi-select works (Shift, Ctrl)
- [ ] Split warning for middle shots
- [ ] Merge warning when applicable
- [ ] Undo restores deleted rows
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Rust Tests
1. Test DeleteShot command removes shot
2. Test DeleteShot creates undo entry
3. Test section split when middle shot deleted
4. Test merge break detection when merged shot deleted
5. Test batch delete removes multiple shots
6. Test delete all shots leaves empty section

### Playwright Tests (Mocked IPC)
1. Test Delete key triggers delete flow
2. Test Backspace key triggers delete flow
3. Test confirmation dialog appears
4. Test confirmation shows correct count
5. Test Shift+Click selects range
6. Test Ctrl+Click adds to selection
7. Test Ctrl+A selects all rows
8. Test split warning shown for middle shot
9. Test merge warning shown for merged shot
10. Test cancel aborts delete

### WebdriverIO Tests (Full App)
1. Test deleted shot removed from database
2. Test undo restores deleted shot(s)
3. Test section split creates two sections
4. Test merge broken when shot deleted
5. Test map updates after delete
6. Test batch delete performance with 50 rows

## Edge Cases
- Delete all rows in section
- Delete shots involved in loop
- Delete with pending edits
- Very large batch delete
