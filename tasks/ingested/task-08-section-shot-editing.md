# Task 08: Section and Shot Editing Tests (Playwright)

## Overview
| Field | Value |
|-------|-------|
| **Task ID** | task-08 |
| **Category** | Playwright E2E Tests |
| **Target File** | `e2e-playwright/section-shot-editing.spec.ts` (new file) |
| **Tests** | 6 |
| **Priority** | P1 - High |
| **Dependencies** | task-06 (project creation helpers) |

## Affected Files
- `e2e-playwright/section-shot-editing.spec.ts` - New test file
- `e2e-playwright/mocks/tauri-ipc.ts` - Add shot/section mutation mocks

## Mock Requirements

Update `e2e-playwright/mocks/tauri-ipc.ts` to handle:
```typescript
case 'update_shot': {
  // Track updates for verification
  return { success: true };
}

case 'delete_shot': {
  return { success: true, split_sections: null };
}

case 'delete_section': {
  return { success: true };
}

case 'update_section_metadata': {
  return { success: true };
}

case 'create_shot': {
  return { success: true, shot_id: 99 };
}
```

## Test Specifications

---

### Test 8.1: `should edit shot values in detail panel`

**Purpose:** Verify users can edit shot values through the detail panel when a shot is selected.

**Test Code:**
```typescript
import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

test.describe('Section and Shot Editing', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('should edit shot values in detail panel', async ({ page }) => {
    await createProjectWithSection(page);

    // Track update_shot calls
    await page.evaluate(() => {
      (window as any).__UPDATE_SHOT_CALLS__ = [];
      const originalInvoke = (window as any).__TAURI_INTERNALS__.invoke;
      (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
        if (cmd === 'update_shot') {
          (window as any).__UPDATE_SHOT_CALLS__.push(args);
        }
        return originalInvoke(cmd, args);
      };
    });

    // Open detail panel (Ctrl+2)
    await page.keyboard.press('Control+2');
    await page.waitForSelector('[data-testid="detail-panel"]');

    // Select a shot on the map or via sections panel
    await page.locator('[data-testid="sections-panel"] [data-testid="shot-item"]').first().click();

    // Verify detail panel shows shot data
    const detailPanel = page.locator('[data-testid="detail-panel"]');
    await expect(detailPanel.locator('[data-testid="shot-details"]')).toBeVisible();

    // Edit length field
    const lengthInput = detailPanel.locator('[data-testid="shot-length-input"]');
    await expect(lengthInput).toBeVisible();
    await lengthInput.clear();
    await lengthInput.fill('7.5');
    await lengthInput.press('Tab'); // Trigger blur/save

    // Edit azimuth field
    const azimuthInput = detailPanel.locator('[data-testid="shot-azimuth-in-input"]');
    await azimuthInput.clear();
    await azimuthInput.fill('60.0');
    await azimuthInput.press('Tab');

    // Edit depth fields
    const depthOutInput = detailPanel.locator('[data-testid="shot-depth-out-input"]');
    await depthOutInput.clear();
    await depthOutInput.fill('2.5');
    await depthOutInput.press('Enter'); // Should also trigger save

    // Verify update_shot was called with correct values
    const updateCalls = await page.evaluate(() => (window as any).__UPDATE_SHOT_CALLS__);
    expect(updateCalls.length).toBeGreaterThan(0);

    // Check that at least one call has the updated values
    const hasLengthUpdate = updateCalls.some((call: any) =>
      call.updates?.length === 7.5 || Math.abs((call.updates?.length || 0) - 7.5) < 0.01
    );
    expect(hasLengthUpdate).toBe(true);
  });

  test('should validate shot values on edit', async ({ page }) => {
    await createProjectWithSection(page);

    await page.keyboard.press('Control+2');
    await page.locator('[data-testid="sections-panel"] [data-testid="shot-item"]').first().click();

    const detailPanel = page.locator('[data-testid="detail-panel"]');

    // Try to enter invalid length (0)
    const lengthInput = detailPanel.locator('[data-testid="shot-length-input"]');
    await lengthInput.clear();
    await lengthInput.fill('0');
    await lengthInput.press('Tab');

    // Should show validation error
    const lengthError = detailPanel.locator('[data-testid="shot-length-error"]');
    await expect(lengthError).toBeVisible();
    await expect(lengthError).toContainText(/positive|greater than|invalid/i);

    // Try invalid azimuth (>360)
    const azimuthInput = detailPanel.locator('[data-testid="shot-azimuth-in-input"]');
    await azimuthInput.clear();
    await azimuthInput.fill('400');
    await azimuthInput.press('Tab');

    const azimuthError = detailPanel.locator('[data-testid="shot-azimuth-error"]');
    await expect(azimuthError).toBeVisible();
    await expect(azimuthError).toContainText(/360|range|invalid/i);

    // Valid value should clear error
    await azimuthInput.clear();
    await azimuthInput.fill('45');
    await azimuthInput.press('Tab');
    await expect(azimuthError).not.toBeVisible();
  });
});
```

**Assertions:**
- [ ] Detail panel shows shot data when selected
- [ ] Length field editable
- [ ] Azimuth field editable
- [ ] Depth fields editable
- [ ] Updates trigger backend call
- [ ] Validation errors shown for invalid values

---

### Test 8.2: `should edit LRUD values`

**Purpose:** Verify LRUD (Left, Right, Up, Down) passage dimensions can be edited.

**Test Code:**
```typescript
test('should edit LRUD values', async ({ page }) => {
  await createProjectWithSection(page);

  await page.keyboard.press('Control+2');
  await page.locator('[data-testid="sections-panel"] [data-testid="shot-item"]').first().click();

  const detailPanel = page.locator('[data-testid="detail-panel"]');

  // Expand LRUD section if collapsed
  const lrudSection = detailPanel.locator('[data-testid="lrud-section"]');
  if (await lrudSection.locator('[data-testid="lrud-collapsed"]').isVisible()) {
    await lrudSection.locator('[data-testid="lrud-toggle"]').click();
  }

  // Edit Left value
  const leftInput = detailPanel.locator('[data-testid="shot-left-input"]');
  await expect(leftInput).toBeVisible();
  await leftInput.clear();
  await leftInput.fill('2.5');
  await leftInput.press('Tab');

  // Edit Right value
  const rightInput = detailPanel.locator('[data-testid="shot-right-input"]');
  await rightInput.clear();
  await rightInput.fill('1.8');
  await rightInput.press('Tab');

  // Edit Up value
  const upInput = detailPanel.locator('[data-testid="shot-up-input"]');
  await upInput.clear();
  await upInput.fill('3.0');
  await upInput.press('Tab');

  // Edit Down value
  const downInput = detailPanel.locator('[data-testid="shot-down-input"]');
  await downInput.clear();
  await downInput.fill('0.5');
  await downInput.press('Tab');

  // Try negative value (should error)
  await leftInput.clear();
  await leftInput.fill('-1.0');
  await leftInput.press('Tab');

  const leftError = detailPanel.locator('[data-testid="shot-left-error"]');
  await expect(leftError).toBeVisible();
  await expect(leftError).toContainText(/negative|positive|invalid/i);

  // Clear LRUD by entering empty (should set to None)
  await leftInput.clear();
  await leftInput.press('Tab');
  // No error for empty (None is valid)
  await expect(leftError).not.toBeVisible();
});
```

**Assertions:**
- [ ] LRUD section visible/expandable
- [ ] Each dimension editable
- [ ] Negative values show error
- [ ] Empty values allowed (None)

---

### Test 8.3: `should delete shot with confirmation`

**Purpose:** Verify shot deletion requires confirmation and updates the UI.

**Test Code:**
```typescript
test('should delete shot with confirmation', async ({ page }) => {
  await createProjectWithSection(page);

  // Track delete_shot calls
  await page.evaluate(() => {
    (window as any).__DELETE_SHOT_CALLED__ = false;
  });

  // Get initial shot count
  const initialShotCount = await page.locator('[data-testid="sections-panel"] [data-testid="shot-item"]').count();
  expect(initialShotCount).toBeGreaterThan(1);

  // Select a shot
  await page.locator('[data-testid="sections-panel"] [data-testid="shot-item"]').nth(1).click();

  // Open detail panel
  await page.keyboard.press('Control+2');
  await page.waitForSelector('[data-testid="detail-panel"]');

  // Click delete button
  const deleteBtn = page.locator('[data-testid="delete-shot-btn"]');
  await expect(deleteBtn).toBeVisible();
  await deleteBtn.click();

  // Confirmation dialog should appear
  const confirmDialog = page.locator('[data-testid="confirm-delete-dialog"]');
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText(/delete|remove|shot/i);

  // Cancel first
  await confirmDialog.locator('button:has-text("Cancel")').click();
  await expect(confirmDialog).not.toBeVisible();

  // Shot should still exist
  const shotCountAfterCancel = await page.locator('[data-testid="sections-panel"] [data-testid="shot-item"]').count();
  expect(shotCountAfterCancel).toBe(initialShotCount);

  // Now actually delete
  await deleteBtn.click();
  await page.waitForSelector('[data-testid="confirm-delete-dialog"]');
  await page.locator('[data-testid="confirm-delete-dialog"] button:has-text("Delete")').click();

  // Dialog should close
  await expect(confirmDialog).not.toBeVisible();

  // Shot count should decrease
  await expect(page.locator('[data-testid="sections-panel"] [data-testid="shot-item"]'))
    .toHaveCount(initialShotCount - 1, { timeout: 5000 });
});

test('should delete shot with keyboard shortcut', async ({ page }) => {
  await createProjectWithSection(page);

  const initialShotCount = await page.locator('[data-testid="sections-panel"] [data-testid="shot-item"]').count();

  // Select a shot
  await page.locator('[data-testid="sections-panel"] [data-testid="shot-item"]').first().click();

  // Press Delete key
  await page.keyboard.press('Delete');

  // Confirmation should appear
  await expect(page.locator('[data-testid="confirm-delete-dialog"]')).toBeVisible();

  // Confirm deletion
  await page.locator('[data-testid="confirm-delete-dialog"] button:has-text("Delete")').click();

  // Verify deletion
  await expect(page.locator('[data-testid="sections-panel"] [data-testid="shot-item"]'))
    .toHaveCount(initialShotCount - 1, { timeout: 5000 });
});
```

**Assertions:**
- [ ] Delete button visible when shot selected
- [ ] Confirmation dialog appears
- [ ] Cancel preserves shot
- [ ] Confirm deletes shot
- [ ] Delete keyboard shortcut works
- [ ] UI updates after deletion

---

### Test 8.4: `should edit section metadata`

**Purpose:** Verify section name, date, surveyor, and color can be edited.

**Test Code:**
```typescript
test('should edit section metadata', async ({ page }) => {
  await createProjectWithSection(page);

  // Track update calls
  await page.evaluate(() => {
    (window as any).__UPDATE_SECTION_CALLS__ = [];
    const originalInvoke = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      if (cmd === 'update_section_metadata') {
        (window as any).__UPDATE_SECTION_CALLS__.push(args);
      }
      return originalInvoke(cmd, args);
    };
  });

  // Click on section header in sections panel
  const sectionHeader = page.locator('[data-testid="sections-panel"] [data-testid="section-header"]').first();
  await sectionHeader.click();

  // Open detail panel to show section details
  await page.keyboard.press('Control+2');
  await page.waitForSelector('[data-testid="detail-panel"]');

  // Verify section details shown
  const detailPanel = page.locator('[data-testid="detail-panel"]');
  await expect(detailPanel.locator('[data-testid="section-details"]')).toBeVisible();

  // Edit section name
  const nameInput = detailPanel.locator('[data-testid="section-name-input"]');
  await expect(nameInput).toBeVisible();
  await nameInput.clear();
  await nameInput.fill('Updated Section Name');
  await nameInput.press('Tab');

  // Edit surveyor
  const surveyorInput = detailPanel.locator('[data-testid="section-surveyor-input"]');
  await surveyorInput.clear();
  await surveyorInput.fill('Jane Doe');
  await surveyorInput.press('Tab');

  // Edit date (if date picker exists)
  const dateInput = detailPanel.locator('[data-testid="section-date-input"]');
  if (await dateInput.isVisible()) {
    await dateInput.clear();
    await dateInput.fill('2024-06-15');
    await dateInput.press('Tab');
  }

  // Edit color
  const colorPicker = detailPanel.locator('[data-testid="section-color-picker"]');
  if (await colorPicker.isVisible()) {
    await colorPicker.click();
    // Select a color from palette
    const colorOption = page.locator('[data-testid="color-option-red"], [data-color="#ff0000"]').first();
    if (await colorOption.isVisible()) {
      await colorOption.click();
    }
  }

  // Verify backend call
  const updateCalls = await page.evaluate(() => (window as any).__UPDATE_SECTION_CALLS__);
  expect(updateCalls.length).toBeGreaterThan(0);

  // Verify at least name was updated
  const hasNameUpdate = updateCalls.some((call: any) =>
    call.name === 'Updated Section Name'
  );
  expect(hasNameUpdate).toBe(true);

  // Verify UI reflects changes
  await expect(sectionHeader).toContainText('Updated Section Name');
});
```

**Assertions:**
- [ ] Section details shown when section selected
- [ ] Name editable
- [ ] Surveyor editable
- [ ] Date editable
- [ ] Color editable
- [ ] Backend receives updates
- [ ] UI reflects changes

---

### Test 8.5: `should delete section with confirmation`

**Purpose:** Verify section deletion requires confirmation and handles dependent data.

**Test Code:**
```typescript
test('should delete section with confirmation', async ({ page }) => {
  // Create project with multiple sections
  await page.evaluate(() => {
    (window as any).__MOCK_PROJECT__ = {
      id: 1,
      name: 'Multi Section Project',
      sections: [
        { id: 0, name: 'Section A', shots: [{ azimuth_in: 45, azimuth_out: 225, length: 5, depth_in: 0, depth_out: 1 }] },
        { id: 1, name: 'Section B', shots: [{ azimuth_in: 90, azimuth_out: 270, length: 3, depth_in: 1, depth_out: 2 }] },
      ],
      station_merges: [],
      zero_datums: [],
      section_offsets: {}
    };
  });

  await createProject(page, 'Multi Section');

  // Track delete calls
  await page.evaluate(() => {
    (window as any).__DELETE_SECTION_CALLED__ = false;
    const originalInvoke = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      if (cmd === 'delete_section') {
        (window as any).__DELETE_SECTION_CALLED__ = true;
      }
      return originalInvoke(cmd, args);
    };
  });

  // Get initial section count
  const initialSectionCount = await page.locator('[data-testid="sections-panel"] [data-testid="section-header"]').count();
  expect(initialSectionCount).toBe(2);

  // Right-click on section for context menu
  const sectionHeader = page.locator('[data-testid="sections-panel"] [data-testid="section-header"]').first();
  await sectionHeader.click({ button: 'right' });

  // Click delete option
  const deleteOption = page.locator('[data-testid="context-menu"] [data-testid="delete-section-option"]');
  await expect(deleteOption).toBeVisible();
  await deleteOption.click();

  // Confirmation dialog should appear
  const confirmDialog = page.locator('[data-testid="confirm-delete-dialog"]');
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText(/section|delete|remove/i);

  // Should mention shots will be deleted
  await expect(confirmDialog).toContainText(/shot|data|lose/i);

  // Confirm deletion
  await confirmDialog.locator('button:has-text("Delete")').click();

  // Dialog should close
  await expect(confirmDialog).not.toBeVisible();

  // Section count should decrease
  await expect(page.locator('[data-testid="sections-panel"] [data-testid="section-header"]'))
    .toHaveCount(initialSectionCount - 1, { timeout: 5000 });

  // Verify backend called
  const deleteCalled = await page.evaluate(() => (window as any).__DELETE_SECTION_CALLED__);
  expect(deleteCalled).toBe(true);
});
```

**Assertions:**
- [ ] Context menu has delete option
- [ ] Confirmation dialog appears
- [ ] Dialog mentions data loss
- [ ] Confirm deletes section
- [ ] UI updates after deletion
- [ ] Backend receives delete command

---

### Test 8.6: `should add new shot to section`

**Purpose:** Verify users can add new shots to existing sections.

**Test Code:**
```typescript
test('should add new shot to section', async ({ page }) => {
  await createProjectWithSection(page);

  // Track create_shot calls
  await page.evaluate(() => {
    (window as any).__CREATE_SHOT_CALLS__ = [];
    const originalInvoke = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      if (cmd === 'create_shot') {
        (window as any).__CREATE_SHOT_CALLS__.push(args);
      }
      return originalInvoke(cmd, args);
    };
  });

  // Get initial shot count
  const initialShotCount = await page.locator('[data-testid="sections-panel"] [data-testid="shot-item"]').count();

  // Click add shot button in section
  const addShotBtn = page.locator('[data-testid="sections-panel"] [data-testid="add-shot-btn"]').first();
  await expect(addShotBtn).toBeVisible();
  await addShotBtn.click();

  // Add shot dialog should appear
  const addDialog = page.locator('[data-testid="add-shot-dialog"]');
  await expect(addDialog).toBeVisible();

  // Fill in shot data
  await addDialog.locator('[data-testid="new-shot-length"]').fill('4.5');
  await addDialog.locator('[data-testid="new-shot-azimuth-in"]').fill('120');
  await addDialog.locator('[data-testid="new-shot-azimuth-out"]').fill('300');
  await addDialog.locator('[data-testid="new-shot-depth-in"]').fill('2.0');
  await addDialog.locator('[data-testid="new-shot-depth-out"]').fill('3.5');

  // Select insertion position
  const positionSelect = addDialog.locator('[data-testid="shot-position"]');
  await positionSelect.selectOption('end'); // Add at end

  // Click Add button
  await addDialog.locator('button:has-text("Add")').click();

  // Dialog should close
  await expect(addDialog).not.toBeVisible();

  // Shot count should increase
  await expect(page.locator('[data-testid="sections-panel"] [data-testid="shot-item"]'))
    .toHaveCount(initialShotCount + 1, { timeout: 5000 });

  // Verify backend received correct data
  const createCalls = await page.evaluate(() => (window as any).__CREATE_SHOT_CALLS__);
  expect(createCalls.length).toBe(1);
  expect(createCalls[0].shot.length).toBeCloseTo(4.5);
  expect(createCalls[0].shot.azimuth_in).toBeCloseTo(120);
});

test('should validate new shot before adding', async ({ page }) => {
  await createProjectWithSection(page);

  const addShotBtn = page.locator('[data-testid="sections-panel"] [data-testid="add-shot-btn"]').first();
  await addShotBtn.click();

  const addDialog = page.locator('[data-testid="add-shot-dialog"]');
  await expect(addDialog).toBeVisible();

  // Fill in invalid data
  await addDialog.locator('[data-testid="new-shot-length"]').fill('0'); // Invalid
  await addDialog.locator('[data-testid="new-shot-azimuth-in"]').fill('400'); // Invalid

  // Try to add
  await addDialog.locator('button:has-text("Add")').click();

  // Dialog should stay open with validation errors
  await expect(addDialog).toBeVisible();
  await expect(addDialog.locator('[data-testid="validation-error"]')).toBeVisible();

  // Fix errors
  await addDialog.locator('[data-testid="new-shot-length"]').clear();
  await addDialog.locator('[data-testid="new-shot-length"]').fill('5.0');
  await addDialog.locator('[data-testid="new-shot-azimuth-in"]').clear();
  await addDialog.locator('[data-testid="new-shot-azimuth-in"]').fill('120');

  // Now it should work
  await addDialog.locator('button:has-text("Add")').click();
  await expect(addDialog).not.toBeVisible();
});
```

**Assertions:**
- [ ] Add shot button visible
- [ ] Add shot dialog opens
- [ ] All required fields present
- [ ] Position selection available
- [ ] Add creates shot
- [ ] Validation prevents invalid shots
- [ ] Shot count updates

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

async function createProjectWithSection(page: Page) {
  await page.evaluate(() => {
    (window as any).__MOCK_PROJECT__ = {
      id: 1,
      name: 'Test Project',
      sections: [{
        id: 0,
        name: 'Test Section',
        surveyor: 'Test Surveyor',
        date: '2024-01-15',
        color: '#4ecdc4',
        shots: [
          { azimuth_in: 45, azimuth_out: 225, length: 5.0, depth_in: 0, depth_out: 1.5, left: 1.0, right: 0.8, up: 2.0, down: 0.5 },
          { azimuth_in: 90, azimuth_out: 270, length: 3.0, depth_in: 1.5, depth_out: 2.5, left: 0.5, right: 1.2, up: 2.5, down: 0.3 },
          { azimuth_in: 60, azimuth_out: 240, length: 4.0, depth_in: 2.5, depth_out: 3.5, left: 0.8, right: 0.9, up: 1.8, down: 0.4 },
        ]
      }],
      station_merges: [],
      zero_datums: [],
      section_offsets: {}
    };
  });

  await createProject(page, 'Test Project');
}
```

---

## Verification

```bash
pnpm test:ui --grep "Section and Shot Editing"
pnpm test:ui:headed --grep "Section and Shot Editing"  # Debug with visible browser
```

## Definition of Done
- [ ] All 6 tests implemented
- [ ] Mocks updated in tauri-ipc.ts
- [ ] Tests pass in headless mode
- [ ] Shot editing tested (values, LRUD)
- [ ] Shot deletion tested
- [ ] Section metadata editing tested
- [ ] Section deletion tested
- [ ] New shot creation tested
- [ ] Validation errors tested
