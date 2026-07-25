/**
 * Quit entry point, shared by every affordance (GlobalView menu, in-project
 * menu, and the Ctrl+Q shortcut in both shortcut hooks) so the unsaved-changes
 * guard + close contract lives in exactly one place.
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';

/**
 * Perform the actual quit: request a window close.
 *
 * The Rust `on_window_event` handler re-emits `tauri://close-requested`, which
 * the App-level `useBeforeUnload` listener turns into a window destroy (no
 * import is in progress at this point, so it doesn't re-prompt). Requires the
 * `core:window:allow-close` capability; a rejection is logged so a denied/
 * regressed capability is visible rather than failing silently.
 *
 * Call this only AFTER any unsaved-changes confirmation - it does NOT prompt.
 */
export function performQuit(): void {
  getCurrentWindow()
    .close()
    .catch((err) => {
      console.error('[quit] window.close() failed:', err);
    });
}

/**
 * Quit the application. If a project has unsaved changes, route through the
 * in-app unsaved-changes dialog (Save / Discard & Quit / Cancel) - the same
 * guard New/Open use - instead of destroying the window and silently dropping
 * the edits. Otherwise quit immediately.
 */
export function quitApp(): void {
  const { project, isDirty } = useProjectStore.getState();
  if (project && isDirty) {
    useUIStore.getState().openDialog('unsaved-changes', { pendingQuit: true });
    return;
  }
  performQuit();
}
