import {
  waitForAppReady,
  resetAppState,
  createNewProject,
} from '../helpers/app';

/**
 * E2E tests for Back button navigation (WebdriverIO/Tauri).
 *
 * These tests verify that clicking the Back button in SingleSystemView:
 * 1. Returns to Global View without crashing
 * 2. Handles unsaved changes dialog correctly
 * 3. Does not produce JavaScript errors (regression for app freeze bug)
 * 4. React remains mounted after navigation
 */

/**
 * Filter out known errors that are unrelated to the Back button bug.
 * The Back button crash produces "this.style.getLayer" error - we DO want to catch that.
 */
function filterMockErrors(errors: string[]): string[] {
  return errors.filter((error) => {
    // Allow the actual Back button crash error through
    if (error.includes('this.style.getLayer')) {
      return true;
    }
    // Filter out known Tauri mock-environment errors
    if (error.includes('unregisterListener')) {
      return false;
    }
    return true;
  });
}

describe('Back Button Navigation', () => {
  beforeEach(async () => {
    await waitForAppReady();
    // Reset any leftover state from previous tests
    await resetAppState();

    // Set up error collectors - BOTH onerror AND onunhandledrejection
    await browser.execute(() => {
      (window as unknown as { __testErrors: string[] }).__testErrors = [];

      // Capture sync errors
      const origOnError = window.onerror;
      window.onerror = (msg, src, line, col, error) => {
        (window as unknown as { __testErrors: string[] }).__testErrors.push(String(msg));
        if (origOnError) origOnError(msg, src, line, col, error);
        return false;
      };

      // Capture async/promise errors (critical for React/MapLibre teardown)
      window.onunhandledrejection = (e) => {
        (window as unknown as { __testErrors: string[] }).__testErrors.push(
          e.reason?.message || String(e.reason)
        );
      };
    });
  });

  afterEach(async () => {
    // Assert no JS errors occurred (sync or async)
    const allErrors = await browser.execute(
      () => (window as unknown as { __testErrors: string[] }).__testErrors
    );
    const relevantErrors = filterMockErrors(allErrors);
    expect(relevantErrors).toHaveLength(0);
  });

  it('should return to Global View without crashing (clean state)', async () => {
    // Create a new project using actual UI
    await createNewProject('Back Button E2E Test');

    // Verify we're in SingleSystemView (canvas visible)
    const canvas = await $('canvas');
    await canvas.waitForExist({ timeout: 15000 });

    // Click actual Back button (not store bypass)
    const backButton = await $('[data-testid="back-button"]');
    await backButton.waitForDisplayed({ timeout: 5000 });
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
    // Create a new project
    await createNewProject('Dirty Project E2E Test');

    // Wait for canvas to be visible
    const canvas = await $('canvas');
    await canvas.waitForExist({ timeout: 15000 });

    // Set dirty state via exposed store helper
    await browser.execute(() => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            setState: (state: { isDirty: boolean }) => void;
          };
        };
      }).__E2E_TEST__;
      if (e2e && e2e.projectStore) {
        e2e.projectStore.setState({ isDirty: true });
      }
    });

    // Click Back button
    const backButton = await $('[data-testid="back-button"]');
    await backButton.waitForDisplayed({ timeout: 5000 });
    await backButton.click();

    // Verify dialog appears
    const dialog = await $('[role="dialog"]');
    await dialog.waitForDisplayed({ timeout: 5000 });

    // Click Discard button
    const discardBtn = await $('button*=Discard');
    await discardBtn.waitForDisplayed({ timeout: 5000 });
    await discardBtn.click();

    // Verify clean exit to Global View
    const globalView = await $('[data-testid="global-view"]');
    await globalView.waitForExist({ timeout: 10000 });

    // Verify React still mounted
    const isMounted = await browser.execute(() => {
      const root = document.getElementById('root');
      return root && root.innerHTML.length > 50;
    });
    expect(isMounted).toBe(true);
  });

  it('should stay in view when canceling unsaved changes dialog', async () => {
    // Create a new project
    await createNewProject('Cancel Dialog E2E Test');

    // Wait for canvas to be visible
    const canvas = await $('canvas');
    await canvas.waitForExist({ timeout: 15000 });

    // Set dirty state
    await browser.execute(() => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            setState: (state: { isDirty: boolean }) => void;
          };
        };
      }).__E2E_TEST__;
      if (e2e && e2e.projectStore) {
        e2e.projectStore.setState({ isDirty: true });
      }
    });

    // Click Back button
    const backButton = await $('[data-testid="back-button"]');
    await backButton.click();

    // Verify dialog appears
    const dialog = await $('[role="dialog"]');
    await dialog.waitForDisplayed({ timeout: 5000 });

    // Click Cancel button to stay
    const cancelBtn = await $('button*=Cancel');
    await cancelBtn.click();

    // Verify dialog closes
    await browser.waitUntil(
      async () => !(await dialog.isDisplayed()),
      { timeout: 5000, timeoutMsg: 'Dialog did not close' }
    );

    // Verify we're still in SingleSystemView (canvas visible)
    await expect(canvas).toBeDisplayed();

    // Verify React still mounted
    const isMounted = await browser.execute(() => {
      const root = document.getElementById('root');
      return root && root.innerHTML.length > 50;
    });
    expect(isMounted).toBe(true);
  });

  it('should handle rapid Back clicks gracefully', async () => {
    // Create a new project
    await createNewProject('Rapid Click E2E Test');

    // Wait for canvas to be visible
    const canvas = await $('canvas');
    await canvas.waitForExist({ timeout: 15000 });

    // Rapidly click Back button multiple times
    const backButton = await $('[data-testid="back-button"]');
    await backButton.click();
    await backButton.click();
    await backButton.click();

    // Should still end up at Global View with no errors
    const globalView = await $('[data-testid="global-view"]');
    await globalView.waitForExist({ timeout: 10000 });

    // Verify React still mounted
    const isMounted = await browser.execute(() => {
      const root = document.getElementById('root');
      return root && root.innerHTML.length > 50;
    });
    expect(isMounted).toBe(true);
  });
});
