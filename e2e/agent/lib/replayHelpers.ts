/**
 * Helpers a generated replay spec imports. Replay specs run under wdio (the
 * ambient `browser`/`$` globals), so these take the browser explicitly and wrap
 * the same page-context primitives the live harness uses. Keeping the generated
 * spec's imports pointed here (not at internal lib layout) decouples committed
 * replays from harness refactors.
 */
import type { Browser } from 'webdriverio';

export { invokeInApp as ipc, evalInApp } from './page';
export { callStoreAction as storeAction } from './stores';

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
