import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { confirm } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { debugLog } from '../utils/debugLog';
import { consumeQuitConfirmation } from '../utils/quit';

/**
 * Hook to show a confirmation dialog when the user tries to close the app window
 * or navigate away while certain conditions are met (e.g., import in progress).
 *
 * IMPORTANT: The Tauri backend always prevents window close and emits 'tauri://close-requested'.
 * This hook MUST always listen for that event, otherwise the window cannot be closed.
 * When shouldBlock is false, we immediately close. When true, we show a confirmation.
 *
 * `guard` is the second, in-app tier: the OS window X arrives here as a
 * `tauri://close-requested` event, so this is the ONLY place that can route it
 * through the app's own exit guards (`guardQuit`). Before it existed, closing via
 * X destroyed the window whenever `shouldBlock` was false - discarding unsaved-
 * to-disk work and unpushed SpeleoDB edits with no prompt at all, while the menu
 * Quit prompted for both. A native `confirm` string is not a substitute for the
 * app's own dialog, which is why the guard opens a real dialog and aborts the
 * close instead of answering here.
 *
 * @param shouldBlock - Whether to block the close action and show confirmation
 * @param message - The message to show in the confirmation dialog
 * @param onConfirm - Optional callback to run cleanup before closing (e.g., delete placed sections)
 * @param guard - Optional in-app guard run after any `shouldBlock` confirmation.
 *   Returns true when it opened a dialog and the close must be abandoned.
 */
export function useBeforeUnload(
  shouldBlock: boolean,
  message: string,
  onConfirm?: () => Promise<void>,
  guard?: () => boolean
) {
  // Track if a dialog is currently being shown to prevent duplicates
  const isShowingDialog = useRef(false);
  // Track the unlisten function directly
  const unlistenRef = useRef<UnlistenFn | null>(null);
  // Track if we're in the process of closing
  const isClosing = useRef(false);
  // Track current blocking state for the listener callback
  const shouldBlockRef = useRef(shouldBlock);
  // Kept in a ref (not a dep) so a re-rendered guard identity never tears down
  // and re-registers the close listener.
  const guardRef = useRef(guard);

  // Keep ref in sync with prop
  useEffect(() => {
    shouldBlockRef.current = shouldBlock;
  }, [shouldBlock]);

  useEffect(() => {
    guardRef.current = guard;
  }, [guard]);

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

          // A quit the user already confirmed in-app (performQuit) comes back
          // through this same event. Consume the one-shot so the in-app guard
          // below is skipped for THIS close only - otherwise e.g. "Discard &
          // Quit" would re-open the dialog it came from, forever.
          const preConfirmed = consumeQuitConfirmation();

          // Tier 1: the in-memory states with no in-app dialog of their own (an
          // import wizard mid-flight, a dirty dive plan). Deliberately NOT
          // skipped by `preConfirmed`: a menu Quit confirms the PROJECT, which
          // says nothing about the dive plan the same close would drop.
          // Tier-1 cleanup, DEFERRED. It is destructive by contract ("e.g. delete
          // placed sections"), so it may only run once the close is actually going
          // ahead. Running it inside the tier-1 confirmation performed the deletions
          // for a close that tier 2 below then aborted - the user gets their dialog,
          // cancels, keeps the app open, and the sections are gone anyway.
          let deferredCleanup: (() => Promise<void>) | undefined;

          if (shouldBlockRef.current) {
            // Prevent multiple dialogs
            if (isShowingDialog.current || !isMounted) return;
            isShowingDialog.current = true;
            let proceed = false;
            try {
              proceed = await confirm(message, {
                title: 'Close Application',
                kind: 'warning',
                okLabel: 'Discard and Close',
                cancelLabel: 'Cancel',
              });
            } catch (e) {
              console.error('Close confirmation error:', e);
              proceed = false;
            } finally {
              isShowingDialog.current = false;
            }
            if (!proceed) return;
            deferredCleanup = onConfirm;
          }

          // Tier 2: the app's own exit guards (unpushed SpeleoDB edits under our
          // write lock, then unsaved-to-disk changes). Opening a dialog abandons
          // this close; the dialog's own action re-issues it via performQuit,
          // which arms `preConfirmed` so we land past this branch next time.
          if (!preConfirmed && guardRef.current?.()) {
            debugLog('[useBeforeUnload] In-app guard opened a dialog, aborting close');
            return;
          }

          // Past every guard: the window IS going away, so the tier-1 cleanup is
          // finally safe to perform.
          if (deferredCleanup) {
            try {
              await deferredCleanup();
            } catch (e) {
              console.error('Cleanup callback failed:', e);
            }
          }

          // Mark that we're closing to prevent re-triggering
          isClosing.current = true;

          // Unregister our listener before destroying to prevent loops
          if (unlistenRef.current) {
            unlistenRef.current();
            unlistenRef.current = null;
          }

          // Destroy the window
          await closeWindowNow();
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
