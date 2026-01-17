# fn-39-h9j.1 Implement 6 DMP import dialog tests

## Description
Created `e2e-playwright/dmp-import.spec.ts` with 6 comprehensive Playwright E2E tests for the DMP Import Dialog:

1. **Test 6.1**: `should parse and display DMP file data in import dialog` - Verifies dialog displays parsed DMP data including section names, shots, LRUD values, and ARIA attributes
2. **Test 6.2**: `should show validation warnings for problematic shots` - Verifies validation summary, error/warning counts, validation icons with tooltips, and import button disabled on errors
3. **Test 6.3**: `should allow editing shot values before import` - Verifies section direction dropdown can be modified and changes persist
4. **Test 6.4**: `should handle multi-section DMP files` - Verifies multiple sections displayed, expandable, selectable with checkboxes, and statistics update based on selection
5. **Test 6.5**: `should close dialog on Cancel without importing` - Verifies Cancel closes dialog without changes and state resets
6. **Test 6.6**: `should display statistics footer during import preview` - Verifies live statistics (shot count, total length, depth range) update based on selection

## Acceptance
- [x] All 6 tests implemented
- [x] Mocks already handle `parse_dmp` in tauri-ipc.ts
- [x] Tests pass in headless mode (pnpm test:ui --grep "DMP Import")
- [x] Tests use proper data-testid selectors
- [x] Dialog has correct ARIA attributes (role="dialog", aria-modal="true")

## Done summary
## Task Summary

Created `e2e-playwright/dmp-import.spec.ts` with 6 comprehensive Playwright E2E tests for the DMP Import Dialog:

1. **Test 6.1**: `should parse and display DMP file data in import dialog` - Verifies dialog displays parsed DMP data including section names, shots, LRUD values, and ARIA attributes
2. **Test 6.2**: `should show validation warnings for problematic shots` - Verifies validation summary, error/warning counts, validation icons with tooltips, and import button disabled on errors
3. **Test 6.3**: `should allow editing shot values before import` - Verifies section direction dropdown can be modified and changes persist
4. **Test 6.4**: `should handle multi-section DMP files` - Verifies multiple sections displayed, expandable, selectable with checkboxes, and statistics update based on selection
5. **Test 6.5**: `should close dialog on Cancel without importing` - Verifies Cancel closes dialog without changes and state resets
6. **Test 6.6**: `should display statistics footer during import preview` - Verifies live statistics (shot count, total length, depth range) update based on selection

All tests use proper data-testid selectors and verify correct ARIA attributes.
## Evidence
- Commits:
- Tests: added, command, passed, count
- PRs: