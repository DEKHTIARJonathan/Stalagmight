# Zoom Tool Click Behavior

## Summary
Add click-to-zoom functionality to the zoom tool: left-click zoom in, right-click zoom out, box zoom via drag, spring-loaded Z key.

## Task 1: Config (fn-2-f4f.1)

### Rust: src-tauri/src/config/mod.rs
```rust
#[serde(default = "default_zoom_step")]
pub zoom_step: f64,

fn default_zoom_step() -> f64 { 1.0 }

impl MapConfig {
    pub fn normalize(&mut self) {
        self.zoom_step = self.zoom_step.clamp(0.1, 5.0);
    }
}
```

### CRITICAL: Single Normalization Point - Config::save takes &mut self

Change signature:
```rust
impl Config {
    pub fn save(&mut self) -> Result<(), ConfigError> {
        self.map.normalize(); // Normalize before writing
        // ... serialize and write
    }
}
```

**Call sites to update (src-tauri/src/core/state.rs):**
- Line 709: `config.save()` - make config mutable
- Line 855: `config.save()` - make config mutable
- Line 1876: `config.save()` - make config mutable
- Line 1893: `config.save()?` - make config mutable

In `Config::load()`:
```rust
let mut config = /* deserialize */;
config.map.normalize();
Ok(config)
```

### Rust: src-tauri/src/config/defaults.rs
```rust
zoom_step: 1.0,
```

### TypeScript: src/types/config.ts
```typescript
export interface MapConfig {
  // ... existing fields
  zoom_step: number;
}

export const defaultConfig: Config = {
  map: {
    // ... existing fields
    zoom_step: 1.0,
  },
};
```

### Playwright Mock: e2e-playwright/mocks/tauri-ipc.ts
```typescript
map: {
  // ... existing fields
  zoom_step: 1.0,
},
```

## Task 2: Click-to-Zoom (fn-2-f4f.2)

### REQUIRED: Left-Click Capture Handler
```typescript
const handleClickCapture = (e: MouseEvent) => {
  if (e.button === 0 && !e.ctrlKey) {
    e.stopPropagation(); // CRITICAL: prevents SurveyLayer selection
  }
};
mapElement.addEventListener('click', handleClickCapture, { capture: true });
```

### REQUIRED: Right-Click Capture Handler (with placementMode guard)
```typescript
const handleContextMenuCapture = (e: MouseEvent) => {
  if (placementMode) return; // Don't intercept during placement mode
  
  e.preventDefault();
  e.stopPropagation();
  
  if (zoomBox.start) {
    setZoomBox({ start: null, end: null });
    return;
  }
  
  // ... zoom out logic
};
```

### REQUIRED: Set Map Zoom Limits
```typescript
useEffect(() => {
  if (!map.current || !config) return;
  map.current.setMinZoom(config.map.zoom_min ?? 0);
  map.current.setMaxZoom(config.map.zoom_max ?? 22);
}, [config]);
```

### doubleClickZoom Toggle
```typescript
useEffect(() => {
  if (!map.current) return;
  if (activeTool === 'zoom') map.current.doubleClickZoom.disable();
  else map.current.doubleClickZoom.enable();
}, [activeTool]);
```

## Task 3: Box Zoom (fn-2-f4f.3)

### fitBounds with maxZoom
```typescript
map.current.fitBounds([sw, ne], { 
  padding: 20, 
  linear: true, 
  duration: 300,
  maxZoom: config?.map.zoom_max ?? 22  // CRITICAL: respect zoom limit
});
```

### BOTH noPanTools Arrays (line ~584 and ~851)
```typescript
const noPanTools = ['select', 'zoom', 'draw', 'delete', 'merge', 'measure', 'move_section', 'move_station'];
```

### Ctrl+Drag Cursor Restore
```typescript
const cursors: Record<string, string> = {
  select: 'default',
  zoom: 'zoom-in',  // ADD THIS
  draw: 'crosshair',
  // ...
};
```

## Task 4: Spring-Loaded Z (fn-2-f4f.4)

See task 4 spec for full uiStore implementation.

## Task 5: Keyboard Shortcuts (fn-2-f4f.5)

See task 5 spec for +/- shortcuts.

## Task 6: Playwright Tests (fn-2-f4f.6)

### Test File: e2e-playwright/zoom-tool.spec.ts

Use shared fixture from e2e-playwright/fixtures/ (create if needed) or inline minimal setup:

```typescript
import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';

test.describe('Zoom Tool', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Create minimal project inline or use shared fixture
  });

  test('left-click zooms in', async ({ page }) => {
    await page.keyboard.press('z');
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    
    const initialZoom = await page.evaluate(() => (window as any).__cavechef_map__?.getZoom());
    await page.mouse.click(box!.x + box!.width/2, box!.y + box!.height/2);
    await page.waitForTimeout(400);
    const newZoom = await page.evaluate(() => (window as any).__cavechef_map__?.getZoom());
    expect(newZoom).toBeGreaterThan(initialZoom);
  });
  
  test('right-click zooms out', async ({ page }) => {
    await page.keyboard.press('z');
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    
    const initialZoom = await page.evaluate(() => (window as any).__cavechef_map__?.getZoom());
    await page.mouse.click(box!.x + box!.width/2, box!.y + box!.height/2, { button: 'right' });
    await page.waitForTimeout(400);
    const newZoom = await page.evaluate(() => (window as any).__cavechef_map__?.getZoom());
    expect(newZoom).toBeLessThan(initialZoom);
  });
  
  test('box zoom drag shows overlay mid-drag', async ({ page }) => {
    await page.keyboard.press('z');
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    
    await page.mouse.move(box!.x + 100, box!.y + 100);
    await page.mouse.down();
    await page.mouse.move(box!.x + 200, box!.y + 200);
    
    await expect(page.locator('[data-testid="zoom-box-overlay"]')).toBeVisible();
    
    await page.mouse.up();
    await expect(page.locator('[data-testid="zoom-box-overlay"]')).not.toBeVisible();
  });
  
  test('spring-loaded Z key restores tool on hold', async ({ page }) => {
    // Start on select tool
    await page.keyboard.press('s');
    await page.waitForTimeout(100);
    
    // Verify select is active (ring-2 ring-accent class indicates active)
    const toolButtons = page.locator('.bg-background.rounded button');
    const selectButton = toolButtons.filter({ hasText: '↖' });
    await expect(selectButton).toHaveClass(/ring-accent/);
    
    // Hold Z > 200ms
    await page.keyboard.down('z');
    await page.waitForTimeout(250);
    
    // Verify zoom is now active
    const zoomButton = toolButtons.filter({ hasText: '🔍' });
    await expect(zoomButton).toHaveClass(/ring-accent/);
    
    // Release Z
    await page.keyboard.up('z');
    await page.waitForTimeout(100);
    
    // Verify select is restored
    await expect(selectButton).toHaveClass(/ring-accent/);
  });
});
```

## Quick Commands
```bash
pnpm tsc --noEmit
pnpm test:ui
cargo test --manifest-path src-tauri/Cargo.toml
```

## Acceptance
- [ ] zoom_step in all config locations (Rust, TS, mock)
- [ ] Config::save takes &mut self, call sites updated
- [ ] Map min/max zoom set from config
- [ ] Left-click capture handler calls e.stopPropagation()
- [ ] Right-click capture handler with placementMode guard
- [ ] fitBounds respects maxZoom
- [ ] BOTH noPanTools arrays include 'zoom'
- [ ] Ctrl+drag cursor restore includes zoom
- [ ] SpringLoadedState in uiStore with targetTool
- [ ] keyup and blur handlers for spring-loaded
- [ ] Playwright tests with proper assertions
- [ ] pnpm tsc --noEmit passes
