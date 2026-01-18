import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { confirm } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * Hook to show a confirmation dialog when the user tries to close the app window
 * or navigate away while certain conditions are met (e.g., import in progress).
 *
 * @param shouldBlock - Whether to block the close action and show confirmation
 * @param message - The message to show in the confirmation dialog
 * @param onConfirm - Optional callback to run cleanup before closing (e.g., delete placed sections)
 */
export function useBeforeUnload(
  shouldBlock: boolean,
  message: string,
  onConfirm?: () => Promise<void>
) {
  useEffect(() => {
    if (!shouldBlock) return;

    let unlistenPromise: Promise<() => void> | undefined;

    // Handle Tauri window close request
    const setupTauriListener = async () => {
      try {
        unlistenPromise = listen('tauri://close-requested', async () => {
          const confirmed = await confirm(message, {
            title: 'Close Application',
            kind: 'warning',
            okLabel: 'Discard and Close',
            cancelLabel: 'Cancel',
          });

          if (confirmed) {
            // Run cleanup callback if provided
            if (onConfirm) {
              await onConfirm();
            }
            // Destroy the window
            const appWindow = getCurrentWindow();
            await appWindow.destroy();
          }
          // If not confirmed, window stays open
        });
      } catch (e) {
        // Tauri API not available (dev mode without Tauri)
        console.warn('Tauri close-requested listener not available:', e);
      }
    };

    setupTauriListener();

    // Handle browser beforeunload (for dev mode)
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = message;
      return message;
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      if (unlistenPromise) {
        unlistenPromise.then((unlisten) => unlisten());
      }
    };
  }, [shouldBlock, message, onConfirm]);
}
