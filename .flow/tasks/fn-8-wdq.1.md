# fn-8-wdq.1 Add validation logic and warning display

## Description
## Overview
Add validation warnings to shot preview with error/warning severity.

## Implementation
1. Create validation.ts with rules
2. Add warning icon column
3. Add cell highlighting
4. Add tooltips
5. Add summary + proceed checkbox

## Files
- src/components/Dialogs/DmpImportDialog.tsx
- src/utils/validation.ts (new)
- e2e-playwright/import-dialog.spec.ts
## Acceptance
- [ ] Validation rules from config
- [ ] Warning/error icons
- [ ] Cell highlighting
- [ ] Tooltips
- [ ] Summary count
- [ ] Proceed checkbox
- [ ] Errors block import
- [ ] Tests pass
## Done summary
## Summary

Added inline validation warnings to the DMP Import Dialog that check shot data against configurable thresholds.

### Implementation

1. **Created validation.ts utility** (`src/utils/validation.ts`):
   - `validateShot()` - validates a single shot against config thresholds
   - `validateSection()` - validates all shots in a section, detects duplicates
   - `countIssues()` - counts errors and warnings across sections
   - `getHighestSeverity()` - determines if issues are errors or warnings

2. **Updated DmpImportDialog.tsx**:
   - Added validation icon column in shot preview table (warning/error badges)
   - Cell highlighting for fields with issues (yellow background)
   - Tooltips on validation icons showing issue messages
   - Validation summary panel showing error/warning counts
   - "Acknowledge warnings" checkbox for bypassing warnings
   - Import button disabled when errors present or warnings not acknowledged

3. **Added Validation Test Section in mock data**:
   - Shot with length exceeding max (warning)
   - Shot with invalid azimuth >360 (error)
   - Shot with excessive depth change (warning)
   - Shot with LRUD exceeding max (warning)

### Validation Rules
- Shot length below minimum or above maximum (warning)
- Azimuth out of [0, 360] range (error)
- Azimuth deviation between in/out readings (warning)
- Depth change per shot exceeds threshold (warning)
- LRUD dimensions exceed 50m (warning)
- Missing required length field (error)
- Duplicate marker indices in section (warning)

### Test Coverage
Added 9 new Playwright E2E tests covering:
- Validation summary visibility and counts
- Validation icons with correct severity
- Tooltips with validation messages
- Errors blocking import
- Acknowledge checkbox workflow
- Cell highlighting for LRUD issues
- Selection changes updating validation
## Evidence
- Commits:
- Tests:
- PRs: