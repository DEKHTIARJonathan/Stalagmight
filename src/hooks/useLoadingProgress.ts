/**
 * Hook to listen for Tauri loading-progress events.
 * Updates projectStore loading state based on backend progress events.
 * Includes timeout detection to show "taking longer than expected" message.
 */
import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useProjectStore } from '../store/projectStore';
import type { LoadingProgressPayload } from '../types/loading';

const TIMEOUT_MS = 30000; // 30 second timeout

export function useLoadingProgress() {
  const setLoadingProgress = useProjectStore((s) => s.setLoadingProgress);
  const loading = useProjectStore((s) => s.loading);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    // Only listen when loading is active and no error yet
    if (!loading.isLoading || loading.error) return;

    let unlisten: UnlistenFn | null = null;

    const checkTimeout = () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => {
        const current = useProjectStore.getState().loading;
        if (current.isLoading && !current.error) {
          // Show timeout warning without replacing the phase
          setLoadingProgress({ phase: 'loading_taking_long' });
        }
      }, TIMEOUT_MS);
    };

    const setupListener = async () => {
      unlisten = await listen<LoadingProgressPayload>('loading-progress', (event) => {
        const currentLoadingId = useProjectStore.getState().loading.loadingId;

        // CRITICAL: Ignore stale events from cancelled/previous loads
        if (event.payload.loadingId !== currentLoadingId) {
          if (import.meta.env.DEV) {
            console.debug(
              '[Loading] Ignoring stale event',
              event.payload.loadingId,
              '!=',
              currentLoadingId
            );
          }
          return;
        }

        // Reset timeout on each progress event
        checkTimeout();

        const { phase, phaseIndex, phaseCount, current, total, overallPercent, isIndeterminate } =
          event.payload;

        setLoadingProgress({
          phase,
          phaseIndex,
          phaseCount,
          phaseProgress: isIndeterminate
            ? undefined
            : current !== null && total !== null && total > 0
              ? (current / total) * 100
              : 0,
          phaseCurrent: current ?? undefined,
          phaseTotal: total ?? undefined,
          overallProgress: overallPercent,
        });

        if (import.meta.env.DEV) {
          console.debug(
            '[Loading]',
            phase,
            phaseIndex + 1,
            '/',
            phaseCount,
            current,
            '/',
            total,
            `(${overallPercent.toFixed(1)}%)`
          );
        }
      });
    };

    // Start initial timeout
    checkTimeout();
    setupListener();

    return () => {
      unlisten?.();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [loading.isLoading, loading.error, setLoadingProgress]);
}
