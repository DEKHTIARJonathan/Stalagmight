import { useEffect, useRef, useCallback, useState } from 'react';
import { useProjectStore } from '../store/projectStore';

export type AutoSaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface AutoSaveState {
  status: AutoSaveStatus;
  countdown: number;
  cancelPending: () => void;
}

/**
 * Debounced auto-save hook.
 *
 * Watches `isDirty` in the project store and, when auto-save is enabled and the
 * project has a file path, starts a debounce timer. Repeated changes reset the
 * timer.  Manual saves (isDirty going false externally) cancel the timer and
 * briefly show "Saved".
 */
export function useAutoSave(): AutoSaveState {
  const [status, setStatus] = useState<AutoSaveStatus>('idle');
  const [countdown, setCountdown] = useState(0);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const flashRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether we initiated the save so we can distinguish our own
  // isDirty→false from a manual Ctrl+S save.
  const savingRef = useRef(false);

  const clearAllTimers = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    if (flashRef.current) {
      clearTimeout(flashRef.current);
      flashRef.current = null;
    }
    setCountdown(0);
  }, []);

  const cancelPending = useCallback(() => {
    clearAllTimers();
    setStatus((prev) => (prev === 'pending' ? 'idle' : prev));
  }, [clearAllTimers]);

  // Flash a transient status then return to idle.
  const flash = useCallback(
    (s: 'saved' | 'error', durationMs: number) => {
      setStatus(s);
      if (flashRef.current) clearTimeout(flashRef.current);
      flashRef.current = setTimeout(() => {
        flashRef.current = null;
        setStatus('idle');
      }, durationMs);
    },
    [],
  );

  useEffect(() => {
    // Zustand v4 subscribe(listener) – listener receives (state, prevState).
    const unsub = useProjectStore.subscribe((state, prevState) => {
      const isDirty = state.isDirty;
      const wasDirty = prevState.isDirty;
      const filePath = state.project?.file_path ?? null;
      const autoSave = state.config?.general?.auto_save ?? false;
      const intervalSeconds =
        state.config?.general?.auto_save_interval_seconds ?? 30;
      const hasProject = state.project != null;

      // --- Project closed ---
      if (!hasProject) {
        clearAllTimers();
        savingRef.current = false;

        setStatus('idle');
        return;
      }

      // --- isDirty went false (save completed) ---
      if (wasDirty && !isDirty) {
        clearAllTimers();
        savingRef.current = false;

        flash('saved', 2000);
        return;
      }

      // --- isDirty is true (change happened) ---
      if (isDirty) {
        // Guard: skip if auto-save disabled, no project, or never saved
        if (!autoSave || !filePath) return;

        // If we're already executing a save, don't restart timers
        if (savingRef.current) return;

        const seconds = intervalSeconds;

        // Cancel existing debounce timer (reset on every change)
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (countdownRef.current) clearInterval(countdownRef.current);
        if (flashRef.current) {
          clearTimeout(flashRef.current);
          flashRef.current = null;
        }

        setStatus('pending');
        setCountdown(seconds);

        // 1-second countdown interval
        countdownRef.current = setInterval(() => {
          setCountdown((c) => {
            if (c <= 1) return 0;
            return c - 1;
          });
        }, 1000);

        // Debounce timer – fires the actual save
        debounceRef.current = setTimeout(async () => {
          debounceRef.current = null;
          if (countdownRef.current) {
            clearInterval(countdownRef.current);
            countdownRef.current = null;
          }
          setCountdown(0);

          const store = useProjectStore.getState();
          // Re-check guards at fire time
          if (
            !store.isDirty ||
            !store.project?.file_path ||
            !store.config?.general?.auto_save
          ) {
            setStatus('idle');
            return;
          }

          savingRef.current = true;
          setStatus('saving');
          const result = await store.saveProject();
          // saveProject sets isDirty=false on success, which triggers the
          // subscriber above to flash "saved".  On failure we handle here.
          if (!result.success) {
            savingRef.current = false;
            flash('error', 3000);
          }
        }, seconds * 1000);
      }
    });

    return () => {
      unsub();
      clearAllTimers();
    };
  }, [clearAllTimers, flash]);

  return { status, countdown, cancelPending };
}
