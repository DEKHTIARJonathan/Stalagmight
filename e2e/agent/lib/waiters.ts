/**
 * App-state waiters, ported from e2e/legacy/helpers/app.ts but parameterized by
 * a `Browser` instance (the legacy versions use the ambient wdio `browser`/`$`
 * globals, which a standalone `remote()` session does not have).
 */
import type { Browser } from 'webdriverio';

/** Resolve once the E2E test hooks are installed on window. */
export async function waitForE2EHooks(browser: Browser, timeout = 30000): Promise<boolean> {
  try {
    await browser.waitUntil(
      async () =>
        browser.execute(() => Boolean((window as unknown as { __E2E_TEST__?: unknown }).__E2E_TEST__)),
      { timeout, timeoutMsg: 'window.__E2E_TEST__ not present' },
    );
    return true;
  } catch {
    return false;
  }
}

/** Wait for the main app container (global view, New Project button, or map). */
export async function waitForAppReady(browser: Browser): Promise<void> {
  await browser.waitUntil(
    async () => {
      if (await browser.$('[data-testid="global-view"]').isExisting()) return true;
      if (await browser.$('button*=New Project').isExisting()) return true;
      return browser.$('[data-testid="map-canvas"]').isExisting();
    },
    { timeout: 30000, timeoutMsg: 'Application did not load within 30 seconds' },
  );
  await waitForUiIdle(browser, 200);
}

/** Wait for document-ready + a top-level view present (+ map idle if present). */
export async function waitForUiIdle(browser: Browser, minDelayMs = 0): Promise<void> {
  const start = Date.now();
  await browser.waitUntil(
    async () => {
      const docReady = await browser.execute(() => document.readyState === 'complete');
      if (!docReady) return false;
      const viewReady = await browser.execute(() =>
        Boolean(
          document.querySelector('[data-testid="global-view"], [data-testid="single-system-view"]'),
        ),
      );
      if (!viewReady) return false;
      if (await browser.$('[data-testid="map-canvas"]').isExisting()) {
        const mapIdle = await browser.execute(() => {
          const map = (
            window as unknown as {
              __stalagmight_map__?: {
                loaded?: () => boolean;
                isMoving?: () => boolean;
                isZooming?: () => boolean;
                isRotating?: () => boolean;
                isPitching?: () => boolean;
              };
            }
          ).__stalagmight_map__;
          if (!map) return false;
          return Boolean(
            (map.loaded?.() ?? false) &&
              !(map.isMoving?.() ?? false) &&
              !(map.isZooming?.() ?? false) &&
              !(map.isRotating?.() ?? false) &&
              !(map.isPitching?.() ?? false),
          );
        });
        if (!mapIdle) return false;
      }
      return Date.now() - start >= minDelayMs;
    },
    { timeout: 15000, timeoutMsg: 'UI did not reach idle state' },
  );
}

/** Wait for the MapLibre instance to be idle (no-op if no map mounted). */
export async function waitForMapIdle(browser: Browser, minDelayMs = 0): Promise<void> {
  const start = Date.now();
  await browser.waitUntil(
    async () => {
      const idle = await browser.execute(() => {
        const map = (
          window as unknown as {
            __stalagmight_map__?: {
              loaded?: () => boolean;
              isMoving?: () => boolean;
              isZooming?: () => boolean;
              isRotating?: () => boolean;
              isPitching?: () => boolean;
            };
          }
        ).__stalagmight_map__;
        if (!map) return true;
        return Boolean(
          (map.loaded?.() ?? true) &&
            !(map.isMoving?.() ?? false) &&
            !(map.isZooming?.() ?? false) &&
            !(map.isRotating?.() ?? false) &&
            !(map.isPitching?.() ?? false),
        );
      });
      return idle && Date.now() - start >= minDelayMs;
    },
    { timeout: 10000, timeoutMsg: 'Map did not reach idle state' },
  );
}

/** Wait until the map canvas reports the given active tool. */
export async function waitForActiveTool(browser: Browser, tool: string): Promise<void> {
  const canvas = browser.$('[data-testid="map-canvas"]');
  await canvas.waitForExist({ timeout: 15000 });
  await browser.waitUntil(async () => (await canvas.getAttribute('data-active-tool')) === tool, {
    timeout: 5000,
    timeoutMsg: `Active tool did not switch to ${tool}`,
  });
}

/** Best-effort: turn off onboarding overlays that intercept clicks. */
export async function disableOnboardingGuides(browser: Browser): Promise<void> {
  const hasConfig = await browser
    .waitUntil(
      async () =>
        browser.execute(() => {
          const e2e = (
            window as unknown as { __E2E_TEST__?: { projectStore?: { getState: () => { config: unknown } } } }
          ).__E2E_TEST__;
          return Boolean(e2e?.projectStore?.getState().config);
        }),
      { timeout: 10000, timeoutMsg: 'project config not available' },
    )
    .then(() => true)
    .catch(() => false);
  if (!hasConfig) return;

  await browser.executeAsync((done: (r: unknown) => void) => {
    const e2e = (
      window as unknown as {
        __E2E_TEST__?: {
          projectStore?: {
            getState: () => {
              config: { general?: { onboarding_enabled?: boolean } } | null;
              updateConfig?: (c: unknown) => Promise<unknown>;
            };
          };
        };
      }
    ).__E2E_TEST__;
    const store = e2e?.projectStore?.getState();
    const config = store?.config;
    if (!config || !store?.updateConfig) {
      done(null);
      return;
    }
    const next = { ...config, general: { ...config.general, onboarding_enabled: false } };
    Promise.resolve(store.updateConfig(next))
      .then(() => done(null))
      .catch(() => done(null));
  });
}
