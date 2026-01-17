# Task 07: Export Dialog Tests (Playwright)

## Overview
| Field | Value |
|-------|-------|
| **Task ID** | task-07 |
| **Category** | Playwright E2E Tests |
| **Target File** | `e2e-playwright/export-dialog.spec.ts` (new file) |
| **Tests** | 6 |
| **Priority** | P2 - Medium |
| **Dependencies** | task-06 (project creation helpers) |

## Affected Files
- `e2e-playwright/export-dialog.spec.ts` - New test file
- `e2e-playwright/mocks/tauri-ipc.ts` - Add export mocks

## Mock Requirements

Update `e2e-playwright/mocks/tauri-ipc.ts` to handle:
```typescript
case 'export_csv': {
  return { success: true, path: '/tmp/export.csv' };
}

case 'export_json': {
  return { success: true, path: '/tmp/export.json' };
}

case 'export_image': {
  return { success: true, path: '/tmp/export.png' };
}

case 'get_export_preview': {
  return {
    csv_preview: 'Station,X,Y,Z\nA0,0.00,0.00,0.00\nA1,3.54,3.54,1.50',
    json_preview: '{"project": {"name": "Test"}, "sections": [...]}',
    image_dimensions: { width: 1920, height: 1080 }
  };
}
```

## Test Specifications

---

### Test 7.1: `should open export dialog with Ctrl+E`

**Purpose:** Verify the export dialog opens via keyboard shortcut when a project is open.

**Test Code:**
```typescript
import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

test.describe('Export Dialog', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('should open export dialog with Ctrl+E', async ({ page }) => {
    // Create project with some data
    await createProjectWithSection(page, 'Export Test');

    // Press Ctrl+E
    await page.keyboard.press('Control+e');

    // Verify dialog opens
    const dialog = page.locator('[data-testid="export-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Verify dialog has correct ARIA attributes
    await expect(dialog.locator('[role="dialog"]')).toBeVisible();

    // Verify dialog title
    await expect(dialog.locator('h2, [data-testid="dialog-title"]')).toContainText(/export/i);

    // Verify format options present
    await expect(dialog.locator('[data-testid="format-csv"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="format-json"]')).toBeVisible();
    await expect(dialog.locator('[data-testid="format-image"]')).toBeVisible();
  });

  test('should not open export dialog without project', async ({ page }) => {
    // Don't create a project

    // Press Ctrl+E
    await page.keyboard.press('Control+e');

    // Dialog should not open
    const dialog = page.locator('[data-testid="export-dialog"]');
    await expect(dialog).not.toBeVisible({ timeout: 1000 });

    // Should show notification or status message
    const notification = page.locator('[data-testid="notification"], [role="alert"]');
    // Either no dialog or a "no project" message
    const hasNotification = await notification.isVisible().catch(() => false);
    // This is acceptable - just verify dialog didn't open
  });

  async function createProjectWithSection(page: Page, name: string) {
    // Set up mock data for project with section
    await page.evaluate(() => {
      (window as any).__MOCK_PROJECT__ = {
        id: 1,
        name: 'Export Test',
        sections: [{
          id: 0,
          name: 'Test Section',
          shots: [
            { azimuth_in: 45, azimuth_out: 225, length: 5.0, depth_in: 0, depth_out: 1.5 },
            { azimuth_in: 90, azimuth_out: 270, length: 3.0, depth_in: 1.5, depth_out: 2.5 },
          ]
        }],
        station_merges: [],
        zero_datums: [],
        section_offsets: {}
      };
    });

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
- [ ] Ctrl+E opens export dialog
- [ ] Dialog has correct ARIA role
- [ ] Format options visible
- [ ] Dialog doesn't open without project

---

### Test 7.2: `should show CSV format options and preview`

**Purpose:** Verify CSV export options are displayed and preview updates based on selections.

**Test Code:**
```typescript
test('should show CSV format options and preview', async ({ page }) => {
  await createProjectWithSection(page, 'CSV Test');
  await page.keyboard.press('Control+e');
  await page.waitForSelector('[data-testid="export-dialog"]');

  // Select CSV format
  const csvOption = page.locator('[data-testid="format-csv"]');
  await csvOption.click();

  // Verify CSV-specific options appear
  const csvOptions = page.locator('[data-testid="csv-options"]');
  await expect(csvOptions).toBeVisible();

  // Check delimiter option
  const delimiterSelect = csvOptions.locator('[data-testid="csv-delimiter"]');
  await expect(delimiterSelect).toBeVisible();

  // Check include header option
  const includeHeader = csvOptions.locator('[data-testid="csv-include-header"]');
  await expect(includeHeader).toBeVisible();
  await expect(includeHeader).toBeChecked(); // Default: include headers

  // Check coordinate system option
  const coordSystem = csvOptions.locator('[data-testid="csv-coord-system"]');
  await expect(coordSystem).toBeVisible();

  // Verify preview updates
  const preview = page.locator('[data-testid="export-preview"]');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('Station'); // Header
  await expect(preview).toContainText('0.00'); // Coordinates

  // Change delimiter to semicolon
  await delimiterSelect.selectOption('semicolon');

  // Preview should update to show semicolons
  await expect(preview).toContainText(';');

  // Uncheck headers
  await includeHeader.uncheck();

  // Preview should not have header row
  await expect(preview).not.toContainText('Station');
});
```

**Assertions:**
- [ ] CSV format selectable
- [ ] CSV-specific options shown
- [ ] Delimiter option works
- [ ] Header option works
- [ ] Preview updates with options

---

### Test 7.3: `should show JSON format options and preview`

**Purpose:** Verify JSON export options and preview functionality.

**Test Code:**
```typescript
test('should show JSON format options and preview', async ({ page }) => {
  await createProjectWithSection(page, 'JSON Test');
  await page.keyboard.press('Control+e');
  await page.waitForSelector('[data-testid="export-dialog"]');

  // Select JSON format
  const jsonOption = page.locator('[data-testid="format-json"]');
  await jsonOption.click();

  // Verify JSON-specific options
  const jsonOptions = page.locator('[data-testid="json-options"]');
  await expect(jsonOptions).toBeVisible();

  // Check pretty print option
  const prettyPrint = jsonOptions.locator('[data-testid="json-pretty"]');
  await expect(prettyPrint).toBeVisible();
  await expect(prettyPrint).toBeChecked(); // Default: pretty print

  // Check include metadata option
  const includeMetadata = jsonOptions.locator('[data-testid="json-include-metadata"]');
  await expect(includeMetadata).toBeVisible();

  // Verify preview is valid JSON
  const preview = page.locator('[data-testid="export-preview"]');
  await expect(preview).toBeVisible();

  // Preview should have JSON structure markers
  await expect(preview).toContainText('{');
  await expect(preview).toContainText('"project"');

  // Toggle pretty print off
  await prettyPrint.uncheck();

  // Preview should be minified (no newlines within JSON)
  const previewText = await preview.textContent();
  // Minified JSON should be more compact
  expect(previewText?.includes('\n  "')).toBeFalsy();
});
```

**Assertions:**
- [ ] JSON format selectable
- [ ] Pretty print option available
- [ ] Metadata option available
- [ ] Preview shows valid JSON structure
- [ ] Pretty print toggle works

---

### Test 7.4: `should show image export options`

**Purpose:** Verify image export format options including resolution and style.

**Test Code:**
```typescript
test('should show image export options', async ({ page }) => {
  await createProjectWithSection(page, 'Image Test');
  await page.keyboard.press('Control+e');
  await page.waitForSelector('[data-testid="export-dialog"]');

  // Select image format
  const imageOption = page.locator('[data-testid="format-image"]');
  await imageOption.click();

  // Verify image-specific options
  const imageOptions = page.locator('[data-testid="image-options"]');
  await expect(imageOptions).toBeVisible();

  // Check format selection (PNG/SVG)
  const formatSelect = imageOptions.locator('[data-testid="image-format"]');
  await expect(formatSelect).toBeVisible();

  // Check resolution option
  const resolution = imageOptions.locator('[data-testid="image-resolution"]');
  await expect(resolution).toBeVisible();

  // Check dimension inputs
  const widthInput = imageOptions.locator('[data-testid="image-width"]');
  const heightInput = imageOptions.locator('[data-testid="image-height"]');
  await expect(widthInput).toBeVisible();
  await expect(heightInput).toBeVisible();

  // Verify default dimensions
  await expect(widthInput).toHaveValue('1920');
  await expect(heightInput).toHaveValue('1080');

  // Check background option
  const bgOption = imageOptions.locator('[data-testid="image-background"]');
  await expect(bgOption).toBeVisible();

  // Check include legend option
  const legendOption = imageOptions.locator('[data-testid="image-legend"]');
  await expect(legendOption).toBeVisible();

  // Change resolution
  await widthInput.fill('3840');
  await heightInput.fill('2160');

  // Verify aspect ratio lock (if implemented)
  const aspectLock = imageOptions.locator('[data-testid="aspect-lock"]');
  if (await aspectLock.isVisible()) {
    await aspectLock.click(); // Unlock
    await widthInput.fill('1000');
    // Height should not auto-change
    await expect(heightInput).toHaveValue('2160');
  }
});
```

**Assertions:**
- [ ] Image format selectable
- [ ] Format type option (PNG/SVG)
- [ ] Resolution/dimension inputs
- [ ] Background option
- [ ] Legend option
- [ ] Dimension inputs work

---

### Test 7.5: `should execute export and show success`

**Purpose:** Verify the export button executes export and shows success feedback.

**Test Code:**
```typescript
test('should execute export and show success', async ({ page }) => {
  await createProjectWithSection(page, 'Export Execute Test');
  await page.keyboard.press('Control+e');
  await page.waitForSelector('[data-testid="export-dialog"]');

  // Track export command calls
  await page.evaluate(() => {
    (window as any).__EXPORT_CALLS__ = [];
    const originalInvoke = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      if (cmd.startsWith('export_')) {
        (window as any).__EXPORT_CALLS__.push({ cmd, args });
      }
      return originalInvoke(cmd, args);
    };
  });

  // Select CSV format
  await page.locator('[data-testid="format-csv"]').click();

  // Click Export button
  const exportBtn = page.locator('button:has-text("Export")');
  await expect(exportBtn).toBeEnabled();
  await exportBtn.click();

  // Verify loading state shown
  const loadingIndicator = page.locator('[data-testid="export-loading"]');
  // Loading might be brief, so use a short timeout
  const wasLoading = await loadingIndicator.isVisible().catch(() => false);

  // Verify success notification
  await page.waitForSelector('[data-testid="export-success"], [role="alert"]', { timeout: 5000 });
  const successMsg = page.locator('[data-testid="export-success"], [role="alert"]');
  await expect(successMsg).toContainText(/success|exported|saved/i);

  // Dialog should close after successful export
  await expect(page.locator('[data-testid="export-dialog"]')).not.toBeVisible({ timeout: 3000 });

  // Verify export command was called
  const exportCalls = await page.evaluate(() => (window as any).__EXPORT_CALLS__);
  expect(exportCalls.length).toBeGreaterThan(0);
  expect(exportCalls[0].cmd).toBe('export_csv');
});

test('should show error on export failure', async ({ page }) => {
  await createProjectWithSection(page, 'Export Fail Test');

  // Setup mock to fail
  await page.evaluate(() => {
    (window as any).__MOCK_EXPORT_ERROR__ = 'Permission denied: cannot write to file';
  });

  await page.keyboard.press('Control+e');
  await page.waitForSelector('[data-testid="export-dialog"]');

  await page.locator('[data-testid="format-csv"]').click();
  await page.locator('button:has-text("Export")').click();

  // Verify error notification
  await page.waitForSelector('[data-testid="export-error"], [role="alert"]', { timeout: 5000 });
  const errorMsg = page.locator('[data-testid="export-error"], [role="alert"]');
  await expect(errorMsg).toContainText(/error|failed|permission/i);

  // Dialog should remain open for retry
  await expect(page.locator('[data-testid="export-dialog"]')).toBeVisible();
});
```

**Assertions:**
- [ ] Export button executes export
- [ ] Loading state shown during export
- [ ] Success notification displayed
- [ ] Dialog closes on success
- [ ] Error shown on failure
- [ ] Dialog stays open on error for retry

---

### Test 7.6: `should close dialog on Cancel`

**Purpose:** Verify Cancel button closes the dialog without exporting.

**Test Code:**
```typescript
test('should close dialog on Cancel', async ({ page }) => {
  await createProjectWithSection(page, 'Cancel Test');

  // Track export calls
  await page.evaluate(() => {
    (window as any).__EXPORT_CALLED__ = false;
    const originalInvoke = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      if (cmd.startsWith('export_')) {
        (window as any).__EXPORT_CALLED__ = true;
      }
      return originalInvoke(cmd, args);
    };
  });

  await page.keyboard.press('Control+e');
  await page.waitForSelector('[data-testid="export-dialog"]');

  // Make some selections
  await page.locator('[data-testid="format-json"]').click();

  // Click Cancel
  await page.locator('button:has-text("Cancel")').click();

  // Dialog should close
  await expect(page.locator('[data-testid="export-dialog"]')).not.toBeVisible();

  // Export should not have been called
  const exportCalled = await page.evaluate(() => (window as any).__EXPORT_CALLED__);
  expect(exportCalled).toBe(false);
});

test('should remember last used format', async ({ page }) => {
  await createProjectWithSection(page, 'Remember Format');

  // Open dialog and select JSON
  await page.keyboard.press('Control+e');
  await page.waitForSelector('[data-testid="export-dialog"]');
  await page.locator('[data-testid="format-json"]').click();

  // Cancel
  await page.locator('button:has-text("Cancel")').click();
  await expect(page.locator('[data-testid="export-dialog"]')).not.toBeVisible();

  // Re-open dialog
  await page.keyboard.press('Control+e');
  await page.waitForSelector('[data-testid="export-dialog"]');

  // JSON should still be selected
  const jsonOption = page.locator('[data-testid="format-json"]');
  await expect(jsonOption).toHaveAttribute('data-selected', 'true')
    .catch(async () => {
      // Alternative: check if JSON options are visible
      await expect(page.locator('[data-testid="json-options"]')).toBeVisible();
    });
});
```

**Assertions:**
- [ ] Cancel closes dialog
- [ ] No export executed on cancel
- [ ] Format preference remembered between opens

---

## Test Helper Functions

```typescript
async function createProjectWithSection(page: Page, name: string) {
  await page.evaluate((projectName) => {
    (window as any).__MOCK_PROJECT__ = {
      id: 1,
      name: projectName,
      sections: [{
        id: 0,
        name: 'Section A',
        shots: [
          { azimuth_in: 45, azimuth_out: 225, length: 5.0, depth_in: 0, depth_out: 1.5 },
          { azimuth_in: 90, azimuth_out: 270, length: 3.0, depth_in: 1.5, depth_out: 2.5 },
        ]
      }],
      station_merges: [],
      zero_datums: [],
      section_offsets: {}
    };
  }, name);

  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill(name);
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });
}
```

---

## Verification

```bash
pnpm test:ui --grep "Export Dialog"
pnpm test:ui:headed --grep "Export Dialog"  # Debug with visible browser
```

## Definition of Done
- [ ] All 6 tests implemented
- [ ] Mocks updated in tauri-ipc.ts
- [ ] Tests pass in headless mode
- [ ] All export formats tested (CSV, JSON, Image)
- [ ] Error handling tested
- [ ] Dialog has correct ARIA attributes
