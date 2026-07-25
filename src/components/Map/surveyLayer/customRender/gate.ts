/**
 * Runtime sync hook for the custom-render survey layer (#customRender).
 *
 * The custom WebGL renderer is now the SOLE survey renderer: there is no gate and
 * no stock fallback. Only the runtime re-sync hook survives here - the controller
 * registers `window.__stalagmightSyncCustomRender` so a manual/dev re-sync can
 * force a rebuild from current geometry (used after a project switch and by the
 * agent bridge). The former localStorage / `window.__` enable machinery is gone.
 */

export const CUSTOM_RENDER_SYNC_HOOK = '__stalagmightSyncCustomRender';
