# fn-7-gba.3 Add E2E tests for Back button navigation

## Description
Add E2E tests for Back button navigation to ensure the freeze bug does not regress.

## Implementation

### 1. Playwright test (src/tests/back-button.spec.ts)

```typescript
import { test, expect } from '@playwright/test';

test.describe('Back Button Navigation', () => {
  test('should return to Global View without crashing', async ({ page }) => {
    // Open a project to get to Single System View
    // ... project opening steps

    // Click Back button
    await page.click('[data-testid="back-button"]');

    // Verify we're back at Global View
    await expect(page.locator('[data-testid="global-view"]')).toBeVisible();

    // Verify no JavaScript errors occurred
    // (Playwright captures console errors automatically)
  });

  test('should handle unsaved changes dialog', async ({ page }) => {
    // Open project, make changes
    // Click Back button
    // Verify dialog appears
    // Click "Discard Changes"
    // Verify clean return to Global View
  });
});
```

### 2. WebdriverIO test (e2e/test/specs/back-button.e2e.ts)

```typescript
describe('Back Button Navigation', () => {
  it('should return to Global View without crashing', async () => {
    // Open a project
    // Click Back button
    // Verify Global View is displayed
    // Verify app is responsive
  });

  it('should show unsaved changes dialog when dirty', async () => {
    // Open project, make changes
    // Click Back
    // Verify dialog
    // Click Discard
    // Verify clean exit
  });
});
```

### 3. Test scenarios to cover

1. Back button with clean state (no unsaved changes)
2. Back button with dirty state → Discard Changes
3. Back button with dirty state → Cancel (stay in view)
4. Back button immediately after opening project
5. Back button with grid overlay visible
6. Back button with grid overlay hidden
## Acceptance
- [ ] Playwright test file created at src/tests/back-button.spec.ts
- [ ] WebdriverIO test file created at e2e/test/specs/back-button.e2e.ts
- [ ] Test covers Back button with clean state
- [ ] Test covers Back button with dirty state + Discard
- [ ] Test verifies no JavaScript errors in console
- [ ] Test verifies app remains responsive after navigation
- [ ] `pnpm test:ui` passes
- [ ] `(cd e2e && pnpm test)` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
