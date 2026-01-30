# fn-51-g8j.9 Add E2E tests for theme switching

## Description

Add Playwright E2E tests that verify theme switching works correctly: the data-theme attribute changes, CSS variables resolve to expected values, and the Settings Appearance tab functions.

## Files to create/modify

- `e2e-playwright/tests/theme.spec.ts` — New test file for theme switching

## Implementation

### Test cases

1. **Default theme is dark**: On app load, `document.documentElement.dataset.theme` should be `'dark'` (or unset, since `:root` defaults to dark)

2. **CSS variables resolve correctly in dark theme**: Check that `getComputedStyle(document.documentElement).getPropertyValue('--cc-background')` returns the dark value

3. **Theme can be changed via Settings**:
   - Open Settings dialog
   - Navigate to Appearance tab
   - Select Light theme
   - Save settings
   - Verify `data-theme="light"` is set on root

4. **Light theme CSS variables resolve**: After switching to light, verify `--cc-background` returns the light value

5. **Theme persists across dialog close**: After saving Light theme, close and reopen Settings — Light should still be selected

### Test patterns

Follow existing Playwright test patterns in the codebase:
- Use mocked IPC (no Rust backend needed)
- Use `data-testid` attributes for selectors
- Use `page.evaluate()` to check CSS variables and dataset attributes

### Mock setup

The test needs to mock `get_config` to return a config with `appearance.theme` field, and mock `update_config` to capture the saved config.

## Acceptance

- [ ] Test file exists at `e2e-playwright/tests/theme.spec.ts`
- [ ] Tests verify default dark theme on load
- [ ] Tests verify theme switching via Settings UI
- [ ] Tests verify CSS variables change with theme
- [ ] Tests follow existing Playwright patterns (mocked IPC)
- [ ] `pnpm test:ui` passes with new tests included
