# Task 30: Add Playwright tests for GPS/placement features

## Overview
Add comprehensive Playwright E2E tests for the GPS and placement features from Phase 3 (Tasks 10-14).

## Priority
High - Phase 7 (Testing & Quality)

## Risk Level
High (due to GPS format testing complexity)

## Dependencies
- Tasks 10-14 implemented

## Files to Modify
- `e2e-playwright/gps-placement.spec.ts` - New test file
- `e2e-playwright/mocks/tauri-ipc.ts` - Update for GPS commands

## Specifications

### Test Approach
- All GPS formats must be tested
- Mocked and real tests where possible
- Interaction tests for placement mode

### Test Scope
- GPS input (Task 10) - ALL formats
- From Existing Station (Task 11)
- Manual placement mode (Task 12)
- Section adjustment dialog (Task 13)

### GPS Format Tests
- DD (Decimal Degrees)
- DMS (Degrees Minutes Seconds)
- DDM (Degrees Decimal Minutes)
- UTM
- MGRS
- Plus Codes (mocked API)
- What3words (mocked API)

### Test Structure
```typescript
test.describe('GPS and Placement', () => {
  test.describe('GPS Input', () => {
    test('parses DD format', async ({ page }) => {});
    test('parses DMS format', async ({ page }) => {});
    test('parses UTM format', async ({ page }) => {});
    // ... all formats
  });

  test.describe('Existing Station', () => {
    test('shows station dropdown', async ({ page }) => {});
    test('connects sections on import', async ({ page }) => {});
  });

  test.describe('Manual Placement', () => {
    test('section follows cursor', async ({ page }) => {});
    test('click places section', async ({ page }) => {});
    test('escape cancels', async ({ page }) => {});
  });

  test.describe('Adjustment Dialog', () => {
    test('opens from context menu', async ({ page }) => {});
    test('applies offset changes', async ({ page }) => {});
  });
});
```

## Acceptance Criteria
- [ ] All GPS format tests pass
- [ ] Existing station tests pass
- [ ] Manual placement tests pass
- [ ] Adjustment dialog tests pass
- [ ] Mock APIs for Plus Codes/What3words
- [ ] Tests run in CI

## Test Requirements

### Specific Tests to Write

#### GPS Input (Task 10)
- `test('parses DD format: 40.7128, -74.0060')`
- `test('parses DMS format: 40°42\'46"N')`
- `test('parses DDM format: 40°42.767\'N')`
- `test('parses UTM format: 18T 583960 4507523')`
- `test('parses MGRS format: 18TWL8396007523')`
- `test('parses Plus Codes: 87G8Q2JQ+V8')`
- `test('parses What3words: ///filled.count.soap')`
- `test('validates coordinate range')`
- `test('extracts coords from URL')`

#### Existing Station (Task 11)
- `test('station dropdown populated')`
- `test('preview shows connection')`
- `test('import creates merge')`
- `test('disabled without project')`

#### Manual Placement (Task 12)
- `test('placement mode activates')`
- `test('section follows mouse')`
- `test('click confirms placement')`
- `test('escape cancels')`
- `test('right-click cancels')`
- `test('snaps to stations')`

#### Adjustment Dialog (Task 13)
- `test('context menu opens dialog')`
- `test('dx/dy inputs work')`
- `test('changes apply live')`
- `test('cancel reverts changes')`
- `test('undo reverts adjustment')`

## Edge Cases
- Invalid GPS format
- GPS near poles/date line
- Place on empty map
- Rapid mouse movement in placement
- API offline for Plus Codes

## Implementation Notes
- High risk due to GPS format complexity
- Mock external APIs thoroughly
- Test GPS parsing utilities separately
- Consider E2E vs unit test split for GPS
