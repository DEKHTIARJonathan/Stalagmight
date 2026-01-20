# fn-6-yz5.3 Add E2E tests for Edit Section/Shot dialog save functionality

## Description
# Add E2E Tests for Edit Section/Shot Dialog Save Functionality

## Objective
Add Playwright E2E tests that verify the Save button works correctly in both Edit Section and Edit Shot dialogs.

## Test Cases

### Edit Section Dialog
1. Open dialog, change name, save → name persisted
2. Open dialog, change date, save → date persisted
3. Open dialog, change color, save → color persisted
4. Open dialog, change direction, save → direction persisted
5. Save with no changes → dialog closes without error
6. Save shows loading state while saving

### Edit Shot Dialog
1. Open dialog, change depth_in, save → depth persisted
2. Open dialog, change depth_out, save → depth persisted
3. Open dialog, change azimuth, save → azimuth persisted
4. Open dialog, change length, save → length persisted
5. Open dialog, change comment, save → comment persisted

### Error Handling
1. Backend error during save → error displayed, dialog stays open
2. Validation error → error displayed, dialog stays open

## Implementation Notes
- Use existing test infrastructure in e2e-playwright/
- Follow patterns from existing dialog tests
- Ensure mocks handle save operations correctly

## Verification
- All new tests pass
- Existing tests still pass
## Acceptance
- [ ] TBD

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
