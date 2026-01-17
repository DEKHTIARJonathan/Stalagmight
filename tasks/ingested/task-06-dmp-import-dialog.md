# Task 06: DMP Import Dialog Tests (Playwright)

## Overview
| Field | Value |
|-------|-------|
| **Task ID** | task-06 |
| **Category** | Playwright E2E Tests |
| **Target File** | `e2e-playwright/dmp-import.spec.ts` (new file) |
| **Tests** | 6 |
| **Priority** | P1 - High |
| **Dependencies** | task-01 (mock data structure) |

## Affected Files
- `e2e-playwright/dmp-import.spec.ts` - New test file
- `e2e-playwright/mocks/tauri-ipc.ts` - Add DMP parsing mocks

## Mock Requirements

Update `e2e-playwright/mocks/tauri-ipc.ts` to handle:
```typescript
case 'parse_dmp': {
  // Return mock parsed sections based on test scenario
  return mockDmpParseResult;
}

case 'import_sections': {
  // Accept sections and add to project
  return { success: true, section_ids: [1, 2] };
}
```

## Test Specifications

---

### Test 6.1: `should parse and display DMP file data in import dialog`

**Purpose:** Verify the import dialog correctly displays parsed DMP data including shots, azimuths, and depths.

**Test Code:**
```typescript
import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

test.describe('DMP Import Dialog', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('should parse and display DMP file data in import dialog', async ({ page }) => {
    // Setup mock for parse_dmp to return specific data
    await page.evaluate(() => {
      (window as any).__MOCK_DMP_RESULT__ = {
        sections: [{
          name: 'TST',
          direction: 'IN',
          date: '2024-01-15',
          surveyor: 'John Doe',
          shots: [
            {
              azimuth_in: 45.5,
              azimuth_out: 225.5,
              length: 5.23,
              depth_in: 0.0,
              depth_out: 1.52,
              left: 1.2,
              right: 0.8,
              up: 2.5,
              down: 0.3
            },
            {
              azimuth_in: 90.0,
              azimuth_out: 270.0,
              length: 3.17,
              depth_in: 1.52,
              depth_out: 2.84,
              left: 0.5,
              right: 1.1,
              up: 3.0,
              down: 0.5
            },
          ]
        }]
      };
    });

    // Create a project first (required for import)
    await createProject(page, 'Test Project');

    // Open import dialog via Ctrl+I
    await page.keyboard.press('Control+i');
    await page.waitForSelector('[data-testid="import-dmp-dialog"]', { timeout: 5000 });

    // Verify dialog is open with correct role
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();

    // Verify section name displayed
    await expect(page.locator('[data-testid="section-name"]')).toHaveText('TST');

    // Verify direction displayed
    await expect(page.locator('[data-testid="section-direction"]')).toHaveText('IN');

    // Verify shot table has correct rows
    const shotRows = page.locator('[data-testid="shot-table"] tbody tr');
    await expect(shotRows).toHaveCount(2);

    // Verify first shot data
    const firstRow = shotRows.first();
    await expect(firstRow.locator('td').nth(0)).toContainText('1'); // Shot number
    await expect(firstRow.locator('td').nth(1)).toContainText('5.23'); // Length
    await expect(firstRow.locator('td').nth(2)).toContainText('45.5'); // Azimuth in
    await expect(firstRow.locator('td').nth(3)).toContainText('225.5'); // Azimuth out
    await expect(firstRow.locator('td').nth(4)).toContainText('0.0'); // Depth in
    await expect(firstRow.locator('td').nth(5)).toContainText('1.52'); // Depth out

    // Verify second shot
    const secondRow = shotRows.nth(1);
    await expect(secondRow.locator('td').nth(1)).toContainText('3.17');
  });

  async function createProject(page: Page, name: string) {
    const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
    await newProjectBtn.click();
    await page.waitForSelector('.fixed.inset-0');
    await page.locator('.fixed.inset-0 input').first().fill(name);
    await page.click('.fixed.inset-0 button:has-text("Create")');
    await page.waitForSelector('canvas', { timeout: 10000 });
  }
});
```

**Assertions:**
- [ ] Dialog opens with Ctrl+I
- [ ] Dialog has correct ARIA role
- [ ] Section name displayed
- [ ] Direction displayed
- [ ] Shot table has correct row count
- [ ] Shot data values match mock data

---

### Test 6.2: `should show validation warnings for problematic shots`

**Purpose:** Verify inline validation warnings appear for shots with unusual values.

**Test Code:**
```typescript
test('should show validation warnings for problematic shots', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).__MOCK_DMP_RESULT__ = {
      sections: [{
        name: 'WARN',
        direction: 'OUT',
        shots: [
          {
            azimuth_in: 45.0,
            azimuth_out: 220.0, // Backsight off by 5° (should warn)
            length: 0.05, // Very short shot (should warn)
            depth_in: 0.0,
            depth_out: 0.1,
          },
          {
            azimuth_in: 400.0, // Invalid azimuth > 360 (should error)
            azimuth_out: 270.0,
            length: 5.0,
            depth_in: 0.1,
            depth_out: 1.0,
            left: -1.0, // Negative LRUD (should error)
          },
        ]
      }]
    };
  });

  await createProject(page, 'Validation Test');
  await page.keyboard.press('Control+i');
  await page.waitForSelector('[data-testid="import-dmp-dialog"]');

  // Check for warning indicators on shot rows
  const shotRows = page.locator('[data-testid="shot-table"] tbody tr');

  // First row should have warnings (short length, backsight)
  const firstRowWarnings = shotRows.first().locator('[data-testid="validation-warning"]');
  await expect(firstRowWarnings.first()).toBeVisible();

  // Hover to see warning tooltip
  await firstRowWarnings.first().hover();
  const tooltip = page.locator('[role="tooltip"], .tooltip');
  await expect(tooltip).toContainText(/short|length|backsight/i);

  // Second row should have errors (invalid azimuth, negative LRUD)
  const secondRowErrors = shotRows.nth(1).locator('[data-testid="validation-error"]');
  await expect(secondRowErrors.first()).toBeVisible();

  // Verify error count in footer
  const errorCount = page.locator('[data-testid="validation-error-count"]');
  await expect(errorCount).toContainText(/[1-9]/); // At least 1 error

  // Import button should be disabled or show warning when errors exist
  const importBtn = page.locator('button:has-text("Import")');
  // Either disabled or shows confirmation warning
  const isDisabled = await importBtn.isDisabled();
  if (!isDisabled) {
    // Click and verify warning dialog
    await importBtn.click();
    await expect(page.locator('[data-testid="import-warning-dialog"]')).toBeVisible();
  }
});
```

**Assertions:**
- [ ] Warning icons appear on problematic rows
- [ ] Tooltips show specific warning text
- [ ] Error icons appear on invalid data
- [ ] Error count displayed in footer
- [ ] Import button handles errors appropriately

---

### Test 6.3: `should allow editing shot values before import`

**Purpose:** Verify users can modify shot data in the import dialog before confirming import.

**Test Code:**
```typescript
test('should allow editing shot values before import', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).__MOCK_DMP_RESULT__ = {
      sections: [{
        name: 'EDIT',
        shots: [
          { azimuth_in: 45.0, azimuth_out: 225.0, length: 5.0, depth_in: 0.0, depth_out: 1.0 },
        ]
      }]
    };
  });

  await createProject(page, 'Edit Test');
  await page.keyboard.press('Control+i');
  await page.waitForSelector('[data-testid="import-dmp-dialog"]');

  // Click on length cell to edit
  const lengthCell = page.locator('[data-testid="shot-table"] tbody tr').first()
    .locator('[data-testid="shot-length"]');
  await lengthCell.dblclick();

  // Verify edit mode active
  const editInput = lengthCell.locator('input');
  await expect(editInput).toBeVisible();
  await expect(editInput).toHaveValue('5.0');

  // Change value
  await editInput.fill('7.5');
  await editInput.press('Enter');

  // Verify value updated
  await expect(lengthCell).toContainText('7.5');

  // Edit azimuth
  const azimuthCell = page.locator('[data-testid="shot-table"] tbody tr').first()
    .locator('[data-testid="shot-azimuth-in"]');
  await azimuthCell.dblclick();
  await azimuthCell.locator('input').fill('60.0');
  await azimuthCell.locator('input').press('Tab'); // Move to next field

  // Verify azimuth updated
  await expect(azimuthCell).toContainText('60.0');

  // Press Escape to cancel an edit
  const depthCell = page.locator('[data-testid="shot-table"] tbody tr').first()
    .locator('[data-testid="shot-depth-out"]');
  await depthCell.dblclick();
  await depthCell.locator('input').fill('999');
  await depthCell.locator('input').press('Escape');

  // Value should revert
  await expect(depthCell).toContainText('1.0');
});
```

**Assertions:**
- [ ] Double-click enables edit mode
- [ ] Input shows current value
- [ ] Enter confirms edit
- [ ] Tab moves to next field
- [ ] Escape cancels edit and reverts value
- [ ] Updated values persist in table

---

### Test 6.4: `should handle multi-section DMP files`

**Purpose:** Verify the import dialog handles DMP files with multiple sections.

**Test Code:**
```typescript
test('should handle multi-section DMP files', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).__MOCK_DMP_RESULT__ = {
      sections: [
        {
          name: 'MAIN',
          direction: 'IN',
          date: '2024-01-15',
          shots: [
            { azimuth_in: 45.0, azimuth_out: 225.0, length: 5.0, depth_in: 0.0, depth_out: 1.0 },
            { azimuth_in: 90.0, azimuth_out: 270.0, length: 3.0, depth_in: 1.0, depth_out: 2.0 },
          ]
        },
        {
          name: 'SIDE',
          direction: 'OUT',
          date: '2024-01-16',
          shots: [
            { azimuth_in: 180.0, azimuth_out: 0.0, length: 4.0, depth_in: 1.0, depth_out: 1.5 },
          ]
        },
        {
          name: 'DEEP',
          direction: 'IN',
          date: '2024-01-17',
          shots: [
            { azimuth_in: 270.0, azimuth_out: 90.0, length: 6.0, depth_in: 2.0, depth_out: 5.0 },
            { azimuth_in: 280.0, azimuth_out: 100.0, length: 4.0, depth_in: 5.0, depth_out: 8.0 },
            { azimuth_in: 260.0, azimuth_out: 80.0, length: 3.0, depth_in: 8.0, depth_out: 10.0 },
          ]
        },
      ]
    };
  });

  await createProject(page, 'Multi-Section Test');
  await page.keyboard.press('Control+i');
  await page.waitForSelector('[data-testid="import-dmp-dialog"]');

  // Verify section tabs/selector exists
  const sectionSelector = page.locator('[data-testid="section-selector"]');
  await expect(sectionSelector).toBeVisible();

  // Verify all sections listed
  const sectionOptions = sectionSelector.locator('[data-testid="section-option"]');
  await expect(sectionOptions).toHaveCount(3);
  await expect(sectionOptions.nth(0)).toContainText('MAIN');
  await expect(sectionOptions.nth(1)).toContainText('SIDE');
  await expect(sectionOptions.nth(2)).toContainText('DEEP');

  // First section shown by default
  await expect(page.locator('[data-testid="section-name"]')).toHaveText('MAIN');
  await expect(page.locator('[data-testid="shot-table"] tbody tr')).toHaveCount(2);

  // Click to select second section
  await sectionOptions.nth(1).click();
  await expect(page.locator('[data-testid="section-name"]')).toHaveText('SIDE');
  await expect(page.locator('[data-testid="shot-table"] tbody tr')).toHaveCount(1);

  // Click to select third section
  await sectionOptions.nth(2).click();
  await expect(page.locator('[data-testid="section-name"]')).toHaveText('DEEP');
  await expect(page.locator('[data-testid="shot-table"] tbody tr')).toHaveCount(3);

  // Verify statistics show totals across all sections
  const totalShotsDisplay = page.locator('[data-testid="total-shots"]');
  await expect(totalShotsDisplay).toContainText('6'); // 2 + 1 + 3

  // Verify checkbox to select which sections to import
  const sectionCheckboxes = page.locator('[data-testid="section-checkbox"]');
  await expect(sectionCheckboxes).toHaveCount(3);

  // Uncheck middle section
  await sectionCheckboxes.nth(1).uncheck();

  // Import should only include checked sections
  const importBtn = page.locator('button:has-text("Import")');
  await importBtn.click();

  // Verify import command called with only 2 sections
  // This would be verified via mock tracking
});
```

**Assertions:**
- [ ] Section selector shows all sections
- [ ] Clicking section switches displayed data
- [ ] Shot counts update per section
- [ ] Total statistics across all sections
- [ ] Checkboxes to include/exclude sections
- [ ] Import respects section selection

---

### Test 6.5: `should close dialog on Cancel without importing`

**Purpose:** Verify Cancel button closes dialog without making changes.

**Test Code:**
```typescript
test('should close dialog on Cancel without importing', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).__MOCK_DMP_RESULT__ = {
      sections: [{
        name: 'CANCEL',
        shots: [
          { azimuth_in: 45.0, azimuth_out: 225.0, length: 5.0, depth_in: 0.0, depth_out: 1.0 },
        ]
      }]
    };
  });

  await createProject(page, 'Cancel Test');

  // Get initial section count
  const initialSections = await page.evaluate(() => {
    return (window as any).__E2E_TEST__.projectStore.getState().project?.sections?.length ?? 0;
  });

  // Open import dialog
  await page.keyboard.press('Control+i');
  await page.waitForSelector('[data-testid="import-dmp-dialog"]');

  // Make some edits (shouldn't matter after cancel)
  const lengthCell = page.locator('[data-testid="shot-table"] tbody tr').first()
    .locator('[data-testid="shot-length"]');
  await lengthCell.dblclick();
  await lengthCell.locator('input').fill('99.0');
  await lengthCell.locator('input').press('Enter');

  // Click Cancel
  const cancelBtn = page.locator('button:has-text("Cancel")');
  await cancelBtn.click();

  // Dialog should close
  await expect(page.locator('[data-testid="import-dmp-dialog"]')).not.toBeVisible();

  // Project should be unchanged
  const finalSections = await page.evaluate(() => {
    return (window as any).__E2E_TEST__.projectStore.getState().project?.sections?.length ?? 0;
  });
  expect(finalSections).toBe(initialSections);

  // Re-open dialog and verify edits were not persisted
  await page.keyboard.press('Control+i');
  await page.waitForSelector('[data-testid="import-dmp-dialog"]');

  // Values should be original (5.0, not 99.0)
  await expect(lengthCell).toContainText('5.0');
});

test('should close dialog on backdrop click', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).__MOCK_DMP_RESULT__ = {
      sections: [{ name: 'BG', shots: [{ azimuth_in: 0, azimuth_out: 180, length: 1, depth_in: 0, depth_out: 0 }] }]
    };
  });

  await createProject(page, 'Backdrop Test');
  await page.keyboard.press('Control+i');
  await page.waitForSelector('[data-testid="import-dmp-dialog"]');

  // Click on backdrop (outside dialog content)
  const backdrop = page.locator('[data-testid="dialog-backdrop"]');
  await backdrop.click({ position: { x: 10, y: 10 } });

  // Dialog should close
  await expect(page.locator('[data-testid="import-dmp-dialog"]')).not.toBeVisible();
});
```

**Assertions:**
- [ ] Cancel button closes dialog
- [ ] No changes made to project
- [ ] Edits not persisted after cancel
- [ ] Backdrop click closes dialog

---

### Test 6.6: `should display statistics footer during import preview`

**Purpose:** Verify the import dialog shows live statistics about the data being imported.

**Test Code:**
```typescript
test('should display statistics footer during import preview', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).__MOCK_DMP_RESULT__ = {
      sections: [{
        name: 'STATS',
        direction: 'IN',
        date: '2024-01-15',
        shots: [
          { azimuth_in: 45.0, azimuth_out: 225.0, length: 5.0, depth_in: 0.0, depth_out: 1.5 },
          { azimuth_in: 90.0, azimuth_out: 270.0, length: 3.2, depth_in: 1.5, depth_out: 2.8 },
          { azimuth_in: 60.0, azimuth_out: 240.0, length: 4.5, depth_in: 2.8, depth_out: 4.0 },
          { azimuth_in: 120.0, azimuth_out: 300.0, length: 2.8, depth_in: 4.0, depth_out: 5.2 },
        ]
      }]
    };
  });

  await createProject(page, 'Stats Test');
  await page.keyboard.press('Control+i');
  await page.waitForSelector('[data-testid="import-dmp-dialog"]');

  // Verify statistics footer exists
  const statsFooter = page.locator('[data-testid="import-stats"]');
  await expect(statsFooter).toBeVisible();

  // Verify shot count
  const shotCount = statsFooter.locator('[data-testid="stat-shot-count"]');
  await expect(shotCount).toContainText('4');

  // Verify total length (5.0 + 3.2 + 4.5 + 2.8 = 15.5)
  const totalLength = statsFooter.locator('[data-testid="stat-total-length"]');
  await expect(totalLength).toContainText('15.5');

  // Verify depth range (0.0 to 5.2)
  const depthRange = statsFooter.locator('[data-testid="stat-depth-range"]');
  await expect(depthRange).toContainText('0');
  await expect(depthRange).toContainText('5.2');

  // Verify station count (4 shots = 5 stations)
  const stationCount = statsFooter.locator('[data-testid="stat-station-count"]');
  await expect(stationCount).toContainText('5');

  // Edit a shot and verify stats update
  const lengthCell = page.locator('[data-testid="shot-table"] tbody tr').first()
    .locator('[data-testid="shot-length"]');
  await lengthCell.dblclick();
  await lengthCell.locator('input').fill('10.0'); // Change from 5.0 to 10.0
  await lengthCell.locator('input').press('Enter');

  // Total length should update (10.0 + 3.2 + 4.5 + 2.8 = 20.5)
  await expect(totalLength).toContainText('20.5');

  // Delete a shot (if supported) and verify stats update
  const deleteBtn = page.locator('[data-testid="shot-table"] tbody tr').first()
    .locator('[data-testid="delete-shot"]');
  if (await deleteBtn.isVisible()) {
    await deleteBtn.click();
    await expect(shotCount).toContainText('3');
  }
});
```

**Assertions:**
- [ ] Statistics footer visible
- [ ] Shot count accurate
- [ ] Total length calculated correctly
- [ ] Depth range shows min/max
- [ ] Station count correct
- [ ] Stats update on edit
- [ ] Stats update on delete

---

## Test Helper Functions

```typescript
async function createProject(page: Page, name: string) {
  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill(name);
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });
}

async function openImportDialog(page: Page) {
  await page.keyboard.press('Control+i');
  await page.waitForSelector('[data-testid="import-dmp-dialog"]', { timeout: 5000 });
}
```

---

## Verification

```bash
pnpm test:ui --grep "DMP Import"
pnpm test:ui:headed --grep "DMP Import"  # Debug with visible browser
```

## Definition of Done
- [ ] All 6 tests implemented
- [ ] Mocks updated in tauri-ipc.ts
- [ ] Tests pass in headless mode
- [ ] Tests use proper data-testid selectors
- [ ] Dialog has correct ARIA attributes
- [ ] Edge cases covered (validation, multi-section, cancel)
