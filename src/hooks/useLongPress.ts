import { useRef, useCallback } from 'react';

interface LongPressOptions {
  /** Delay in ms before firing (default 500) */
  delay?: number;
  /** Max movement in px before cancelling (default 10) */
  moveThreshold?: number;
  /** Whether the hook is enabled (default true) */
  enabled?: boolean;
}

interface LongPressHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
}

/**
 * Hook for long-press detection on touch devices.
 * Only activates for `pointerType === 'touch'` - mouse events pass through untouched.
 * After firing, prevents the subsequent synthetic click.
 */
export function useLongPress(
  callback: (position: { x: number; y: number }, target: HTMLElement) => void,
  options?: LongPressOptions,
): LongPressHandlers {
  const { delay = 500, moveThreshold = 10, enabled = true } = options ?? {};

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startPos.current = null;
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return;
      if (e.pointerType !== 'touch') return;

      firedRef.current = false;
      startPos.current = { x: e.clientX, y: e.clientY };

      const target = e.currentTarget as HTMLElement;
      const x = e.clientX;
      const y = e.clientY;

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        firedRef.current = true;
        callback({ x, y }, target);
      }, delay);
    },
    [enabled, delay, callback],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      if (!startPos.current || timerRef.current === null) return;

      const dx = e.clientX - startPos.current.x;
      const dy = e.clientY - startPos.current.y;
      if (dx * dx + dy * dy > moveThreshold * moveThreshold) {
        clear();
      }
    },
    [moveThreshold, clear],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      clear();
      // Prevent synthetic click after long-press fired
      if (firedRef.current) {
        e.preventDefault();
        e.stopPropagation();
        firedRef.current = false;
      }
    },
    [clear],
  );

  const onPointerCancel = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      clear();
      firedRef.current = false;
    },
    [clear],
  );

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
