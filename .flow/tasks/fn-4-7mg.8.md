# fn-4-7mg.8 Add Playwright E2E tests for hit detection

## Description
Add Playwright E2E tests for hitbox detection in a NEW non-skipped spec file.

**Note**: `e2e-playwright/map-tools.spec.ts` is currently `describe.skip`. Create a NEW spec file instead.

## Test File

Create `e2e-playwright/hitbox-detection.spec.ts` (NOT in map-tools.spec.ts)

## Test Strategy

Use `window.__cavechef_map__` for deterministic pixel positions via `map.project()`.

**IMPORTANT**: The `window.__E2E_TEST__` helper must only be exposed in dev/test mode:

```typescript
// In SurveyLayer.ts or MapCanvas.tsx - GUARDED exposure
if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
  window.__E2E_TEST__ = window.__E2E_TEST__ || {};
  window.__E2E_TEST__.stations = stationCoordinates;
  window.__E2E_TEST__.mapInstance = this.map;
}
```

This ensures test helpers are NEVER shipped to production.

### Setup helpers

```typescript
async function getStationScreenPosition(
  page: Page,
  sectionId: string,
  stationIndex: number
): Promise<{ x: number; y: number }> {
  return page.evaluate(({ sectionId, stationIndex }) => {
    const store = window.__E2E_TEST__?.projectStore.getState();
    const section = store?.project?.sections.find(s => s.id === sectionId);
    const station = section?.stations[stationIndex];
    if (!station) throw new Error(`Station not found: ${sectionId}:${stationIndex}`);

    // Use __cavechef_map__.project() for deterministic screen coords
    const map = (window as any).__cavechef_map__;
    if (!map) throw new Error('Map not available');

    // Convert station meters to map coords (using GPS origin)
    // This depends on how coordinates are stored/converted
    const screenPos = map.project([station.lng, station.lat]);
    return { x: screenPos.x, y: screenPos.y };
  }, { sectionId, stationIndex });
}

async function waitForMapReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const map = (window as any).__cavechef_map__;
    return map && map.loaded();
  }, { timeout: 10000 });
}
```

### Test: Station click at hitArea boundary

```typescript
test.describe('Hitbox Detection', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await createTestProject(page);
    await waitForMapReady(page);
  });

  test('station click at hitArea-1 hits, hitArea+1 misses', async ({ page }) => {
    const hitArea = 10;  // Default from mock config

    // Create a section with known station
    await createTestSection(page);

    const stationPos = await getStationScreenPosition(page, 'section-1', 0);
    const canvas = page.locator('canvas.maplibregl-canvas');
    const canvasBox = await canvas.boundingBox();

    // Click at hitArea - 1 (should hit)
    await page.mouse.click(
      canvasBox!.x + stationPos.x + hitArea - 1,
      canvasBox!.y + stationPos.y
    );

    // Verify selection via Detail Panel
    await expect(page.locator('[data-testid="detail-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="detail-panel"]')).toContainText('Station');

    // Clear selection
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="detail-panel"]')).not.toBeVisible();

    // Click at hitArea + 1 (should miss)
    await page.mouse.click(
      canvasBox!.x + stationPos.x + hitArea + 1,
      canvasBox!.y + stationPos.y
    );

    // Should NOT show detail panel (missed)
    await page.waitForTimeout(200);  // Small wait for any async handlers
    await expect(page.locator('[data-testid="detail-panel"]')).not.toBeVisible();
  });

  test('shot click detection uses hitArea', async ({ page }) => {
    // Similar test for shots at hitArea/2 distance from line
  });

  test('overlapping hitboxes select nearest to click', async ({ page }) => {
    // Create two stations close together
    // Click between them, verify nearest is selected
  });

  test('debug.map.showHitboxes shows red overlay', async ({ page }) => {
    // Update config to enable showHitboxes
    // Verify layer paint properties changed
    const hasDebugOverlay = await page.evaluate(() => {
      const map = (window as any).__cavechef_map__;
      const opacity = map.getPaintProperty('survey-stations-hitbox', 'circle-opacity');
      return opacity === 1;  // Debug mode sets opacity to 1
    });
    expect(hasDebugOverlay).toBe(true);
  });
});
```

### Test: Config reload changes hit detection

```typescript
test('config reload updates hitbox sizes', async ({ page }) => {
  // This test verifies that config reload applies new hitArea values
  // May require mocking config file changes or using test API
});
```

## Files

- Create: `e2e-playwright/hitbox-detection.spec.ts`
- May modify: `e2e-playwright/helpers/` to add shared helpers
## Test File

Create `e2e-playwright/specs/hitbox-detection.spec.ts`

## Test Strategy

### Setup helper

```typescript
async function getStationScreenCoords(
  page: Page,
  sectionId: string,
  stationIndex: number
): Promise<{ x: number; y: number }> {
  // Access station via test API exposed on window.__E2E_TEST__
  return page.evaluate(({ sectionId, stationIndex }) => {
    const store = window.__E2E_TEST__.projectStore.getState();
    const section = store.project?.sections.find(s => s.id === sectionId);
    const station = section?.stations[stationIndex];
    if (!station) throw new Error('Station not found');

    // Get map instance and project station to screen coords
    const map = window.__E2E_TEST__.mapInstance;
    const screenPos = map.project([station.lng, station.lat]);
    return { x: screenPos.x, y: screenPos.y };
  }, { sectionId, stationIndex });
}
```

### Test: Station click at hitArea boundary

```typescript
test('station click at hitArea-1 hits, hitArea+1 misses', async ({ page }) => {
  await waitForAppReady(page);
  await createTestSection(page);  // Create section with known stations

  const hitArea = 10;  // Default from config
  const stationPos = await getStationScreenCoords(page, 'section-1', 0);
  const canvas = page.locator('canvas.maplibregl-canvas');
  const canvasBox = await canvas.boundingBox();

  // Click at hitArea - 1 (should hit)
  await page.mouse.click(
    canvasBox.x + stationPos.x + hitArea - 1,
    canvasBox.y + stationPos.y
  );
  await expect(page.locator('[data-testid="detail-panel"]')).toBeVisible();

  // Clear selection
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="detail-panel"]')).not.toBeVisible();

  // Click at hitArea + 1 (should miss)
  await page.mouse.click(
    canvasBox.x + stationPos.x + hitArea + 1,
    canvasBox.y + stationPos.y
  );
  await expect(page.locator('[data-testid="detail-panel"]')).not.toBeVisible();
});
```

### Test: Shot click at hitArea boundary

```typescript
test('shot click at hitArea/2-1 hits, hitArea/2+1 misses', async ({ page }) => {
  // Similar pattern for shots
  // Click perpendicular to shot line at different distances
});
```

### Test: Station hover at hitArea boundary

```typescript
test('station hover triggers at hitArea boundary', async ({ page }) => {
  // Move mouse to hitArea-1, verify hover state
  // Move mouse to hitArea+1, verify no hover state
});
```

### Test: Config reload changes hit detection

```typescript
test('config reload updates hit detection boundaries', async ({ page }) => {
  // Default hitArea = 10
  // Click at 8px distance - should hit

  // Update config via test API to hitArea = 5
  // Click Reload Config button

  // Click at 8px distance - should now miss
  // Click at 4px distance - should hit
});
```

### Test: Debug visualization toggle

```typescript
test('debug.map.showHitboxes shows red overlay', async ({ page }) => {
  // Enable showHitboxes via config reload
  // Take screenshot, verify red circles/lines visible
  // Disable showHitboxes
  // Verify overlay gone
});
```

## Files

- Create: `e2e-playwright/specs/hitbox-detection.spec.ts`
- Modify: `e2e-playwright/helpers/app.ts` (add getStationScreenCoords helper if needed)
## Test Strategy

### Setup

1. Create a test project with known station/shot positions
2. Set specific hitArea values in config (e.g., station.hitArea = 10, shot.hitArea = 8)
3. Calculate exact screen coordinates for test clicks

### Test Cases

#### Station Hit Detection

```typescript
test('station click detection at exact hitArea boundary', async ({ page }) => {
  // Station at known position
  const stationCenter = await getStationScreenCoords(page, 'section1', 0);

  // Click at hitArea - 1 (should hit)
  await page.mouse.click(stationCenter.x + 9, stationCenter.y);
  await expect(page.locator('[data-testid="selected-station"]')).toBeVisible();

  // Clear selection
  await page.keyboard.press('Escape');

  // Click at hitArea + 1 (should miss)
  await page.mouse.click(stationCenter.x + 11, stationCenter.y);
  await expect(page.locator('[data-testid="selected-station"]')).not.toBeVisible();
});
```

#### Shot Hit Detection

Similar tests for shots:
- Click at shotWidth/2 - 1 from line center (should hit)
- Click at shotWidth/2 + 1 from line center (should miss)

#### Hover Detection

Test that hover state triggers at correct distances.

#### Config Changes

Test that changing hitArea in config affects detection:
1. Set hitArea to 5
2. Click at 6px distance (miss)
3. Reload config with hitArea = 10
4. Click at 6px distance (hit)

### Helper Functions

```typescript
async function getStationScreenCoords(page, sectionId, stationIndex) {
  // Use evaluate to get station's screen position
}

async function getShotScreenCoords(page, sectionId, shotId) {
  // Get midpoint of shot line
}
```
## Acceptance
- [ ] NEW test file `e2e-playwright/hitbox-detection.spec.ts` created (NOT in map-tools.spec.ts)
- [ ] Test is NOT skipped (`test.describe`, not `test.describe.skip`)
- [ ] Helper `getStationScreenPosition()` uses `__cavechef_map__.project()` for deterministic coords
- [ ] Helper `waitForMapReady()` waits for map loaded state
- [ ] `window.__E2E_TEST__` exposure guarded by `import.meta.env.DEV || import.meta.env.MODE === 'test'`
- [ ] Test: station click at hitArea-1 hits (shows detail panel)
- [ ] Test: station click at hitArea+1 misses (no detail panel)
- [ ] Test: shot click detection uses hitArea
- [ ] Test: overlapping hitboxes select nearest to click
- [ ] Test: debug.map.showHitboxes changes layer opacity
- [ ] Test: layer order verification - station-hitbox above shot-hitbox via `map.getStyle().layers`
- [ ] All tests use mock config with known hitArea values (from task 9)
- [ ] `pnpm test:ui` runs the new tests (not skipped)
- [ ] All new tests pass
## Done summary
Added comprehensive Playwright E2E tests for hitbox detection in a new test file, covering station/shot click boundaries, layer ordering, debug visualization toggle, and config reload effects.
## Evidence
- Commits: 7c80bc0eb8385bde0af7f80af1fae3a63d0cc070, 1c8c05c, 6c69fec, 52d683a
- Tests: pnpm test:ui e2e-playwright/hitbox-detection.spec.ts
- PRs: