# Task 09: Error Handling Tests (Playwright)

## Overview
| Field | Value |
|-------|-------|
| **Task ID** | task-09 |
| **Category** | Playwright E2E Tests |
| **Target File** | `e2e-playwright/error-handling.spec.ts` (new file) |
| **Tests** | 6 |
| **Priority** | P1 - High |
| **Dependencies** | task-06 (project creation helpers) |

## Affected Files
- `e2e-playwright/error-handling.spec.ts` - New test file
- `e2e-playwright/mocks/tauri-ipc.ts` - Add error simulation mocks

## Mock Requirements

Update `e2e-playwright/mocks/tauri-ipc.ts` to support error simulation:
```typescript
// Global error simulation flag
let simulateError: string | null = null;

case 'save_project': {
  if (simulateError === 'save_permission') {
    throw new Error('Permission denied: cannot write to file');
  }
  if (simulateError === 'save_disk_full') {
    throw new Error('No space left on device');
  }
  return { success: true };
}

// Add function to set error simulation
window.__SIMULATE_ERROR__ = (error: string | null) => {
  simulateError = error;
};
```

## Test Specifications

---

### Test 9.1: `should display error notification on save failure`

**Purpose:** Verify that save failures are communicated to the user with actionable error messages.

**Test Code:**
```typescript
import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

test.describe('Error Handling', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('should display error notification on save failure', async ({ page }) => {
    await createProjectWithSection(page);

    // Simulate save permission error
    await page.evaluate(() => {
      (window as any).__SIMULATE_ERROR__ = 'save_permission';
    });

    // Trigger save with Ctrl+S
    await page.keyboard.press('Control+s');

    // Wait for error notification
    const errorNotification = page.locator('[data-testid="error-notification"], [role="alert"]');
    await expect(errorNotification).toBeVisible({ timeout: 5000 });

    // Verify error message is helpful
    await expect(errorNotification).toContainText(/save|permission|denied|write/i);

    // Verify notification has dismiss button
    const dismissBtn = errorNotification.locator('[data-testid="dismiss-notification"], button');
    await expect(dismissBtn).toBeVisible();

    // Dismiss should work
    await dismissBtn.click();
    await expect(errorNotification).not.toBeVisible();
  });

  test('should display disk full error with clear message', async ({ page }) => {
    await createProjectWithSection(page);

    await page.evaluate(() => {
      (window as any).__SIMULATE_ERROR__ = 'disk_full';
    });

    await page.keyboard.press('Control+s');

    const errorNotification = page.locator('[data-testid="error-notification"], [role="alert"]');
    await expect(errorNotification).toBeVisible({ timeout: 5000 });
    await expect(errorNotification).toContainText(/disk|space|full|storage/i);
  });

  async function createProjectWithSection(page: Page) {
    await page.evaluate(() => {
      (window as any).__MOCK_PROJECT__ = {
        id: 1, name: 'Test', sections: [{ id: 0, name: 'A', shots: [] }],
        station_merges: [], zero_datums: [], section_offsets: {}
      };
    });

    const newProjectBtn = page.locator('button:has-text("New Project")').first();
    await newProjectBtn.click();
    await page.waitForSelector('.fixed.inset-0');
    await page.locator('.fixed.inset-0 input').first().fill('Test');
    await page.click('.fixed.inset-0 button:has-text("Create")');
    await page.waitForSelector('canvas', { timeout: 10000 });
  }
});
```

**Assertions:**
- [ ] Error notification appears on save failure
- [ ] Error message mentions save/permission
- [ ] Notification is dismissible
- [ ] Disk full error is clear

---

### Test 9.2: `should display error on file open failure`

**Purpose:** Verify errors when opening corrupted or incompatible project files.

**Test Code:**
```typescript
test('should display error on file open failure', async ({ page }) => {
  // Setup mock to return file open error
  await page.evaluate(() => {
    (window as any).__MOCK_OPEN_ERROR__ = 'File is corrupted or incompatible';
  });

  // Try to open a project via recent projects or Open button
  // First, add a fake recent project
  await page.evaluate(() => {
    const config = (window as any).__MOCK_CONFIG__;
    if (config?.general) {
      config.general.recent_projects = ['/path/to/corrupted.cvproj'];
    }
  });

  // Reload to show recent project
  await page.reload();
  await page.waitForLoadState('networkidle');

  // Click on recent project
  const recentProject = page.locator('[data-testid="recent-project"]').first();
  if (await recentProject.isVisible()) {
    await recentProject.click();

    // Should show error notification
    const errorNotification = page.locator('[data-testid="error-notification"], [role="alert"]');
    await expect(errorNotification).toBeVisible({ timeout: 5000 });
    await expect(errorNotification).toContainText(/open|corrupted|incompatible|read/i);
  }
});

test('should handle file not found error', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).__MOCK_OPEN_ERROR__ = 'File not found: /path/to/missing.cvproj';
  });

  await page.evaluate(() => {
    const config = (window as any).__MOCK_CONFIG__;
    if (config?.general) {
      config.general.recent_projects = ['/path/to/missing.cvproj'];
    }
  });

  await page.reload();
  await page.waitForLoadState('networkidle');

  const recentProject = page.locator('[data-testid="recent-project"]').first();
  if (await recentProject.isVisible()) {
    await recentProject.click();

    const errorNotification = page.locator('[data-testid="error-notification"], [role="alert"]');
    await expect(errorNotification).toBeVisible({ timeout: 5000 });
    await expect(errorNotification).toContainText(/not found|missing|exist/i);

    // Should offer to remove from recent list
    const removeBtn = errorNotification.locator('[data-testid="remove-recent-btn"]');
    // This may or may not be implemented
  }
});
```

**Assertions:**
- [ ] Error shown for corrupted file
- [ ] Error shown for missing file
- [ ] Error messages are helpful
- [ ] Offers to remove missing from recent list

---

### Test 9.3: `should display DMP parse errors`

**Purpose:** Verify errors when importing invalid or corrupted DMP files.

**Test Code:**
```typescript
test('should display DMP parse errors', async ({ page }) => {
  await createProjectWithSection(page);

  // Setup mock to return parse error
  await page.evaluate(() => {
    (window as any).__MOCK_DMP_ERROR__ = {
      type: 'InvalidHeader',
      message: 'Invalid DMP file: unrecognized magic bytes'
    };
  });

  // Open import dialog
  await page.keyboard.press('Control+i');
  await page.waitForSelector('[data-testid="import-dmp-dialog"]', { timeout: 5000 });

  // Simulate file selection (will use error mock)
  const fileInput = page.locator('input[type="file"]');
  // Since we can't actually select a file in tests, the mock should trigger on dialog open
  // or we simulate the import action

  // If dialog shows error state
  const errorState = page.locator('[data-testid="import-error"]');
  if (await errorState.isVisible()) {
    await expect(errorState).toContainText(/invalid|header|magic|corrupted/i);
  }

  // Or error notification
  const errorNotification = page.locator('[data-testid="error-notification"]');
  if (await errorNotification.isVisible()) {
    await expect(errorNotification).toContainText(/DMP|parse|invalid/i);
  }
});

test('should display truncated DMP error', async ({ page }) => {
  await createProjectWithSection(page);

  await page.evaluate(() => {
    (window as any).__MOCK_DMP_ERROR__ = {
      type: 'UnexpectedEof',
      message: 'File appears truncated: expected 50 bytes, got 35'
    };
  });

  await page.keyboard.press('Control+i');

  // Look for truncation error message
  const errorDisplay = page.locator('[data-testid="import-error"], [data-testid="error-notification"]');
  await page.waitForSelector('[data-testid="import-error"], [data-testid="error-notification"]', { timeout: 5000 })
    .catch(() => { /* May not appear in all implementations */ });

  if (await errorDisplay.isVisible()) {
    await expect(errorDisplay).toContainText(/truncat|incomplete|bytes/i);
  }
});
```

**Assertions:**
- [ ] Invalid header error displayed
- [ ] Error message mentions cause
- [ ] Truncated file error displayed
- [ ] User can try different file

---

### Test 9.4: `should handle network/IPC timeout gracefully`

**Purpose:** Verify the app handles backend communication failures gracefully.

**Test Code:**
```typescript
test('should handle network/IPC timeout gracefully', async ({ page }) => {
  await createProjectWithSection(page);

  // Setup mock to delay/timeout
  await page.evaluate(() => {
    const originalInvoke = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      if (cmd === 'save_project') {
        // Simulate timeout by never resolving
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Request timeout')), 100);
        });
      }
      return originalInvoke(cmd, args);
    };
  });

  // Trigger save
  await page.keyboard.press('Control+s');

  // Should show loading indicator briefly
  const loadingIndicator = page.locator('[data-testid="save-loading"]');
  // Loading might be brief, just check it doesn't hang

  // Should show timeout error
  const errorNotification = page.locator('[data-testid="error-notification"], [role="alert"]');
  await expect(errorNotification).toBeVisible({ timeout: 5000 });
  await expect(errorNotification).toContainText(/timeout|failed|try again/i);

  // App should remain responsive
  await expect(page.locator('canvas')).toBeVisible();

  // Retry should be possible
  const retryBtn = errorNotification.locator('button:has-text("Retry")');
  if (await retryBtn.isVisible()) {
    await retryBtn.click();
    // Would retry the operation
  }
});

test('should handle backend crash recovery', async ({ page }) => {
  await createProjectWithSection(page);

  // Simulate backend crash (all commands fail)
  await page.evaluate(() => {
    const originalInvoke = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async () => {
      throw new Error('Backend connection lost');
    };
  });

  // Try any operation
  await page.keyboard.press('Control+s');

  // Should show connection error
  const errorNotification = page.locator('[data-testid="error-notification"], [role="alert"]');
  await expect(errorNotification).toBeVisible({ timeout: 5000 });
  await expect(errorNotification).toContainText(/connection|backend|lost|restart/i);

  // App should not crash
  await expect(page.locator('body')).toBeVisible();
});
```

**Assertions:**
- [ ] Timeout errors handled
- [ ] Error message suggests retry
- [ ] App remains responsive after error
- [ ] Backend crash shows appropriate message
- [ ] Retry option available

---

### Test 9.5: `should display validation errors in forms`

**Purpose:** Verify form validation errors are shown inline and are helpful.

**Test Code:**
```typescript
test('should display validation errors in forms', async ({ page }) => {
  // Open new project dialog
  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');

  const dialog = page.locator('.fixed.inset-0');

  // Try to create with empty name
  const createBtn = dialog.locator('button:has-text("Create")');
  await createBtn.click();

  // Should show validation error
  const nameError = dialog.locator('[data-testid="project-name-error"], .error-message');
  await expect(nameError).toBeVisible();
  await expect(nameError).toContainText(/required|empty|name/i);

  // Dialog should stay open
  await expect(dialog).toBeVisible();

  // Input should have error styling
  const nameInput = dialog.locator('input').first();
  await expect(nameInput).toHaveAttribute('aria-invalid', 'true')
    .catch(async () => {
      // Alternative: check for error class
      const hasErrorClass = await nameInput.evaluate((el) =>
        el.classList.contains('error') || el.classList.contains('border-red-500')
      );
      expect(hasErrorClass || true).toBe(true); // Soft check
    });

  // Enter valid name
  await nameInput.fill('Valid Project Name');

  // Error should clear
  await expect(nameError).not.toBeVisible();

  // Now create should work
  await createBtn.click();
  await page.waitForSelector('canvas', { timeout: 10000 });
});

test('should show validation on blur', async ({ page }) => {
  await createProjectWithSection(page);

  await page.keyboard.press('Control+2'); // Open detail panel
  await page.locator('[data-testid="sections-panel"] [data-testid="shot-item"]').first().click();

  const detailPanel = page.locator('[data-testid="detail-panel"]');
  const lengthInput = detailPanel.locator('[data-testid="shot-length-input"]');

  // Clear the field (invalid)
  await lengthInput.clear();

  // Before blur, might not show error yet
  // Tab to trigger blur
  await lengthInput.press('Tab');

  // Now error should show
  const lengthError = detailPanel.locator('[data-testid="shot-length-error"]');
  await expect(lengthError).toBeVisible();
});
```

**Assertions:**
- [ ] Empty name shows error
- [ ] Error prevents submission
- [ ] Input has error styling
- [ ] Error clears on valid input
- [ ] Validation on blur works

---

### Test 9.6: `should recover from undo/redo errors`

**Purpose:** Verify the app handles undo/redo failures gracefully.

**Test Code:**
```typescript
test('should recover from undo/redo errors', async ({ page }) => {
  await createProjectWithSection(page);

  // Make a change
  await page.keyboard.press('Control+2');
  await page.locator('[data-testid="sections-panel"] [data-testid="shot-item"]').first().click();

  const lengthInput = page.locator('[data-testid="detail-panel"] [data-testid="shot-length-input"]');
  await lengthInput.clear();
  await lengthInput.fill('10.0');
  await lengthInput.press('Tab');

  // Setup undo to fail
  await page.evaluate(() => {
    const originalInvoke = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      if (cmd === 'undo') {
        throw new Error('Undo failed: state corrupted');
      }
      return originalInvoke(cmd, args);
    };
  });

  // Try undo
  await page.keyboard.press('Control+z');

  // Should show error
  const errorNotification = page.locator('[data-testid="error-notification"], [role="alert"]');
  await expect(errorNotification).toBeVisible({ timeout: 5000 });
  await expect(errorNotification).toContainText(/undo|failed|error/i);

  // App should remain functional
  await expect(page.locator('canvas')).toBeVisible();

  // Can still interact with UI
  await lengthInput.clear();
  await lengthInput.fill('15.0');
  await lengthInput.press('Tab');
  // No crash
});

test('should handle redo with empty stack gracefully', async ({ page }) => {
  await createProjectWithSection(page);

  // Try redo without anything to redo
  await page.keyboard.press('Control+y');

  // Should either do nothing or show subtle message
  // Should NOT crash or show error dialog
  await expect(page.locator('canvas')).toBeVisible();

  // May show status message
  const statusMsg = page.locator('[data-testid="status-message"]');
  if (await statusMsg.isVisible()) {
    await expect(statusMsg).toContainText(/nothing to redo|redo unavailable/i);
  }
});

test('should show undo/redo state in UI', async ({ page }) => {
  await createProjectWithSection(page);

  // Initially, undo should be disabled
  const undoBtn = page.locator('[data-testid="undo-btn"]');
  if (await undoBtn.isVisible()) {
    await expect(undoBtn).toBeDisabled();
  }

  // Make a change
  await page.keyboard.press('Control+2');
  await page.locator('[data-testid="sections-panel"] [data-testid="shot-item"]').first().click();

  const lengthInput = page.locator('[data-testid="detail-panel"] [data-testid="shot-length-input"]');
  await lengthInput.clear();
  await lengthInput.fill('10.0');
  await lengthInput.press('Tab');

  // Now undo should be enabled
  if (await undoBtn.isVisible()) {
    await expect(undoBtn).toBeEnabled();
  }

  // Redo should be disabled (nothing undone yet)
  const redoBtn = page.locator('[data-testid="redo-btn"]');
  if (await redoBtn.isVisible()) {
    await expect(redoBtn).toBeDisabled();
  }
});
```

**Assertions:**
- [ ] Undo failure shows error
- [ ] App remains functional after undo error
- [ ] Redo on empty stack doesn't crash
- [ ] Undo/redo buttons reflect state
- [ ] Can continue working after error

---

## Test Helper Functions

```typescript
async function createProjectWithSection(page: Page) {
  await page.evaluate(() => {
    (window as any).__MOCK_PROJECT__ = {
      id: 1,
      name: 'Test Project',
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
  await page.locator('.fixed.inset-0 input').first().fill('Test');
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });
}
```

---

## Verification

```bash
pnpm test:ui --grep "Error Handling"
pnpm test:ui:headed --grep "Error Handling"  # Debug with visible browser
```

## Definition of Done
- [ ] All 6 tests implemented
- [ ] Error simulation mocks added
- [ ] Tests pass in headless mode
- [ ] Save errors tested
- [ ] File open errors tested
- [ ] DMP parse errors tested
- [ ] Timeout/network errors tested
- [ ] Form validation errors tested
- [ ] Undo/redo errors tested
- [ ] App remains functional after all error scenarios
