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
TBD

## Evidence
- Commits:
- Tests:
- PRs:
