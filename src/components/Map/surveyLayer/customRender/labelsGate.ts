/**
 * Runtime gate for the custom-render LABEL pass (#customRender labels).
 *
 * The custom WebGL label renderer is now the DEFAULT (and only) label path in
 * normal operation: default ON whenever a DOM is present and it has not been
 * explicitly disabled. The five stock symbol label layers remain only as the GL
 * fail-safe target (a self-disable flips them back on) and behind this opt-out.
 *
 * STANDALONE (no longer composed with the geometry gate): labels anchor from
 * `SurveyData`, not from the geometry buffers, so the label layer is an
 * independent sibling of the stock/custom GEOMETRY layer. Custom labels over
 * stock geometry (the default: labels gate on, `stalagmight_custom_render` off)
 * is a valid, supported combination — the label controller activates on THIS
 * gate alone.
 *
 * Sibling of `gate.ts` (the geometry gate); same runtime-flippable idiom
 * (localStorage + a live `window.__` override, no rebuild), only the default is
 * inverted (ON, not OFF).
 *
 * Disable, full opt-out (persists, restores the stock label path):
 *     localStorage.setItem('stalagmight_custom_labels', '0')
 * Disable live this session (no reload): window.__stalagmight_custom_labels__ = false; then
 *   window.__stalagmightSyncCustomLabels?.()   // the label controller registers this hook
 * Re-enable:                            remove the key / set the global true, then re-sync.
 */

export const CUSTOM_LABELS_STORAGE_KEY = 'stalagmight_custom_labels';
export const CUSTOM_LABELS_WINDOW_KEY = '__stalagmight_custom_labels__';
export const CUSTOM_LABELS_SYNC_HOOK = '__stalagmightSyncCustomLabels';

/**
 * Read the labels gate. Default ON when a DOM is present; a boolean `window.__`
 * override wins over the persisted localStorage value, and localStorage `'0'` /
 * `'false'` is the explicit opt-out. Non-DOM (test/node) reads as OFF — mirroring
 * the effective {@link import('./gate').readCustomRenderGate} result when nothing
 * is set — so controllers built without a DOM stay inert and unit suites that
 * never flip the gate remain deterministic.
 */
export function readCustomLabelsGate(): boolean {
  // No DOM (node unit tests / SSR): OFF, keeping gate-less test controllers inert.
  if (typeof window === 'undefined') return false;
  const live = (window as unknown as Record<string, unknown>)[CUSTOM_LABELS_WINDOW_KEY];
  if (typeof live === 'boolean') return live;
  try {
    if (typeof localStorage !== 'undefined') {
      const v = localStorage.getItem(CUSTOM_LABELS_STORAGE_KEY);
      if (v === '0' || v === 'false') return false;
    }
  } catch {
    // localStorage can throw in locked-down contexts; fall through to the default.
  }
  // DOM present and not explicitly disabled → ON (the default, and only, path).
  return true;
}
