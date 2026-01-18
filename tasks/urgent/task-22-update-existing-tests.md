# Task 22: Update Existing Tests for New Import Flow

## Description

Update all existing Playwright and WebdriverIO tests that reference the old DmpImportDialog to work with the new two-step import flow.

## Files to Modify

- `e2e-playwright/import-dialog.spec.ts`
- `e2e-playwright/mocks/tauri-ipc.ts`
- `e2e/specs/import.spec.ts` (if exists)
- Any other test files referencing DMP import

## Implementation

### 1. Update IPC Mocks

```tsx
// In e2e-playwright/mocks/tauri-ipc.ts

// Add new mock handlers for import flow
case 'calculate_file_hash':
  return 'mock-hash-123';

case 'check_duplicate_import':
  return false;

case 'track_imported_file':
  return null;

// Existing handlers may need updates
case 'import_dmp':
  // Return enhanced DMP data with all fields
  return {
    version: 5,
    sections: [
      {
        name: 'ABC',
        date: '2024-01-10',
        direction: 'in',
        shots: [
          {
            shot_type: 'Standard',
            length: 3.2,
            heading_in: 45.0,
            heading_out: 225.0,
            depth_in: 5.1,
            depth_out: 5.8,
            pitch_in: 0,
            pitch_out: 0,
            left: 1.2,
            right: 0.8,
            up: 2.1,
            down: 1.5,
            comment: 'Test shot',
          },
          // ... more shots
        ],
      },
    ],
  };
```

### 2. Update Import Dialog Tests

```tsx
// In e2e-playwright/import-dialog.spec.ts

test.describe('DMP Import - Step 1', () => {
  test('should display DMP metadata in header', async ({ page }) => {
    // Trigger import flow
    await page.keyboard.press('Control+i');

    // Wait for Step 1 dialog
    await page.locator('[data-testid="dmp-selection-dialog"]').waitFor();

    // Verify metadata
    await expect(page.locator('[data-testid="dmp-version"]')).toContainText('5');
    await expect(page.locator('[data-testid="dmp-section-count"]')).toContainText('3');
  });

  test('should allow selecting sections', async ({ page }) => {
    // ... test section selection
  });

  test('should disable Continue when no sections selected', async ({ page }) => {
    // ... test button state
  });
});

test.describe('DMP Import - Step 2', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to Step 2
    await page.keyboard.press('Control+i');
    await page.locator('[data-testid="dmp-selection-dialog"]').waitFor();
    await page.click('[data-testid="continue-button"]');
    await page.locator('[data-testid="dmp-section-config-dialog"]').waitFor();
  });

  test('should display section parameters', async ({ page }) => {
    // ... test parameters panel
  });

  test('should allow placement selection', async ({ page }) => {
    // ... test placement options
  });

  test('should navigate between sections', async ({ page }) => {
    // ... test navigation
  });
});
```

### 3. Update WebdriverIO Tests

```ts
// In e2e/specs/import.spec.ts

describe('DMP Import Two-Step Flow', () => {
  it('should complete full import flow', async () => {
    // Open import dialog
    await browser.keys(['Control', 'i']);

    // Step 1: Select sections
    const step1Dialog = await $('[data-testid="dmp-selection-dialog"]');
    await step1Dialog.waitForDisplayed();

    // Select first section
    await $('[data-testid="section-checkbox-0"]').click();

    // Continue to Step 2
    await $('[data-testid="continue-button"]').click();

    // Step 2: Configure and place
    const step2Dialog = await $('[data-testid="dmp-section-config-dialog"]');
    await step2Dialog.waitForDisplayed();

    // Click Place button
    await $('[data-testid="place-origin-button"]').click();

    // Import
    await $('[data-testid="import-button"]').click();

    // Verify section created
    await expect($('[data-testid="section-panel"]')).toBeDisplayed();
  });
});
```

### 4. Add New Test Cases

Add tests for new functionality:
- Two-step flow navigation
- Placement modes
- Section editing in Step 2
- Undo/redo in dialog
- Error blocking
- Merge preview

### 5. Remove Obsolete Tests

Remove tests that specifically test old single-dialog behavior that no longer applies.

## Acceptance Criteria

- [ ] IPC mocks updated for new commands
- [ ] Playwright tests updated for two-step flow
- [ ] WebdriverIO tests updated for two-step flow
- [ ] New test cases added for new functionality
- [ ] Obsolete tests removed
- [ ] All tests pass with new dialog flow
- [ ] Test coverage maintained or improved

## Existing Tests to Modify

This task is specifically about updating all existing tests. Here is the comprehensive list:

### Playwright Tests (Priority Order)
1. **`e2e-playwright/import-dialog.spec.ts`** (~1937 lines) - **Highest priority**
   - Replace all `[data-testid="import-dmp-dialog"]` with `[data-testid="dmp-selection-dialog"]` (Step 1) or `[data-testid="dmp-section-config-dialog"]` (Step 2)
   - Update shot table tests for new column layout (Azimuth as average, Warnings column)
   - Add navigation between Step 1 and Step 2
   - Update placement tests for new 4-mode panel
   - Update validation/warning tests

2. **`e2e-playwright/dmp-import.spec.ts`** (~395 lines)
   - Update import flow tests for two-step process
   - Add tests for Step 1 → Step 2 navigation

3. **`e2e-playwright/section-shot-editing.spec.ts`** (~346 lines)
   - Update for shared ShotTableEditor component
   - Update for shared SectionMetadataForm component

4. **`e2e-playwright/mocks/tauri-ipc.ts`**
   - Add: `calculate_file_hash`, `check_duplicate_import`, `track_imported_file`
   - Add: `createSection` (if not present with return ID)
   - Ensure shot data uses `azimuth_in`, `azimuth_out`, `depth_in`, `depth_out` (per commit 5b7aa96)

### WebdriverIO Tests
1. **`e2e/specs/import-dmp-dialog.spec.ts`** - Update for two-step flow
2. **`e2e/specs/import-section-dialog.spec.ts`** - Update for shared components
3. **`e2e/specs/keyboard-shortcuts.spec.ts`** - Update Ctrl+I behavior

## Test Suggestions

### Playwright Tests to Update/Add
1. Test Step 1 dialog opens on Ctrl+I
2. Test Step 1 metadata display
3. Test Step 1 section selection
4. Test Step 1 bulk selection
5. Test Step 1 Continue button state
6. Test Step 2 navigation
7. Test Step 2 section parameters
8. Test Step 2 shot table editing
9. Test Step 2 placement modes
10. Test Step 2 Import button state

### WebdriverIO Tests to Update/Add
1. Test complete import flow end-to-end
2. Test Place at 0,0 flow
3. Test Zero Datum flow
4. Test From Existing flow
5. Test Manual Placement flow
6. Test Cancel at Step 1
7. Test Cancel at Step 2
8. Test Back from Step 2
9. Test editing placed section
10. Test drag-drop DMP file

## Done Summary
(To be filled when complete)

## Evidence
- Commits:
- Tests:
- PRs:
