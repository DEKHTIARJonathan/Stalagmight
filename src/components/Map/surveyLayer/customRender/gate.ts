/**
 * Runtime gate for the custom-render prototype (#customRender).
 *
 * Follows the repo's runtime-flippable idiom (localStorage, like
 * `utils/uiScale.ts`) plus a live `window.__` override (like
 * `window.__stalagmight_map__` in MapCanvas): OFF by default, flippable on
 * reload via localStorage or live via the window global — never needs a rebuild.
 *
 * Enable (persists across reloads):   localStorage.setItem('stalagmight_custom_render', '1')
 * Enable live this session (no reload): window.__stalagmight_custom_render__ = true; then
 *   window.__stalagmightSyncCustomRender?.()   // controller registers this hook
 * Disable:                             remove the key / set the global false, then re-sync.
 */

export const CUSTOM_RENDER_STORAGE_KEY = 'stalagmight_custom_render';
export const CUSTOM_RENDER_WINDOW_KEY = '__stalagmight_custom_render__';
export const CUSTOM_RENDER_SYNC_HOOK = '__stalagmightSyncCustomRender';

/** Read the gate. Live window override wins over the persisted localStorage
 *  value; both absent means OFF. Fully guarded for non-DOM (test/node) envs. */
export function readCustomRenderGate(): boolean {
  if (typeof window !== 'undefined') {
    const live = (window as unknown as Record<string, unknown>)[CUSTOM_RENDER_WINDOW_KEY];
    if (typeof live === 'boolean') return live;
  }
  try {
    if (typeof localStorage !== 'undefined') {
      const v = localStorage.getItem(CUSTOM_RENDER_STORAGE_KEY);
      return v === '1' || v === 'true';
    }
  } catch {
    // localStorage can throw in locked-down contexts; treat as OFF.
  }
  return false;
}
