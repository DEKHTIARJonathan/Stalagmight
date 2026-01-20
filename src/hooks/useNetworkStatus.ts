import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';

// Number of consecutive failures before disabling IPC polling
const MAX_IPC_FAILURES = 3;

/**
 * Hook to track network connectivity status.
 *
 * Combines browser online state with periodic backend connectivity checks
 * to the ESRI tile server. This gives accurate offline detection for
 * the tile caching feature.
 *
 * @param pollInterval - Interval in ms between network checks (default: 10000)
 * @returns Object with isOnline status and manual refresh function
 */
export function useNetworkStatus(pollInterval = 10000) {
  // Start with browser's online state
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  // Track consecutive IPC failures
  // Only disable polling after multiple failures to handle transient issues
  const ipcFailureCountRef = useRef(0);
  const ipcDisabledRef = useRef(false);

  // Check network status via backend
  const checkNetworkStatus = useCallback(async () => {
    // If browser reports offline, trust that immediately
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setIsOnline(false);
      return;
    }

    // If IPC has been permanently disabled after repeated failures, use browser state
    if (ipcDisabledRef.current) {
      setIsOnline(typeof navigator !== 'undefined' ? navigator.onLine : true);
      return;
    }

    try {
      const online = await invoke<boolean>('get_network_status');
      // Success - reset failure counter
      ipcFailureCountRef.current = 0;
      setIsOnline(online);
    } catch (error) {
      // IPC failure - increment counter
      ipcFailureCountRef.current++;

      if (ipcFailureCountRef.current >= MAX_IPC_FAILURES) {
        // Too many consecutive failures - disable polling
        // This handles non-Tauri environments (tests, browser preview)
        ipcDisabledRef.current = true;
        console.warn(
          `[useNetworkStatus] Tauri IPC unavailable after ${MAX_IPC_FAILURES} failures, falling back to browser online state`
        );
      }

      // Fall back to browser's online state
      setIsOnline(typeof navigator !== 'undefined' ? navigator.onLine : true);
    }
  }, []);

  // Listen to browser online/offline events for immediate updates
  useEffect(() => {
    const handleOnline = () => {
      // Browser came online - verify with backend if available
      if (!ipcDisabledRef.current) {
        checkNetworkStatus();
      } else {
        setIsOnline(true);
      }
    };

    const handleOffline = () => {
      // Browser reports offline - trust immediately
      setIsOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [checkNetworkStatus]);

  // Periodic polling for network status (only if IPC is available)
  useEffect(() => {
    // Initial check
    checkNetworkStatus();

    // Set up interval (will self-disable after MAX_IPC_FAILURES)
    const intervalId = setInterval(() => {
      if (!ipcDisabledRef.current) {
        checkNetworkStatus();
      }
    }, pollInterval);

    return () => clearInterval(intervalId);
  }, [checkNetworkStatus, pollInterval]);

  return { isOnline, refresh: checkNetworkStatus };
}
