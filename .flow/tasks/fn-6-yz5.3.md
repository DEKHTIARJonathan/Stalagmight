# fn-6-yz5.3 Add E2E tests for Edit Section/Shot dialog save functionality

## Description
# Add E2E Tests for ID=0 Scenarios

## Objective

Add Playwright tests that specifically verify dialogs work with section/shot id=0 (the first section/shot).

## Test File

Create or update: `e2e-playwright/id-zero-regression.spec.ts`

## Test Cases

### Edit Section Dialog (sectionId=0)

```typescript
test('should save changes to first section (id=0)', async ({ page }) => {
  // Create new project with single section
  // Section will have id=0
  // Open Edit Section dialog
  // Change name
  // Click Save
  // Verify dialog closes
  // Verify name persisted
});
```

### Edit Shot Dialog (shotId=0)

```typescript
test('should save changes to first shot (id=0)', async ({ page }) => {
  // Create project with section
  // First shot has id=0
  // Open Edit Shot dialog
  // Change depth
  // Click Save
  // Verify dialog closes
  // Verify depth persisted
});
```

### Section Adjust Dialog (sectionId=0)

```typescript
test('should adjust position of first section (id=0)', async ({ page }) => {
  // Create project with single section (id=0)
  // Open Section Adjust dialog
  // Enter dx/dy values
  // Click Apply
  // Verify changes applied
});

test('should cancel adjustment of first section (id=0)', async ({ page }) => {
  // Create project with single section (id=0)
  // Open Section Adjust dialog
  // Apply preview
  // Click Cancel
  // Verify preview reverted
});
```

### DataTable Warnings (sectionId=0)

```typescript
test('should show warnings for first section (id=0)', async ({ page }) => {
  // Create project with section that has validation warnings
  // Select first section (id=0)
  // Verify warnings panel shows warnings
});
```

## Implementation Notes

- Use existing test infrastructure in `e2e-playwright/`
- Follow patterns from `section-shot-editing.spec.ts`
- Ensure mocks handle id=0 correctly
- May need to update mock data to include section/shot with id=0

## Reference

- Existing dialog tests: `e2e-playwright/section-shot-editing.spec.ts`
- Mock setup: `e2e-playwright/mocks/tauri-ipc.ts`
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
- [ ] Test file created: e2e-playwright/id-zero-regression.spec.ts
- [ ] Test: Edit Section with sectionId=0 saves correctly
- [ ] Test: Edit Shot with shotId=0 saves correctly
- [ ] Test: Section Adjust with sectionId=0 applies correctly
- [ ] Test: Section Adjust cancel with sectionId=0 reverts correctly
- [ ] Test: DataTable shows warnings for sectionId=0
- [ ] All new tests pass
- [ ] All existing tests still pass
## Done summary
Added E2E tests verifying all id=0 scenarios work correctly: Edit Section dialog (5 tests), Edit Shot dialog (1 test), Section Adjust apply/cancel (2 tests), and DataTable warnings (1 test). All 9 tests pass, confirming the fix in fn-6-yz5.2.
## Evidence
- Commits: 0f67cb658029ed216e720778a542268b51e8f28c, 58b6709150e60785b0770d960b83c484d03b8aba
- Tests: pnpm test:ui --project=chromium (308 passed), cargo test --manifest-path src-tauri/Cargo.toml (80 passed)
- PRs:
