import { useState, useEffect, useCallback } from 'react';
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

  // Check network status via backend
  const checkNetworkStatus = useCallback(async () => {
    // If browser reports offline, trust that immediately
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setIsOnline(false);
      return;
    }

    try {
      const online = await invoke<boolean>('get_network_status');
      setIsOnline(online);
    } catch (error) {
      // IPC failure could mean app is closing or backend issue
      // Don't change state on invoke failures
      console.warn('[useNetworkStatus] Failed to check network status:', error);
    }
  }, []);

  // Listen to browser online/offline events for immediate updates
  useEffect(() => {
    const handleOnline = () => {
      // Browser came online - verify with backend
      checkNetworkStatus();
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

  // Periodic polling for network status
  useEffect(() => {
    // Initial check
    checkNetworkStatus();

    // Set up interval
    const intervalId = setInterval(checkNetworkStatus, pollInterval);

    return () => clearInterval(intervalId);
  }, [checkNetworkStatus, pollInterval]);

  return { isOnline, refresh: checkNetworkStatus };
}
