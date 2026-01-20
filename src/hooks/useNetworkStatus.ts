import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';

// Number of consecutive failures before backing off
const MAX_IPC_FAILURES = 3;

// After disabling, retry every N poll intervals to check if IPC recovered
const RECOVERY_CHECK_INTERVAL = 6; // Every 6th poll (e.g., every 60s if poll is 10s)

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
  // Only back off after multiple failures to handle transient issues
  const ipcFailureCountRef = useRef(0);
  const ipcBackedOffRef = useRef(false);

  // Counter for recovery attempts (retry periodically even when backed off)
  const pollCountRef = useRef(0);

  // Check network status via backend
  const checkNetworkStatus = useCallback(async () => {
    // If browser reports offline, trust that immediately
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setIsOnline(false);
      return;
    }

    // If IPC is backed off, only try recovery periodically
    if (ipcBackedOffRef.current) {
      pollCountRef.current++;
      if (pollCountRef.current < RECOVERY_CHECK_INTERVAL) {
        // Not time for recovery check yet - use browser state
        setIsOnline(typeof navigator !== 'undefined' ? navigator.onLine : true);
        return;
      }
      // Time for a recovery attempt
      pollCountRef.current = 0;
    }

    try {
      const online = await invoke<boolean>('get_network_status');
      // Success - reset failure counter and clear backoff
      ipcFailureCountRef.current = 0;
      if (ipcBackedOffRef.current) {
        ipcBackedOffRef.current = false;
        console.info('[useNetworkStatus] IPC recovered, resuming backend checks');
      }
      setIsOnline(online);
    } catch (error) {
      // IPC failure - increment counter
      ipcFailureCountRef.current++;

      if (ipcFailureCountRef.current >= MAX_IPC_FAILURES && !ipcBackedOffRef.current) {
        // Too many consecutive failures - back off but allow recovery
        ipcBackedOffRef.current = true;
        pollCountRef.current = 0;
        console.warn(
          `[useNetworkStatus] Tauri IPC unavailable after ${MAX_IPC_FAILURES} failures, backing off (will retry periodically)`
        );
      }

      // Fall back to browser's online state
      setIsOnline(typeof navigator !== 'undefined' ? navigator.onLine : true);
    }
  }, []);

  // Listen to browser online/offline events for immediate updates
  useEffect(() => {
    const handleOnline = () => {
      // Browser came online - verify with backend
      // Reset backoff to allow immediate recovery check
      if (ipcBackedOffRef.current) {
        pollCountRef.current = RECOVERY_CHECK_INTERVAL; // Force immediate retry
      }
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

    // Set up interval (will back off but periodically retry)
    const intervalId = setInterval(checkNetworkStatus, pollInterval);

    return () => clearInterval(intervalId);
  }, [checkNetworkStatus, pollInterval]);

  return { isOnline, refresh: checkNetworkStatus };
}
