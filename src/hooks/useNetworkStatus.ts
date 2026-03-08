import { useEffect, useRef, useCallback } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invokeIpc } from '../utils/ipc';
import { useNetworkStore } from '../store/networkStore';

/**
 * Event-driven network status orchestrator.
 *
 * Uses tile fetch outcomes as the primary connectivity signal:
 * - Tauri `tile-transport-error` event → offline
 * - Tauri `tile-transport-success` event → online
 *
 * Only polls the ESRI server when offline (to detect recovery).
 * On offline→online transition, triggers tile reload for stale tiles.
 *
 * Mount once at app root. Consumers read from `useNetworkStore`.
 */
export function useNetworkStatus() {
  const isOnline = useNetworkStore((s) => s.isOnline);
  const setOnline = useNetworkStore((s) => s.setOnline);
  const triggerTileReload = useNetworkStore((s) => s.triggerTileReload);

  // Ref to avoid stale closures in event handlers
  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;

  const goOnline = useCallback(() => {
    if (!isOnlineRef.current) {
      setOnline(true);
      triggerTileReload();
      console.info('[useNetworkStatus] Online — tiles reloading');
    }
  }, [setOnline, triggerTileReload]);

  const goOffline = useCallback(() => {
    if (isOnlineRef.current) {
      setOnline(false);
      console.info('[useNetworkStatus] Offline');
    }
  }, [setOnline]);

  // Listen for Tauri tile transport events + browser online/offline
  useEffect(() => {
    const unlisteners: Promise<UnlistenFn>[] = [];

    unlisteners.push(listen('tile-transport-error', () => goOffline()));
    unlisteners.push(listen('tile-transport-success', () => goOnline()));

    const handleBrowserOnline = () => {
      // Browser reports online — verify with backend
      invokeIpc<boolean>('get_network_status', undefined, { purpose: 'check network status' })
        .then((online) => { if (online) goOnline(); })
        .catch(() => { /* ignore — tile events will confirm */ });
    };
    const handleBrowserOffline = () => goOffline();

    window.addEventListener('online', handleBrowserOnline);
    window.addEventListener('offline', handleBrowserOffline);

    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()));
      window.removeEventListener('online', handleBrowserOnline);
      window.removeEventListener('offline', handleBrowserOffline);
    };
  }, [goOnline, goOffline]);

  // Poll get_network_status only when offline (to detect recovery)
  useEffect(() => {
    if (isOnline) return;

    const poll = async () => {
      try {
        const online = await invokeIpc<boolean>('get_network_status', undefined, { purpose: 'check network status' });
        if (online) goOnline();
      } catch {
        // Still offline
      }
    };

    poll();
    const intervalId = setInterval(poll, 10000);

    return () => clearInterval(intervalId);
  }, [isOnline, goOnline]);
}
