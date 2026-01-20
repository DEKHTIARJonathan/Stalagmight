# fn-5-jef.9 Add Playwright and WebdriverIO tests for depth gradient

## Description
Add Playwright and WebdriverIO E2E tests for depth gradient functionality.

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
- [ ] Playwright test file created at `e2e-playwright/tests/depth-gradient.spec.ts`
- [ ] Tests: toggle behavior, legend visibility, legend values, persistence
- [ ] Tests: export dialog color mode option
- [ ] WebdriverIO test file created at `e2e-wdio/specs/depth-gradient.spec.ts`
- [ ] Cross-browser tests pass (Chrome, Firefox)
- [ ] Mock data updated if needed
- [ ] `pnpm test:ui` passes
- [ ] `pnpm test:wdio` passes (if applicable)
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
