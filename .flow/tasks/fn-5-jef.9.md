# fn-5-jef.9 Add Playwright and WebdriverIO tests for depth gradient

## Description
Add Playwright E2E tests for depth gradient functionality.

## Playwright Test File
`e2e-playwright/tests/depth-gradient.spec.ts`

### Test Cases
```typescript
import { test, expect } from '@playwright/test';

test.describe('Depth Gradient', () => {
  test.beforeEach(async ({ page }) => {
    // Setup: load project with depth data via mock
  });

  test('toggle enables depth coloring on map', async ({ page }) => {
    // Open Display menu
    await page.click('[data-testid="display-menu-button"]');
    
    // Click Depth Gradient toggle
    await page.click('[data-testid="toggle-showDepthGradient"]');
    
    // Verify toggle is checked
    await expect(page.locator('[data-testid="toggle-showDepthGradient"]'))
      .toHaveAttribute('data-checked', 'true');
  });

  test('toggle shows depth legend', async ({ page }) => {
    // Enable depth gradient
    await page.click('[data-testid="display-menu-button"]');
    await page.click('[data-testid="toggle-showDepthGradient"]');
    
    // Verify legend visible
    await expect(page.locator('[data-testid="depth-legend"]')).toBeVisible();
  });

  test('toggle hides depth legend when disabled', async ({ page }) => {
    // Enable then disable
    await page.click('[data-testid="display-menu-button"]');
    await page.click('[data-testid="toggle-showDepthGradient"]');
    await page.click('[data-testid="toggle-showDepthGradient"]');
    
    // Verify legend hidden
    await expect(page.locator('[data-testid="depth-legend"]')).not.toBeVisible();
  });

  test('legend shows correct depth range', async ({ page }) => {
    // Enable depth gradient
    await page.click('[data-testid="display-menu-button"]');
    await page.click('[data-testid="toggle-showDepthGradient"]');
    
    // Check legend labels (values depend on test fixture)
    const legend = page.locator('[data-testid="depth-legend"]');
    await expect(legend).toContainText('m');
  });

  test('depth gradient persists across page reload', async ({ page }) => {
    // Enable depth gradient
    await page.click('[data-testid="display-menu-button"]');
    await page.click('[data-testid="toggle-showDepthGradient"]');
    
    // Reload page
    await page.reload();
    
    // Verify still enabled (legend visible)
    await expect(page.locator('[data-testid="depth-legend"]')).toBeVisible();
  });
});
```

## Mock Data
Update `e2e-playwright/mocks/tauri-ipc.ts` to include `showDepthGradient: 'true'` in display settings mock.

## Test IDs to Add
- `data-testid="depth-legend"` on DepthLegend component
- `data-testid="toggle-showDepthGradient"` on DisplayMenu toggle button
## Playwright Tests
Location: `e2e-playwright/tests/depth-gradient.spec.ts`

### Test Cases
```typescript
test.describe('Depth Gradient', () => {
  test('toggle enables depth coloring on map', async ({ page }) => {
    // Load project with depth data
    // Open Display menu
    // Toggle Depth Gradient ON
    // Verify stations/shots changed color (screenshot comparison or color sampling)
  });

  test('toggle shows/hides depth legend', async ({ page }) => {
    // Toggle ON: legend visible at bottom-left
    // Toggle OFF: legend hidden
  });

  test('legend shows correct depth range', async ({ page }) => {
    // Load project with known depth range
    // Enable depth gradient
    // Check legend labels show correct min/max values
  });

  test('depth gradient persists across session', async ({ page }) => {
    // Enable depth gradient
    // Reload page
    // Verify still enabled
  });

  test('export dialog has color mode option', async ({ page }) => {
    // Open export dialog
    // Verify dropdown exists with both options
  });
});
```

## WebdriverIO Tests
Location: `e2e-wdio/specs/depth-gradient.spec.ts`

### Test Cases
- Same scenarios as Playwright for cross-browser coverage
- Focus on Chrome, Firefox, Safari compatibility

## Mock Data
May need to add mock project with depth data in `e2e-playwright/mocks/`.

## Notes
- Use visual regression if available for color verification
- Test on different project sizes (small, large)
- Verify performance doesn't degrade significantly with depth gradient on
## Acceptance
- [ ] Playwright test file at `e2e-playwright/tests/depth-gradient.spec.ts`
- [ ] Test: toggle enables depth coloring
- [ ] Test: legend shows when enabled
- [ ] Test: legend hides when disabled
- [ ] Test: legend shows depth values
- [ ] Test: setting persists on reload
- [ ] Mock data updated with showDepthGradient
- [ ] Test IDs added to components
- [ ] `pnpm test:ui` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
