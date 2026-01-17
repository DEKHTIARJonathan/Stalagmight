# Playwright E2E: DMP Import Dialog

## Overview
| Field | Value |
|-------|-------|
| **Epic ID** | fn-39-h9j |
| **Category** | Playwright E2E Tests |
| **Target File** | `e2e-playwright/dmp-import.spec.ts` (new file) |
| **Tests** | 6 |
| **Priority** | P1 - High |
| **Source** | `tasks/task-06-dmp-import-dialog.md` |

## Objective
Implement Playwright E2E tests for the DMP Import Dialog. These tests use mocked Tauri IPC to validate the import dialog UI, data display, editing, validation, and multi-section handling.

## Test Specifications

### Test 6.1: `should parse and display DMP file data in import dialog`
Verify the import dialog correctly displays parsed DMP data including shots, azimuths, and depths.

### Test 6.2: `should show validation warnings for problematic shots`
Verify inline validation warnings appear for shots with unusual values (short shots, backsight errors, invalid azimuths, negative LRUD).

### Test 6.3: `should allow editing shot values before import`
Verify users can modify shot data in the import dialog before confirming import.

### Test 6.4: `should handle multi-section DMP files`
Verify the import dialog handles DMP files with multiple sections.

### Test 6.5: `should close dialog on Cancel without importing`
Verify Cancel button closes dialog without making changes.

### Test 6.6: `should display statistics footer during import preview`
Verify the import dialog shows live statistics (shot count, total length, depth range, station count).

## Mock Requirements
Update `e2e-playwright/mocks/tauri-ipc.ts` to handle:
- `parse_dmp` - Return mock parsed sections
- `import_sections` - Accept sections and add to project

## Verification
```bash
pnpm test:ui --grep "DMP Import"
pnpm test:ui:headed --grep "DMP Import"
```

## Definition of Done
- [ ] All 6 tests implemented
- [ ] Mocks updated in tauri-ipc.ts
- [ ] Tests pass in headless mode
- [ ] Tests use proper data-testid selectors
- [ ] Dialog has correct ARIA attributes
