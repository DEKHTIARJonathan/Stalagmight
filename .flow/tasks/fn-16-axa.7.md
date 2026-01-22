# fn-16-axa.7 Add E2E Playwright tests for Settings dialog

## Description
Create comprehensive E2E tests for the new Settings dialog sidebar layout, including navigation, keyboard accessibility, dirty state, and Reset to Defaults.

**Size:** M
**Depends on:** fn-16-axa.5 (SettingsDialog refactor), fn-16-axa.6 (Keyboard shortcut)
**Files:**
- `e2e-playwright/settings-dialog.spec.ts` - New test file
- `e2e-playwright/settings-shortcuts.spec.ts` - Update existing tests if needed

## Approach

1. Follow existing Playwright patterns in `e2e-playwright/`
2. Use setupTauriMocks() pattern from `settings-shortcuts.spec.ts`
3. Test categories:
   - Sidebar navigation (click to switch categories)
   - Keyboard navigation (Arrow Up/Down, Home/End, Enter)
   - Cmd/Ctrl+, shortcut opens dialog
   - Dirty state (Save button enabled/disabled)
   - Unsaved changes preserved when switching categories
   - Unsaved changes confirmation on close
   - Reset to Defaults with confirmation
   - Error indicators on categories
   - Escape closes dialog
4. Use data-testid selectors for reliable element targeting

## Key Context

- Existing Playwright tests at `e2e-playwright/`
- settings-shortcuts.spec.ts has patterns for Settings dialog testing
- Use `data-testid` attributes for selectors
- Test convention: `closest('[data-testid]')` to find containers

## Acceptance
- [ ] Test: Cmd/Ctrl+, keyboard shortcut opens Settings
- [ ] Test: clicking sidebar category switches content panel
- [ ] Test: Arrow Up/Down navigates sidebar categories
- [ ] Test: Home/End jump to first/last category
- [ ] Test: Save button disabled when no changes made
- [ ] Test: Save button enabled after changing a setting
- [ ] Test: unsaved changes preserved when switching categories
- [ ] Test: closing with unsaved changes shows confirmation
- [ ] Test: Reset to Defaults shows confirmation
- [ ] Test: Reset to Defaults resets current category only
- [ ] Test: Escape closes Settings dialog
- [ ] Test: error indicator appears on category with validation error
- [ ] All tests use data-testid selectors
- [ ] pnpm test:ui passes
