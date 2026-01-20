import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';

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

  // Track if we've detected that Tauri IPC is unavailable
  // This prevents log spam in non-Tauri environments (tests, browser preview, etc.)
  const ipcUnavailableRef = useRef(false);

  // Check network status via backend
  const checkNetworkStatus = useCallback(async () => {
    // If browser reports offline, trust that immediately
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setIsOnline(false);
      return;
    }

    // If we've already determined IPC isn't available, skip the check
    if (ipcUnavailableRef.current) {
      // Fall back to browser's online state
      setIsOnline(typeof navigator !== 'undefined' ? navigator.onLine : true);
      return;
    }

    try {
      const online = await invoke<boolean>('get_network_status');
      setIsOnline(online);
    } catch (error) {
      // IPC failure - this could mean:
      // 1. App is running outside Tauri (tests, browser preview)
      // 2. App is closing
      // 3. Backend issue
      // Mark IPC as unavailable to prevent repeated failures
      ipcUnavailableRef.current = true;
      // Fall back to browser's online state (only log once)
      console.warn('[useNetworkStatus] Tauri IPC unavailable, falling back to browser online state');
      setIsOnline(typeof navigator !== 'undefined' ? navigator.onLine : true);
    }
  }, []);

  // Listen to browser online/offline events for immediate updates
  useEffect(() => {
    const handleOnline = () => {
      // Browser came online - verify with backend if available
      if (!ipcUnavailableRef.current) {
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

    // Set up interval (will self-disable if IPC is unavailable)
    const intervalId = setInterval(() => {
      if (!ipcUnavailableRef.current) {
        checkNetworkStatus();
      }
    }, pollInterval);

    return () => clearInterval(intervalId);
  }, [checkNetworkStatus, pollInterval]);

  return { isOnline, refresh: checkNetworkStatus };
}
