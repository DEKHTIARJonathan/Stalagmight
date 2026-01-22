# CaveChef Testing Guide

This document describes the testing infrastructure, conventions, and best practices for CaveChef.

## Testing Philosophy

**Tests are mandatory for all features.** A feature is not complete until it has appropriate test coverage. Tests serve as:

1. **Documentation**: Tests describe expected behavior
2. **Regression prevention**: Catch bugs before they reach users
3. **Refactoring safety net**: Confidently modify code knowing tests will catch breaks
4. **Design feedback**: Hard-to-test code often indicates design issues

## Test Infrastructure

CaveChef uses a multi-layered testing approach:

| Layer | Framework | Purpose | Speed |
|-------|-----------|---------|-------|
| Playwright E2E | Playwright | UI tests with mocked IPC | Fast (~8s for 34 tests) |
| WebdriverIO E2E | WebdriverIO + tauri-driver | Full app tests | Slow (real backend) |
| Backend Unit | Rust `#[test]` | Rust logic tests | Fast |

## Quick Start

```bash
# Run Playwright tests (recommended for development)
pnpm test:ui

# Run with visible browser (debugging)
pnpm test:ui:headed

# Run backend tests
cargo test --manifest-path src-tauri/Cargo.toml

# Run all tests
pnpm test:all
```

## Required Tests by Feature Type

| Feature Type | Required Tests |
|--------------|----------------|
| New UI component/dialog | Playwright E2E tests |
| New Tauri IPC command | Rust unit tests + Playwright E2E tests |
| Backend logic (parsers, models) | Rust unit tests |
| User workflow (multi-step) | Playwright E2E tests |
| Bug fix | Regression test covering the fix |

## Playwright E2E Tests

Located in `e2e-playwright/`. These tests run against the Vite dev server with mocked Tauri IPC calls.

### Directory Structure

```
e2e-playwright/
├── mocks/
│   └── tauri-ipc.ts       # Mock Tauri IPC command handlers
├── fixtures/              # Test data files
├── project-crud.spec.ts   # Project CRUD operation tests
├── ui-components.spec.ts  # UI interaction tests
└── debug.spec.ts          # Debugging helper test
```

### Configuration

See `playwright.config.ts` for settings:
- Runs against `http://localhost:1420` (Vite dev server)
- Auto-starts dev server via `webServer` config
- Uses Chromium browser
- Generates traces, screenshots, and videos on failure

### Writing Playwright Tests

#### Basic Test Structure

```typescript
import { test, expect } from '@playwright/test';
import { setupMockedPage } from './helpers/app';

test.describe('Feature Name', () => {
  test.beforeEach(async ({ page }) => {
    // Setup mocks + app bootstrap before each test
    await setupMockedPage(page);
  });

  test('should do something', async ({ page }) => {
    // Test implementation
    await page.click('button:has-text("Click Me")');
    await expect(page.locator('.result')).toBeVisible();
  });
});
```

#### Common Patterns

**Creating a project (required for most tests):**
```typescript
import { setupMockedPage, createProject, waitForMapReady } from './helpers/app';

test.beforeEach(async ({ page }) => {
  await setupMockedPage(page);
});

// In test:
await createProject(page, 'Test Project');
await waitForMapReady(page);
```

**Opening dialogs:**
```typescript
// Via keyboard shortcut (opens DmpSelectionDialog, Step 1 of DMP import flow)
await page.keyboard.press('Control+i');
await page.waitForSelector('[data-testid="dmp-selection-dialog"]');

// Via store (opens ImportDialog for section creation)
await page.evaluate(() => {
  (window as any).__E2E_TEST__.uiStore.getState().openDialog('import');
});
await page.waitForSelector('[data-testid="import-section-dialog"]');
```

> **Note**: `Ctrl+I` opens `DmpSelectionDialog` (Step 1 of DMP import), NOT `ImportDialog` (manual section creation). Step 2 is `DmpSectionConfigDialog`. See [Dialog Reference](#dialog-reference) for details.

**Closing dialogs:**
```typescript
// Via Cancel button (dialogs don't close on Escape)
const dialog = page.locator('[data-testid="new-project-dialog"]');
await dialog.locator('[data-testid="new-project-cancel-button"]').click();
```

**Interacting with canvas:**
```typescript
import { waitForMapReady, waitForMapIdle } from './helpers/app';

await waitForMapReady(page);
const mapCanvas = page.locator('[data-testid="map-canvas"]');
await expect(mapCanvas).toBeVisible();

// Click on canvas
await mapCanvas.click();

// Drag on canvas
const box = await mapCanvas.boundingBox();
if (box) {
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.up();
  await waitForMapIdle(page);
}
```

### Updating Tauri IPC Mocks

When adding new Tauri commands, update `e2e-playwright/mocks/tauri-ipc.ts`.

#### Mock Structure

The mock intercepts `__TAURI_INTERNALS__.invoke()` and returns mock data:

```typescript
case 'your_new_command': {
  const param = args?.param_name as string;
  // Return mock response matching Rust return type
  return { success: true, data: mockData };
}
```

#### Important Mock Fields

When mocking project state, ensure all required fields are present:

```typescript
// Project must have all these fields
const project = {
  id: 1,
  name: 'Test Project',
  location: null,
  created_at: new Date().toISOString(),
  modified_at: new Date().toISOString(),
  file_path: null,
  sections: [],
  station_merges: [],
  zero_datums: [],
  loop_closures: [],  // Don't forget this!
  section_offsets: {},
};

// Stats must have all these fields
const stats = {
  section_count: 0,
  shot_count: 0,
  total_length: 0,
  min_depth: 0,
  max_depth: 0,
  station_count: 0,
  loop_count: 0,
  penetration_distance: 0,
};

// Config must match src/types/config.ts structure
const config = {
  general: { ... },
  units: { ... },
  display: { default_background: '#1a1a2e', ... },  // Required!
  section_colors: { ... },
  map: { ... },
  validation: { ... },
  export: { ... },
  logging: { ... },
  shortcuts: { ... },
  snap: { ... },
  panels: { ... },
};
```

### Debugging Failed Tests

1. **Run in headed mode**: `pnpm test:ui:headed`
2. **Use debug test**: Run `e2e-playwright/debug.spec.ts` to see console logs
3. **Check artifacts**: Failed tests generate screenshots and videos in `test-results/`
4. **Add console logging in mocks**: Add `console.log()` in mock handlers

## WebdriverIO E2E Tests

Located in `e2e/`. These tests run against the full Tauri application.

### Requirements

- Linux or Windows (macOS not supported by tauri-driver)
- tauri-driver installed: `cargo install tauri-driver`
- Display server (X11/Wayland) or `xvfb` for headless environments

### Directory Structure

```
e2e/
├── specs/
│   ├── import-dmp-dialog.spec.ts      # DMP import flow (Selection + Config)
│   ├── import-section-dialog.spec.ts  # ImportDialog tests (section creation)
│   ├── project-lifecycle.spec.ts
│   ├── keyboard-shortcuts.spec.ts
│   └── map-interactions.spec.ts
├── fixtures/
│   ├── test_v2.dmp
│   ├── test_v5.dmp
│   └── test_v5_buggy_EOS.dmp
└── helpers/
    └── app.ts
```

### Dialog Reference

CaveChef has two different import flows that serve different purposes:

| Dialog Component | `activeDialog` Value | Opened By | Test File | Stats Feature |
|------------------|---------------------|-----------|-----------|---------------|
| `DmpSelectionDialog` | `'dmp-selection'` | `Ctrl+I` keyboard shortcut | `import-dmp-dialog.spec.ts` | Selection stats (shot count, total length, depth range) |
| `DmpSectionConfigDialog` | `'dmp-section-config'` | Continue from selection | `import-dmp-dialog.spec.ts` | Section stats in Parameters panel |
| `ImportDialog` | `'import'` | SectionsPanel "+" button, E2E store | `import-section-dialog.spec.ts` | N/A |

**Important**: The `Ctrl+I` shortcut opens `DmpSelectionDialog` (Step 1), not `ImportDialog`. Tests that need to verify section name input should use `ImportDialog` via the store.

**Stats Testing Notes:**
- Step 1 stats update when sections are checked/unchecked - verify `[data-testid="selection-stats"]` content changes
- Step 2 stats update when shots are edited/deleted - verify `[data-testid="section-stats"]` content changes
- Use `aria-label` attribute for accessibility testing - contains full descriptive text

### Dialog Close Behaviors

| Method | Works? | Notes |
|--------|--------|-------|
| Cancel/Close button | Yes | Recommended for tests |
| Backdrop click | Yes | Calls onClose |
| Escape key | No | Not implemented yet (planned in fn-3-m4h) |

**Note**: Escape key handling is not implemented for dialogs. Tests should use the Cancel button for reliable dialog closing.

### Opening Dialogs in E2E Tests

**Recommended**: Use the E2E store for reliable dialog opening:

```typescript
await browser.execute(() => {
  (window as any).__E2E_TEST__.uiStore.getState().openDialog('import');
});
```

**Note**: `Ctrl+I` opens `DmpSelectionDialog` (Step 1 of .dmp import), NOT the generic `ImportDialog` (manual section creation).

### Configuration

See `wdio.conf.ts`. Key settings:
- Auto-builds debug Tauri app before tests
- Starts tauri-driver on base port 4444 (workers use base + index)
- 30-second timeout for app startup
- Parallel execution enabled by default (maxInstances = min(4, CPU count))
- Per-worker config/data/cache isolation under a temp directory (auto-cleaned)
- Worker ports derived from base ports (4444 / base+1000) + worker index
- Base ports configurable via `WDIO_BASE_PORT` and `WDIO_BASE_NATIVE_PORT`
- Set `WDIO_MAX_INSTANCES=1` to force serial execution

### Running WebdriverIO Tests

**Recommended: Use the comprehensive test runner script:**

```bash
# Run all tests (auto-detects display, ensures fresh build)
./scripts/wdio.sh

# Run a specific spec file
./scripts/wdio.sh --spec e2e/specs/ctrl-drag-pan-movement.spec.ts

# Force rebuild before tests
./scripts/wdio.sh --rebuild

# Force headless mode (uses xvfb)
./scripts/wdio.sh --headless

# Skip build checks (use with caution - can cause stale binary issues)
./scripts/wdio.sh --skip-build

# Combine options: skip build and run single spec
./scripts/wdio.sh --skip-build --spec e2e/specs/map-interactions.spec.ts
```

The `wdio.sh` script automatically handles:
- Platform verification (Linux/Windows only)
- tauri-driver installation check
- Display detection (uses xvfb automatically if headless)
- Port cleanup (kills stale tauri-driver/cavechef processes)
- Build freshness checks (rebuilds if source is newer than binary)
- Proper argument passing to wdio (uses `npx wdio` directly)

**Manual run (not recommended):**

```bash
# Standard run (builds app first)
pnpm test:e2e

# Headless Linux (no display server)
xvfb-run -a pnpm test:e2e

# Skip rebuild if binary already exists
SKIP_BUILD=1 xvfb-run -a pnpm test:e2e

# Run with N parallel workers
WDIO_MAX_INSTANCES=4 xvfb-run -a pnpm test:e2e

# Run a single spec file (must use npx wdio directly, not pnpm test:e2e)
SKIP_BUILD=1 npx wdio run wdio.conf.ts --spec e2e/specs/ctrl-drag-pan-movement.spec.ts
```

> **Note**: When running a single spec file manually, you must use `npx wdio run wdio.conf.ts --spec <file>` directly. The `pnpm test:e2e -- --spec <file>` syntax does not properly pass the `--spec` flag.

#### Binary Path Configuration

The test runner looks for the Tauri binary at `$CARGO_TARGET_DIR/debug/cavechef`. By default, `wdio.conf.ts` expects `~/.cargo_build/debug/cavechef`.

If your project builds to a different location (e.g., the standard `src-tauri/target/`), set `CARGO_TARGET_DIR`:

```bash
# If binary is at src-tauri/target/debug/cavechef
CARGO_TARGET_DIR=./src-tauri/target xvfb-run -a pnpm test:e2e

# Combined with skip build
CARGO_TARGET_DIR=./src-tauri/target SKIP_BUILD=1 xvfb-run -a pnpm test:e2e
```

## Backend Rust Tests

Located alongside source code in `src-tauri/src/`.

### Running Rust Tests

```bash
cargo test --manifest-path src-tauri/Cargo.toml              # All tests
cargo test --manifest-path src-tauri/Cargo.toml parser       # Tests matching "parser"
cargo test --manifest-path src-tauri/Cargo.toml -- --nocapture  # Show println! output
```

### Writing Rust Tests

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_function_name() {
        let input = create_test_input();
        let result = function_under_test(input);
        assert_eq!(result, expected_output);
    }

    #[test]
    fn test_error_case() {
        let result = function_that_can_fail(invalid_input);
        assert!(result.is_err());
    }
}
```

### Testing Database Operations

Use in-memory SQLite for fast tests:

```rust
#[test]
fn test_database_operation() {
    let db = Database::open_in_memory().unwrap();
    // Run test operations
}
```

### Testing Parsers

Use test fixtures in `e2e/fixtures/`:

```rust
#[test]
fn test_parse_dmp_v5() {
    let data = include_bytes!("../../e2e/fixtures/test_v5.dmp");
    let result = parse_dmp(data);
    assert!(result.is_ok());
    let sections = result.unwrap();
    assert!(!sections.is_empty());
}
```

## Test Fixtures

### DMP Files

Located in `e2e/fixtures/`:

| File | Description |
|------|-------------|
| `test_v2.dmp` | Valid DMP version 2 file |
| `test_v5.dmp` | Valid DMP version 5 file |
| `test_v5_buggy_EOS.dmp` | DMP v5 with edge case EOS handling |

### Creating Test Fixtures

1. Use real data from mNemo device (anonymized if needed)
2. Create synthetic data for edge cases
3. Document the fixture's purpose in this file

## Best Practices

### Test Naming

Use descriptive names that explain what's being tested:

```typescript
// Good
test('should display error when project name is empty', ...)
test('should close dialog when Cancel button is clicked', ...)

// Bad
test('test1', ...)
test('error test', ...)
```

### Test Independence

Each test should:
- Set up its own state
- Not depend on other tests
- Clean up after itself

### Assertions

Be specific in assertions:

```typescript
// Good - specific assertion
await expect(page.locator('h1')).toHaveText('CaveChef');

// Bad - generic assertion
expect(true).toBeTruthy();
```

### Wait Strategies

Prefer explicit waits over timeouts:

```typescript
// Good - wait for map readiness
await waitForMapReady(page);
await waitForMapIdle(page);

// Avoid - arbitrary timeout
// await page.waitForTimeout(1000);
```

### Error Messages

Include context in error assertions:

```typescript
await expect(page.locator('.error-message'))
  .toHaveText('Project name is required', { timeout: 3000 });
```

## UI Component Testability Requirements

All UI components must include proper attributes for tests to locate elements reliably.

### Dialog Components (MANDATORY)

```tsx
<div
  role="dialog"
  aria-modal="true"
  aria-labelledby="dialog-title-id"
  data-testid="example-dialog"
>
  <h2 id="dialog-title-id">Dialog Title</h2>
</div>
```

**Why**: E2E tests target stable `data-testid` attributes, while `role="dialog"` and ARIA attributes are required for accessibility.

### Test Identifiers (`data-testid`)

| Element Type | Convention | Example |
|--------------|------------|---------|
| Main views | `<view>-view` | `data-testid="global-view"` |
| Buttons | `<action>-button` | `data-testid="new-project-button"` |
| Dialogs | `<name>-dialog` | `data-testid="new-project-dialog"` |
| Form inputs | `<field>-input` | `data-testid="project-name-input"` |
| Statistics | `stats-<metric>` | `data-testid="stats-total-length"` |
| Selection stats (Step 1) | `selection-stats`, `stats-<metric>` | `data-testid="selection-stats"`, `data-testid="stats-shot-count"`, `data-testid="stats-total-length"`, `data-testid="stats-depth-range"` |
| Section stats (Step 2) | `section-stats`, `section-stats-<metric>` | `data-testid="section-stats"`, `data-testid="section-stats-shot-count"`, `data-testid="section-stats-total-length"`, `data-testid="section-stats-depth-range"` |

### ARIA Attributes Quick Reference

| Attribute | Use Case |
|-----------|----------|
| `role="dialog"` | Modal dialogs (required) |
| `aria-modal="true"` | Dialogs that block interaction |
| `aria-labelledby` | Connect dialog to its title |
| `aria-label` | Icon-only buttons |
| `aria-expanded` | Collapsible panels |
| `aria-label` (stats) | Statistics containers for screen readers |

#### Statistics ARIA Labels

The selection and section stats containers use descriptive `aria-label` attributes for accessibility:

**Selection Stats (Step 1):**
```
aria-label="Selection statistics: 70 shots, 281.8m total length, depth range 2.1-15.4m"
```

**Section Stats (Step 2):**
```
aria-label="Section statistics: 42 shots, 187.3m total length, depth range 3.2-17.8m"
```

When no depth data is available, the label shows "--" for depth range:
```
aria-label="Selection statistics: 5 shots, 42.3m total length, depth range --"
```

### Selector Priority

1. `data-testid` - Most reliable: `[data-testid="new-project-button"]`
2. `role` + `aria-*` - Accessibility: `[role="dialog"]`
3. Semantic elements: `button:has-text("New Project")`
4. CSS classes - Least reliable

### Checklist for New UI Components

- [ ] Dialogs have `role="dialog"` and `aria-modal="true"`
- [ ] Dialog titles have `id` referenced by `aria-labelledby`
- [ ] Primary buttons have `data-testid`
- [ ] Form inputs have `data-testid`
- [ ] Icon-only buttons have `aria-label`

## Testing Dropdown Components

### Undo/Redo History Dropdown

The `UndoHistoryDropdown` component uses hover-triggered display with ARIA menu patterns.

#### Test Identifiers

| Element | data-testid | Notes |
|---------|-------------|-------|
| Undo button | `toolbar-undo-button` | Main trigger button |
| Redo button | `toolbar-redo-button` | Main trigger button |
| Undo dropdown | `toolbar-undo-button-dropdown` | Container with `role="menu"` |
| Redo dropdown | `toolbar-redo-button-dropdown` | Container with `role="menu"` |
| Undo item | `toolbar-undo-button-item-{index}` | Index matches item.index from stack |
| Redo item | `toolbar-redo-button-item-{index}` | Index matches item.index from stack |
| Detail preview | `detail-preview-popup` | Shows on item hover |
| Undo chevron | `undo-chevron` | Visible when stack not empty |
| Redo chevron | `redo-chevron` | Visible when stack not empty |

#### Hover Trigger Testing

The dropdown opens after a 300ms delay on hover. Tests should account for this:

```typescript
// Trigger hover and wait for dropdown
await page.hover('[data-testid="toolbar-undo-button"]');
await page.waitForSelector('[data-testid="toolbar-undo-button-dropdown"]', { timeout: 500 });

// Verify dropdown is visible
await expect(page.locator('[role="menu"]')).toBeVisible();
```

#### Keyboard Navigation Testing

```typescript
// Focus button and press Arrow Down to open
await page.focus('[data-testid="toolbar-undo-button"]');
await page.keyboard.press('ArrowDown');

// Wait for aria-activedescendant to be set (may be async)
await page.waitForFunction(() => {
  const dropdown = document.querySelector('[role="menu"]');
  return dropdown && dropdown.getAttribute('aria-activedescendant');
});

// Navigate and select
await page.keyboard.press('ArrowDown');  // Move to second item
await page.keyboard.press('Enter');       // Select
```

**Important**: The component sets `aria-activedescendant` in a `setTimeout(0)` callback after keyboard open. Always wait for this attribute before asserting on keyboard navigation state.

#### Close Behavior Testing

Test all close paths:

```typescript
// 1. Escape key
await page.keyboard.press('Escape');
await expect(page.locator('[role="menu"]')).not.toBeVisible();

// 2. Click outside (mousedown)
await page.click('body', { position: { x: 10, y: 10 } });

// 3. Global undo/redo shortcut
await page.keyboard.press('Control+z');

// 4. Mouse leave (100ms buffer)
await page.hover('[data-testid="map-canvas"]');
await page.waitForTimeout(150);
```

#### Detail Preview Testing

The preview popup appears on item hover without delay:

```typescript
// Hover an item to show preview
const item = page.locator('[data-testid="toolbar-undo-button-item-0"]');
await item.hover();

// Preview should appear immediately (no delay)
await expect(page.locator('[data-testid="detail-preview-popup"]')).toBeVisible();

// Verify preview content
await expect(page.locator('.detail-preview-popup')).toContainText('length');
```

#### Mock Requirements

When testing with mocked IPC, ensure `get_undo_stack` and `get_redo_stack` return the correct structure:

```typescript
case 'get_undo_stack': {
  return [
    {
      index: 0,
      description: 'Create section "Main Line"',
      timestamp: new Date().toISOString(),
      commandType: 'create_section',
      previewData: {
        changes: [{ field: 'name', oldValue: '', newValue: 'Main Line' }],
        additionalChanges: 0,
      },
    },
    // ... more items
  ];
}
```

## Export Testing

### SVG/PNG Export Scaling

The export system uses pixel-stable sizing to ensure consistent element appearance regardless of survey extent. Tests verify that SVG element sizes scale correctly.

#### Key Scaling Formula

```rust
let px = |pixels: f64| -> f64 { pixels / scale };
```

where `scale = TARGET_SIZE / max(width, height)` with `TARGET_SIZE = 800px`.

#### Verifying Element Sizes

To verify an element has the correct pixel size, multiply its viewBox value by the scale factor:

```rust
// Scale for 100m survey with 20m padding = 140m total
let scale = 800.0 / 140.0; // ≈ 5.714

// Station radius in viewBox units
let r = 0.525; // from SVG

// Verify: r * scale ≈ 3px (target station radius)
assert!((r * scale - 3.0).abs() < 0.1);
```

#### Target Element Sizes

| Element | Target Pixels | Test Pattern |
|---------|---------------|--------------|
| Station radius | 3px | `r="..."` attribute |
| Shot stroke-width | 2px | CSS `.shot { stroke-width: ... }` |
| Grid stroke-width | 0.5px | `class="grid" ... stroke-width="..."` |
| Virtual shot dash | 4px | `stroke-dasharray="X,Y"` |
| Virtual shot gap | 2px | `stroke-dasharray="X,Y"` |
| Label font-size | 10px | CSS `.label { font-size: ... }` |
| Section-name font-size | 12px | CSS `.section-name { font-size: ... }` |

#### Running Export Tests

```bash
# Run all Rust export tests
cargo test --manifest-path src-tauri/Cargo.toml export

# Run scaling regression tests specifically
cargo test --manifest-path src-tauri/Cargo.toml scaling_regression

# Run visual regression tests
cargo test --manifest-path src-tauri/Cargo.toml scaling_consistent
```

#### PNG DPI Scaling Tests

PNG exports scale dimensions based on DPI:

```
pixel_dimensions = svg_dimensions * (dpi / 72)
```

Tests verify that PNG dimensions match expected values at 72, 150, 300, and 600 DPI.

## Troubleshooting

### Playwright Tests Failing

1. **Check mock completeness**: Ensure all IPC commands are mocked
2. **Check selectors**: Use `[role="dialog"]` for dialogs, `[data-testid="..."]` for elements
3. **Check field types**: Ensure mock returns match TypeScript types
4. **Run debug test**: Use `debug.spec.ts` to see console errors

### WebdriverIO Tests Failing

1. **"No such file or directory" for cavechef binary**: Set `CARGO_TARGET_DIR` to point to where your binary was built (e.g., `CARGO_TARGET_DIR=./src-tauri/target`)
2. **"No display available" or display errors**: Use `xvfb-run -a` to provide a virtual display, or use `./scripts/wdio.sh` which auto-detects
3. **Port 4444 already in use**: A previous tauri-driver is still running. Kill it with `pkill tauri-driver`, or use `./scripts/wdio.sh` which handles this automatically
4. **Check tauri-driver**: Must be installed (`cargo install tauri-driver`)
5. **Check build**: App must be built with `--debug --no-bundle`
6. **Check platform**: Only Linux/Windows supported (not macOS)
7. **Check ARIA attributes**: Dialogs must have `role="dialog"`
8. **"Application did not load" with "Could not connect to localhost" in page source**: The binary has stale/incorrectly embedded frontend assets. This happens when using `SKIP_BUILD=1` with an outdated binary. Solution:
   - Use `./scripts/wdio.sh` (recommended) - it checks build freshness automatically
   - Or rebuild manually: `pnpm tauri build --debug --no-bundle`
   - Verify binary timestamp is after latest source file changes

### Rust Tests Failing

1. **Check test isolation**: Tests shouldn't share mutable state
2. **Check async**: Use `#[tokio::test]` for async tests
3. **Check file paths**: Use `include_bytes!` for relative paths

## CI Integration

Tests are run in CI on every push. The CI pipeline:

1. Runs `pnpm tsc --noEmit` (type check)
2. Runs `pnpm test:ui` (Playwright tests)
3. Runs `cargo test --manifest-path src-tauri/Cargo.toml` (Rust tests)

All must pass for the build to succeed.
