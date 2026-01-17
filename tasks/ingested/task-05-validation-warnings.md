# Task 05: Add inline validation warnings to DMP Import Dialog

## Overview
Display warning icons on shots with validation issues in the DMP Import Dialog. Use existing validation rules from config to identify problems and show them inline with the table data.

## Priority
High - Phase 1 (Import Dialog Enhancements)

## Risk Level
Medium

## Dependencies
None - can start immediately

## Files to Modify
- `src/components/Dialogs/DmpImportDialog.tsx` - Add warning display
- `src/utils/validation.ts` - Validation logic (create if needed)

## Specifications

### Validation Trigger
- Run validation on initial load
- Re-validate on blur (when editing fields, if inline edit enabled)

### Warning Display
- Sidebar column with warning icons
- Cell highlighting for fields with issues
- Hover tooltip showing warning message
- Warning panel/summary showing all issues

### Severity Levels
- Error (red): Critical issues that may cause problems
- Warning (yellow): Potential issues but not blocking

### Validation Rules (from config thresholds)
- Shot length exceeds maximum
- Azimuth out of range (0-360)
- Depth change exceeds threshold
- LRUD values exceed passage maximum
- Duplicate station names
- Missing required fields

### Warning Blocking
- User choice via checkbox: "Proceed with warnings"
- Errors always block import
- Warnings can be acknowledged and bypassed

### UI Requirements
- Warning icon column on left side of table
- Click icon to see full warning message
- Summary count in dialog header: "3 warnings, 1 error"
- Add `data-testid` attributes:
  - `validation-icon-{rowIndex}`
  - `validation-summary`
  - `validation-proceed-checkbox`

## Acceptance Criteria
- [ ] Warning icons visible on rows with issues
- [ ] Correct severity levels (error/warning)
- [ ] Cell highlighting for problem fields
- [ ] Hover tooltips with warning messages
- [ ] Summary count in header
- [ ] Proceed checkbox for warnings
- [ ] Errors block import
- [ ] Uses config thresholds
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Playwright tests pass

## Test Requirements

### Playwright Tests (e2e-playwright/)
- Test warning icons appear for invalid data
- Test error icons block import
- Test proceed checkbox allows warnings
- Test hover tooltip shows message
- Test summary count accurate
- Test valid file shows no warnings

### Rust Tests
- Test validation logic with various edge cases

## Edge Cases
- File with no validation issues
- File with only warnings (no errors)
- File with only errors
- Many warnings on single row
- Validation of empty/null values

## Implementation Notes
- Config thresholds defined in `src-tauri/src/config/defaults.rs`
- May need to expose validation thresholds to frontend
- WCAG 2.1 AA: Ensure warnings are accessible (not color-only)
