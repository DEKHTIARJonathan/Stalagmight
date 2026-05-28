import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { confirm } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { debugLog } from '../utils/debugLog';

/**
 * Hook to show a confirmation dialog when the user tries to close the app window
 * or navigate away while certain conditions are met (e.g., import in progress).
 *
 * IMPORTANT: The Tauri backend always prevents window close and emits 'tauri://close-requested'.
 * This hook MUST always listen for that event, otherwise the window cannot be closed.
 * When shouldBlock is false, we immediately close. When true, we show a confirmation.
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
  // Track if a dialog is currently being shown to prevent duplicates
  const isShowingDialog = useRef(false);
  // Track the unlisten function directly
  const unlistenRef = useRef<UnlistenFn | null>(null);
  // Track if we're in the process of closing
  const isClosing = useRef(false);
  // Track current blocking state for the listener callback
  const shouldBlockRef = useRef(shouldBlock);

  // Keep ref in sync with prop
  useEffect(() => {
    shouldBlockRef.current = shouldBlock;
  }, [shouldBlock]);

  useEffect(() => {
    // Always clean up any existing listener first
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }

    let isMounted = true;

    // Close the window immediately without confirmation
    const closeWindowNow = async () => {
      debugLog('[useBeforeUnload] closeWindowNow called');
      try {
        const appWindow = getCurrentWindow();
        debugLog('[useBeforeUnload] Got window, calling destroy');
        await appWindow.destroy();
        debugLog('[useBeforeUnload] Window destroyed');
      } catch (e) {
        console.error('[useBeforeUnload] Window destroy failed:', e);
      }
    };

    // Handle Tauri window close request
    // ALWAYS listen for this event - the backend always prevents default close
    const setupTauriListener = async () => {
      try {
        debugLog('[useBeforeUnload] Setting up close listener');
        const unlisten = await listen('tauri://close-requested', async () => {
          debugLog('[useBeforeUnload] Close requested, shouldBlock:', shouldBlockRef.current, 'isClosing:', isClosing.current);

          // If we're already closing, don't do anything
          if (isClosing.current) {
            debugLog('[useBeforeUnload] Already closing, ignoring');
            return;
          }

          // If not blocking, immediately close the window
          if (!shouldBlockRef.current) {
            debugLog('[useBeforeUnload] Not blocking, closing immediately');
            isClosing.current = true;
            await closeWindowNow();
            return;
          }

          // Prevent multiple dialogs
          if (isShowingDialog.current || !isMounted) return;
          isShowingDialog.current = true;

          try {
            const confirmed = await confirm(message, {
              title: 'Close Application',
              kind: 'warning',
              okLabel: 'Discard and Close',
              cancelLabel: 'Cancel',
            });

            if (confirmed) {
              // Mark that we're closing to prevent re-triggering
              isClosing.current = true;

              // Run cleanup callback if provided
              if (onConfirm) {
                try {
                  await onConfirm();
                } catch (e) {
                  console.error('Cleanup callback failed:', e);
                }
              }

              // Unregister our listener before destroying to prevent loops
              if (unlistenRef.current) {
                unlistenRef.current();
                unlistenRef.current = null;
              }

              // Destroy the window
              await closeWindowNow();
            }
          } catch (e) {
            console.error('Close confirmation error:', e);
          } finally {
            if (!isClosing.current) {
              isShowingDialog.current = false;
            }
          }
        });

        if (isMounted) {
          unlistenRef.current = unlisten;
        } else {
          // Component unmounted before listener was set up
          unlisten();
        }
      } catch (e) {
        // Tauri API not available (dev mode without Tauri)
        console.warn('Tauri close-requested listener not available:', e);
      }
    };

    setupTauriListener();

    // Handle browser beforeunload (for dev mode) - only when blocking
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isClosing.current || !shouldBlockRef.current) return;
      e.preventDefault();
      e.returnValue = message;
      return message;
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      isMounted = false;
      window.removeEventListener('beforeunload', handleBeforeUnload);
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, [message, onConfirm]); // Note: shouldBlock not in deps, we use ref for immediate access
}
