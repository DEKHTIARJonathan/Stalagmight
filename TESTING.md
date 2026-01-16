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
cd src-tauri && cargo test

# Run all tests
pnpm test:all
```

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
import { setupTauriMocks } from './mocks/tauri-ipc';

test.describe('Feature Name', () => {
  test.beforeEach(async ({ page }) => {
    // Setup mocks before each test
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
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
async function createProject(page: Page, name: string) {
  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill(name);
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });
}
```

**Opening dialogs:**
```typescript
// Via keyboard shortcut (opens DmpImportDialog for DMP file import)
await page.keyboard.press('Control+i');
await page.waitForSelector('[data-testid="import-dmp-dialog"]');

// Via store (opens ImportDialog for section creation)
await page.evaluate(() => {
  (window as any).__E2E_TEST__.uiStore.getState().openDialog('import');
});
await page.waitForSelector('[data-testid="import-section-dialog"]');
```

> **Note**: `Ctrl+I` opens `DmpImportDialog` (for DMP file import), NOT `ImportDialog` (for manual section creation). See [Dialog Reference](#dialog-reference) for details.

**Closing dialogs:**
```typescript
// Via Cancel button (dialogs don't close on Escape)
await page.click('.fixed.inset-0 button:has-text("Cancel")');
```

**Interacting with canvas:**
```typescript
const canvas = page.locator('canvas').first();
await expect(canvas).toBeVisible();

// Click on canvas
await canvas.click();

// Drag on canvas
const box = await canvas.boundingBox();
if (box) {
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.up();
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

### Directory Structure

```
e2e/
├── specs/
│   ├── import-dmp-dialog.spec.ts      # DmpImportDialog tests (Ctrl+I)
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

CaveChef has two different import dialogs that serve different purposes:

| Dialog Component | `activeDialog` Value | Opened By | Test File |
|------------------|---------------------|-----------|-----------|
| `DmpImportDialog` | `'import-dmp'` | `Ctrl+I` keyboard shortcut | `import-dmp-dialog.spec.ts` |
| `ImportDialog` | `'import'` | SectionsPanel "+" button, E2E store | `import-section-dialog.spec.ts` |

**Important**: The `Ctrl+I` shortcut specifically opens `DmpImportDialog`, not `ImportDialog`. Tests that need to verify section name input should use `ImportDialog` via the store.

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

**Note**: `Ctrl+I` opens `DmpImportDialog` (for .dmp file import), NOT the generic `ImportDialog` (for manual section creation).

### Configuration

See `wdio.conf.ts`. Key settings:
- Auto-builds debug Tauri app before tests
- Starts tauri-driver on port 4444
- 30-second timeout for app startup

### Running WebdriverIO Tests

```bash
# Build and run
pnpm test:e2e

# Or manually:
# 1. Build the app
pnpm tauri build --debug --no-bundle

# 2. Start tauri-driver
tauri-driver &

# 3. Run tests
npx wdio run wdio.conf.ts
```

## Backend Rust Tests

Located alongside source code in `src-tauri/src/`.

### Running Rust Tests

```bash
cd src-tauri
cargo test                    # All tests
cargo test parser             # Tests matching "parser"
cargo test -- --nocapture     # Show println! output
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
// Good - wait for specific element
await page.waitForSelector('canvas', { timeout: 10000 });

// Avoid - arbitrary timeout
await page.waitForTimeout(1000);
```

### Error Messages

Include context in error assertions:

```typescript
await expect(page.locator('.error-message'))
  .toHaveText('Project name is required', { timeout: 3000 });
```

## UI Component Requirements for Testability

All UI components must include proper attributes for tests to locate elements reliably.

### Dialog Components (MANDATORY)

```tsx
<div
  role="dialog"
  aria-modal="true"
  aria-labelledby="dialog-title-id"
>
  <h2 id="dialog-title-id">Dialog Title</h2>
</div>
```

### Test Identifiers (`data-testid`)

```tsx
<button data-testid="new-project-button">New Project</button>
<div data-testid="global-view">...</div>
<input data-testid="project-name-input" />
```

### Selector Priority

1. `data-testid` - Most reliable: `[data-testid="new-project-button"]`
2. `role` + `aria-*` - Accessibility: `[role="dialog"]`
3. Semantic elements: `button:has-text("New Project")`
4. CSS classes - Least reliable

## Troubleshooting

### Playwright Tests Failing

1. **Check mock completeness**: Ensure all IPC commands are mocked
2. **Check selectors**: Use `[role="dialog"]` for dialogs, `[data-testid="..."]` for elements
3. **Check field types**: Ensure mock returns match TypeScript types
4. **Run debug test**: Use `debug.spec.ts` to see console errors

### WebdriverIO Tests Failing

1. **Check tauri-driver**: Must be installed and running
2. **Check build**: App must be built with `--debug --no-bundle`
3. **Check platform**: Only Linux/Windows supported
4. **Check ARIA attributes**: Dialogs must have `role="dialog"`

### Rust Tests Failing

1. **Check test isolation**: Tests shouldn't share mutable state
2. **Check async**: Use `#[tokio::test]` for async tests
3. **Check file paths**: Use `include_bytes!` for relative paths

## CI Integration

Tests are run in CI on every push. The CI pipeline:

1. Runs `pnpm tsc --noEmit` (type check)
2. Runs `pnpm test:ui` (Playwright tests)
3. Runs `cargo test` (Rust tests)

All must pass for the build to succeed.
