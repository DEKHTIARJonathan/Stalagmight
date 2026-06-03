import { test, expect } from './fixtures/coverage';
import { setupTauriMocks } from './mocks/tauri-ipc';

/**
 * Regression guard for #43: scrolling over the map must not move the whole
 * window. The root layout (html/body/#root) uses `overflow: hidden` +
 * `overscroll-behavior: none` so wheel/trackpad scroll can't chain up to the
 * document and rubber-band the window on macOS WKWebView.
 *
 * This guards the CSS contract — the macOS rubber-band itself is WKWebView-only
 * and can't be reproduced in headless Chromium, so the behavioural check stays
 * a manual macOS step.
 */
test.describe('Scroll containment', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
  });

  test('document is scroll-contained (no overscroll chaining) @smoke', async ({ page }) => {
    const styles = await page.evaluate(() => {
      const read = (el: Element) => {
        const s = getComputedStyle(el);
        return { overscrollY: s.overscrollBehaviorY, overflowY: s.overflowY };
      };
      const root = document.getElementById('root');
      return {
        html: read(document.documentElement),
        body: read(document.body),
        root: root ? read(root) : null,
      };
    });

    // overscroll-behavior: none — stops wheel scroll from chaining to the window.
    expect(styles.html.overscrollY).toBe('none');
    expect(styles.body.overscrollY).toBe('none');
    // overflow: hidden — the document shell itself has no scroll range.
    expect(styles.html.overflowY).toBe('hidden');
    expect(styles.body.overflowY).toBe('hidden');
    // #root is covered by the same rule — guard it independently.
    expect(styles.root).not.toBeNull();
    expect(styles.root?.overscrollY).toBe('none');
    expect(styles.root?.overflowY).toBe('hidden');
  });
});
