/**
 * Runtime gate for the custom-render LABEL pass (#customRender labels, Phase 2).
 *
 * Sibling of `gate.ts` (the geometry gate); same runtime-flippable idiom
 * (localStorage + a live `window.__` override, OFF by default, no rebuild). The
 * two gates COMPOSE: labels ride the custom pipeline, so the label layer only
 * takes effect when the geometry gate (`readCustomRenderGate`) is ALSO on — the
 * label controller ANDs the two. Keeping a separate key lets the label subsystem
 * be flipped independently for staged rollout without re-litigating geometry.
 *
 * Enable (persists across reloads):   localStorage.setItem('stalagmight_custom_labels', '1')
 * Enable live this session (no reload): window.__stalagmight_custom_labels__ = true; then
 *   window.__stalagmightSyncCustomLabels?.()   // the label controller registers this hook
 * Disable:                             remove the key / set the global false, then re-sync.
 */

export const CUSTOM_LABELS_STORAGE_KEY = 'stalagmight_custom_labels';
export const CUSTOM_LABELS_WINDOW_KEY = '__stalagmight_custom_labels__';
export const CUSTOM_LABELS_SYNC_HOOK = '__stalagmightSyncCustomLabels';

/** Read the labels gate. Live window override wins over the persisted
 *  localStorage value; both absent means OFF. Fully guarded for non-DOM
 *  (test/node) envs. Mirrors {@link import('./gate').readCustomRenderGate}. */
export function readCustomLabelsGate(): boolean {
  if (typeof window !== 'undefined') {
    const live = (window as unknown as Record<string, unknown>)[CUSTOM_LABELS_WINDOW_KEY];
    if (typeof live === 'boolean') return live;
  }
  try {
    if (typeof localStorage !== 'undefined') {
      const v = localStorage.getItem(CUSTOM_LABELS_STORAGE_KEY);
      return v === '1' || v === 'true';
    }
  } catch {
    // localStorage can throw in locked-down contexts; treat as OFF.
  }
  return false;
}
