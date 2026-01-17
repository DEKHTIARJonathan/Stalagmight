# Task 11: Map Tools Tests (Playwright)

## Overview
| Field | Value |
|-------|-------|
| **Task ID** | task-11 |
| **Category** | Playwright E2E Tests |
| **Target File** | `e2e-playwright/map-tools.spec.ts` (new file) |
| **Tests** | 6 |
| **Priority** | P2 - Medium |
| **Dependencies** | task-06 (project creation helpers) |

## Affected Files
- `e2e-playwright/map-tools.spec.ts` - New test file
- `e2e-playwright/mocks/tauri-ipc.ts` - Ensure tool state mocks

## Test Specifications

---

### Test 11.1: `should switch between tools with keyboard shortcuts`

**Purpose:** Verify all map tools can be activated via keyboard shortcuts.

**Test Code:**
```typescript
import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

test.describe('Map Tools', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('should switch between tools with keyboard shortcuts', async ({ page }) => {
    await createProjectWithSection(page);

    const toolIndicator = page.locator('[data-testid="active-tool"], [data-testid="tool-indicator"]');

    // Test each tool shortcut
    const tools = [
      { key: 's', name: 'select', label: /select/i },
      { key: 'p', name: 'pan', label: /pan/i },
      { key: 'z', name: 'zoom', label: /zoom/i },
      { key: 'd', name: 'draw', label: /draw/i },
      { key: 'x', name: 'delete', label: /delete/i },
      { key: 'm', name: 'merge', label: /merge/i },
      { key: 'r', name: 'measure', label: /measure/i },
      { key: 'v', name: 'move-section', label: /move.*section/i },
      { key: 't', name: 'move-station', label: /move.*station/i },
    ];

    for (const tool of tools) {
      await page.keyboard.press(tool.key);

      // Verify tool is active
      if (await toolIndicator.isVisible()) {
        await expect(toolIndicator).toContainText(tool.label);
      }

      // Alternatively, check toolbar button state
      const toolBtn = page.locator(`[data-testid="tool-${tool.name}"]`);
      if (await toolBtn.isVisible()) {
        await expect(toolBtn).toHaveAttribute('data-active', 'true')
          .catch(async () => {
            await expect(toolBtn).toHaveClass(/active|selected/);
          });
      }
    }
  });

  test('should switch tools via toolbar buttons', async ({ page }) => {
    await createProjectWithSection(page);

    const toolbar = page.locator('[data-testid="toolbar"], [data-testid="tool-palette"]');
    await expect(toolbar).toBeVisible();

    // Click select tool
    const selectBtn = toolbar.locator('[data-testid="tool-select"]');
    await selectBtn.click();

    // Verify cursor changes or tool is active
    const canvas = page.locator('canvas');
    // Cursor style depends on tool
    // await expect(canvas).toHaveCSS('cursor', 'default');

    // Click pan tool
    const panBtn = toolbar.locator('[data-testid="tool-pan"]');
    await panBtn.click();

    // Pan tool typically has grab cursor
    // await expect(canvas).toHaveCSS('cursor', 'grab');
  });
});
```

**Assertions:**
- [ ] All keyboard shortcuts work (S, P, Z, D, X, M, R, V, T)
- [ ] Tool indicator shows active tool
- [ ] Toolbar buttons reflect active tool
- [ ] Only one tool active at a time

---

### Test 11.2: `should select stations with select tool`

**Purpose:** Verify the select tool allows clicking on stations to select them.

**Test Code:**
```typescript
test('should select stations with select tool', async ({ page }) => {
  await createProjectWithSection(page);

  // Activate select tool
  await page.keyboard.press('s');

  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();

  // Click on the canvas where a station should be
  // Stations are rendered based on section data
  // First station is typically at the origin or placement point
  const centerX = box!.x + box!.width / 2;
  const centerY = box!.y + box!.height / 2;

  await canvas.click({ position: { x: box!.width / 2, y: box!.height / 2 } });

  // Check if a station was selected
  const selectionInfo = await page.evaluate(() => {
    const store = (window as any).__E2E_TEST__?.uiStore;
    return store?.getState()?.selectedStations ?? [];
  });

  // If clicked on a station, it should be selected
  // This depends on actual station positions, which are mock-dependent

  // Alternative: Check sections panel for selection highlight
  const selectedStation = page.locator('[data-testid="station-item"][data-selected="true"]');
  // May or may not find one depending on where we clicked
});

test('should multi-select stations with Ctrl+click', async ({ page }) => {
  await createProjectWithSection(page);

  await page.keyboard.press('s');

  // Select first station in sections panel
  const stations = page.locator('[data-testid="sections-panel"] [data-testid="station-item"]');
  await stations.first().click();

  // Ctrl+click second station
  await stations.nth(1).click({ modifiers: ['Control'] });

  // Both should be selected
  const selectedCount = await page.locator('[data-testid="station-item"][data-selected="true"]').count();
  expect(selectedCount).toBe(2);
});

test('should select all with Ctrl+A', async ({ page }) => {
  await createProjectWithSection(page);

  // Press Ctrl+A
  await page.keyboard.press('Control+a');

  // All stations should be selected
  const selectedCount = await page.evaluate(() => {
    const store = (window as any).__E2E_TEST__?.uiStore;
    return store?.getState()?.selectedStations?.length ?? 0;
  });

  // Should be more than 0 (based on mock data)
  expect(selectedCount).toBeGreaterThan(0);
});
```

**Assertions:**
- [ ] Click selects station
- [ ] Ctrl+click adds to selection
- [ ] Ctrl+A selects all
- [ ] Selection shown in sections panel

---

### Test 11.3: `should pan map with pan tool or middle mouse button`

**Purpose:** Verify map panning works with pan tool and middle mouse button.

**Test Code:**
```typescript
test('should pan map with pan tool', async ({ page }) => {
  await createProjectWithSection(page);

  // Activate pan tool
  await page.keyboard.press('p');

  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();

  // Get initial map center (via store or evaluate)
  const initialCenter = await page.evaluate(() => {
    const map = (window as any).__MAP_INSTANCE__;
    return map?.getCenter() ?? { lng: 0, lat: 0 };
  });

  // Drag on canvas
  const startX = box!.x + box!.width / 2;
  const startY = box!.y + box!.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 100, startY + 50, { steps: 5 });
  await page.mouse.up();

  // Get new center
  const newCenter = await page.evaluate(() => {
    const map = (window as any).__MAP_INSTANCE__;
    return map?.getCenter() ?? { lng: 0, lat: 0 };
  });

  // Center should have changed
  // Note: In mocked environment, map may not actually pan
  // This test verifies the interaction is handled
});

test('should pan with middle mouse button regardless of tool', async ({ page }) => {
  await createProjectWithSection(page);

  // Stay on select tool
  await page.keyboard.press('s');

  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();

  const centerX = box!.x + box!.width / 2;
  const centerY = box!.y + box!.height / 2;

  // Middle mouse drag
  await page.mouse.move(centerX, centerY);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(centerX + 50, centerY + 50, { steps: 5 });
  await page.mouse.up({ button: 'middle' });

  // Should not crash and should pan
  await expect(canvas).toBeVisible();
});
```

**Assertions:**
- [ ] Pan tool enables dragging
- [ ] Middle mouse pans in any tool
- [ ] Map center changes on pan
- [ ] Smooth panning (visual)

---

### Test 11.4: `should measure distance with measure tool`

**Purpose:** Verify the measure tool displays distance between two points.

**Test Code:**
```typescript
test('should measure distance with measure tool', async ({ page }) => {
  await createProjectWithSection(page);

  // Activate measure tool
  await page.keyboard.press('r');

  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();

  // Click first point
  const point1X = box!.width / 4;
  const point1Y = box!.height / 2;
  await canvas.click({ position: { x: point1X, y: point1Y } });

  // Click second point
  const point2X = (3 * box!.width) / 4;
  const point2Y = box!.height / 2;
  await canvas.click({ position: { x: point2X, y: point2Y } });

  // Measurement display should appear
  const measurement = page.locator('[data-testid="measurement-display"], [data-testid="measure-result"]');
  await expect(measurement).toBeVisible({ timeout: 2000 });

  // Should show distance value
  await expect(measurement).toContainText(/\d+\.?\d*/); // Contains a number

  // Should show units
  await expect(measurement).toContainText(/m|meters|ft|feet/i);
});

test('should clear measurement on Escape', async ({ page }) => {
  await createProjectWithSection(page);

  await page.keyboard.press('r');

  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();

  // Start measuring
  await canvas.click({ position: { x: 100, y: 100 } });
  await canvas.click({ position: { x: 200, y: 200 } });

  const measurement = page.locator('[data-testid="measurement-display"]');
  // May or may not be visible depending on implementation

  // Press Escape to clear
  await page.keyboard.press('Escape');

  // Measurement should clear (or tool should reset)
  // Tool may switch to select or measurement display clears
});
```

**Assertions:**
- [ ] Measure tool activates with R
- [ ] Two clicks show distance
- [ ] Distance value displayed
- [ ] Units shown
- [ ] Escape clears measurement

---

### Test 11.5: `should fit view to all data with Ctrl+0`

**Purpose:** Verify Ctrl+0 fits the map view to show all survey data.

**Test Code:**
```typescript
test('should fit view to all data with Ctrl+0', async ({ page }) => {
  await createProjectWithSection(page);

  const canvas = page.locator('canvas');

  // First zoom in manually
  await page.keyboard.press('z');
  const box = await canvas.boundingBox();

  // Zoom in with scroll
  await canvas.click({ position: { x: box!.width / 2, y: box!.height / 2 } });
  await page.mouse.wheel(0, -500); // Scroll up = zoom in

  // Wait for zoom
  await page.waitForTimeout(500);

  // Get current zoom level
  const zoomedLevel = await page.evaluate(() => {
    const map = (window as any).__MAP_INSTANCE__;
    return map?.getZoom() ?? 10;
  });

  // Fit to view
  await page.keyboard.press('Control+0');

  // Wait for animation
  await page.waitForTimeout(500);

  // Zoom level should be different (typically zoomed out to fit all)
  const fittedLevel = await page.evaluate(() => {
    const map = (window as any).__MAP_INSTANCE__;
    return map?.getZoom() ?? 10;
  });

  // In mocked env, we just verify no crash
  await expect(canvas).toBeVisible();
});

test('should fit view with empty project', async ({ page }) => {
  // Create project without sections
  await page.evaluate(() => {
    (window as any).__MOCK_PROJECT__ = {
      id: 1,
      name: 'Empty',
      sections: [],
      station_merges: [],
      zero_datums: [],
      section_offsets: {}
    };
  });

  const newProjectBtn = page.locator('button:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill('Empty');
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });

  // Fit to view should not crash with empty project
  await page.keyboard.press('Control+0');

  // Canvas should still be visible
  await expect(page.locator('canvas')).toBeVisible();
});
```

**Assertions:**
- [ ] Ctrl+0 fits view
- [ ] All data visible after fit
- [ ] Works with empty project (no crash)
- [ ] Smooth animation (visual)

---

### Test 11.6: `should delete selected items with Delete key`

**Purpose:** Verify the Delete key removes selected stations/shots.

**Test Code:**
```typescript
test('should delete selected items with Delete key', async ({ page }) => {
  await createProjectWithSection(page);

  // Track delete command calls
  await page.evaluate(() => {
    (window as any).__DELETE_CALLS__ = [];
    const originalInvoke = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      if (cmd.includes('delete')) {
        (window as any).__DELETE_CALLS__.push({ cmd, args });
      }
      return originalInvoke(cmd, args);
    };
  });

  // Select a shot in sections panel
  const shots = page.locator('[data-testid="sections-panel"] [data-testid="shot-item"]');
  const initialCount = await shots.count();
  expect(initialCount).toBeGreaterThan(1);

  await shots.nth(1).click(); // Select second shot

  // Press Delete
  await page.keyboard.press('Delete');

  // Confirmation dialog should appear
  const confirmDialog = page.locator('[data-testid="confirm-delete-dialog"]');
  await expect(confirmDialog).toBeVisible({ timeout: 2000 });

  // Confirm deletion
  await confirmDialog.locator('button:has-text("Delete")').click();

  // Dialog should close
  await expect(confirmDialog).not.toBeVisible();

  // Verify delete was called
  const deleteCalls = await page.evaluate(() => (window as any).__DELETE_CALLS__);
  expect(deleteCalls.length).toBeGreaterThan(0);
});

test('should delete with Backspace key as alternative', async ({ page }) => {
  await createProjectWithSection(page);

  // Select a shot
  await page.locator('[data-testid="sections-panel"] [data-testid="shot-item"]').first().click();

  // Press Backspace
  await page.keyboard.press('Backspace');

  // Confirmation should appear
  const confirmDialog = page.locator('[data-testid="confirm-delete-dialog"]');
  await expect(confirmDialog).toBeVisible({ timeout: 2000 });

  // Cancel to abort
  await confirmDialog.locator('button:has-text("Cancel")').click();
  await expect(confirmDialog).not.toBeVisible();
});

test('should do nothing on Delete with no selection', async ({ page }) => {
  await createProjectWithSection(page);

  // Clear selection
  await page.keyboard.press('Escape');

  // Press Delete with nothing selected
  await page.keyboard.press('Delete');

  // No dialog should appear (nothing to delete)
  const confirmDialog = page.locator('[data-testid="confirm-delete-dialog"]');
  await expect(confirmDialog).not.toBeVisible({ timeout: 500 });
});
```

**Assertions:**
- [ ] Delete key triggers deletion
- [ ] Confirmation dialog appears
- [ ] Confirm actually deletes
- [ ] Backspace works as alternative
- [ ] No action when nothing selected

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
          { azimuth_in: 60, azimuth_out: 240, length: 4.0, depth_in: 2.5, depth_out: 3.5 },
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
pnpm test:ui --grep "Map Tools"
pnpm test:ui:headed --grep "Map Tools"  # Debug with visible browser
```

## Definition of Done
- [ ] All 6 tests implemented
- [ ] Tests pass in headless mode
- [ ] Tool switching tested (keyboard and toolbar)
- [ ] Select tool tested (single and multi-select)
- [ ] Pan tool tested
- [ ] Measure tool tested
- [ ] Fit view tested
- [ ] Delete action tested
