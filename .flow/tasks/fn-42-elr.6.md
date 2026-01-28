# fn-42-elr.6 Update E2E tests, visual baselines, and documentation

## Description
Update E2E tests for the new shortcuts behavior, regenerate visual regression baselines, and update documentation.

**Size:** M
**Files:**
- `e2e-playwright/settings-shortcuts.spec.ts` (E2E tests)
- `docs/configuration.md` (reserved shortcuts table)
- `docs/SPEC.md` (keyboard shortcuts appendix)

## Approach

### E2E Tests
- Add test for File category with Import DMP and Export shortcuts
- Update reserved shortcuts section test (now has fewer items, positioned above search)
- Add test verifying Ctrl+I/E can be reassigned without conflict error
- Add test that customized Import DMP shortcut triggers import dialog

### Visual Baselines
- Run `pnpm test:ui --update-snapshots` for shortcuts settings tests
- Verify new row styling, alternating colors visible in snapshots

### Documentation
- `docs/configuration.md` lines 151-161: Remove Ctrl+I and Ctrl+E from reserved shortcuts table
- `docs/SPEC.md` Appendix A: Add note that Import/Export shortcuts are user-configurable (defaults: Ctrl+I, Ctrl+E)

## Key context
- Playwright test file has testid selectors: `shortcut-row-{action}`, `reserved-shortcuts`
- Use `page.keyboard.press('Control+i')` for shortcut testing
## Acceptance
- [ ] Test for File category shortcuts added
- [ ] Test for reassigning Ctrl+I/E without conflict added
- [ ] Test for Import DMP shortcut triggering import dialog
- [ ] Reserved shortcuts section test updated for new position
- [ ] Visual regression baselines regenerated
- [ ] `docs/configuration.md` reserved shortcuts table updated
- [ ] `docs/SPEC.md` keyboard shortcuts appendix updated
- [ ] All E2E tests pass: `pnpm test:ui`
## Done summary
Added E2E tests for File category shortcuts (Import DMP, Export), Ctrl+I/E reassignment, and import dialog triggering. Updated reserved shortcuts display test and position assertion. Regenerated visual baselines. Updated docs/configuration.md and docs/SPEC.md to reflect configurable Import/Export shortcuts and complete reserved shortcuts table.
## Evidence
- Commits: daf50f6, 99bc7ea, 2f4720c
- Tests: pnpm exec playwright test --grep 'shortcuts|Shortcuts' (34 passed), pnpm tsc --noEmit, cargo test --manifest-path src-tauri/Cargo.toml (80 passed)
- PRs: