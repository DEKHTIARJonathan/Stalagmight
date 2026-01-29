# fn-48-oen.6 Update E2E tests for hash tracking

## Description
Update E2E tests and mocks to reflect the new hash-based duplicate detection system.

**Update mocks** (`e2e-playwright/mocks/tauri-ipc.ts`):
- Make `check_duplicate_import` return value configurable via global flag or mock state
- Default: return false (no duplicate)

**Update existing tests** (`e2e-playwright/dmp-import.spec.ts`):
- Test 6.5: Change from expecting duplicate-import-dialog to expecting dmp-selection-dialog with duplicate-hash-warning banner (set mock to return true)
- Test 6.7: Same — expect inline banner, remove confirm-duplicate-import-button references

**Add new test cases**:
- duplicate-hash-warning banner NOT visible on first import (mock returns false)
- duplicate-hash-warning banner IS visible when mock returns true
- track_imported_file IPC call made after successful import
- track_imported_file NOT called when import has errors

## Acceptance
- [ ] Mock supports configurable check_duplicate_import return value
- [ ] Tests 6.5 and 6.7 updated to use inline banner instead of separate dialog
- [ ] New test: banner not visible on first import
- [ ] New test: banner visible when check returns true
- [ ] New test: track_imported_file called after success
- [ ] New test: track_imported_file not called on error
- [ ] All E2E tests pass: `pnpm test:ui`

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
