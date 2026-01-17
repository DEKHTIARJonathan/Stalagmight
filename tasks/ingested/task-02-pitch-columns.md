# Task 02: Add pitch columns to DMP Import Dialog table

## Overview
Display pitch_in and pitch_out values in the DMP Import Dialog preview table. These fields are already imported by the parser but not currently displayed to users.

## Priority
High - Phase 1 (Import Dialog Enhancements)

## Risk Level
Low

## Dependencies
None - can start immediately

## Files to Modify
- `src/components/Dialogs/DmpImportDialog.tsx` - Add pitch columns to table

## Specifications

### Display Format
- Show in degrees only (no unit suffix needed)
- Display average of pitch_in and pitch_out in a single "Pitch" column
- Store both values internally for potential future use
- Empty cell for null/undefined values

### Column Header
- Pitch (single column showing average)

### Data Source
- Pitch data comes from `shot.pitch_in` and `shot.pitch_out` in parsed DMP data
- Both are optional numbers representing angles in degrees

### Calculation
- If both pitch_in and pitch_out exist: display average `(pitch_in + pitch_out) / 2`
- If only one exists: display that value
- If neither exists: empty cell

### Version Handling
- Check parser to confirm which DMP versions include pitch data
- Always show column regardless of version

### UI Requirements
- Column should match existing table styling
- Use same number formatting as other numeric columns
- Add `data-testid` attribute: `pitch-{rowIndex}`

## Acceptance Criteria
- [ ] Pitch column visible in import preview table
- [ ] Correct average displayed when both values present
- [ ] Single value displayed when only one present
- [ ] Empty cell for missing values
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Playwright tests pass

## Test Requirements

### Playwright Tests (e2e-playwright/)
- Test pitch column visible in import dialog
- Test average calculation (both values present)
- Test single value display (one value present)
- Test empty cells for missing data

## Edge Cases
- Only pitch_in present
- Only pitch_out present
- Neither present
- Both present with different values
- Negative pitch values (valid for downward slopes)

## Implementation Notes
- Low risk task - straightforward column addition
- Similar implementation pattern to Task 01 (LRUD)
