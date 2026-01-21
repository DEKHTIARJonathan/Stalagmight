# fn-7-gba.3 Add E2E tests for Back button navigation

## Description
Add E2E tests for Back button navigation with proper error capture to ensure the freeze bug does not regress.

## Implementation

### 1. Playwright test (e2e-playwright/back-button-navigation.spec.ts)

**NOTE**: Playwright runs from `e2e-playwright/` directory (see playwright.config.ts testDir).

```typescript
import { test, expect } from '@playwright/test';

test.describe('Back Button Navigation', () => {
  test.beforeEach(async ({ page }) => {
    // Capture page errors - test will fail if any occur
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    
    // Store for assertions
    (page as any).__capturedErrors = errors;
  });
  
  test.afterEach(async ({ page }) => {
    const errors = (page as any).__capturedErrors;
    expect(errors, 'No JavaScript errors should occur').toHaveLength(0);
  });

  test('should return to Global View without crashing (clean state)', async ({ page }) => {
    // Create/open a project to get to Single System View
    // ... project opening steps
    
    // Click Back button
    await page.click('[data-testid="back-button"]');
    
    // Verify we're back at Global View
    await expect(page.locator('[data-testid="global-view"]')).toBeVisible();
  });

  test('should handle unsaved changes dialog correctly', async ({ page }) => {
    // Open project
    // ...
    
    // CONCRETE DIRTYING ACTION: Use Zustand setState directly (no setDirty action exists)
    await page.evaluate(() => {
      const e2e = (window as any).__E2E_TEST__;
      if (e2e && e2e.projectStore) {
        e2e.projectStore.setState({ isDirty: true });
      }
    });
    
    // Click Back button
    await page.click('[data-testid="back-button"]');
    
    // Verify unsaved changes dialog appears
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    
    // Click "Discard Changes"
    await page.click('button:has-text("Discard")');
    
    // Verify clean return to Global View
    await expect(page.locator('[data-testid="global-view"]')).toBeVisible();
  });
  
  test('should handle rapid Back clicks gracefully', async ({ page }) => {
    // Open project
    // ...
    
    // Rapidly click Back button multiple times
    await page.click('[data-testid="back-button"]');
    await page.click('[data-testid="back-button"]');
    await page.click('[data-testid="back-button"]');
    
    // Should still end up at Global View with no errors
    await expect(page.locator('[data-testid="global-view"]')).toBeVisible();
  });
});
```

### 2. WebdriverIO test (e2e/specs/back-button.spec.ts)

**NOTE**: WDIO uses `e2e/specs/` directory (not e2e/test/specs).

```typescript
describe('Back Button Navigation', () => {
  beforeEach(async () => {
    // Set up error collectors - BOTH onerror AND onunhandledrejection
    await browser.execute(() => {
      (window as any).__testErrors = [];
      
      // Capture sync errors
      const origOnError = window.onerror;
      window.onerror = (msg, src, line, col, error) => {
        (window as any).__testErrors.push(String(msg));
        if (origOnError) origOnError(msg, src, line, col, error);
        return false;
      };
      
      // Capture async/promise errors (critical for React/MapLibre teardown)
      window.onunhandledrejection = (e) => {
        (window as any).__testErrors.push(e.reason?.message || String(e.reason));
      };
    });
  });
  
  afterEach(async () => {
    // Assert no JS errors occurred (sync or async)
    const errors = await browser.execute(() => (window as any).__testErrors);
    expect(errors).toHaveLength(0);
  });

  it('should return to Global View without crashing', async () => {
    // Open a project using actual UI (not store bypass)
    // ... project opening via UI
    
    // Click actual Back button (not store-level reset)
    const backButton = await $('[data-testid="back-button"]');
    await backButton.click();
    
    // Verify Global View is displayed
    const globalView = await $('[data-testid="global-view"]');
    await globalView.waitForExist({ timeout: 10000 });
    
    // Verify React still mounted (app not frozen)
    const isMounted = await browser.execute(() => {
      const root = document.getElementById('root');
      return root && root.innerHTML.length > 50;
    });
    expect(isMounted).toBe(true);
  });

  it('should show unsaved changes dialog when dirty', async () => {
    // Open project via UI
    // ...
    
    // CONCRETE DIRTYING ACTION: Use Zustand setState directly (no setDirty action exists)
    await browser.execute(() => {
      const e2e = (window as any).__E2E_TEST__;
      if (e2e && e2e.projectStore) {
        e2e.projectStore.setState({ isDirty: true });
      }
    });
    
    // Click Back
    const backButton = await $('[data-testid="back-button"]');
    await backButton.click();
    
    // Verify dialog appears
    const dialog = await $('[role="dialog"]');
    await dialog.waitForDisplayed({ timeout: 5000 });
    
    // Click Discard
    const discardBtn = await $('button*=Discard');
    await discardBtn.click();
    
    // Verify clean exit to Global View
    const globalView = await $('[data-testid="global-view"]');
    await globalView.waitForExist({ timeout: 10000 });
  });
});
```

### 3. Test scenarios to cover

1. Back button with clean state (no unsaved changes) - no dialog, clean exit
2. Back button with dirty state → Discard Changes → clean exit  
3. Back button with dirty state → Cancel → stay in view
4. Back button immediately after opening project
5. Back button with grid overlay visible
6. Back button with grid overlay hidden
7. Multiple rapid Back clicks → graceful handling
## Implementation

### 1. Playwright test (e2e-playwright/back-button-navigation.spec.ts)

**NOTE**: Playwright runs from `e2e-playwright/` directory (see playwright.config.ts testDir).

```typescript
import { test, expect } from '@playwright/test';

test.describe('Back Button Navigation', () => {
  test.beforeEach(async ({ page }) => {
    // Capture page errors - test will fail if any occur
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    
    // Store for assertions
    (page as any).__capturedErrors = errors;
  });
  
  test.afterEach(async ({ page }) => {
    const errors = (page as any).__capturedErrors;
    expect(errors, 'No JavaScript errors should occur').toHaveLength(0);
  });

  test('should return to Global View without crashing (clean state)', async ({ page }) => {
    // Create/open a project to get to Single System View
    // ... project opening steps
    
    // Click Back button
    await page.click('[data-testid="back-button"]');
    
    // Verify we're back at Global View
    await expect(page.locator('[data-testid="global-view"]')).toBeVisible();
  });

  test('should handle unsaved changes dialog correctly', async ({ page }) => {
    // Open project
    // ...
    
    // CONCRETE DIRTYING ACTION: Use exposed store helper
    await page.evaluate(() => {
      const e2e = (window as any).__E2E_TEST__;
      if (e2e && e2e.projectStore) {
        e2e.projectStore.getState().setDirty(true);
      }
    });
    
    // Click Back button
    await page.click('[data-testid="back-button"]');
    
    // Verify unsaved changes dialog appears
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    
    // Click "Discard Changes"
    await page.click('button:has-text("Discard")');
    
    // Verify clean return to Global View
    await expect(page.locator('[data-testid="global-view"]')).toBeVisible();
  });
  
  test('should handle rapid Back clicks gracefully', async ({ page }) => {
    // Open project
    // ...
    
    // Rapidly click Back button multiple times
    await page.click('[data-testid="back-button"]');
    await page.click('[data-testid="back-button"]');
    await page.click('[data-testid="back-button"]');
    
    // Should still end up at Global View with no errors
    await expect(page.locator('[data-testid="global-view"]')).toBeVisible();
  });
});
```

### 2. WebdriverIO test (e2e/specs/back-button.spec.ts)

**NOTE**: WDIO uses `e2e/specs/` directory (not e2e/test/specs).

```typescript
describe('Back Button Navigation', () => {
  beforeEach(async () => {
    // Set up error collector via exposed __E2E_TEST__
    await browser.execute(() => {
      (window as any).__testErrors = [];
      const origOnError = window.onerror;
      window.onerror = (msg, src, line, col, error) => {
        (window as any).__testErrors.push(String(msg));
        if (origOnError) origOnError(msg, src, line, col, error);
        return false;
      };
    });
  });
  
  afterEach(async () => {
    // Assert no JS errors occurred
    const errors = await browser.execute(() => (window as any).__testErrors);
    expect(errors).toHaveLength(0);
  });

  it('should return to Global View without crashing', async () => {
    // Open a project using actual UI (not store bypass)
    // ... project opening via UI
    
    // Click actual Back button (not store-level reset)
    const backButton = await $('[data-testid="back-button"]');
    await backButton.click();
    
    // Verify Global View is displayed
    const globalView = await $('[data-testid="global-view"]');
    await globalView.waitForExist({ timeout: 10000 });
    
    // Verify React still mounted (app not frozen)
    const isMounted = await browser.execute(() => {
      const root = document.getElementById('root');
      return root && root.innerHTML.length > 50;
    });
    expect(isMounted).toBe(true);
  });

  it('should show unsaved changes dialog when dirty', async () => {
    // Open project via UI
    // ...
    
    // CONCRETE DIRTYING ACTION: Use exposed store helper
    await browser.execute(() => {
      const e2e = (window as any).__E2E_TEST__;
      if (e2e && e2e.projectStore) {
        e2e.projectStore.getState().setDirty(true);
      }
    });
    
    // Click Back
    const backButton = await $('[data-testid="back-button"]');
    await backButton.click();
    
    // Verify dialog appears
    const dialog = await $('[role="dialog"]');
    await dialog.waitForDisplayed({ timeout: 5000 });
    
    // Click Discard
    const discardBtn = await $('button*=Discard');
    await discardBtn.click();
    
    // Verify clean exit to Global View
    const globalView = await $('[data-testid="global-view"]');
    await globalView.waitForExist({ timeout: 10000 });
  });
});
```

### 3. Test scenarios to cover

1. Back button with clean state (no unsaved changes) - no dialog, clean exit
2. Back button with dirty state → Discard Changes → clean exit  
3. Back button with dirty state → Cancel → stay in view
4. Back button immediately after opening project
5. Back button with grid overlay visible
6. Back button with grid overlay hidden
7. Multiple rapid Back clicks → graceful handling
## Implementation

### 1. Playwright test (src/tests/back-button-navigation.spec.ts)

```typescript
import { test, expect } from '@playwright/test';

test.describe('Back Button Navigation', () => {
  test.beforeEach(async ({ page }) => {
    // Capture page errors - test will fail if any occur
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    
    // Store for assertions
    (page as any).__capturedErrors = errors;
  });
  
  test.afterEach(async ({ page }) => {
    const errors = (page as any).__capturedErrors;
    expect(errors, 'No JavaScript errors should occur').toHaveLength(0);
  });

  test('should return to Global View without crashing (clean state)', async ({ page }) => {
    // Create/open a project to get to Single System View
    // ... project opening steps
    
    // Click Back button
    await page.click('[data-testid="back-button"]');
    
    // Verify we're back at Global View
    await expect(page.locator('[data-testid="global-view"]')).toBeVisible();
  });

  test('should handle unsaved changes dialog correctly', async ({ page }) => {
    // Open project, make a change to trigger dirty state
    // Click Back button
    // Verify unsaved changes dialog appears
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    
    // Click "Discard Changes"
    await page.click('button:has-text("Discard")');
    
    // Verify clean return to Global View
    await expect(page.locator('[data-testid="global-view"]')).toBeVisible();
  });
  
  test('should handle rapid Back clicks gracefully', async ({ page }) => {
    // Open project
    // Rapidly click Back button multiple times
    await page.click('[data-testid="back-button"]');
    await page.click('[data-testid="back-button"]');
    await page.click('[data-testid="back-button"]');
    
    // Should still end up at Global View with no errors
    await expect(page.locator('[data-testid="global-view"]')).toBeVisible();
  });
});
```

### 2. WebdriverIO test (e2e/test/specs/back-button.e2e.ts)

```typescript
describe('Back Button Navigation', () => {
  beforeEach(async () => {
    // Set up error collector via exposed __E2E_TEST__
    await browser.execute(() => {
      (window as any).__testErrors = [];
      const origOnError = window.onerror;
      window.onerror = (msg, src, line, col, error) => {
        (window as any).__testErrors.push(String(msg));
        if (origOnError) origOnError(msg, src, line, col, error);
        return false;
      };
    });
  });
  
  afterEach(async () => {
    // Assert no JS errors occurred
    const errors = await browser.execute(() => (window as any).__testErrors);
    expect(errors).toHaveLength(0);
  });

  it('should return to Global View without crashing', async () => {
    // Open a project using actual UI (not store bypass)
    // ... project opening via UI
    
    // Click actual Back button (not store-level reset)
    const backButton = await $('[data-testid="back-button"]');
    await backButton.click();
    
    // Verify Global View is displayed
    const globalView = await $('[data-testid="global-view"]');
    await globalView.waitForExist({ timeout: 10000 });
    
    // Verify React still mounted (app not frozen)
    const isMounted = await browser.execute(() => {
      const root = document.getElementById('root');
      return root && root.innerHTML.length > 50;
    });
    expect(isMounted).toBe(true);
  });

  it('should show unsaved changes dialog when dirty', async () => {
    // Open project via UI
    // Make a change to trigger dirty state
    
    // Click Back
    const backButton = await $('[data-testid="back-button"]');
    await backButton.click();
    
    // Verify dialog appears
    const dialog = await $('[role="dialog"]');
    await dialog.waitForDisplayed({ timeout: 5000 });
    
    // Click Discard
    const discardBtn = await $('button*=Discard');
    await discardBtn.click();
    
    // Verify clean exit to Global View
    const globalView = await $('[data-testid="global-view"]');
    await globalView.waitForExist({ timeout: 10000 });
  });
});
```

### 3. Test scenarios to cover

1. Back button with clean state (no unsaved changes) - no dialog, clean exit
2. Back button with dirty state → Discard Changes → clean exit  
3. Back button with dirty state → Cancel → stay in view
4. Back button immediately after opening project
5. Back button with grid overlay visible
6. Back button with grid overlay hidden
7. Multiple rapid Back clicks → graceful handling
## Implementation

### 1. Playwright test (src/tests/back-button.spec.ts)

```typescript
import { test, expect } from '@playwright/test';

test.describe('Back Button Navigation', () => {
  test('should return to Global View without crashing', async ({ page }) => {
    // Open a project to get to Single System View
    // ... project opening steps

    // Click Back button
    await page.click('[data-testid="back-button"]');

    // Verify we're back at Global View
    await expect(page.locator('[data-testid="global-view"]')).toBeVisible();

    // Verify no JavaScript errors occurred
    // (Playwright captures console errors automatically)
  });

  test('should handle unsaved changes dialog', async ({ page }) => {
    // Open project, make changes
    // Click Back button
    // Verify dialog appears
    // Click "Discard Changes"
    // Verify clean return to Global View
  });
});
```

### 2. WebdriverIO test (e2e/test/specs/back-button.e2e.ts)

```typescript
describe('Back Button Navigation', () => {
  it('should return to Global View without crashing', async () => {
    // Open a project
    // Click Back button
    // Verify Global View is displayed
    // Verify app is responsive
  });

  it('should show unsaved changes dialog when dirty', async () => {
    // Open project, make changes
    // Click Back
    // Verify dialog
    // Click Discard
    // Verify clean exit
  });
});
```

### 3. Test scenarios to cover

1. Back button with clean state (no unsaved changes)
2. Back button with dirty state → Discard Changes
3. Back button with dirty state → Cancel (stay in view)
4. Back button immediately after opening project
5. Back button with grid overlay visible
6. Back button with grid overlay hidden
## Acceptance
- [ ] Playwright test file created at `e2e-playwright/back-button-navigation.spec.ts`
- [ ] Playwright test uses `page.on('pageerror', ...)` to capture errors
- [ ] Playwright test uses `page.on('console', ...)` to capture console.error
- [ ] Playwright afterEach asserts no errors were captured
- [ ] Playwright test clicks actual Back button (not bypassing UI)
- [ ] WebdriverIO test file created at `e2e/specs/back-button.spec.ts`
- [ ] WebdriverIO sets up both `window.onerror` AND `window.onunhandledrejection` collectors
- [ ] WebdriverIO afterEach asserts no errors were captured
- [ ] WebdriverIO clicks actual Back button (not store-level reset)
- [ ] WebdriverIO verifies React is still mounted after navigation
- [ ] Tests use `__E2E_TEST__.projectStore.setState({ isDirty: true })` for dirtying
- [ ] Test covers clean state scenario
- [ ] Test covers dirty state + Discard scenario
- [ ] Test covers rapid Back clicks scenario
- [ ] `pnpm test:ui` passes
- [ ] `pnpm test:e2e` passes
## Done summary
Added comprehensive E2E tests for Back button navigation covering clean state, unsaved changes dialog, rapid clicks, grid overlay states (visible/hidden), and immediate back after project creation. Tests capture pageerror and console errors to detect the app freeze bug (this.style.getLayer).
## Evidence
- Commits: b302636, a612463, 309dc4b5c9c8e21d30468a013c1e8f3a42698f22
- Tests: pnpm test:ui --grep 'Back Button' (7 passed), pnpm tsc --noEmit
- PRs: