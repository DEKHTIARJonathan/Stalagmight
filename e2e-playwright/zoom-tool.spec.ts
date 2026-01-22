import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

/**
 * Helper to wait for the MapLibre map to be ready.
 */
async function waitForMap(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const map = (window as unknown as { __cavechef_map__?: { loaded: () => boolean; getZoom: () => number } }).__cavechef_map__;
      return map && map.loaded() && typeof map.getZoom() === 'number';
    },
    { timeout: 10000 }
  );
}

/**
 * Helper to create a new project and get to SingleSystemView with map canvas.
 */
async function createProjectWithMap(page: Page): Promise<void> {
  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill('Zoom Tool Test');
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });
  // Wait for map to be fully ready
  await waitForMap(page);
}

/**
 * Helper to get the current map zoom level. Returns null if map is not ready.
 */
async function getMapZoom(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const map = (window as unknown as { __cavechef_map__?: { getZoom: () => number } }).__cavechef_map__;
    return map?.getZoom() ?? null;
  });
}

/**
 * Helper to get the current map center. Returns null if map is not ready.
 */
async function getMapCenter(page: Page): Promise<{ lng: number; lat: number } | null> {
  return page.evaluate(() => {
    const map = (window as unknown as { __cavechef_map__?: { getCenter: () => { lng: number; lat: number } } }).__cavechef_map__;
    const center = map?.getCenter();
    return center ? { lng: center.lng, lat: center.lat } : null;
  });
}

/**
 * Helper to wait for zoom to change from a starting value.
 */
async function waitForZoomChange(page: Page, startZoom: number, direction: 'in' | 'out'): Promise<number> {
  await page.waitForFunction(
    ({ start, dir }) => {
      const map = (window as unknown as { __cavechef_map__?: { getZoom: () => number } }).__cavechef_map__;
      const current = map?.getZoom();
      if (typeof current !== 'number') return false;
      return dir === 'in' ? current > start : current < start;
    },
    { start: startZoom, dir: direction },
    { timeout: 5000 }
  );
  const zoom = await getMapZoom(page);
  expect(zoom).not.toBeNull();
  return zoom as number;
}

test.describe('Zoom Tool', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProjectWithMap(page);
  });

  test.describe('Click Zoom', () => {
    test('left-click zooms in', async ({ page }) => {
      // Switch to zoom tool
      await page.keyboard.press('z');
      await page.waitForTimeout(50);

      const canvas = page.locator('canvas').first();
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();

      const initialZoom = await getMapZoom(page);
      expect(initialZoom).not.toBeNull();

      // Left click to zoom in
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);

      // Wait for zoom to change
      const newZoom = await waitForZoomChange(page, initialZoom!, 'in');
      expect(newZoom).toBeGreaterThan(initialZoom!);
    });

    test('right-click zooms out', async ({ page }) => {
      // Switch to zoom tool
      await page.keyboard.press('z');
      await page.waitForTimeout(50);

      const canvas = page.locator('canvas').first();
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();

      // First zoom in a bit so we can zoom out
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.waitForTimeout(400);

      const initialZoom = await getMapZoom(page);
      expect(initialZoom).not.toBeNull();

      // Right click to zoom out
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, { button: 'right' });

      // Wait for zoom to change
      const newZoom = await waitForZoomChange(page, initialZoom!, 'out');
      expect(newZoom).toBeLessThan(initialZoom!);
    });

    test('right-click does not show context menu', async ({ page }) => {
      // Switch to zoom tool
      await page.keyboard.press('z');
      await page.waitForTimeout(50);

      const canvas = page.locator('canvas').first();
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();

      const initialZoom = await getMapZoom(page);
      expect(initialZoom).not.toBeNull();

      // Right click should zoom out, not show context menu
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, { button: 'right' });

      // Wait for zoom to change (proves context menu didn't interfere with zoom)
      const newZoom = await waitForZoomChange(page, initialZoom!, 'out');
      expect(newZoom).toBeLessThan(initialZoom!);

      // Verify no context menu in UI store (more reliable than selector)
      const hasContextMenu = await page.evaluate(() => {
        const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { activeDialog: string | null } } } }).__E2E_TEST__;
        return stores?.uiStore?.getState()?.activeDialog === 'context-menu';
      });
      expect(hasContextMenu).toBe(false);
    });

    test('click at zoom 22 (max) is ignored', async ({ page }) => {
      // Switch to zoom tool
      await page.keyboard.press('z');
      await page.waitForTimeout(50);

      const canvas = page.locator('canvas').first();
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();

      // Set zoom to max (22)
      await page.evaluate(() => {
        const map = (window as unknown as { __cavechef_map__?: { setZoom: (z: number) => void } }).__cavechef_map__;
        map?.setZoom(22);
      });
      await page.waitForTimeout(100);

      const centerBefore = await getMapCenter(page);
      expect(centerBefore).not.toBeNull();

      // Left click should be ignored at max zoom (no recenter either)
      await page.mouse.click(box!.x + box!.width / 2 + 50, box!.y + box!.height / 2 + 50);
      await page.waitForTimeout(400);

      const zoomAfter = await getMapZoom(page);
      const centerAfter = await getMapCenter(page);
      expect(zoomAfter).not.toBeNull();
      expect(centerAfter).not.toBeNull();

      expect(zoomAfter).toBe(22);
      // Center should not change (click ignored entirely)
      expect(Math.abs(centerAfter!.lng - centerBefore!.lng)).toBeLessThan(0.001);
      expect(Math.abs(centerAfter!.lat - centerBefore!.lat)).toBeLessThan(0.001);
    });

    test('right-click at zoom 1 (min) is ignored', async ({ page }) => {
      // Switch to zoom tool
      await page.keyboard.press('z');
      await page.waitForTimeout(50);

      const canvas = page.locator('canvas').first();
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();

      // Set zoom to min (1 per mock config)
      await page.evaluate(() => {
        const map = (window as unknown as { __cavechef_map__?: { setZoom: (z: number) => void } }).__cavechef_map__;
        map?.setZoom(1);
      });
      await page.waitForTimeout(100);

      const centerBefore = await getMapCenter(page);
      expect(centerBefore).not.toBeNull();

      // Right click should be ignored at min zoom (no recenter either)
      await page.mouse.click(box!.x + box!.width / 2 + 50, box!.y + box!.height / 2 + 50, { button: 'right' });
      await page.waitForTimeout(400);

      const zoomAfter = await getMapZoom(page);
      const centerAfter = await getMapCenter(page);
      expect(zoomAfter).not.toBeNull();
      expect(centerAfter).not.toBeNull();

      expect(zoomAfter).toBe(1);
      // Center should not change (click ignored entirely)
      expect(Math.abs(centerAfter!.lng - centerBefore!.lng)).toBeLessThan(0.001);
      expect(Math.abs(centerAfter!.lat - centerBefore!.lat)).toBeLessThan(0.001);
    });
  });

  test.describe('Box Zoom', () => {
    test('drag draws rectangle overlay', async ({ page }) => {
      // Switch to zoom tool
      await page.keyboard.press('z');
      await page.waitForTimeout(50);

      const canvas = page.locator('canvas').first();
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();

      // Start drag
      await page.mouse.move(box!.x + 100, box!.y + 100);
      await page.mouse.down();
      await page.mouse.move(box!.x + 200, box!.y + 200);

      // Box zoom overlay should be visible
      const overlay = page.locator('[data-testid="zoom-box-overlay"]');
      await expect(overlay).toBeVisible();

      // Release
      await page.mouse.up();
    });

    test('escape cancels box zoom', async ({ page }) => {
      // Switch to zoom tool
      await page.keyboard.press('z');
      await page.waitForTimeout(50);

      const canvas = page.locator('canvas').first();
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();

      const initialZoom = await getMapZoom(page);
      expect(initialZoom).not.toBeNull();

      // Start drag
      await page.mouse.move(box!.x + 100, box!.y + 100);
      await page.mouse.down();
      await page.mouse.move(box!.x + 200, box!.y + 200);

      // Box zoom overlay should be visible
      const overlay = page.locator('[data-testid="zoom-box-overlay"]');
      await expect(overlay).toBeVisible();

      // Press Escape to cancel
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);

      // Overlay should be gone
      await expect(overlay).not.toBeVisible();

      // Release mouse
      await page.mouse.up();
      await page.waitForTimeout(400);

      // Zoom should not have changed
      const finalZoom = await getMapZoom(page);
      expect(finalZoom).not.toBeNull();
      expect(Math.abs(finalZoom! - initialZoom!)).toBeLessThan(0.1);
    });

    test('small drag (<10px) treated as click', async ({ page }) => {
      // Switch to zoom tool
      await page.keyboard.press('z');
      await page.waitForTimeout(50);

      const canvas = page.locator('canvas').first();
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();

      const initialZoom = await getMapZoom(page);
      expect(initialZoom).not.toBeNull();

      // Small drag (less than 10px)
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.down();
      await page.mouse.move(box!.x + box!.width / 2 + 5, box!.y + box!.height / 2 + 5);
      await page.mouse.up();

      // Wait for zoom to change (treated as click)
      const finalZoom = await waitForZoomChange(page, initialZoom!, 'in');
      expect(finalZoom).toBeGreaterThan(initialZoom!);
    });

    test('Ctrl+drag pans instead of box zoom', async ({ page }) => {
      // Switch to zoom tool
      await page.keyboard.press('z');
      await page.waitForTimeout(50);

      const canvas = page.locator('canvas').first();
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();

      const initialZoom = await getMapZoom(page);
      const initialCenter = await getMapCenter(page);
      expect(initialZoom).not.toBeNull();
      expect(initialCenter).not.toBeNull();

      // Ctrl+drag should pan, not box zoom
      await page.keyboard.down('Control');
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.down();
      await page.mouse.move(box!.x + box!.width / 2 + 100, box!.y + box!.height / 2 + 100);

      // Box zoom overlay should NOT be visible
      const overlay = page.locator('[data-testid="zoom-box-overlay"]');
      await expect(overlay).not.toBeVisible();

      await page.mouse.up();
      await page.keyboard.up('Control');
      await page.waitForTimeout(200);

      // Zoom should not have changed
      const finalZoom = await getMapZoom(page);
      expect(finalZoom).not.toBeNull();
      expect(Math.abs(finalZoom! - initialZoom!)).toBeLessThan(0.1);

      // Center should have changed (panned)
      const finalCenter = await getMapCenter(page);
      expect(finalCenter).not.toBeNull();
      const centerChanged = Math.abs(finalCenter!.lng - initialCenter!.lng) > 0.0001 ||
                            Math.abs(finalCenter!.lat - initialCenter!.lat) > 0.0001;
      expect(centerChanged).toBe(true);
    });
  });

  test.describe('Cursor', () => {
    test('shows zoom-in cursor when zoom tool is active', async ({ page }) => {
      // Switch to zoom tool
      await page.keyboard.press('z');
      await page.waitForTimeout(50);

      const cursor = await page.evaluate(() => {
        const map = (window as unknown as { __cavechef_map__?: { getCanvas: () => HTMLCanvasElement } }).__cavechef_map__;
        return map?.getCanvas()?.style.cursor ?? null;
      });
      expect(cursor).not.toBeNull();
      expect(cursor).toBe('zoom-in');
    });

    test('cursor stays zoom-in when hovering over map', async ({ page }) => {
      // Switch to zoom tool
      await page.keyboard.press('z');
      await page.waitForTimeout(50);

      const canvas = page.locator('canvas').first();
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();

      // Move mouse over different parts of the canvas
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.waitForTimeout(100);

      // Cursor should still be zoom-in (not pointer like with select tool)
      const cursor = await page.evaluate(() => {
        const map = (window as unknown as { __cavechef_map__?: { getCanvas: () => HTMLCanvasElement } }).__cavechef_map__;
        return map?.getCanvas()?.style.cursor ?? null;
      });
      expect(cursor).not.toBeNull();
      expect(cursor).toBe('zoom-in');
    });
  });

  test.describe('Keyboard Shortcuts', () => {
    test('= key zooms in', async ({ page }) => {
      const initialZoom = await getMapZoom(page);
      expect(initialZoom).not.toBeNull();

      // Press = to zoom in
      await page.keyboard.press('=');

      // Wait for zoom to change
      const newZoom = await waitForZoomChange(page, initialZoom!, 'in');
      expect(newZoom).toBeGreaterThan(initialZoom!);
      // Should zoom in (direction verified above, exact step may vary by animation)
    });

    test('- key zooms out', async ({ page }) => {
      // First zoom in a bit
      const beforeZoomIn = await getMapZoom(page);
      expect(beforeZoomIn).not.toBeNull();

      await page.keyboard.press('=');
      await waitForZoomChange(page, beforeZoomIn!, 'in');

      const initialZoom = await getMapZoom(page);
      expect(initialZoom).not.toBeNull();

      // Press - to zoom out
      await page.keyboard.press('-');

      // Wait for zoom to change
      const newZoom = await waitForZoomChange(page, initialZoom!, 'out');
      expect(newZoom).toBeLessThan(initialZoom!);
      // Should zoom out (direction verified above, exact step may vary by animation)
    });

    test('keyboard zoom works regardless of active tool', async ({ page }) => {
      // Switch to select tool
      await page.keyboard.press('s');
      await page.waitForTimeout(50);

      const initialZoom = await getMapZoom(page);
      expect(initialZoom).not.toBeNull();

      // Press = to zoom in (should work even in select mode)
      await page.keyboard.press('=');

      // Wait for zoom to change
      const newZoom = await waitForZoomChange(page, initialZoom!, 'in');
      expect(newZoom).toBeGreaterThan(initialZoom!);
    });
  });

  test.describe('Toolbar Interaction', () => {
    test('clicking zoom button in toolbar activates zoom tool', async ({ page }) => {
      // First ensure we're not in zoom mode by switching to select
      await page.keyboard.press('s');
      await page.waitForTimeout(50);

      const selectButton = page.locator('button[title="Select (S)"]');
      await expect(selectButton).toHaveClass(/ring-accent/);

      // Click the zoom button in toolbar
      const zoomButton = page.locator('button[title="Zoom (Z)"]');
      await zoomButton.click();
      await page.waitForTimeout(50);

      // Verify zoom tool is now active
      await expect(zoomButton).toHaveClass(/ring-accent/);
      await expect(selectButton).not.toHaveClass(/ring-accent/);
    });

    test('switching between tools via toolbar updates cursor', async ({ page }) => {
      // Start in select mode
      await page.keyboard.press('s');
      await page.waitForTimeout(50);

      // Verify select cursor
      let cursor = await page.evaluate(() => {
        const map = (window as unknown as { __cavechef_map__?: { getCanvas: () => HTMLCanvasElement } }).__cavechef_map__;
        return map?.getCanvas()?.style.cursor ?? null;
      });
      expect(cursor).toBe('default');

      // Click zoom button
      const zoomButton = page.locator('button[title="Zoom (Z)"]');
      await zoomButton.click();
      await page.waitForTimeout(50);

      // Verify zoom cursor
      cursor = await page.evaluate(() => {
        const map = (window as unknown as { __cavechef_map__?: { getCanvas: () => HTMLCanvasElement } }).__cavechef_map__;
        return map?.getCanvas()?.style.cursor ?? null;
      });
      expect(cursor).toBe('zoom-in');

      // Click pan button
      const panButton = page.locator('button[title="Pan (P)"]');
      await panButton.click();
      await page.waitForTimeout(50);

      // Verify pan cursor
      cursor = await page.evaluate(() => {
        const map = (window as unknown as { __cavechef_map__?: { getCanvas: () => HTMLCanvasElement } }).__cavechef_map__;
        return map?.getCanvas()?.style.cursor ?? null;
      });
      expect(cursor).toBe('grab');
    });
  });

  test.describe('Config Integration', () => {
    test('uses zoom_step from config for click zoom', async ({ page }) => {
      // Wait for config to be loaded from mock backend
      await page.waitForFunction(
        () => {
          const stores = (window as unknown as {
            __E2E_TEST__?: {
              projectStore: {
                getState: () => {
                  config: { map: { zoom_step: number } } | null;
                };
              };
            };
          }).__E2E_TEST__;
          return stores?.projectStore?.getState()?.config != null;
        },
        { timeout: 5000 }
      );

      // Read the zoom_step value from config
      const configuredZoomStep = await page.evaluate(() => {
        const stores = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                config: { map: { zoom_step: number } } | null;
              };
            };
          };
        }).__E2E_TEST__;
        return stores?.projectStore?.getState()?.config?.map?.zoom_step ?? null;
      });

      expect(configuredZoomStep).not.toBeNull();
      expect(typeof configuredZoomStep).toBe('number');
      expect(configuredZoomStep).toBeGreaterThan(0);

      // Switch to zoom tool
      await page.keyboard.press('z');
      await page.waitForTimeout(50);

      const canvas = page.locator('canvas').first();
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();

      const initialZoom = await getMapZoom(page);
      expect(initialZoom).not.toBeNull();

      // Left click to zoom in
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);

      // Wait for zoom animation to complete
      await page.waitForTimeout(500);

      const newZoom = await getMapZoom(page);
      expect(newZoom).not.toBeNull();

      const actualDiff = newZoom! - initialZoom!;

      // Verify the zoom delta matches the configured zoom_step
      // Allow for animation/rounding variance (within 0.5 of configured value)
      expect(actualDiff).toBeGreaterThan(configuredZoomStep! - 0.5);
      expect(actualDiff).toBeLessThan(configuredZoomStep! + 0.5);
    });

    test('uses zoom_step from config for keyboard zoom', async ({ page }) => {
      // Wait for config to be loaded
      await page.waitForFunction(
        () => {
          const stores = (window as unknown as {
            __E2E_TEST__?: {
              projectStore: {
                getState: () => {
                  config: { map: { zoom_step: number } } | null;
                };
              };
            };
          }).__E2E_TEST__;
          return stores?.projectStore?.getState()?.config != null;
        },
        { timeout: 5000 }
      );

      // Read the zoom_step value from config
      const configuredZoomStep = await page.evaluate(() => {
        const stores = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                config: { map: { zoom_step: number } } | null;
              };
            };
          };
        }).__E2E_TEST__;
        return stores?.projectStore?.getState()?.config?.map?.zoom_step ?? null;
      });

      expect(configuredZoomStep).not.toBeNull();

      const initialZoom = await getMapZoom(page);
      expect(initialZoom).not.toBeNull();

      // Press = to zoom in
      await page.keyboard.press('=');

      // Wait for zoom animation to complete
      await page.waitForTimeout(500);

      const newZoom = await getMapZoom(page);
      expect(newZoom).not.toBeNull();

      const actualDiff = newZoom! - initialZoom!;

      // Verify the zoom delta matches the configured zoom_step
      expect(actualDiff).toBeGreaterThan(configuredZoomStep! - 0.5);
      expect(actualDiff).toBeLessThan(configuredZoomStep! + 0.5);
    });

    test('respects zoom_min boundary', async ({ page }) => {
      // Switch to zoom tool
      await page.keyboard.press('z');
      await page.waitForTimeout(50);

      const canvas = page.locator('canvas').first();
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();

      // Set zoom to min (1 per mock config)
      await page.evaluate(() => {
        const map = (window as unknown as { __cavechef_map__?: { setZoom: (z: number) => void } }).__cavechef_map__;
        map?.setZoom(1);
      });
      await page.waitForTimeout(100);

      const zoomAtMin = await getMapZoom(page);
      expect(zoomAtMin).toBe(1);

      // Right click should be ignored at min zoom
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, { button: 'right' });
      await page.waitForTimeout(400);

      const zoomAfter = await getMapZoom(page);
      expect(zoomAfter).toBe(1);
    });

    test('respects zoom_max boundary', async ({ page }) => {
      // Switch to zoom tool
      await page.keyboard.press('z');
      await page.waitForTimeout(50);

      const canvas = page.locator('canvas').first();
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();

      // Set zoom to max (22 per mock config)
      await page.evaluate(() => {
        const map = (window as unknown as { __cavechef_map__?: { setZoom: (z: number) => void } }).__cavechef_map__;
        map?.setZoom(22);
      });
      await page.waitForTimeout(100);

      const zoomAtMax = await getMapZoom(page);
      expect(zoomAtMax).toBe(22);

      // Left click should be ignored at max zoom
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.waitForTimeout(400);

      const zoomAfter = await getMapZoom(page);
      expect(zoomAfter).toBe(22);
    });
  });

  test.describe('Wheel Zoom Interaction', () => {
    test('scroll wheel zooms in and out', async ({ page }) => {
      const canvas = page.locator('canvas').first();
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();

      // Move mouse to center of canvas
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

      const initialZoom = await getMapZoom(page);
      expect(initialZoom).not.toBeNull();

      // Scroll up (zoom in)
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(400);

      const zoomAfterScrollUp = await getMapZoom(page);
      expect(zoomAfterScrollUp).not.toBeNull();
      expect(zoomAfterScrollUp!).toBeGreaterThan(initialZoom!);

      // Scroll down (zoom out)
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(400);

      const zoomAfterScrollDown = await getMapZoom(page);
      expect(zoomAfterScrollDown).not.toBeNull();
      expect(zoomAfterScrollDown!).toBeLessThan(zoomAfterScrollUp!);
    });

    test('wheel zoom works regardless of active tool', async ({ page }) => {
      // Switch to select tool
      await page.keyboard.press('s');
      await page.waitForTimeout(50);

      const canvas = page.locator('canvas').first();
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();

      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

      const initialZoom = await getMapZoom(page);
      expect(initialZoom).not.toBeNull();

      // Scroll up (zoom in) while in select mode
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(400);

      const newZoom = await getMapZoom(page);
      expect(newZoom).not.toBeNull();
      expect(newZoom!).toBeGreaterThan(initialZoom!);
    });
  });

  test.describe('Center on Click', () => {
    test('click-to-zoom centers map on click location', async ({ page }) => {
      // Switch to zoom tool
      await page.keyboard.press('z');
      await page.waitForTimeout(50);

      const canvas = page.locator('canvas').first();
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();

      const initialCenter = await getMapCenter(page);
      expect(initialCenter).not.toBeNull();

      // Click off-center to zoom (but not too far to avoid map bounds issues)
      const clickX = box!.x + box!.width / 4;
      const clickY = box!.y + box!.height / 4;
      await page.mouse.click(clickX, clickY);

      // Wait for zoom animation to complete
      await page.waitForTimeout(500);

      const newCenter = await getMapCenter(page);
      expect(newCenter).not.toBeNull();

      // The map center should have changed toward the click location
      const centerChanged = Math.abs(newCenter!.lng - initialCenter!.lng) > 0.0001 ||
                            Math.abs(newCenter!.lat - initialCenter!.lat) > 0.0001;
      expect(centerChanged).toBe(true);
    });
  });
});
