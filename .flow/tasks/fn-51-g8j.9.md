# fn-51-g8j.9 Add E2E tests for theme switching

## Description

Add Playwright E2E tests that verify theme switching works correctly: the data-theme attribute changes, CSS variables resolve to expected values, and the Settings Appearance tab functions.

**Size:** M
**Files:**
- `e2e-playwright/theme.spec.ts` (new) — NOT in `e2e-playwright/tests/` (that directory does not exist)

## Approach

- Follow existing Playwright test patterns in `e2e-playwright/*.spec.ts` (e.g. `settings-dialog.spec.ts`)
- Use mocked IPC (no Rust backend needed) — mock config must include `appearance: { theme: 'dark' }` (added in task 4)
- Use `data-testid` attributes for selectors
- Use `page.evaluate()` to check CSS variables and dataset attributes

### Test cases

1. **Default theme is dark**: On app load, `document.documentElement.dataset.theme` should be `'dark'`
2. **CSS variables resolve correctly in dark theme**: Verify `--cc-background` returns the dark value
3. **Theme can be changed via Settings**: Open Settings → Appearance tab → select Light → save → verify `data-theme="light"`
4. **Light theme CSS variables resolve**: After switching, verify `--cc-background` returns light value
5. **Theme persists across dialog close**: After saving Light, close and reopen Settings — Light still selected

## Key context

- E2E tests live directly in `e2e-playwright/` (NOT in a `tests/` subdirectory)
- Mock IPC handler for `get_config` is in `e2e-playwright/mocks/tauri-ipc.ts`
- Mock must include `appearance` field (added in task 4)

## Acceptance

- [ ] Test file exists at `e2e-playwright/theme.spec.ts`
- [ ] Tests verify default dark theme on load
- [ ] Tests verify theme switching via Settings UI
- [ ] Tests verify CSS variables change with theme
- [ ] Tests follow existing Playwright patterns (mocked IPC, `data-testid` selectors)
- [ ] `pnpm test:ui` passes with new tests included

## Done summary
Added 5 Playwright E2E tests for theme switching at e2e-playwright/theme.spec.ts: verifying default dark theme on load, CSS variable resolution in both themes, theme switching via Settings Appearance tab, and theme persistence across dialog close/reopen.
## Evidence
- Commits: a9dfb16, a21f941
- Tests: pnpm exec playwright test e2e-playwright/theme.spec.ts (5 passed), pnpm tsc --noEmit (passed)
- PRs: