import { test, expect, Page } from '@playwright/test';
import {
  setupMockedPage,
  createProject,
  waitForMapReady,
  waitForActiveTool,
  waitForMapIdle,
} from './helpers/app';

/**
 * Helper to create a new project and get to SingleSystemView with map canvas.
 */
async function createProjectWithMap(page: Page): Promise<void> {
  await createProject(page, 'Ctrl Drag Test');
  await waitForMapReady(page);
}

test.describe('Ctrl+Drag Panning', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProjectWithMap(page);
  });

  // Supported tools that should allow Ctrl+drag panning
  const supportedTools = [
    { key: 's', name: 'select' },
    { key: 'd', name: 'draw' },
    { key: 'x', name: 'delete' },
    { key: 'm', name: 'merge' },
    { key: 'r', name: 'measure' },
  ];

  test.describe('Cursor Changes', () => {
    for (const tool of supportedTools) {
      test(`should show grab cursor when Ctrl held in ${tool.name} mode`, async ({ page }) => {
        // Switch to the tool
        await page.keyboard.press(tool.key);
        await waitForActiveTool(page, tool.name);

        const canvas = page.getByTestId('map-canvas');
        await expect(canvas).toBeVisible();

        // Hold Ctrl
        await page.keyboard.down('Control');
        await page.waitForFunction(() => {
          const canvas = document.querySelector('canvas');
          return canvas?.style.cursor === 'grab';
        });

        // Get the cursor from the MapLibre canvas
        const cursor = await page.evaluate(() => {
          const canvas = document.querySelector('canvas');
          return canvas?.style.cursor || '';
        });
        expect(cursor).toBe('grab');

        await page.keyboard.up('Control');
      });
    }
  });

  test.describe('Ctrl+Drag Panning Behavior', () => {
    for (const tool of supportedTools) {
      test(`should allow Ctrl+drag to pan in ${tool.name} mode`, async ({ page }) => {
        // Switch to the tool
        await page.keyboard.press(tool.key);
        await waitForActiveTool(page, tool.name);

        const canvas = page.getByTestId('map-canvas');
        const box = await canvas.boundingBox();
        expect(box).not.toBeNull();

        // Perform Ctrl+drag
        await page.keyboard.down('Control');
        await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
        await page.mouse.down();
        await page.mouse.move(box!.x + box!.width / 2 + 100, box!.y + box!.height / 2 + 100, { steps: 8 });
        await page.mouse.up();
        await page.keyboard.up('Control');

        await waitForMapIdle(page);

        // Map should remain functional after pan
        await expect(canvas).toBeVisible();
      });
    }
  });

  // Unsupported tools (have their own drag behaviors)
  const unsupportedTools = [
    { key: 'p', name: 'pan' },
    { key: 'z', name: 'zoom' },
    { key: 'v', name: 'move_section' },
    { key: 't', name: 'move_station' },
  ];

  test.describe('Unsupported Tools', () => {
    for (const tool of unsupportedTools) {
      test(`should NOT change cursor to grab with Ctrl in ${tool.name} mode`, async ({ page }) => {
        // Switch to the tool
        await page.keyboard.press(tool.key);
        await waitForActiveTool(page, tool.name);

        const canvas = page.getByTestId('map-canvas');
        await expect(canvas).toBeVisible();

        // Hold Ctrl
        await page.keyboard.down('Control');
        await page.waitForFunction(() => {
          const canvas = document.querySelector('canvas');
          return typeof canvas?.style.cursor === 'string';
        });

        // Get the cursor
        const cursor = await page.evaluate(() => {
          const canvas = document.querySelector('canvas');
          return canvas?.style.cursor || '';
        });

        // Pan tool naturally shows 'grab', so that's expected
        // Other tools should NOT show grab cursor when Ctrl is held
        if (tool.name === 'pan') {
          expect(cursor).toBe('grab');
        } else {
          expect(cursor).not.toBe('grab');
        }

        await page.keyboard.up('Control');
      });
    }
  });

  test.describe('Box Select Interactions', () => {
    test('should not start box select when Ctrl+drag in select mode', async ({ page }) => {
      // Switch to select mode
      await page.keyboard.press('s');
      await waitForActiveTool(page, 'select');

      const canvas = page.getByTestId('map-canvas');
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();

      // Perform Ctrl+drag
      await page.keyboard.down('Control');
      await page.mouse.move(box!.x + 50, box!.y + 50);
      await page.mouse.down();
      await page.mouse.move(box!.x + 200, box!.y + 200);

      // Box select overlay should NOT be visible (uses border-dashed bg-accent/10)
      const boxOverlay = page.locator('.border-dashed.bg-accent\\/10');
      await expect(boxOverlay).not.toBeVisible();

      await page.mouse.up();
      await page.keyboard.up('Control');
    });

    test('should cancel box select when Ctrl pressed mid-drag', async ({ page }) => {
      // Switch to select mode
      await page.keyboard.press('s');
      await waitForActiveTool(page, 'select');

      const canvas = page.getByTestId('map-canvas');
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();

      // Start a normal drag (no Ctrl) to begin box select
      await page.mouse.move(box!.x + 50, box!.y + 50);
      await page.mouse.down();
      await page.mouse.move(box!.x + 100, box!.y + 100);

      // Box select should be visible at this point
      const boxOverlay = page.locator('.border-dashed.bg-accent\\/10');
      await expect(boxOverlay).toBeVisible();

      // NOW press Ctrl mid-drag - box select should cancel
      await page.keyboard.down('Control');

      // Box select should be cancelled
      await expect(boxOverlay).toBeHidden();

      // Continue drag and clean up
      await page.mouse.move(box!.x + 200, box!.y + 200);
      await page.mouse.up();
      await page.keyboard.up('Control');

      // Map should remain functional
      await expect(canvas).toBeVisible();
    });
  });

  test.describe('Edge Cases', () => {
    test('should handle window blur while Ctrl is held', async ({ page }) => {
      // Switch to select mode
      await page.keyboard.press('s');
      await waitForActiveTool(page, 'select');

      const canvas = page.getByTestId('map-canvas');

      // Hold Ctrl
      await page.keyboard.down('Control');
      await page.waitForFunction(() => {
        const canvas = document.querySelector('canvas');
        return canvas?.style.cursor === 'grab';
      });

      // Verify cursor is grab
      let cursor = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        return canvas?.style.cursor || '';
      });
      expect(cursor).toBe('grab');

      // Simulate window blur
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await page.waitForFunction(() => {
        const canvas = document.querySelector('canvas');
        return canvas?.style.cursor !== 'grab';
      });

      // Cursor should no longer be grab (ctrlHeld reset)
      cursor = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        return canvas?.style.cursor || '';
      });
      expect(cursor).not.toBe('grab');

      // Clean up
      await page.keyboard.up('Control');
    });

    test('should allow Ctrl+click for selection (not drag)', async ({ page }) => {
      // Switch to select mode
      await page.keyboard.press('s');
      await waitForActiveTool(page, 'select');

      const canvas = page.getByTestId('map-canvas');
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();

      // Ctrl+click (no drag) should work without issues
      await page.keyboard.down('Control');
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.keyboard.up('Control');

      // Map should remain functional
      await expect(canvas).toBeVisible();
    });

    test('should stop showing grab cursor when Ctrl released mid-drag', async ({ page }) => {
      // Switch to select mode
      await page.keyboard.press('s');
      await waitForActiveTool(page, 'select');

      const canvas = page.getByTestId('map-canvas');
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();

      // Start Ctrl+drag
      await page.keyboard.down('Control');
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.down();
      await page.mouse.move(box!.x + box!.width / 2 + 50, box!.y + box!.height / 2);

      // Release Ctrl mid-drag
      await page.keyboard.up('Control');
      await page.waitForFunction(() => {
        const canvas = document.querySelector('canvas');
        return canvas?.style.cursor !== 'grab';
      });

      // Cursor should no longer be grab
      const cursor = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        return canvas?.style.cursor || '';
      });
      expect(cursor).not.toBe('grab');

      // Clean up
      await page.mouse.move(box!.x + box!.width / 2 + 100, box!.y + box!.height / 2);
      await page.mouse.up();

      // Map should remain functional
      await expect(canvas).toBeVisible();
    });

    test('should work with rapid Ctrl press/release cycles', async ({ page }) => {
      // Switch to select mode
      await page.keyboard.press('s');
      await waitForActiveTool(page, 'select');

      const canvas = page.getByTestId('map-canvas');
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();

      // Rapid Ctrl press/release cycles
      for (let i = 0; i < 5; i++) {
        await page.keyboard.down('Control');
        await page.keyboard.up('Control');
      }

      // Map should remain functional
      await expect(canvas).toBeVisible();

      // Verify final cursor is default (not stuck on grab)
      const cursor = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        return canvas?.style.cursor || '';
      });
      expect(cursor).not.toBe('grab');
    });

    test('should handle tool switch while Ctrl is held', async ({ page }) => {
      // Start in select mode
      await page.keyboard.press('s');
      await waitForActiveTool(page, 'select');

      // Hold Ctrl
      await page.keyboard.down('Control');
      await page.waitForFunction(() => {
        const canvas = document.querySelector('canvas');
        return canvas?.style.cursor === 'grab';
      });

      // Verify cursor is grab
      let cursor = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        return canvas?.style.cursor || '';
      });
      expect(cursor).toBe('grab');

      // Switch to pan tool while Ctrl is held
      await page.keyboard.press('p');
      await waitForActiveTool(page, 'pan');

      // Pan tool has 'grab' cursor naturally, so it should still show grab
      cursor = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        return canvas?.style.cursor || '';
      });
      expect(cursor).toBe('grab');

      // Release Ctrl
      await page.keyboard.up('Control');

      // Switch to zoom tool
      await page.keyboard.press('z');
      await waitForActiveTool(page, 'zoom');

      // Now cursor should be zoom-in
      cursor = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        return canvas?.style.cursor || '';
      });
      expect(cursor).toBe('zoom-in');

      // Map should remain functional after all these switches
      const canvas = page.getByTestId('map-canvas');
      await expect(canvas).toBeVisible();
    });
  });
});
