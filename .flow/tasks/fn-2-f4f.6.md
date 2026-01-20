# fn-2-f4f.6 Add Playwright tests for zoom tool

## Description
Add Playwright tests for zoom tool interactions.

## Test File: e2e-playwright/tests/zoom-tool.spec.ts

```typescript
import { test, expect } from '@playwright/test';

test.describe('Zoom Tool', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for map to load
    await page.waitForFunction(() => (window as any).__cavechef_map__);
  });

  test('left-click zooms in', async ({ page }) => {
    await page.click('[data-testid="zoom-tool"]');
    const initialZoom = await page.evaluate(() => (window as any).__cavechef_map__?.getZoom());
    await page.click('[data-testid="map-container"]');
    await page.waitForTimeout(400);
    const newZoom = await page.evaluate(() => (window as any).__cavechef_map__?.getZoom());
    expect(newZoom).toBeGreaterThan(initialZoom);
  });
  
  test('right-click zooms out', async ({ page }) => {
    await page.click('[data-testid="zoom-tool"]');
    const initialZoom = await page.evaluate(() => (window as any).__cavechef_map__?.getZoom());
    await page.click('[data-testid="map-container"]', { button: 'right' });
    await page.waitForTimeout(400);
    const newZoom = await page.evaluate(() => (window as any).__cavechef_map__?.getZoom());
    expect(newZoom).toBeLessThan(initialZoom);
  });
  
  test('right-click does not show context menu', async ({ page }) => {
    await page.click('[data-testid="zoom-tool"]');
    const menuPromise = page.waitForSelector('[data-testid="context-menu"]', { timeout: 500 }).catch(() => null);
    await page.click('[data-testid="map-container"]', { button: 'right' });
    const menu = await menuPromise;
    expect(menu).toBeNull();
  });
  
  test('box zoom drag shows overlay', async ({ page }) => {
    await page.click('[data-testid="zoom-tool"]');
    const map = page.locator('[data-testid="map-container"]');
    const box = await map.boundingBox();
    
    await page.mouse.move(box!.x + 100, box!.y + 100);
    await page.mouse.down();
    await page.mouse.move(box!.x + 200, box!.y + 200);
    
    await expect(page.locator('[data-testid="zoom-box-overlay"]')).toBeVisible();
    
    await page.mouse.up();
  });
  
  test('spring-loaded Z key restores tool on hold', async ({ page }) => {
    await page.click('[data-testid="select-tool"]');
    await page.keyboard.down('z');
    
    // Should switch to zoom
    await expect(page.locator('[data-testid="zoom-tool"]')).toHaveClass(/active/);
    
    await page.waitForTimeout(250); // Hold > 200ms
    await page.keyboard.up('z');
    
    // Should restore to select
    await expect(page.locator('[data-testid="select-tool"]')).toHaveClass(/active/);
  });
  
  test('spring-loaded Z key tap keeps zoom tool', async ({ page }) => {
    await page.click('[data-testid="select-tool"]');
    
    // Quick tap (< 200ms)
    await page.keyboard.down('z');
    await page.waitForTimeout(50);
    await page.keyboard.up('z');
    
    // Should stay on zoom (tap behavior)
    await expect(page.locator('[data-testid="zoom-tool"]')).toHaveClass(/active/);
  });
});
```
## Test File

**File: `e2e-playwright/zoom-tool.spec.ts`** (new file)

## Test Categories

### Click Zoom Tests
```typescript
test('left click zooms in', async ({ page }) => {
  await page.click('[data-testid="tool-zoom"]');
  const initialZoom = await getMapZoom(page);
  await clickMap(page, { x: 400, y: 300, button: 'left' });
  await page.waitForTimeout(400); // Wait for animation
  expect(await getMapZoom(page)).toBeGreaterThan(initialZoom);
});

test('right click zooms out', async ({ page }) => {
  // Verify right-click zooms out, NOT opens context menu
});

test('right click on station zooms out (not context menu)', async ({ page }) => {
  // Click on a station with right-click in zoom mode
  // Verify no context menu opened, zoom level decreased
});

test('click at zoom 22 left-click ignored (no recenter)', async ({ page }) => {
  // Set zoom to 22, left click, verify zoom unchanged AND center unchanged
});

test('click at zoom 0 right-click ignored (no recenter)', async ({ page }) => {
  // Similar for right-click at minimum zoom
});
```

### Box Zoom Tests
```typescript
test('drag draws rectangle overlay', async ({ page }) => {
  await expect(page.locator('[data-testid="zoom-box-overlay"]')).toBeVisible();
});

test('Ctrl+drag pans (not box zoom)', async ({ page }) => {
  // Ctrl+drag should pan, not start box zoom
});

test('escape cancels box zoom', async ({ page }) => {
  // Start drag, press Escape, verify overlay gone
});
```

### Spring-Loaded Z Tests
```typescript
test('hold Z activates zoom, release restores previous tool', async ({ page }) => {
  await page.click('[data-testid="tool-merge"]');
  await page.keyboard.down('z');
  await expect(page.locator('[data-testid="tool-zoom"]')).toHaveClass(/active/);
  await page.waitForTimeout(300); // > 200ms
  await page.keyboard.up('z');
  await expect(page.locator('[data-testid="tool-merge"]')).toHaveClass(/active/);
});

test('tap Z keeps zoom tool', async ({ page }) => {
  // Quick press and release
});

test('merge state preserved after spring-loaded Z', async ({ page }) => {
  // Start merge, hold Z, zoom, release Z
  // Verify merge indicator still shows first station
});
```

### Cursor Tests
```typescript
test('cursor stays zoom-in when hovering station', async ({ page }) => {
  // Hover over station, verify cursor is zoom-in not pointer
});
```

### Keyboard Shortcut Tests
```typescript
test('= key zooms in by config step', async ({ page }) => {
  const initialZoom = await getMapZoom(page);
  await page.keyboard.press('=');
  await page.waitForTimeout(400);
  expect(await getMapZoom(page)).toBeCloseTo(initialZoom + 1.0, 0.5);
});

test('- key zooms out by config step', async ({ page }) => {
  // Similar
});
```

## Helper Functions

Add to `e2e-playwright/helpers.ts`:
```typescript
export async function getMapZoom(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__cavechef_map__?.getZoom() ?? 0);
}

export async function getMapCenter(page: Page): Promise<{lng: number, lat: number}> {
  return page.evaluate(() => {
    const center = (window as any).__cavechef_map__?.getCenter();
    return center ? { lng: center.lng, lat: center.lat } : { lng: 0, lat: 0 };
  });
}
```

## Mock Updates

Ensure `e2e-playwright/mocks/tauri-ipc.ts` has `zoom_step: 1.0` in config.
## Test File

**File: `e2e-playwright/zoom-tool.spec.ts`** (new file)

### Setup

```typescript
import { test, expect } from '@playwright/test';
import { setupMockIPC, getMapZoom, clickMap, dragMap, pressKey } from './helpers';

test.describe('Zoom Tool', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockIPC(page);
    // Navigate to map view with project loaded
    await page.goto('/');
    // ... setup steps
  });
```

### Test Cases

**Click zoom tests:**
```typescript
test('left click zooms in', async ({ page }) => {
  await page.click('[data-testid="tool-zoom"]');
  const initialZoom = await getMapZoom(page);
  await clickMap(page, { x: 400, y: 300, button: 'left' });
  await expect(await getMapZoom(page)).toBeGreaterThan(initialZoom);
});

test('right click zooms out', async ({ page }) => {
  await page.click('[data-testid="tool-zoom"]');
  const initialZoom = await getMapZoom(page);
  await clickMap(page, { x: 400, y: 300, button: 'right' });
  await expect(await getMapZoom(page)).toBeLessThan(initialZoom);
});

test('click centers on click point', async ({ page }) => {
  // Verify center changes to approximately click location
});

test('clicks at zoom 22 (left) are ignored', async ({ page }) => {
  // Set zoom to 22, left click, verify still 22
});

test('clicks at zoom 0 (right) are ignored', async ({ page }) => {
  // Set zoom to 0, right click, verify still 0
});

test('rapid clicks work', async ({ page }) => {
  // Multiple fast clicks should all register
});
```

**Box zoom tests:**
```typescript
test('drag draws rectangle overlay', async ({ page }) => {
  await page.click('[data-testid="tool-zoom"]');
  await dragMap(page, { start: { x: 200, y: 200 }, end: { x: 400, y: 400 } });
  await expect(page.locator('[data-testid="zoom-box-overlay"]')).toBeVisible();
});

test('release zooms to fit rectangle', async ({ page }) => {
  // Drag and verify zoom level changed appropriately
});

test('small drag (<10px) treated as click', async ({ page }) => {
  // Drag < 10px and verify it zooms in like a click
});

test('right-click during drag cancels', async ({ page }) => {
  // Start drag, right-click, verify overlay gone
});

test('escape during drag cancels', async ({ page }) => {
  // Start drag, press Escape, verify overlay gone
});
```

**Spring-loaded Z tests:**
```typescript
test('hold Z activates zoom tool', async ({ page }) => {
  await page.click('[data-testid="tool-select"]');
  await page.keyboard.down('z');
  await expect(page.locator('[data-testid="tool-zoom"]')).toHaveClass(/active/);
});

test('release Z after hold restores previous tool', async ({ page }) => {
  await page.click('[data-testid="tool-merge"]');
  await page.keyboard.down('z');
  await page.waitForTimeout(300); // > 200ms threshold
  await page.keyboard.up('z');
  await expect(page.locator('[data-testid="tool-merge"]')).toHaveClass(/active/);
});

test('tap Z (quick) keeps zoom tool', async ({ page }) => {
  await page.click('[data-testid="tool-select"]');
  await page.keyboard.press('z'); // Quick tap
  await expect(page.locator('[data-testid="tool-zoom"]')).toHaveClass(/active/);
});

test('tool state preserved after spring-loaded', async ({ page }) => {
  // Start merge (click station A), hold Z, zoom, release Z
  // Verify merge station A is still selected
});
```

**Keyboard shortcut tests:**
```typescript
test('= key zooms in', async ({ page }) => {
  const initialZoom = await getMapZoom(page);
  await page.keyboard.press('=');
  await expect(await getMapZoom(page)).toBeGreaterThan(initialZoom);
});

test('Ctrl+drag pans while zoom tool active', async ({ page }) => {
  await page.click('[data-testid="tool-zoom"]');
  // Ctrl+drag and verify center changed but zoom unchanged
});

test('double-click does not zoom when zoom tool active', async ({ page }) => {
  await page.click('[data-testid="tool-zoom"]');
  const initialZoom = await getMapZoom(page);
  await page.dblclick('.map-container');
  await expect(await getMapZoom(page)).toBe(initialZoom);
});
```

### Helper Functions Needed

Add to `e2e-playwright/helpers.ts`:
```typescript
export async function getMapZoom(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__cavechef_map__?.getZoom());
}

export async function clickMap(page: Page, options: {x: number, y: number, button: 'left' | 'right'}) {
  await page.click('.map-container', { position: { x: options.x, y: options.y }, button: options.button });
}

export async function dragMap(page: Page, options: {start: {x: number, y: number}, end: {x: number, y: number}}) {
  const container = page.locator('.map-container');
  await container.hover({ position: options.start });
  await page.mouse.down();
  await container.hover({ position: options.end });
  await page.mouse.up();
}
```

## Note on existing tests

`e2e-playwright/map-tools.spec.ts` has `test.describe.skip('Map Tools')`. Either:
1. Add zoom tests to new file (preferred - separation of concerns)
2. Un-skip and add to existing file (requires fixing existing tests)
## Acceptance
- [ ] Test file created at e2e-playwright/tests/zoom-tool.spec.ts
- [ ] Test: left-click zooms in
- [ ] Test: right-click zooms out
- [ ] Test: right-click suppresses context menu
- [ ] Test: box zoom shows overlay during drag
- [ ] Test: spring-loaded Z hold restores previous tool
- [ ] Test: spring-loaded Z tap keeps zoom tool
- [ ] pnpm test:ui passes
## Done summary
## Summary

Added comprehensive Playwright tests for the zoom tool at `e2e-playwright/zoom-tool.spec.ts`. The test file covers:

### Click Zoom Tests
- Left-click zooms in
- Right-click zooms out
- Right-click does not show context menu
- Click at max zoom (22) is ignored (no recenter)
- Right-click at min zoom (1) is ignored (no recenter)

### Box Zoom Tests
- Drag draws rectangle overlay with `[data-testid="zoom-box-overlay"]`
- Escape cancels box zoom
- Small drag (<10px) treated as click
- Ctrl+drag pans instead of box zoom

### Spring-Loaded Z Key Tests
- Hold Z >200ms activates zoom, release restores previous tool
- Tap Z (<200ms) keeps zoom tool active
- Previous tool state (e.g., merge mode) preserved after spring-loaded Z

### Cursor Tests
- Shows zoom-in cursor when zoom tool is active
- Cursor stays zoom-in when hovering (doesn't switch to pointer)

### Keyboard Shortcuts Tests
- `=` key zooms in by config step
- `-` key zooms out by config step
- Keyboard zoom works regardless of active tool

All 17 new tests pass, plus 4 existing zoom tests in other files. Full test suite: 248 passed.
## Evidence
- Commits:
- Tests: {'file': 'e2e-playwright/zoom-tool.spec.ts', 'result': '17 tests passed'}
- PRs: