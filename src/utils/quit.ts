/**
 * Quit the application by requesting a window close.
 *
 * The Rust `on_window_event` handler re-emits `tauri://close-requested`, which
 * the App-level `useBeforeUnload` listener handles (confirms on unsaved work,
 * otherwise destroys the window). Requires the `core:window:allow-close`
 * capability; a rejection is logged so a denied/regressed capability is visible
 * rather than failing silently.
 *
 * Shared by every quit entry point (GlobalView menu, in-project menu, and the
 * Ctrl+Q shortcut in both shortcut hooks) so the close + error-handling contract
 * lives in exactly one place.
 */
import { getCurrentWindow } from '@tauri-apps/api/window';

export function quitApp(): void {
  getCurrentWindow()
    .close()
    .catch((err) => {
      console.error('[quit] window.close() failed:', err);
    });
}
