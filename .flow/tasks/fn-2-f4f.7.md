# fn-2-f4f.7 Add WebdriverIO E2E tests for zoom tool

## Description
Add WebdriverIO E2E tests for zoom tool in the full Tauri app.

## Test File

**File: `e2e/specs/zoom-tool.spec.ts`** (new file)

### Setup

```typescript
import { browser, expect } from '@wdio/globals';
import { loadProjectFixture, getMapZoom, waitForMapReady } from '../helpers/app';

describe('Zoom Tool E2E', () => {
  beforeEach(async () => {
    await loadProjectFixture('basic-survey');
    await waitForMapReady();
  });
```

### Test Cases

**Toolbar interaction:**
```typescript
it('clicking zoom button in toolbar activates zoom tool', async () => {
  const zoomBtn = await $('[data-testid="tool-zoom"]');
  await zoomBtn.click();
  await expect(zoomBtn).toHaveElementClass('active');
});

it('Z key shortcut activates zoom tool', async () => {
  await browser.keys('z');
  const zoomBtn = await $('[data-testid="tool-zoom"]');
  await expect(zoomBtn).toHaveElementClass('active');
});
```

**Click zoom (real Tauri app):**
```typescript
it('left click on map zooms in', async () => {
  await $('[data-testid="tool-zoom"]').click();
  const initialZoom = await getMapZoom();
  
  const mapContainer = await $('.map-container');
  await mapContainer.click({ x: 300, y: 300 });
  await browser.pause(400); // Wait for animation
  
  const newZoom = await getMapZoom();
  expect(newZoom).toBeGreaterThan(initialZoom);
});

it('right click on map zooms out', async () => {
  await $('[data-testid="tool-zoom"]').click();
  const initialZoom = await getMapZoom();
  
  const mapContainer = await $('.map-container');
  await mapContainer.click({ x: 300, y: 300, button: 'right' });
  await browser.pause(400);
  
  const newZoom = await getMapZoom();
  expect(newZoom).toBeLessThan(initialZoom);
});
```

**Box zoom:**
```typescript
it('drag rectangle zooms to fit area', async () => {
  await $('[data-testid="tool-zoom"]').click();
  const initialZoom = await getMapZoom();
  
  const mapContainer = await $('.map-container');
  await browser.performActions([{
    type: 'pointer',
    id: 'finger1',
    parameters: { pointerType: 'mouse' },
    actions: [
      { type: 'pointerMove', duration: 0, x: 200, y: 200, origin: mapContainer },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerMove', duration: 100, x: 400, y: 400, origin: mapContainer },
      { type: 'pointerUp', button: 0 },
    ],
  }]);
  
  await browser.pause(400);
  const newZoom = await getMapZoom();
  // Box zoom should increase zoom level
  expect(newZoom).toBeGreaterThan(initialZoom);
});
```

**Spring-loaded Z:**
```typescript
it('hold Z then release restores previous tool', async () => {
  // Start with merge tool
  await $('[data-testid="tool-merge"]').click();
  
  // Hold Z
  await browser.performActions([{
    type: 'key',
    id: 'keyboard',
    actions: [{ type: 'keyDown', value: 'z' }],
  }]);
  
  // Verify zoom tool active
  await expect($('[data-testid="tool-zoom"]')).toHaveElementClass('active');
  
  // Wait > 200ms then release
  await browser.pause(300);
  await browser.performActions([{
    type: 'key',
    id: 'keyboard',
    actions: [{ type: 'keyUp', value: 'z' }],
  }]);
  
  // Verify merge tool restored
  await expect($('[data-testid="tool-merge"]')).toHaveElementClass('active');
});
```

**Config integration:**
```typescript
it('uses zoom_step from config', async () => {
  // This test verifies the Rust config is properly loaded
  // Default zoom_step is 1.0, so zoom should change by ~1 level
  await $('[data-testid="tool-zoom"]').click();
  const initialZoom = await getMapZoom();
  
  const mapContainer = await $('.map-container');
  await mapContainer.click({ x: 300, y: 300 });
  await browser.pause(400);
  
  const newZoom = await getMapZoom();
  const diff = newZoom - initialZoom;
  expect(diff).toBeCloseTo(1.0, 0.5); // Within 0.5 of expected step
});
```

### Helper Function

Add to `e2e/helpers/app.ts`:
```typescript
export async function getMapZoom(): Promise<number> {
  return browser.execute(() => {
    return (window as any).__cavechef_map__?.getZoom() ?? 0;
  });
}
```
## Acceptance
- [ ] New file `e2e/specs/zoom-tool.spec.ts` created
- [ ] Test: toolbar click activates zoom
- [ ] Test: Z key activates zoom
- [ ] Test: left click zooms in
- [ ] Test: right click zooms out
- [ ] Test: box drag zooms to area
- [ ] Test: spring-loaded Z hold/release
- [ ] Test: config zoom_step is used
- [ ] Helper `getMapZoom()` in app.ts
- [ ] All WebdriverIO tests pass
## Done summary
Added explicit waitForExist calls to all zoom-tool.spec.ts tests to properly wait for toolbar buttons to render before clicking. Fixed animation timing issue in config integration test by adding pause to wait for zoom animation to complete before measuring zoom delta. All 8 E2E tests now pass.
## Evidence
- Commits:
- Tests:
- PRs: