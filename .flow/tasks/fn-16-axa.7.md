# fn-16-axa.7 Add E2E Playwright tests for Settings dialog
<!-- Updated by plan-sync: fn-16-axa.4 documented actual test ID patterns for sidebar/panels/errors -->

## Description
Create comprehensive E2E tests for the new Settings dialog sidebar layout AND update existing settings-shortcuts.spec.ts to work with the new layout.

**Size:** M
**Depends on:** fn-16-axa.5 (SettingsDialog refactor), fn-16-axa.6 (Keyboard shortcut)
**Files:**
- `e2e-playwright/settings-dialog.spec.ts` - New test file
- `e2e-playwright/settings-shortcuts.spec.ts` - **REQUIRED UPDATE** - existing tests will break with new layout

## Approach

1. Follow existing Playwright patterns in `e2e-playwright/`
2. Use setupTauriMocks() pattern from `settings-shortcuts.spec.ts`
3. **Update existing settings-shortcuts.spec.ts** (REQUIRED - will break otherwise):
   - Update testids from `settings-tab-shortcuts` to new sidebar item testids
   - Update navigation helpers to use sidebar click instead of tab click
   - Preserve Shortcuts-specific test cases (recording, conflicts, save/cancel)
4. **New settings-dialog.spec.ts tests**:
   - Sidebar navigation (click to switch categories)
   - Keyboard navigation (Arrow Up/Down, Home/End, Enter for manual activation)
   - Cmd/Ctrl+, shortcut opens dialog (test in input field too)
   - Dirty state (Save button enabled/disabled)
   - Unsaved changes preserved when switching categories
   - Custom unsaved changes confirmation on close (Save/Discard/Cancel)
   - Backdrop click does NOT close dialog
   - Reset to Defaults with confirmation
   - Error indicators (red dots) on categories
   - Escape closes dialog
5. Use `data-testid` selectors for reliable element targeting
6. **Test ID patterns** (already implemented by fn-16-axa.3 and fn-16-axa.4):
   - Sidebar: `settings-sidebar` (tablist container)
   - Sidebar items: `settings-sidebar-${category}` (e.g., `settings-sidebar-general`, `settings-sidebar-cache`)
   - Sidebar error dots: `settings-sidebar-error-${category}` (e.g., `settings-sidebar-error-general`)
   - Content panels: `settings-panel-${category}` (e.g., `settings-panel-general`)
   - Individual settings: `setting-${name}` (e.g., `setting-auto-save`)
   - Inputs: `input-${name}`, `toggle-${name}`, `select-${name}`
<!-- Updated by plan-sync: fn-16-axa.5 added custom dialog test IDs -->
7. **Custom dialog test IDs** (implemented by fn-16-axa.5):
   - Unsaved changes dialog: `unsaved-changes-dialog`
   - Unsaved dialog buttons: `unsaved-cancel`, `unsaved-discard`, `unsaved-save`
   - Reset confirmation dialog: `reset-confirm-dialog`
   - Reset dialog buttons: `reset-cancel`, `reset-confirm`
   - Reset to Defaults button: `reset-category-defaults`
   - Settings Save/Cancel: `settings-save-button`, `settings-cancel-button`

## Key Context

- Existing Playwright tests at `e2e-playwright/`
- **settings-shortcuts.spec.ts WILL BREAK** - depends on tab testids like `settings-tab-shortcuts` that won't exist
- Use `data-testid` attributes for selectors
- Test convention: `closest('[data-testid]')` to find containers
- **Navigate to Shortcuts category**: `page.click('[data-testid="settings-sidebar-shortcuts"]')`
- **Error indicator visible**: `page.locator('[data-testid="settings-sidebar-error-general"]').isVisible()`
<!-- Updated by plan-sync: fn-16-axa.5 implemented custom Escape handling for overlays -->
- **Escape key behavior**: When unsaved/reset dialogs are open, Escape closes overlay first (not main dialog)

## Acceptance
- [ ] **Update existing settings-shortcuts.spec.ts** for new sidebar layout
- [ ] Test: Cmd/Ctrl+, keyboard shortcut opens Settings
- [ ] Test: Cmd/Ctrl+, works even when focused in input field
- [ ] Test: clicking sidebar category switches content panel
- [ ] Test: Arrow Up/Down navigates sidebar categories (moves focus)
- [ ] Test: Enter activates focused category
- [ ] Test: Home/End jump to first/last category
- [ ] Test: Save button disabled when no changes made
- [ ] Test: Save button enabled after changing a setting
- [ ] Test: unsaved changes preserved when switching categories
- [ ] Test: closing with unsaved changes shows Save/Discard/Cancel dialog
- [ ] Test: backdrop click does NOT close dialog
- [ ] Test: Reset to Defaults shows confirmation
- [ ] Test: Reset to Defaults resets current category only
- [ ] Test: Escape closes Settings dialog
- [ ] Test: error indicator (red dot) appears on category with validation error
- [ ] All tests use data-testid selectors
- [ ] pnpm test:ui passes
