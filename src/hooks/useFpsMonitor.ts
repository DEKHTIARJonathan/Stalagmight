import { useEffect, useRef, useState } from 'react';

/** Rolling window size for FPS averaging */
const ROLLING_WINDOW_SIZE = 30;

/** FPS threshold below which throttling activates (can be overridden via config) */
const DEFAULT_FPS_THRESHOLD = 30;

/** FPS threshold above which throttling deactivates (hysteresis to prevent oscillation) */
const DEFAULT_FPS_RECOVERY_THRESHOLD = 45;

/** Delta time above this threshold (ms) is considered a pause (tab switch, etc.) */
const PAUSE_THRESHOLD_MS = 250;

/** Minimum interval (ms) between FPS state updates to avoid excessive React work */
const FPS_UPDATE_INTERVAL_MS = 250;

/**
 * Configuration options for the FPS monitor.
 */
export interface FpsMonitorConfig {
  /** FPS threshold below which onThrottleNeeded is called (default: 30) */
  fpsThreshold?: number;
  /** FPS threshold above which onThrottleRestore is called (default: 45) */
  recoveryThreshold?: number;
  /** Enable/disable the monitor (default: true) */
  enabled?: boolean;
}

/**
 * Result returned by the useFpsMonitor hook.
 */
export interface FpsMonitorResult {
  /** Current FPS (rolling average) */
  fps: number;
  /** Whether the system is currently in throttled state */
  isThrottled: boolean;
}

/**
 * Hook to monitor FPS using requestAnimationFrame timing.
 *
 * Calculates a rolling average FPS over ROLLING_WINDOW_SIZE frames and
 * triggers callbacks when FPS drops below or recovers above thresholds.
 *
 * Uses hysteresis (different thresholds for throttle vs recovery) to
 * prevent rapid oscillation between states.
 *
 * @param onThrottleNeeded - Called when FPS drops below threshold
 * @param onThrottleRestore - Called when FPS recovers above recovery threshold
 * @param config - Optional configuration overrides
 * @returns Current FPS and throttled state
 */
export function useFpsMonitor(
  onThrottleNeeded: () => void,
  onThrottleRestore: () => void,
  config: FpsMonitorConfig = {}
): FpsMonitorResult {
  const {
    fpsThreshold = DEFAULT_FPS_THRESHOLD,
    recoveryThreshold = DEFAULT_FPS_RECOVERY_THRESHOLD,
    enabled = true,
  } = config;

  const [fps, setFps] = useState(60);
  const [isThrottled, setIsThrottled] = useState(false);

  // Refs for animation frame state (avoid closures capturing stale values)
  const frameTimesRef = useRef<number[]>([]);
  const lastTimeRef = useRef<number>(0);
  const animationFrameIdRef = useRef<number>(0);
  const lastFpsUpdateRef = useRef<number>(0);
  const lastReportedFpsRef = useRef<number>(60);

  // Refs for callbacks to avoid effect dependency churn
  const onThrottleNeededRef = useRef(onThrottleNeeded);
  const onThrottleRestoreRef = useRef(onThrottleRestore);

  // Keep refs updated
  useEffect(() => {
    onThrottleNeededRef.current = onThrottleNeeded;
    onThrottleRestoreRef.current = onThrottleRestore;
  }, [onThrottleNeeded, onThrottleRestore]);

  // Ref for throttled state to use in animation callback
  const isThrottledRef = useRef(isThrottled);
  isThrottledRef.current = isThrottled;

  // Main animation frame loop
  useEffect(() => {
    if (!enabled) {
      // When disabling, restore throttle if currently throttled
      if (isThrottledRef.current) {
        setIsThrottled(false);
        isThrottledRef.current = false;
        onThrottleRestoreRef.current();
      }
      setFps(60);
      return;
    }

    const measureFrame = (currentTime: number) => {
      if (lastTimeRef.current > 0) {
        const deltaTime = currentTime - lastTimeRef.current;

        // Detect pauses (tab backgrounding, window drag, breakpoint)
        // Reset rolling window instead of poisoning the average
        if (deltaTime > PAUSE_THRESHOLD_MS) {
          frameTimesRef.current = [];
          lastTimeRef.current = currentTime;
          animationFrameIdRef.current = requestAnimationFrame(measureFrame);
          return;
        }

        // Add to rolling window
        frameTimesRef.current.push(deltaTime);

        // Trim to window size
        if (frameTimesRef.current.length > ROLLING_WINDOW_SIZE) {
          frameTimesRef.current.shift();
        }

        // Calculate average FPS once we have enough samples
        if (frameTimesRef.current.length === ROLLING_WINDOW_SIZE) {
          // Use reduce instead of spread to avoid stack overflow on large arrays (per pitfalls)
          let totalTime = 0;
          for (const time of frameTimesRef.current) {
            totalTime += time;
          }
          const avgFrameTime = totalTime / ROLLING_WINDOW_SIZE;
          const currentFps = avgFrameTime > 0 ? 1000 / avgFrameTime : 60;
          const roundedFps = Math.round(currentFps);

          // Throttle FPS state updates to avoid excessive React work
          // Only update if enough time has passed AND the value meaningfully changed
          const timeSinceLastUpdate = currentTime - lastFpsUpdateRef.current;
          if (
            timeSinceLastUpdate >= FPS_UPDATE_INTERVAL_MS &&
            roundedFps !== lastReportedFpsRef.current
          ) {
            setFps(roundedFps);
            lastFpsUpdateRef.current = currentTime;
            lastReportedFpsRef.current = roundedFps;
          }

          // Check thresholds with hysteresis (always check, don't throttle)
          if (!isThrottledRef.current && currentFps < fpsThreshold) {
            setIsThrottled(true);
            isThrottledRef.current = true;
            onThrottleNeededRef.current();
          } else if (isThrottledRef.current && currentFps > recoveryThreshold) {
            setIsThrottled(false);
            isThrottledRef.current = false;
            onThrottleRestoreRef.current();
          }
        }
      }

      lastTimeRef.current = currentTime;
      animationFrameIdRef.current = requestAnimationFrame(measureFrame);
    };

    // Start the measurement loop
    animationFrameIdRef.current = requestAnimationFrame(measureFrame);

    return () => {
      if (animationFrameIdRef.current) {
        cancelAnimationFrame(animationFrameIdRef.current);
      }
      // Reset state on cleanup
      frameTimesRef.current = [];
      lastTimeRef.current = 0;
    };
  }, [enabled, fpsThreshold, recoveryThreshold]);

  return { fps, isThrottled };
}
