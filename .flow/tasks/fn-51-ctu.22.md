# fn-51-ctu.22 Update Existing Tests

## Description
Update all existing Playwright and WebdriverIO tests for new two-step import flow.

## Files to Modify
- `e2e-playwright/import-dialog.spec.ts` (~1937 lines) - **Highest priority**
- `e2e-playwright/dmp-import.spec.ts` (~395 lines)
- `e2e-playwright/section-shot-editing.spec.ts` (~346 lines)
- `e2e-playwright/mocks/tauri-ipc.ts`
- `e2e/specs/import-dmp-dialog.spec.ts`
- `e2e/specs/import-section-dialog.spec.ts`
- `e2e/specs/keyboard-shortcuts.spec.ts`

## Key Changes
- Replace `[data-testid="import-dmp-dialog"]` with `[data-testid="dmp-selection-dialog"]` (Step 1) or `[data-testid="dmp-section-config-dialog"]` (Step 2)
- Update shot table tests for new column layout
- Add navigation between Step 1 and Step 2
- Update placement tests for new 4-mode panel
- Add mock handlers: calculate_file_hash, check_duplicate_import, track_imported_file

## References
- `tasks/urgent/task-22-update-existing-tests.md`
## Acceptance
- [ ] IPC mocks updated for new commands
- [ ] Playwright tests updated for two-step flow
- [ ] WebdriverIO tests updated for two-step flow
- [ ] New test cases added for new functionality
- [ ] Obsolete tests removed
- [ ] All tests pass with new dialog flow
- [ ] Test coverage maintained or improved
## Done summary
Updated WebdriverIO E2E tests to use the new two-step import flow. The tests now reference dmp-selection-dialog (Step 1) and dmp-section-config-dialog (Step 2) instead of the deprecated import-dmp-dialog. Added a new test for Step 1 to Step 2 navigation. Playwright tests were already updated in prior tasks - verified they pass (13/13 DMP Import tests passing).
## Evidence
- Commits: 5144f446d040e6a03fcdacd03f65926da9616739
- Tests: pnpm test:ui --grep 'DMP Import', pnpm test:ui, pnpm tsc --noEmit
- PRs: