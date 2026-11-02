import { useEffect } from 'react';
import { IPC_EVENTS, listenIpc } from '../utils/ipcEvents';
import { useInternalErrorStore } from '../store/internalErrorStore';

/**
 * [#576 A11] Listen for the backend's one-shot `internal-error` event and record it
 * for `InternalErrorBanner`. Mount once at the app root.
 *
 * Registered the way `useNetworkStatus` does it: `await listenIpc()` inside
 * try/catch, so a rejected registration is reported where it fails, and a listener
 * that resolves after cleanup is released as soon as it arrives.
 */
export function useInternalErrorEvent() {
  useEffect(() => {
    let disposed = false;
    let release: (() => void) | null = null;
    const register = async () => {
      try {
        const unlisten = await listenIpc(IPC_EVENTS.INTERNAL_ERROR, (event) => {
          const cell = event.payload.cell;
          console.error(`[internal-error] the backend recovered a lock poisoned by a crash (${cell})`);
          useInternalErrorStore.getState().raise(cell);
        });
        const unlistenSafely = () => {
          void new Promise<void>((resolve) => resolve(unlisten())).catch((e: unknown) => {
            console.warn('[useInternalErrorEvent] listener release failed:', e);
          });
        };
        if (disposed) unlistenSafely();
        else release = unlistenSafely;
      } catch (e) {
        console.warn('[useInternalErrorEvent] internal-error listener not available:', e);
      }
    };
    void register();
    return () => {
      disposed = true;
      release?.();
    };
  }, []);
}
