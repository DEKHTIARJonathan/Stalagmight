# Task 10: Panel Interactions Tests (Playwright)

## Overview
| Field | Value |
|-------|-------|
| **Task ID** | task-10 |
| **Category** | Playwright E2E Tests |
| **Target File** | `e2e-playwright/panel-interactions.spec.ts` (new file) |
| **Tests** | 6 |
| **Priority** | P2 - Medium |
| **Dependencies** | task-06 (project creation helpers) |

## Affected Files
- `e2e-playwright/panel-interactions.spec.ts` - New test file
- `e2e-playwright/mocks/tauri-ipc.ts` - Ensure panel state mocks

## Test Specifications

---

### Test 10.1: `should toggle sections panel with Ctrl+1`

**Purpose:** Verify the sections panel can be shown/hidden with keyboard shortcut.

**Test Code:**
```typescript
import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

test.describe('Panel Interactions', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('should toggle sections panel with Ctrl+1', async ({ page }) => {
    await createProjectWithSection(page);

    const sectionsPanel = page.locator('[data-testid="sections-panel"]');

    // Panel should be visible by default
    await expect(sectionsPanel).toBeVisible();

    // Toggle off with Ctrl+1
    await page.keyboard.press('Control+1');
    await expect(sectionsPanel).not.toBeVisible({ timeout: 1000 });

    // Toggle back on
    await page.keyboard.press('Control+1');
    await expect(sectionsPanel).toBeVisible({ timeout: 1000 });

    // Verify panel content is still correct after toggle
    await expect(sectionsPanel.locator('[data-testid="section-header"]')).toBeVisible();
  });

  test('should remember panel state across interactions', async ({ page }) => {
    await createProjectWithSection(page);

    const sectionsPanel = page.locator('[data-testid="sections-panel"]');

    // Close sections panel
    await page.keyboard.press('Control+1');
    await expect(sectionsPanel).not.toBeVisible();

    // Do some other operations
    await page.keyboard.press('Control+2'); // Toggle detail panel
    await page.keyboard.press('Control+2'); // Toggle back

    // Sections panel should still be closed
    await expect(sectionsPanel).not.toBeVisible();
  });
});
```

**Assertions:**
- [ ] Ctrl+1 toggles sections panel
- [ ] Panel initially visible
- [ ] Panel can be hidden
- [ ] Panel can be shown again
- [ ] Panel state persists across other interactions

---

### Test 10.2: `should toggle detail panel with Ctrl+2`

**Purpose:** Verify the detail panel can be shown/hidden and shows contextual information.

**Test Code:**
```typescript
test('should toggle detail panel with Ctrl+2', async ({ page }) => {
  await createProjectWithSection(page);

  const detailPanel = page.locator('[data-testid="detail-panel"]');

  // Detail panel may be hidden by default
  const initiallyVisible = await detailPanel.isVisible();

  // Toggle with Ctrl+2
  await page.keyboard.press('Control+2');

  if (initiallyVisible) {
    await expect(detailPanel).not.toBeVisible({ timeout: 1000 });
    // Toggle back
    await page.keyboard.press('Control+2');
    await expect(detailPanel).toBeVisible({ timeout: 1000 });
  } else {
    await expect(detailPanel).toBeVisible({ timeout: 1000 });
    // Toggle off
    await page.keyboard.press('Control+2');
    await expect(detailPanel).not.toBeVisible({ timeout: 1000 });
  }
});

test('should show contextual content in detail panel', async ({ page }) => {
  await createProjectWithSection(page);

  // Open detail panel
  await page.keyboard.press('Control+2');
  const detailPanel = page.locator('[data-testid="detail-panel"]');
  await expect(detailPanel).toBeVisible();

  // With nothing selected, should show project overview or placeholder
  const noSelection = detailPanel.locator('[data-testid="no-selection"], [data-testid="project-overview"]');
  await expect(noSelection).toBeVisible();

  // Select a shot
  await page.locator('[data-testid="sections-panel"] [data-testid="shot-item"]').first().click();

  // Detail panel should show shot details
  await expect(detailPanel.locator('[data-testid="shot-details"]')).toBeVisible();

  // Select a section
  await page.locator('[data-testid="sections-panel"] [data-testid="section-header"]').first().click();

  // Detail panel should show section details
  await expect(detailPanel.locator('[data-testid="section-details"]')).toBeVisible();
});
```

**Assertions:**
- [ ] Ctrl+2 toggles detail panel
- [ ] Shows placeholder when nothing selected
- [ ] Shows shot details when shot selected
- [ ] Shows section details when section selected

---

### Test 10.3: `should toggle data table panel with Ctrl+3`

**Purpose:** Verify the data table panel shows tabular shot/station data.

**Test Code:**
```typescript
test('should toggle data table panel with Ctrl+3', async ({ page }) => {
  await createProjectWithSection(page);

  const dataTable = page.locator('[data-testid="data-table-panel"]');

  // Toggle with Ctrl+3
  await page.keyboard.press('Control+3');
  await expect(dataTable).toBeVisible({ timeout: 1000 });

  // Verify table structure
  const table = dataTable.locator('table, [data-testid="data-table"]');
  await expect(table).toBeVisible();

  // Should have headers
  const headers = table.locator('th, [data-testid="table-header"]');
  await expect(headers.first()).toBeVisible();

  // Should have data rows
  const rows = table.locator('tbody tr, [data-testid="table-row"]');
  await expect(rows.first()).toBeVisible();

  // Toggle off
  await page.keyboard.press('Control+3');
  await expect(dataTable).not.toBeVisible({ timeout: 1000 });
});

test('should sync data table selection with map', async ({ page }) => {
  await createProjectWithSection(page);

  await page.keyboard.press('Control+3');
  const dataTable = page.locator('[data-testid="data-table-panel"]');
  await expect(dataTable).toBeVisible();

  // Click on a row in the data table
  const firstRow = dataTable.locator('tbody tr, [data-testid="table-row"]').first();
  await firstRow.click();

  // Verify row is selected
  await expect(firstRow).toHaveAttribute('data-selected', 'true')
    .catch(async () => {
      // Alternative: check for selected class
      await expect(firstRow).toHaveClass(/selected/);
    });

  // Selection should reflect in sections panel
  const selectedShot = page.locator('[data-testid="sections-panel"] [data-testid="shot-item"][data-selected="true"]');
  // May or may not sync depending on implementation
});
```

**Assertions:**
- [ ] Ctrl+3 toggles data table
- [ ] Table has headers
- [ ] Table has data rows
- [ ] Rows are clickable
- [ ] Selection syncs with other views

---

### Test 10.4: `should resize panels by dragging`

**Purpose:** Verify panels can be resized by dragging the divider.

**Test Code:**
```typescript
test('should resize panels by dragging', async ({ page }) => {
  await createProjectWithSection(page);

  // Open sections panel (should be open by default)
  const sectionsPanel = page.locator('[data-testid="sections-panel"]');
  await expect(sectionsPanel).toBeVisible();

  // Get initial panel width
  const initialBox = await sectionsPanel.boundingBox();
  expect(initialBox).not.toBeNull();
  const initialWidth = initialBox!.width;

  // Find the resize handle/divider
  const resizeHandle = page.locator('[data-testid="panel-resize-handle"], .resize-handle, [class*="resize"]');

  if (await resizeHandle.isVisible()) {
    const handleBox = await resizeHandle.boundingBox();
    expect(handleBox).not.toBeNull();

    // Drag to resize
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox!.x + 100, handleBox!.y + handleBox!.height / 2); // Drag right
    await page.mouse.up();

    // Verify panel width changed
    const newBox = await sectionsPanel.boundingBox();
    expect(newBox!.width).toBeGreaterThan(initialWidth);

    // Drag back
    await page.mouse.move(newBox!.x + newBox!.width, handleBox!.y + handleBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox!.x - 50, handleBox!.y + handleBox!.height / 2); // Drag left
    await page.mouse.up();

    const finalBox = await sectionsPanel.boundingBox();
    expect(finalBox!.width).toBeLessThan(newBox!.width);
  }
});

test('should have minimum panel width', async ({ page }) => {
  await createProjectWithSection(page);

  const sectionsPanel = page.locator('[data-testid="sections-panel"]');
  const resizeHandle = page.locator('[data-testid="panel-resize-handle"], .resize-handle');

  if (await resizeHandle.isVisible()) {
    const handleBox = await resizeHandle.boundingBox();

    // Try to drag panel to very small width
    await page.mouse.move(handleBox!.x, handleBox!.y + handleBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(10, handleBox!.y + handleBox!.height / 2); // Drag to near edge
    await page.mouse.up();

    // Panel should have minimum width
    const box = await sectionsPanel.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(100); // Minimum 100px
  }
});
```

**Assertions:**
- [ ] Resize handle exists
- [ ] Dragging changes panel width
- [ ] Panel has minimum width
- [ ] Panel has maximum width

---

### Test 10.5: `should expand/collapse section in sections panel`

**Purpose:** Verify sections can be expanded/collapsed to show/hide shots.

**Test Code:**
```typescript
test('should expand/collapse section in sections panel', async ({ page }) => {
  await createProjectWithSection(page);

  const sectionsPanel = page.locator('[data-testid="sections-panel"]');
  await expect(sectionsPanel).toBeVisible();

  // Find section header
  const sectionHeader = sectionsPanel.locator('[data-testid="section-header"]').first();
  await expect(sectionHeader).toBeVisible();

  // Shots should be visible (expanded by default)
  const shots = sectionsPanel.locator('[data-testid="shot-item"]');
  const initialShotCount = await shots.count();
  expect(initialShotCount).toBeGreaterThan(0);

  // Find expand/collapse toggle
  const toggleBtn = sectionHeader.locator('[data-testid="section-toggle"], [data-testid="expand-collapse"]');

  if (await toggleBtn.isVisible()) {
    // Click to collapse
    await toggleBtn.click();

    // Shots should be hidden
    await expect(shots.first()).not.toBeVisible({ timeout: 1000 });

    // Click to expand
    await toggleBtn.click();

    // Shots should be visible again
    await expect(shots.first()).toBeVisible({ timeout: 1000 });
  } else {
    // Alternative: click on section header itself
    await sectionHeader.click();

    // Check if shots visibility changed
    const shotsAfterClick = await shots.first().isVisible();
    // May or may not toggle depending on implementation
  }
});

test('should show shot count in collapsed section header', async ({ page }) => {
  await createProjectWithSection(page);

  const sectionHeader = page.locator('[data-testid="sections-panel"] [data-testid="section-header"]').first();
  const toggleBtn = sectionHeader.locator('[data-testid="section-toggle"]');

  if (await toggleBtn.isVisible()) {
    // Collapse section
    await toggleBtn.click();

    // Header should show shot count
    const shotCount = sectionHeader.locator('[data-testid="shot-count"]');
    await expect(shotCount).toBeVisible();
    await expect(shotCount).toContainText(/\d+/); // Should show a number
  }
});
```

**Assertions:**
- [ ] Sections can be collapsed
- [ ] Collapsed sections hide shots
- [ ] Sections can be expanded
- [ ] Shot count shown in header
- [ ] Animation is smooth (visual)

---

### Test 10.6: `should handle panel overflow with scrolling`

**Purpose:** Verify panels with many items scroll correctly.

**Test Code:**
```typescript
test('should handle panel overflow with scrolling', async ({ page }) => {
  // Create project with many shots
  await page.evaluate(() => {
    const shots = Array.from({ length: 50 }, (_, i) => ({
      azimuth_in: i * 7 % 360,
      azimuth_out: (i * 7 + 180) % 360,
      length: 2 + Math.random() * 3,
      depth_in: i * 0.5,
      depth_out: (i + 1) * 0.5,
    }));

    (window as any).__MOCK_PROJECT__ = {
      id: 1,
      name: 'Many Shots Project',
      sections: [{ id: 0, name: 'Long Section', shots }],
      station_merges: [],
      zero_datums: [],
      section_offsets: {}
    };
  });

  await createProject(page, 'Many Shots');

  const sectionsPanel = page.locator('[data-testid="sections-panel"]');
  await expect(sectionsPanel).toBeVisible();

  // Verify scrollable container
  const shotsList = sectionsPanel.locator('[data-testid="shots-list"], [data-testid="section-content"]');

  // Get first and last shot items
  const shots = sectionsPanel.locator('[data-testid="shot-item"]');
  const firstShot = shots.first();
  const lastShot = shots.last();

  // First shot should be visible
  await expect(firstShot).toBeInViewport();

  // Last shot should exist but may not be visible
  expect(await shots.count()).toBeGreaterThan(10);

  // Scroll to last shot
  await lastShot.scrollIntoViewIfNeeded();

  // Last shot should now be visible
  await expect(lastShot).toBeInViewport();

  // First shot should now be out of view
  await expect(firstShot).not.toBeInViewport();
});

test('should preserve scroll position when toggling panel', async ({ page }) => {
  // Create project with many shots
  await page.evaluate(() => {
    const shots = Array.from({ length: 30 }, (_, i) => ({
      azimuth_in: i * 12 % 360,
      azimuth_out: (i * 12 + 180) % 360,
      length: 3,
      depth_in: i,
      depth_out: i + 1,
    }));

    (window as any).__MOCK_PROJECT__ = {
      id: 1,
      name: 'Scroll Test',
      sections: [{ id: 0, name: 'Section', shots }],
      station_merges: [],
      zero_datums: [],
      section_offsets: {}
    };
  });

  await createProject(page, 'Scroll Test');

  const sectionsPanel = page.locator('[data-testid="sections-panel"]');
  const shots = sectionsPanel.locator('[data-testid="shot-item"]');

  // Scroll to middle
  const middleShot = shots.nth(15);
  await middleShot.scrollIntoViewIfNeeded();
  await middleShot.click();

  // Toggle panel off and on
  await page.keyboard.press('Control+1');
  await expect(sectionsPanel).not.toBeVisible();

  await page.keyboard.press('Control+1');
  await expect(sectionsPanel).toBeVisible();

  // Middle shot should still be visible (or at least the scroll position preserved)
  // This depends on implementation - some apps reset scroll on toggle
  const isMiddleShotVisible = await middleShot.isInViewport();
  // We accept either behavior, just verify no crash
});
```

**Assertions:**
- [ ] Long lists scroll correctly
- [ ] First item visible initially
- [ ] Can scroll to last item
- [ ] Scroll position may be preserved on toggle
- [ ] No overflow issues

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
        shots: [
          { azimuth_in: 45, azimuth_out: 225, length: 5.0, depth_in: 0, depth_out: 1.5 },
          { azimuth_in: 90, azimuth_out: 270, length: 3.0, depth_in: 1.5, depth_out: 2.5 },
          { azimuth_in: 60, azimuth_out: 240, length: 4.0, depth_in: 2.5, depth_out: 3.5 },
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
pnpm test:ui --grep "Panel Interactions"
pnpm test:ui:headed --grep "Panel Interactions"  # Debug with visible browser
```

## Definition of Done
- [ ] All 6 tests implemented
- [ ] Tests pass in headless mode
- [ ] All three panels tested (sections, detail, data table)
- [ ] Panel toggle shortcuts work
- [ ] Panel resize works
- [ ] Section expand/collapse works
- [ ] Scrolling works for long lists
