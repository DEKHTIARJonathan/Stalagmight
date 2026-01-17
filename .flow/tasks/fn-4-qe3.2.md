# fn-4-qe3.2 Add Playwright tests for LRUD columns

## Description
## Overview

Add Playwright E2E tests for the LRUD columns feature. Update mock data to include LRUD fields.

## Implementation

### 1. Update mock data
In `e2e-playwright/mocks/tauri-ipc.ts`:
- Add `left`, `right`, `up`, `down` fields to mock shots
- Add varied test data: some with LRUD, some without
- Add section with all zero LRUD (simulates DMP v2/v3)

### 2. Write Playwright tests
In `e2e-playwright/import-dialog.spec.ts`:

```typescript
test.describe('LRUD Columns', () => {
  test('section rows are expandable', async ({ page }) => {});
  test('LRUD columns visible in shot preview', async ({ page }) => {});
  test('correct LRUD values displayed', async ({ page }) => {});
  test('zero LRUD shows as dash', async ({ page }) => {});
  test('undefined LRUD shows as dash', async ({ page }) => {});
  // Note: Per epic fn-4-qe3, both zero and undefined/null show "-" to indicate "not measured"
});
```

### 3. Test edge cases
- Section with no shots (should show empty state or stay collapsed)
- Section with mixed LRUD (some shots have data, others don't)
- Very large LRUD values
- Multiple sections expanded simultaneously

## Files to Modify
- `e2e-playwright/mocks/tauri-ipc.ts`
- `e2e-playwright/import-dialog.spec.ts`

## References
- Existing import dialog tests: `e2e-playwright/import-dialog.spec.ts`
- Mock structure: `e2e-playwright/mocks/tauri-ipc.ts:347-361`
## Acceptance
- [ ] Mock data includes LRUD fields in shots
- [ ] Mock has varied test data (with/without LRUD)
- [ ] Test: section expansion works
- [ ] Test: LRUD columns visible
- [ ] Test: correct values displayed
- [ ] Test: "-" shown for zero values
- [ ] Test: "-" shown for undefined/missing LRUD (per epic fn-4-qe3 spec)
- [ ] All Playwright tests pass (`pnpm test:ui`)
## Done summary
Added comprehensive Playwright E2E tests for LRUD columns feature, including mock data with varied LRUD scenarios (full values, all zeros, mixed, undefined) and 10 test cases covering expansion, display, and edge cases.
## Evidence
- Commits: b35405f, f8220ba, ec68a97, 490e435
- Tests: pnpm tsc --noEmit, pnpm test:ui
- PRs: