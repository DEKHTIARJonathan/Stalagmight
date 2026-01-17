# Add LRUD columns to DMP Import Dialog

## Overview

Display Left/Right/Up/Down (LRUD) passage dimension values in the DMP Import Dialog preview table. LRUD data is already parsed by the backend but not displayed to users. This enables cave divers to see passage dimensions before importing survey data.

## Scope

- Add expandable shot-level view within section rows
- Display L, R, U, D columns for each shot
- Show "-" for zero/null LRUD values (indicates "not measured")
- Add data-testid attributes for E2E testing
- Update Playwright mocks and add tests

### Out of Scope
- Editing LRUD values in preview (v2)
- Color coding for outlier values
- LRUD summary statistics per section

## Approach

1. Make section rows in DmpImportDialog expandable to show shot-level data
2. Add L, R, U, D columns (4 separate columns, right-aligned)
3. Use existing display pattern: `value?.toFixed(1) ?? '-'`
4. Add data-testid attributes per spec: `lrud-left-{rowIndex}`, etc.
5. Update mock data in tauri-ipc.ts to include LRUD fields
6. Write Playwright tests for LRUD display

### Key Files
- `src/components/Dialogs/DmpImportDialog.tsx:279-314` - Section table to modify
- `src/types/commands.ts:38-56` - DmpShot type (has L/R/U/D as numbers)
- `src/components/SingleSystemView/DetailPanel.tsx:346-356` - LRUD display pattern
- `e2e-playwright/mocks/tauri-ipc.ts:347-361` - Mock data needs LRUD
- `e2e-playwright/import-dialog.spec.ts` - Add tests

### Reuse Points
- Use existing table styling from DmpImportDialog section table
- Use LRUD display pattern from DetailPanel: `shot.left?.toFixed(1) ?? '-'`
- Use existing Column interface pattern from Table.tsx

## Quick commands

```bash
# Type check
pnpm tsc --noEmit

# Run Playwright tests
pnpm test:ui

# Dev mode
pnpm tauri dev
```

## Acceptance

- [ ] Section rows are expandable to show shot-level data
- [ ] L, R, U, D columns visible for each shot
- [ ] Correct values displayed from parsed DMP data
- [ ] "-" shown for zero/null LRUD values
- [ ] data-testid attributes present: `lrud-left-{index}`, `lrud-right-{index}`, etc.
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Playwright tests pass for LRUD display
- [ ] Mock data updated in tauri-ipc.ts

## References

- Task spec: `./tasks/task-01-lrud-columns.md`
- Existing LRUD pattern: `src/components/SingleSystemView/DetailPanel.tsx:346-356`
- DmpShot type: `src/types/commands.ts:38-56`
