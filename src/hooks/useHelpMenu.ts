import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useUIStore } from '../store/uiStore';

/**
 * Event the macOS Help menu emits for "Keyboard Shortcuts" (#665). The sender is
 * `src-tauri/src/app_menu.rs`, which keeps the same name.
 */
export const SHOW_SHORTCUTS_EVENT = 'menu:keyboard-shortcuts';

/**
 * Opens the keyboard shortcuts dialog when the Help menu asks for it, under the
 * same rules as the `?` key: not during station placement or a full-screen data
 * table, and never on top of another dialog.
 */
export function useHelpMenu(): void {
  useEffect(() => {
    const unlisten = listen(SHOW_SHORTCUTS_EVENT, () => {
      const { activeDialog, placementMode, dataTableFullScreen, openDialog } = useUIStore.getState();
      if (activeDialog || placementMode !== null || dataTableFullScreen) return;
      openDialog('keyboard-shortcuts');
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);
}
