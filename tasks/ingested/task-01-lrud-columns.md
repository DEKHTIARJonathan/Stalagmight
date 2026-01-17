# Task 01: Add LRUD columns to DMP Import Dialog table

## Overview
Display Left/Right/Up/Down (LRUD) passage dimension values in the DMP Import Dialog preview table. These fields are already imported by the parser but not currently displayed to users.

## Priority
High - Phase 1 (Import Dialog Enhancements)

## Risk Level
Medium

## Dependencies
None - can start immediately

## Files to Modify
- `src/components/Dialogs/DmpImportDialog.tsx` - Add LRUD columns to table

## Specifications

### Display Format
- Show numeric values only (no units suffix)
- Empty cell for null/undefined values
- Column order: Fixed (L, R, U, D after existing columns)
- No column sorting in v1

### Column Headers
- L (Left)
- R (Right)
- U (Up)
- D (Down)

### Data Source
- LRUD data comes from `shot.lrud` object in parsed DMP data
- Fields: `left`, `right`, `up`, `down` (all optional numbers)

### Version Handling
- Always show LRUD columns regardless of DMP version
- DMP versions without LRUD will show empty cells

### UI Requirements
- Columns should match existing table styling
- Use same number formatting as other numeric columns
- Add `data-testid` attributes for E2E testing:
  - `lrud-left-{rowIndex}`
  - `lrud-right-{rowIndex}`
  - `lrud-up-{rowIndex}`
  - `lrud-down-{rowIndex}`

## Acceptance Criteria
- [ ] LRUD columns visible in import preview table
- [ ] Correct values displayed from parsed DMP data
- [ ] Empty cells for missing/null values
- [ ] Columns have proper headers (L, R, U, D)
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Playwright tests pass
- [ ] Visual appearance matches existing columns

## Test Requirements

### Playwright Tests (e2e-playwright/)
- Test LRUD columns visible in import dialog
- Test correct values displayed for DMP with LRUD data
- Test empty cells for DMP without LRUD data
- Test column headers are correct

### Mock Updates
- Update `e2e-playwright/mocks/tauri-ipc.ts` if needed to include LRUD in mock DMP data

## Edge Cases
- DMP file with no LRUD data (all empty)
- DMP file with partial LRUD (some shots have data, others don't)
- Very large LRUD values
- Negative LRUD values (should display as-is)

## Implementation Notes
- Per-shot rows - each shot row shows its own LRUD values
- LRUD is per-shot, not per-section
