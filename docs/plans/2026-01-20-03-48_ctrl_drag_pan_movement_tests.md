# Plan: Comprehensive Ctrl+Drag Pan Movement Verification Tests

## Objective

Implement comprehensive E2E tests that verify Ctrl+drag pan in Select mode actually moves map content (stations, shots, grid) by measuring position changes before and after panning.

## Methodology

1. Add logging with value differences (tolerance-thresholded)
2. Implement tests and fix issues
3. Verify tests pass in Pan mode (known working baseline)
4. Adjust tolerances based on logging output
5. Test Ctrl+drag in Select mode
6. Fix Ctrl+drag functionality if tests fail

## Progress Tracking

**IMPORTANT**: After every compaction, describe your progress in detail before the compaction and store the details into `./docs/plans/2026-01-20-ctrl-drag-pan-movement-tests/progress_{ts}.md`, where `{ts}` is the current unix timestamp. You do not need to include code but you should at least reference files.

## Reference Files

### Project Configuration
- `CLAUDE.md` - Project rules, test requirements, dev commands
- `docs/TESTING.md` - Testing documentation and patterns

### Map Implementation
- `src/components/Map/MapCanvas.tsx`
  - Line 12: `CTRL_PAN_TOOLS = ['select', 'draw', 'delete', 'merge', 'measure']`
  - Line 37: `ctrlHeld` state
  - Line 381: Map instance creation (`new maplibregl.Map`)
  - Lines 404-407: `dragRotate.disable()`, `boxZoom.disable()`
  - Lines 529-555: Cursor management (grab cursor when Ctrl held)
  - Lines 559-573: dragPan enable/disable based on tool + ctrlHeld
  - Lines 577-621: Keydown/keyup/blur handlers for Ctrl state
  - Lines 625-642: Capture-phase mousedown handler for timing edge case
  - Line 907: Map container div `<div ref={mapContainer}>`

### Coordinate Utilities
- `src/utils/coordinates.ts`
  - `metersToMapCoords(x, y)` - divides by 111320 to get pseudo-lat/lng
  - `mapCoordsToMeters(lng, lat)` - multiplies by 111320
  - Constant: `METERS_PER_DEGREE = 111320`

### Survey Rendering
- `src/components/Map/SurveyLayer.tsx`
  - Source: `survey-data-stations`, Layer: `survey-stations`
  - Source: `survey-data-shots`, Layer: `survey-shots`
  - Feature properties: `sectionId`, `stationIndex`, `color`, `isZeroDatum`

### Grid Rendering
- `src/components/Map/GridOverlay.tsx`
  - Source: `grid-source`, Layer: `grid-lines`

### Existing Tests
- `e2e-playwright/ctrl-drag-pan.spec.ts` - Current cursor/behavior tests (350 lines)
- `e2e-playwright/mocks/tauri-ipc.ts` - Mock IPC setup, station generation at lines 156-182
- `e2e/specs/map-interactions.spec.ts` - WebdriverIO map tests

### Test Helpers
- `e2e/helpers/app.ts` - WebdriverIO helpers including `selectTool()`, `importDmpFile()`

### Fixture Files
- `e2e/fixtures/fractal_plant_iter3.cvproj` - Pre-generated fractal cave survey (~85 sections)

## Implementation Steps

### Overview: Two-Stage Testing Approach

1. **Stage 1: Playwright tests** (fast, mocked data) - Implement and verify first
2. **Stage 2: WebdriverIO tests** (slower, real fixture) - Only after Playwright passes

This allows rapid iteration with Playwright before running slower WebdriverIO tests.

### Step 1: Expose Map Instance for Testing

**File**: `src/components/Map/MapCanvas.tsx`

Add after line ~420 (after map.current is set):

```typescript
// Expose map instance for E2E testing (development only)
useEffect(() => {
  if (map.current) {
    (window as any).__stalagmight_map__ = map.current;
  }
  return () => {
    delete (window as any).__stalagmight_map__;
  };
}, []);
```

This allows tests to access `map.getCenter()`, `map.getZoom()`, `map.project()`, and `map.queryRenderedFeatures()`.

### Step 2: Create Playwright Test File (Stage 1 - Fast)

**File**: `e2e-playwright/ctrl-drag-pan-movement.spec.ts`

Playwright tests run first with mocked station data for fast iteration.

```typescript
import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

// Helper to create project with mocked stations
async function createProjectWithStations(page: Page): Promise<void> {
  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill('Pan Movement Test');
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });

  // Trigger DMP import to get mock stations (mock returns 6 sections)
  await page.keyboard.press('Control+i');
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  // Select file and import (mocked)
  // ... complete import flow or modify mock to auto-populate

  await page.waitForTimeout(500);
}
```

**Structure:**
```
├── Helper Functions (same as WebdriverIO but using page.evaluate)
├── Test Suite: "Ctrl+Drag Pan - Content Movement (Playwright)"
│   ├── describe: "Pan Mode Baseline"
│   │   ├── test: drag right moves map center left
│   │   ├── test: zoom level unchanged
│   ├── describe: "Ctrl+Drag in Select Mode"
│   │   ├── test: Ctrl+drag right moves map center left
│   │   ├── test: no box select during Ctrl+drag
```

**Run Playwright first:**
```bash
pnpm test:ui e2e-playwright/ctrl-drag-pan-movement.spec.ts
```

### Step 3: Create WebdriverIO Test File (Stage 2 - Thorough)

**File**: `e2e/specs/ctrl-drag-pan-movement.spec.ts`

Only run after Playwright tests pass. Uses real fixture for comprehensive verification.

Use WebdriverIO because:
1. Real fixture files can be loaded directly via `openProject()`
2. Real backend processes actual station coordinates
3. More accurate test of actual pan behavior

Structure:
```
├── Helper Functions
│   ├── loadFixtureProject() - Load fractal_plant_iter3.cvproj
│   ├── getMapCenter() - Get map center coordinates
│   ├── getMapZoom() - Get zoom level
│   ├── getStationScreenPositions() - Get all station screen positions
│   ├── logMovementDiff(label, expected, actual, tolerance) - Log with threshold info
│
├── Test Suite: "Ctrl+Drag Pan - Content Movement Verification"
│   ├── beforeEach: waitForAppReady + loadFixtureProject
│   │
│   ├── describe: "Pan Mode Baseline (known working)"
│   │   ├── test: drag right moves map center left
│   │   ├── test: drag down moves map center up
│   │   ├── test: stations move opposite to drag direction
│   │   ├── test: zoom level unchanged during pan
│   │
│   ├── describe: "Ctrl+Drag in Select Mode"
│   │   ├── test: Ctrl+drag right moves map center left
│   │   ├── test: Ctrl+drag moves stations opposite to drag
│   │   ├── test: zoom level unchanged during Ctrl+drag
│   │   ├── test: no box select overlay during Ctrl+drag
│   │
│   ├── describe: "Movement Proportionality"
│   │   ├── test: larger drag produces proportionally larger movement
│   │
│   ├── describe: "All Supported Tools"
│   │   ├── test: Ctrl+drag works in draw mode
│   │   ├── test: Ctrl+drag works in delete mode
│   │   ├── test: Ctrl+drag works in merge mode
│   │   ├── test: Ctrl+drag works in measure mode
```

### Step 3: Implement Helper Functions

```typescript
import * as path from 'path';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const FIXTURE_PATH = path.join(FIXTURES_DIR, 'fractal_plant_iter3.cvproj');

// Load fixture project via store API
async function loadFixtureProject(): Promise<void> {
  await browser.execute((fixturePath) => {
    return (window as any).__E2E_TEST__.projectStore.getState().openProject(fixturePath);
  }, FIXTURE_PATH);
  await browser.pause(1000); // Wait for project load and render
}

// Get map center via exposed map instance
async function getMapCenter(): Promise<{ lng: number; lat: number } | null> {
  return browser.execute(() => {
    const map = (window as any).__stalagmight_map__;
    if (!map) return null;
    const center = map.getCenter();
    return { lng: center.lng, lat: center.lat };
  });
}

// Get map zoom level
async function getMapZoom(): Promise<number | null> {
  return browser.execute(() => {
    const map = (window as any).__stalagmight_map__;
    return map?.getZoom() ?? null;
  });
}

// Get station screen positions via queryRenderedFeatures + project
async function getStationScreenPositions(): Promise<Array<{
  id: string;
  screenX: number;
  screenY: number;
}>> {
  return browser.execute(() => {
    const map = (window as any).__stalagmight_map__;
    if (!map) return [];
    const features = map.queryRenderedFeatures({ layers: ['survey-stations'] });
    return features.map((f: any) => {
      const coords = f.geometry.coordinates;
      const screenPos = map.project(coords);
      return {
        id: `${f.properties.sectionId}:${f.properties.stationIndex}`,
        screenX: screenPos.x,
        screenY: screenPos.y,
      };
    });
  });
}

// Logging helper with tolerance threshold
function logMovementDiff(
  label: string,
  expected: number,
  actual: number,
  tolerance: number
): void {
  const diff = Math.abs(actual - expected);
  const passed = diff <= tolerance;
  console.log(
    `[${passed ? 'PASS' : 'FAIL'}] ${label}: expected=${expected.toFixed(2)}, ` +
    `actual=${actual.toFixed(2)}, diff=${diff.toFixed(2)}, tolerance=${tolerance}`
  );
}
```

### Step 4: Implement Pan Mode Baseline Tests

Test Pan mode first (known working) to validate test infrastructure:

```typescript
it('Pan mode: drag right moves map center left', async () => {
  await selectTool('pan');
  await browser.pause(50);

  const canvas = await $('canvas');
  const location = await canvas.getLocation();
  const size = await canvas.getSize();

  const centerBefore = await getMapCenter();
  expect(centerBefore).not.toBeNull();

  // Drag RIGHT 100px (no Ctrl needed in pan mode)
  const centerX = location.x + size.width / 2;
  const centerY = location.y + size.height / 2;

  await browser.performActions([{
    type: 'pointer',
    id: 'mouse',
    parameters: { pointerType: 'mouse' },
    actions: [
      { type: 'pointerMove', x: Math.round(centerX), y: Math.round(centerY) },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerMove', x: Math.round(centerX + 100), y: Math.round(centerY) },
      { type: 'pointerUp', button: 0 },
    ],
  }]);
  await browser.releaseActions();
  await browser.pause(300);

  const centerAfter = await getMapCenter();
  expect(centerAfter).not.toBeNull();

  // Drag right → map center moves left (negative lng change)
  const lngChange = centerAfter!.lng - centerBefore!.lng;
  logMovementDiff('Pan mode lng change', -0.0009, lngChange, 0.001);

  expect(lngChange).toBeLessThan(0); // Direction check
});
```

### Step 5: Implement Ctrl+Drag Select Mode Tests

```typescript
it('Select mode: Ctrl+drag right moves map center left', async () => {
  await selectTool('select');
  await browser.pause(50);

  const canvas = await $('canvas');
  const location = await canvas.getLocation();
  const size = await canvas.getSize();

  const centerBefore = await getMapCenter();
  expect(centerBefore).not.toBeNull();

  // Ctrl+drag RIGHT 100px
  const centerX = location.x + size.width / 2;
  const centerY = location.y + size.height / 2;

  await browser.performActions([
    {
      type: 'key',
      id: 'keyboard',
      actions: [{ type: 'keyDown', value: '\uE009' }], // Control key
    },
    {
      type: 'pointer',
      id: 'mouse',
      parameters: { pointerType: 'mouse' },
      actions: [
        { type: 'pointerMove', x: Math.round(centerX), y: Math.round(centerY) },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerMove', x: Math.round(centerX + 100), y: Math.round(centerY) },
        { type: 'pointerUp', button: 0 },
      ],
    },
  ]);
  await browser.performActions([
    { type: 'key', id: 'keyboard', actions: [{ type: 'keyUp', value: '\uE009' }] },
  ]);
  await browser.releaseActions();
  await browser.pause(300);

  const centerAfter = await getMapCenter();
  expect(centerAfter).not.toBeNull();

  // Drag right → map center moves left (negative lng change)
  const lngChange = centerAfter!.lng - centerBefore!.lng;
  logMovementDiff('Ctrl+drag lng change', -0.0009, lngChange, 0.001);

  expect(lngChange).toBeLessThan(0); // Direction check
});
```

### Step 6: Implement Station Position Tests

```typescript
it('Select mode: Ctrl+drag moves stations opposite to drag', async () => {
  await selectTool('select');
  await browser.pause(50);

  const canvas = await $('canvas');
  const location = await canvas.getLocation();
  const size = await canvas.getSize();

  const stationsBefore = await getStationScreenPositions();
  if (stationsBefore.length === 0) {
    console.log('No stations rendered - skipping position test');
    return;
  }

  // Ctrl+drag RIGHT 100px
  const dragX = 100;
  const centerX = location.x + size.width / 2;
  const centerY = location.y + size.height / 2;

  await browser.performActions([
    { type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE009' }] },
    {
      type: 'pointer',
      id: 'mouse',
      parameters: { pointerType: 'mouse' },
      actions: [
        { type: 'pointerMove', x: Math.round(centerX), y: Math.round(centerY) },
        { type: 'pointerDown', button: 0 },
        { type: 'pointerMove', x: Math.round(centerX + dragX), y: Math.round(centerY) },
        { type: 'pointerUp', button: 0 },
      ],
    },
  ]);
  await browser.performActions([
    { type: 'key', id: 'keyboard', actions: [{ type: 'keyUp', value: '\uE009' }] },
  ]);
  await browser.releaseActions();
  await browser.pause(300);

  const stationsAfter = await getStationScreenPositions();

  // Verify each station moved LEFT by approximately 100px
  for (const before of stationsBefore.slice(0, 10)) { // Check first 10 stations
    const after = stationsAfter.find(s => s.id === before.id);
    expect(after).toBeDefined();

    const movementX = after!.screenX - before.screenX;
    logMovementDiff(`Station ${before.id} X`, -dragX, movementX, 20);

    // Drag right → stations move left (negative screen X)
    expect(movementX).toBeLessThan(-80);  // -100 ± 20px tolerance
    expect(movementX).toBeGreaterThan(-120);
  }
});
```

### Step 7: Tolerance Calibration

Initial tolerances (to be adjusted based on logging):
- Map center lng/lat change: ±0.001 (depends on zoom level)
- Station screen position: ±20px
- Zoom level: exact match (no tolerance)

Run tests with logging, observe actual values, adjust tolerances.

### Step 8: Run and Verify

```bash
# Run WebdriverIO tests with the new spec
./scripts/wdio.sh

# Or run just the new spec
pnpm test:e2e -- --spec e2e/specs/ctrl-drag-pan-movement.spec.ts
```

## Verification Checklist

### Stage 1: Playwright (run first)
1. [ ] Map instance exposed via `window.__stalagmight_map__`
2. [ ] Mock stations added to tauri-ipc.ts
3. [ ] Pan mode baseline tests pass (Playwright)
4. [ ] Ctrl+drag Select mode tests pass (Playwright)
5. [ ] No box select overlay during Ctrl+drag

### Stage 2: WebdriverIO (run after Playwright passes)
6. [ ] Fixture project loads successfully
7. [ ] Pan mode baseline tests pass (WebdriverIO)
8. [ ] Ctrl+drag Select mode tests pass (WebdriverIO)
9. [ ] Station position tests pass with real data
10. [ ] Zoom level unchanged after pan
11. [ ] All CTRL_PAN_TOOLS tested
12. [ ] Tolerances calibrated from logged values

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/components/Map/MapCanvas.tsx` | Modify | Expose map instance for testing |
| `e2e-playwright/ctrl-drag-pan-movement.spec.ts` | Create | Stage 1: Fast Playwright tests with mocked data |
| `e2e-playwright/mocks/tauri-ipc.ts` | Modify | Add mock stations to default project |
| `e2e/specs/ctrl-drag-pan-movement.spec.ts` | Create | Stage 2: WebdriverIO tests with real fixture |
| `e2e/helpers/app.ts` | Modify (optional) | Add helper for loading fixture projects |

## Potential Issues and Fixes

### If Ctrl+drag doesn't pan in Select mode:

Check `MapCanvas.tsx`:
1. Verify `CTRL_PAN_TOOLS` includes 'select' (line 12)
2. Verify `ctrlHeld` state updates on keydown (line 582)
3. Verify `dragPan.enable()` called when Ctrl held (lines 566-567, 588-590)
4. Verify capture-phase handler works (lines 625-642)
5. Check console for errors during Ctrl+drag

### If map center doesn't change:

1. Verify map instance is accessible via `window.__stalagmight_map__`
2. Check if `dragPan` is actually enabled (add console.log)
3. Verify pan animation completed (increase pause time)

### If stations not found:

1. Verify layer name is 'survey-stations'
2. Check if project has sections with shots
3. Verify stations are within visible bounds

## Commands Reference

```bash
# Type check
pnpm tsc --noEmit

# Run WebdriverIO E2E tests (recommended - uses ./scripts/wdio.sh)
./scripts/wdio.sh                    # Auto-handles display, build, cleanup
./scripts/wdio.sh --rebuild          # Force rebuild before tests
./scripts/wdio.sh --headless         # Force xvfb mode

# Run specific WebdriverIO spec
pnpm test:e2e -- --spec e2e/specs/ctrl-drag-pan-movement.spec.ts

# Run Playwright tests (for cursor/behavior tests without position verification)
pnpm test:ui
pnpm test:ui:headed

# Dev server (if needed)
./scripts/dev.sh

# Rust tests (if backend changes)
cargo test --manifest-path src-tauri/Cargo.toml
```
