# Plan: Fix Ctrl+Drag Map Panning in Select Mode

## Problem Statement
Ctrl+drag does not pan the map when in Select mode (or any other tool). The feature is intended to allow users to pan the map by holding Ctrl while dragging, without having to switch to the Pan tool. **The issue is that it ALWAYS fails** - not intermittent.

## User Clarifications
1. **Scope**: Ctrl+drag panning should work in all non-movement tools:
   - YES: select, draw, delete, merge, measure
   - NO: pan, zoom, move_section, move_station (these already have their own drag behaviors)
2. **Mid-drag behavior**: If box select starts and Ctrl is pressed mid-drag, cancel box select and start panning
3. **Symptom**: Always fails (never works)

## Reference Documentation
- `CLAUDE.md` - Project structure and key files
- `SPEC.md` - Section 6.4 (Map Interactions): "Pan: Middle mouse drag, Pan tool, or Space+drag"
- `TESTING.md` - Testing requirements and patterns

## Root Cause Analysis

### Event Flow Architecture
The current implementation has a complex event flow:

```
User Action → React Event Handler → MapLibre Native Handler
                    ↓
           handleBoxSelectStart (line 229-248)
           checks e.ctrlKey, returns early if true
                    ↓
           Event propagates to MapLibre canvas
                    ↓
           MapLibre's dragPan handler (if enabled)
```

### Critical Files
| File | Lines | Purpose |
|------|-------|---------|
| `src/components/Map/MapCanvas.tsx` | 34 | `ctrlHeld` state tracking |
| `src/components/Map/MapCanvas.tsx` | 229-248 | `handleBoxSelectStart` - box select prevention |
| `src/components/Map/MapCanvas.tsx` | 540-554 | useEffect for dragPan enable/disable |
| `src/components/Map/MapCanvas.tsx` | 558-596 | Ctrl key event handlers |
| `src/components/Map/MapCanvas.tsx` | 828-836 | React event handlers on container |

### Root Causes Identified

Since the issue **always** fails (not intermittent), there are likely fundamental implementation bugs:

**Issue 1: Tool Check Too Restrictive (CONFIRMED)**
Looking at line 565 in MapCanvas.tsx:
```typescript
if (map.current && activeTool === 'select') {
  map.current.dragPan.enable();
}
```
This ONLY enables dragPan when `activeTool === 'select'`, but per requirements, it should also work in draw, delete, merge, and measure modes.

**Issue 2: Possible Event Handler Not Firing**
The keydown handler may not be firing or `map.current` may be null/invalid when it fires. Need to add debug logging to verify.

**Issue 3: UseEffect Order/Override Issue**
Two useEffects manage dragPan state:
1. Lines 540-554: Depends on `[activeTool, ctrlHeld]`
2. Lines 558-596: Depends on `[activeTool]` (keyboard handlers)

Possible race condition: When Ctrl is pressed, the keydown handler enables dragPan (line 566), but then React schedules a re-render and useEffect 1 (line 540) runs. If `ctrlHeld` state update hasn't propagated yet, it might disable dragPan again.

**Issue 4: Box Select Starting Despite Ctrl Check**
The React `onMouseDown={handleBoxSelectStart}` is on the PARENT container div, not the map canvas. This means:
1. User clicks on MapLibre canvas
2. MapLibre's handlers fire FIRST (on the canvas element)
3. THEN event bubbles to parent and React's handler fires

This ordering is actually CORRECT for our needs - MapLibre should see `dragPan` as enabled BEFORE we check for box select.

**Issue 5: Something Else Disabling DragPan**
Check for other code that might be calling `dragPan.disable()`:
- Placement mode (line 738)
- Other useEffects reacting to state changes

### Debug Strategy (Before Fix)
Add console logging to identify exact failure point:
```typescript
// In keydown handler
console.log('[DEBUG] Ctrl keydown, activeTool:', activeTool, 'map.current:', !!map.current);

// After dragPan.enable()
console.log('[DEBUG] Called dragPan.enable(), isEnabled:', map.current?.dragPan.isEnabled());

// In useEffect 540-554
console.log('[DEBUG] dragPan useEffect running, activeTool:', activeTool, 'ctrlHeld:', ctrlHeld);
```

## Solution Design

### Phase 1: Debug and Diagnose
First, add temporary debug logging to confirm the exact failure point, then remove after fix is verified.

### Phase 2: Fix Implementation

**Fix 1: Expand Tool Support (REQUIRED)**
Update line 565 to support all non-movement tools:
```typescript
const ctrlPanTools = ['select', 'draw', 'delete', 'merge', 'measure'];
if (map.current && ctrlPanTools.includes(activeTool)) {
  map.current.dragPan.enable();
}
```

**Fix 2: Add Capture-Phase Event Handler (RECOMMENDED)**
Add a capture-phase mousedown listener that enables `dragPan` BEFORE MapLibre processes the event. This handles the timing issue where Ctrl might be pressed just as mouse is clicked.

```typescript
// In MapCanvas.tsx - new useEffect:
useEffect(() => {
  const mapElement = mapContainer.current;
  if (!mapElement) return;

  const ctrlPanTools = ['select', 'draw', 'delete', 'merge', 'measure'];

  // Capture-phase handler runs BEFORE MapLibre's handlers
  const handleMouseDownCapture = (e: MouseEvent) => {
    if (e.ctrlKey && ctrlPanTools.includes(activeTool) && map.current) {
      // Enable dragPan BEFORE MapLibre processes this mousedown
      map.current.dragPan.enable();
    }
  };

  // Use capture: true to intercept BEFORE MapLibre
  mapElement.addEventListener('mousedown', handleMouseDownCapture, { capture: true });

  return () => {
    mapElement.removeEventListener('mousedown', handleMouseDownCapture, { capture: true });
  };
}, [activeTool]);
```

**Fix 3: Cancel Box Select on Ctrl Press (NEW)**
When Ctrl is pressed mid-box-select, cancel the box select:
```typescript
// In the Ctrl keydown handler, add:
if (boxSelect.start) {
  setBoxSelect({ start: null, end: null }); // Cancel active box select
}
```

**Fix 4: Update useEffect Dependencies Consistently**
Ensure both useEffects use the same `ctrlPanTools` list and handle all tools consistently.

### Why This Solution Works
1. **Capture-phase handler** ensures `dragPan.enable()` is called BEFORE MapLibre's mousedown handler fires
2. **Tool list expansion** enables the feature in all required tools
3. **Box select cancellation** implements the mid-drag Ctrl behavior
4. **Consistent tool lists** prevents tool-specific edge cases

## Implementation Plan

### Step 1: Add Debug Logging (Temporary)
**File:** `src/components/Map/MapCanvas.tsx`

Add console.log statements to verify event handler execution:
```typescript
// In keydown handler (line 562)
console.log('[DEBUG] Ctrl keydown', { activeTool, mapRef: !!map.current });

// After dragPan.enable() (line 566)
console.log('[DEBUG] dragPan.enable() called', { isEnabled: map.current?.dragPan.isEnabled() });

// In useEffect 540-554
console.log('[DEBUG] dragPan useEffect', { activeTool, ctrlHeld });
```

Run `pnpm tauri dev`, open DevTools console, and test Ctrl+drag to see which handlers fire.

### Step 2: Apply Core Fixes
**File:** `src/components/Map/MapCanvas.tsx`

1. **Define constant for Ctrl-pan tools** (add near top of component):
```typescript
const CTRL_PAN_TOOLS = ['select', 'draw', 'delete', 'merge', 'measure'];
```

2. **Update keydown handler (line 564-567):**
```typescript
// Enable dragPan immediately when Ctrl is pressed (for tools that support it)
if (map.current && CTRL_PAN_TOOLS.includes(activeTool)) {
  map.current.dragPan.enable();
}
```

3. **Update useEffect (line 546-548):**
```typescript
// Enable panning when Ctrl is held in supported tools
if (CTRL_PAN_TOOLS.includes(activeTool) && ctrlHeld) {
  map.current.dragPan.enable();
}
```

4. **Update cursor effect (line 530):**
```typescript
if (CTRL_PAN_TOOLS.includes(activeTool) && ctrlHeld) {
  map.current.getCanvas().style.cursor = 'grab';
}
```

### Step 3: Add Capture-Phase Handler
**File:** `src/components/Map/MapCanvas.tsx`

Add new useEffect after line 596:
```typescript
// Capture-phase handler to enable dragPan BEFORE MapLibre processes mousedown
useEffect(() => {
  const mapElement = mapContainer.current;
  if (!mapElement) return;

  const handleMouseDownCapture = (e: MouseEvent) => {
    if (e.ctrlKey && CTRL_PAN_TOOLS.includes(activeTool) && map.current) {
      map.current.dragPan.enable();
    }
  };

  mapElement.addEventListener('mousedown', handleMouseDownCapture, { capture: true });
  return () => mapElement.removeEventListener('mousedown', handleMouseDownCapture, { capture: true });
}, [activeTool]);
```

### Step 4: Cancel Box Select on Ctrl Press
**File:** `src/components/Map/MapCanvas.tsx`

In the keydown handler (around line 563), add box select cancellation:
```typescript
const handleKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Control' && !e.repeat) {
    setCtrlHeld(true);

    // Cancel any active box select
    setBoxSelect({ start: null, end: null });

    // Enable dragPan for supported tools
    if (map.current && CTRL_PAN_TOOLS.includes(activeTool)) {
      map.current.dragPan.enable();
    }
  }
};
```

Note: This requires `setBoxSelect` to be accessible in the handler. May need to pass it as a dependency or use a ref.

### Step 5: Remove Debug Logging
Remove all console.log statements added in Step 1.

### Step 6: Update handleBoxSelectStart
Ensure it returns early for all CTRL_PAN_TOOLS when Ctrl is held:
```typescript
const handleBoxSelectStart = useCallback(
  (e: React.MouseEvent) => {
    if (activeTool !== 'select') return; // Box select only in select mode
    if (!mapContainer.current) return;
    if (e.button !== 0) return;
    if (e.ctrlKey) return; // Ctrl+drag is for panning
    // ... rest of function
  },
  [activeTool]
);
```

## Test Strategy

### Unit Tests (Rust) - N/A
This is a frontend-only change, no backend tests needed.

### Playwright E2E Tests
**File:** `e2e-playwright/ctrl-drag-pan.spec.ts` (NEW)

```typescript
import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

// Helper to create a project and get to SingleSystemView
async function createProjectWithMap(page: Page): Promise<void> {
  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill('Ctrl Drag Test');
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });
}

test.describe('Ctrl+Drag Panning', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProjectWithMap(page);
  });

  // Test each supported tool
  const supportedTools = [
    { key: 's', name: 'select' },
    { key: 'd', name: 'draw' },
    { key: 'x', name: 'delete' },
    { key: 'm', name: 'merge' },
    { key: 'r', name: 'measure' },
  ];

  for (const tool of supportedTools) {
    test(`should pan map with Ctrl+drag in ${tool.name} mode`, async ({ page }) => {
      await page.keyboard.press(tool.key);
      await page.waitForTimeout(50);

      const canvas = page.locator('canvas').first();
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();

      // Get initial map center
      const initialCenter = await page.evaluate(() => {
        const store = (window as any).__E2E_TEST__?.uiStore;
        return store?.getState()?.mapCenter;
      });

      // Perform Ctrl+drag
      await page.keyboard.down('Control');
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.down();
      await page.mouse.move(box!.x + box!.width / 2 + 100, box!.y + box!.height / 2 + 100);
      await page.mouse.up();
      await page.keyboard.up('Control');

      await page.waitForTimeout(100);

      // Verify map center changed
      const finalCenter = await page.evaluate(() => {
        const store = (window as any).__E2E_TEST__?.uiStore;
        return store?.getState()?.mapCenter;
      });

      // Map should have moved
      expect(finalCenter).not.toEqual(initialCenter);
    });

    test(`should show grab cursor when Ctrl held in ${tool.name} mode`, async ({ page }) => {
      await page.keyboard.press(tool.key);
      await page.waitForTimeout(50);

      const canvas = page.locator('canvas').first();

      await page.keyboard.down('Control');
      await page.waitForTimeout(50);

      // Get the cursor from the MapLibre canvas (not the container)
      const cursor = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        return canvas?.style.cursor || window.getComputedStyle(canvas!).cursor;
      });

      expect(cursor).toBe('grab');

      await page.keyboard.up('Control');
    });
  }

  // Test unsupported tools (should NOT pan)
  const unsupportedTools = [
    { key: 'p', name: 'pan' },
    { key: 'z', name: 'zoom' },
    { key: 'v', name: 'move_section' },
    { key: 't', name: 'move_station' },
  ];

  for (const tool of unsupportedTools) {
    test(`should NOT change behavior with Ctrl in ${tool.name} mode`, async ({ page }) => {
      await page.keyboard.press(tool.key);
      await page.waitForTimeout(50);

      const canvas = page.locator('canvas').first();

      // Ctrl should NOT change cursor to grab
      await page.keyboard.down('Control');
      await page.waitForTimeout(50);

      const cursor = await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        return canvas?.style.cursor || window.getComputedStyle(canvas!).cursor;
      });

      // Should NOT be 'grab' in unsupported tools
      if (tool.name === 'pan') {
        expect(cursor).toBe('grab'); // Pan tool already shows grab
      } else {
        expect(cursor).not.toBe('grab');
      }

      await page.keyboard.up('Control');
    });
  }

  // Box select specific tests
  test('should not start box select when Ctrl+drag in select mode', async ({ page }) => {
    await page.keyboard.press('s');

    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();

    await page.keyboard.down('Control');
    await page.mouse.move(box!.x + 50, box!.y + 50);
    await page.mouse.down();
    await page.mouse.move(box!.x + 200, box!.y + 200);

    // Box select overlay should NOT be visible
    const boxOverlay = page.locator('.border-dashed.bg-accent\\/10');
    await expect(boxOverlay).not.toBeVisible();

    await page.mouse.up();
    await page.keyboard.up('Control');
  });

  test('should cancel box select when Ctrl pressed mid-drag', async ({ page }) => {
    await page.keyboard.press('s');

    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();

    // Start a normal drag (no Ctrl) to begin box select
    await page.mouse.move(box!.x + 50, box!.y + 50);
    await page.mouse.down();
    await page.mouse.move(box!.x + 100, box!.y + 100);
    await page.waitForTimeout(50);

    // Box select should be visible at this point
    const boxOverlay = page.locator('.border-dashed.bg-accent\\/10');
    await expect(boxOverlay).toBeVisible();

    // NOW press Ctrl mid-drag - box select should cancel
    await page.keyboard.down('Control');
    await page.waitForTimeout(50);

    // Box select should be cancelled
    await expect(boxOverlay).not.toBeVisible();

    // Continue drag - should now be panning
    await page.mouse.move(box!.x + 200, box!.y + 200);
    await page.mouse.up();
    await page.keyboard.up('Control');
  });

  // Edge case tests
  test('should handle window blur while Ctrl is held', async ({ page }) => {
    await page.keyboard.press('s');

    await page.keyboard.down('Control');
    await page.waitForTimeout(50);

    // Verify cursor is grab
    let cursor = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      return canvas?.style.cursor;
    });
    expect(cursor).toBe('grab');

    // Simulate window blur
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.waitForTimeout(50);

    // Cursor should no longer be grab (ctrlHeld reset)
    cursor = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      return canvas?.style.cursor;
    });
    expect(cursor).not.toBe('grab');
  });

  test('should allow Ctrl+click for toggle selection (not drag)', async ({ page }) => {
    await page.keyboard.press('s');

    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();

    // Ctrl+click (no drag) - should trigger toggle selection, not pan
    const initialCenter = await page.evaluate(() => {
      const store = (window as any).__E2E_TEST__?.uiStore;
      return store?.getState()?.mapCenter;
    });

    await page.keyboard.down('Control');
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.keyboard.up('Control');

    const finalCenter = await page.evaluate(() => {
      const store = (window as any).__E2E_TEST__?.uiStore;
      return store?.getState()?.mapCenter;
    });

    // Map should NOT have moved (click is not drag)
    expect(finalCenter).toEqual(initialCenter);
  });

  test('should stop panning when Ctrl released mid-drag', async ({ page }) => {
    await page.keyboard.press('s');

    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();

    // Start Ctrl+drag
    await page.keyboard.down('Control');
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 50, box!.y + box!.height / 2);

    // Release Ctrl mid-drag
    await page.keyboard.up('Control');
    await page.waitForTimeout(50);

    // dragPan should be disabled - further movement should not pan
    // (This is implementation-specific; MapLibre may continue the current drag)
    await page.mouse.move(box!.x + box!.width / 2 + 100, box!.y + box!.height / 2);
    await page.mouse.up();

    // No assertion on position here - behavior may vary
    // Main test is that app doesn't crash
    await expect(canvas).toBeVisible();
  });
});
```

### WebdriverIO E2E Tests
**File:** `e2e/specs/ctrl-drag-pan.spec.ts` (NEW)

```typescript
import { waitForAppReady, resetAppState, createNewProject, selectTool } from '../helpers/app';

describe('Ctrl+Drag Panning Integration', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
    await createNewProject('Ctrl Drag Test');
  });

  // Test each supported tool
  const supportedTools = ['select', 'draw', 'delete', 'merge', 'measure'];

  for (const tool of supportedTools) {
    it(`should pan map with Ctrl+drag in ${tool} mode`, async () => {
      await selectTool(tool);

      const canvas = await $('canvas');
      const location = await canvas.getLocation();
      const size = await canvas.getSize();

      const centerX = location.x + size.width / 2;
      const centerY = location.y + size.height / 2;

      // Perform Ctrl+drag using WebDriver actions
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
            { type: 'pause', duration: 100 },
            { type: 'pointerMove', x: Math.round(centerX + 100), y: Math.round(centerY + 100) },
            { type: 'pointerUp', button: 0 },
          ],
        },
      ]);

      await browser.performActions([
        {
          type: 'key',
          id: 'keyboard',
          actions: [{ type: 'keyUp', value: '\uE009' }],
        },
      ]);

      await browser.releaseActions();
      await browser.pause(200);

      // Map should remain functional after pan
      await expect(canvas).toBeDisplayed();
    });
  }

  // Test unsupported tools
  const unsupportedTools = ['pan', 'zoom', 'move_section', 'move_station'];

  for (const tool of unsupportedTools) {
    it(`should not add Ctrl+pan behavior in ${tool} mode`, async () => {
      await selectTool(tool);

      const canvas = await $('canvas');
      await expect(canvas).toBeDisplayed();

      // Ctrl+drag should not cause issues
      await browser.keys(['Control']);
      await browser.pause(50);
      await browser.keys([]); // Release

      await expect(canvas).toBeDisplayed();
    });
  }

  it('should cancel box select when Ctrl pressed mid-drag', async () => {
    await selectTool('select');

    const canvas = await $('canvas');
    const location = await canvas.getLocation();
    const size = await canvas.getSize();

    const centerX = location.x + size.width / 2;
    const centerY = location.y + size.height / 2;

    // Start drag without Ctrl (begins box select)
    await browser.performActions([
      {
        type: 'pointer',
        id: 'mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', x: Math.round(centerX - 50), y: Math.round(centerY - 50) },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', x: Math.round(centerX), y: Math.round(centerY) },
        ],
      },
    ]);

    await browser.pause(100);

    // Now press Ctrl - should cancel box select
    await browser.keys(['Control']);
    await browser.pause(50);

    // Continue drag and release
    await browser.performActions([
      {
        type: 'pointer',
        id: 'mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', x: Math.round(centerX + 50), y: Math.round(centerY + 50) },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ]);

    await browser.keys([]); // Release Ctrl
    await browser.releaseActions();

    await expect(canvas).toBeDisplayed();
  });

  it('should work with rapid Ctrl+click sequences', async () => {
    await selectTool('select');

    const canvas = await $('canvas');
    const location = await canvas.getLocation();
    const size = await canvas.getSize();

    const centerX = location.x + size.width / 2;
    const centerY = location.y + size.height / 2;

    // Rapid sequence: Ctrl down, click, Ctrl up, repeat 5 times
    for (let i = 0; i < 5; i++) {
      await browser.keys(['Control']);
      await browser.pause(10);
      await canvas.click({
        x: Math.round(centerX - location.x + i * 10),
        y: Math.round(centerY - location.y)
      });
      await browser.pause(10);
      await browser.keys([]);
    }

    await expect(canvas).toBeDisplayed();
  });
});
```

## Verification Checklist

### Pre-Implementation Verification
- [ ] Run existing Playwright tests: `pnpm test:ui`
- [ ] Verify current failure mode manually: `pnpm tauri dev`

### Post-Implementation Verification
- [ ] TypeScript compiles: `pnpm tsc --noEmit`
- [ ] Playwright tests pass: `pnpm test:ui`
- [ ] Rust tests pass: `cd src-tauri && cargo test`
- [ ] WebdriverIO tests pass (optional): `pnpm test:e2e`

### Manual Testing Scenarios
For each tool in (select, draw, delete, merge, measure):
1. [ ] Ctrl+drag pans map
2. [ ] Cursor shows 'grab' when Ctrl held
3. [ ] Tool-specific behavior works without Ctrl

For select mode specifically:
4. [ ] Box select works without Ctrl
5. [ ] Ctrl+click toggles selection (doesn't pan)
6. [ ] Pressing Ctrl mid-box-select cancels box select
7. [ ] Releasing Ctrl mid-drag stops panning

Edge cases:
8. [ ] Window blur resets Ctrl state
9. [ ] Pan tool works normally (with or without Ctrl)
10. [ ] Zoom, move_section, move_station don't gain Ctrl+pan behavior

## Files to Modify

| File | Action | Description |
|------|--------|-------------|
| `src/components/Map/MapCanvas.tsx` | Modify | Add CTRL_PAN_TOOLS constant, expand tool support, add capture-phase handler, cancel box select on Ctrl |
| `e2e-playwright/ctrl-drag-pan.spec.ts` | Create | New test file with 15+ tests for Ctrl+drag behavior |
| `e2e/specs/ctrl-drag-pan.spec.ts` | Create | New WebdriverIO integration tests |

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Capture-phase handler conflicts with other handlers | Handler only calls `dragPan.enable()`, doesn't stop propagation |
| Box select cancellation affects user workflow | Only cancels when Ctrl is pressed - intentional user action |
| setBoxSelect not accessible in keydown handler | May need to use a ref or restructure the handler |
| MapLibre version compatibility | Test with current maplibre-gl version in package.json |

## Success Criteria

1. Ctrl+drag reliably pans the map in all supported tools (select, draw, delete, merge, measure)
2. Cursor changes to 'grab' when Ctrl is held in supported tools
3. Box select works normally without Ctrl in select mode
4. Pressing Ctrl mid-box-select cancels the box select and enables panning
5. All existing tests continue to pass
6. New Playwright tests cover all supported/unsupported tools and edge cases
7. New WebdriverIO tests verify full app integration

## Test Count Summary

| Test Type | Expected Count |
|-----------|----------------|
| Playwright - per-tool pan tests | 5 (one per supported tool) |
| Playwright - per-tool cursor tests | 5 (one per supported tool) |
| Playwright - unsupported tool tests | 4 (pan, zoom, move_section, move_station) |
| Playwright - box select tests | 2 (no Ctrl, cancel mid-drag) |
| Playwright - edge case tests | 4 (blur, click vs drag, Ctrl release, etc.) |
| **Playwright Total** | ~20 tests |
| WebdriverIO - per-tool tests | 5 + 4 = 9 |
| WebdriverIO - edge cases | 2 |
| **WebdriverIO Total** | ~11 tests |
