/**
 * Helpers a generated replay spec imports. Replay specs run under wdio (the
 * ambient `browser`/`$` globals), so these take the browser explicitly and wrap
 * the same page-context primitives the live harness uses. Keeping the generated
 * spec's imports pointed here (not at internal lib layout) decouples committed
 * replays from harness refactors.
 */
import type { Browser } from 'webdriverio';
import { invokeInApp, evalInApp } from './page';
import { readStore, callStoreAction, type StoreName } from './stores';
import { runScenario } from '../scenarios';

export { invokeInApp as ipc, evalInApp };
export { callStoreAction as storeAction };

/** Click at a canvas-relative pixel (for map/canvas features with no DOM node). */
export async function clickAt(
  browser: Browser,
  x: number,
  y: number,
  button: 'left' | 'right' | 'middle' = 'left',
): Promise<void> {
  await browser
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ x: Math.round(x), y: Math.round(y) })
    .down({ button })
    .up({ button })
    .perform();
}

/** Bounded pause between replayed actions (recorded inter-action gaps, capped). */
export async function pause(browser: Browser, ms: number): Promise<void> {
  await browser.pause(Math.max(0, Math.min(ms, 2000)));
}

/**
 * Re-run a recorded driver_script body with the same helpers in scope it had
 * live (browser/ipc/evalInApp/readStore/callAction/log). The spec runs
 * single-threaded, so no mutex is needed here.
 */
export async function driverScript(browser: Browser, script: string): Promise<unknown> {
  const helpers = {
    browser,
    ipc: (c: string, a?: Record<string, unknown>) => invokeInApp(browser, c, a),
    evalInApp: (b: string, a?: unknown[]) => evalInApp(browser, b, a ?? []),
    readStore: (s: StoreName, p?: string) => readStore(browser, s, p ?? null),
    callAction: (s: StoreName, act: string, a?: unknown[]) =>
      callStoreAction(browser, s, act, a ?? []),
    log: (_m: unknown) => undefined,
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'helpers',
    `return (async () => { const { browser, ipc, evalInApp, readStore, callAction, log } = helpers; ${script} })();`,
  );
  return fn(helpers) as Promise<unknown>;
}

/**
 * Re-run a recorded stress scenario with the recorded seed/iterations. The
 * scenarios are seeded-PRNG deterministic, so the replayed interaction stream
 * matches the recorded one.
 */
export async function runScenarioReplay(
  browser: Browser,
  name: string,
  seed?: number,
  iterations?: number,
): Promise<void> {
  await runScenario(name, { browser, exclusive: (fn) => fn() }, { seed, iterations });
}
