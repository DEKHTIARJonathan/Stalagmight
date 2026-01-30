# fn-48-oen.6 Update E2E tests for hash tracking

## Description
Update E2E tests and mocks to reflect the new hash-based duplicate detection system.

**Update mocks** (`e2e-playwright/mocks/tauri-ipc.ts`):
- Make `check_duplicate_import` return value configurable via global flag or mock state
- Default: return false (no duplicate)

<!-- Updated by plan-sync: fn-48-oen.5 already updated Tests 6.5 and 6.7 -->
**Note:** Tests 6.5 and 6.7 were already updated in fn-48-oen.5 to remove `duplicate-import-dialog` and `confirm-duplicate-import-button` references. Test 6.5 ("should close dialog on Cancel without importing") now expects `dmp-selection-dialog` on re-open. Test 6.7 ("should allow re-importing same file without session-based duplicate warning") already expects `dmp-selection-dialog` without any session-based duplicate dialog. No further modifications to these tests are needed.

**Add new test cases**:
- duplicate-hash-warning banner NOT visible on first import (mock returns false)
- duplicate-hash-warning banner IS visible when mock returns true
- track_imported_file IPC call made after successful import
- track_imported_file NOT called when import has errors

## Acceptance
- [ ] Mock supports configurable check_duplicate_import return value
- [ ] ~Tests 6.5 and 6.7 updated to use inline banner instead of separate dialog~ (already done in fn-48-oen.5)
- [ ] New test: banner not visible on first import
- [ ] New test: banner visible when check returns true
- [ ] New test: track_imported_file called after success
- [ ] New test: track_imported_file not called on error
- [ ] All E2E tests pass: `pnpm test:ui`

## Done summary
Updated E2E mocks and tests for hash-based duplicate import detection. Made check_duplicate_import mock return value configurable, added call tracking for track_imported_file, and added four new test cases verifying banner visibility and hash tracking behavior. Fixed create_section mock to return section_id in CommandResult format.
## Evidence
- Commits: d3477f6, a76af35
- Tests: pnpm test:ui --grep 'Hash Tracking', pnpm test:ui --grep 'DMP Import Dialog', pnpm test:ui, pnpm tsc --noEmit
- PRs: