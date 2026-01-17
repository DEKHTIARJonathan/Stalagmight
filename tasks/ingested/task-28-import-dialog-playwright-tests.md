# Task 28: Add Playwright tests for Import Dialog enhancements

## Overview
Add comprehensive Playwright E2E tests for the Import Dialog enhancements from Phase 1 (Tasks 1-6).

## Priority
High - Phase 7 (Testing & Quality)

## Risk Level
Low

## Dependencies
- Tasks 1-6 implemented

## Files to Modify
- `e2e-playwright/import-dialog.spec.ts` - Add new tests
- `e2e-playwright/mocks/tauri-ipc.ts` - Update mocks with test data

## Specifications

### Test Approach
- Both mocked (Playwright) and real (WebdriverIO) tests
- UI testing + mock IPC verification
- Full visual coverage

### Test Scope
- LRUD columns (Task 1)
- Pitch column (Task 2)
- Comment column (Task 3)
- Statistics footer (Task 4)
- Validation warnings (Task 5)
- Section preview (Task 6)

### Import Test Scope
- UI interaction tests
- Full parsing tests with real DMP fixtures

### Test Structure
```typescript
test.describe('Import Dialog Enhancements', () => {
  test.describe('LRUD Columns', () => {
    test('displays LRUD columns in table', async ({ page }) => {});
    test('shows correct LRUD values', async ({ page }) => {});
    test('shows empty cells for missing LRUD', async ({ page }) => {});
  });

  test.describe('Statistics Footer', () => {
    test('shows total length', async ({ page }) => {});
    test('updates on section selection', async ({ page }) => {});
  });

  // ... more test suites
});
```

### Visual Tests
- Full visual coverage
- Screenshot comparisons where appropriate
- Visual regression testing

## Acceptance Criteria
- [ ] LRUD column tests pass
- [ ] Pitch column tests pass
- [ ] Comment column tests pass
- [ ] Statistics footer tests pass
- [ ] Validation warning tests pass
- [ ] Section preview tests pass
- [ ] Mocks updated with test data
- [ ] Visual tests included
- [ ] Tests run in CI

## Test Requirements

### Specific Tests to Write

#### LRUD (Task 1)
- `test('LRUD columns visible')`
- `test('LRUD shows correct values')`
- `test('LRUD empty for missing data')`

#### Pitch (Task 2)
- `test('Pitch column visible')`
- `test('Pitch shows average value')`

#### Comment (Task 3)
- `test('Comment column visible')`
- `test('Comment expands on click')`
- `test('Long comments truncated')`

#### Statistics (Task 4)
- `test('Statistics footer visible')`
- `test('Total length calculated correctly')`
- `test('Shot count accurate')`
- `test('Updates on selection change')`

#### Validation (Task 5)
- `test('Warning icons on invalid data')`
- `test('Error icons block import')`
- `test('Proceed checkbox allows warnings')`

#### Preview (Task 6)
- `test('Section preview visible')`
- `test('Preview updates on selection')`
- `test('Preview shows stations and shots')`

## Edge Cases
- Empty DMP file
- DMP with all validation errors
- Very large DMP file
- DMP with special characters

## Implementation Notes
- Update mock DMP data with LRUD, pitch, comments
- Add fixtures for validation testing
- Consider test parallelization
- Low risk: testing implemented features
