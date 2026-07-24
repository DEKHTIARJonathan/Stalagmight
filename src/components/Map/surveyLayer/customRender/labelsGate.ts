/**
 * Runtime sync hook for the custom-render LABEL pass (#customRender labels).
 *
 * The custom WebGL label renderer is now the SOLE label path: there is no gate
 * and no stock fallback. Only the runtime re-sync hook survives here — the label
 * controller registers `window.__stalagmightSyncCustomLabels` so a manual/dev
 * re-sync can force a rebuild. The former localStorage / `window.__` opt-out
 * machinery is gone.
 */

export const CUSTOM_LABELS_SYNC_HOOK = '__stalagmightSyncCustomLabels';
