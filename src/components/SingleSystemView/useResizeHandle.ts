import { useCallback, useRef, useState, type PointerEvent, type RefObject } from 'react';

interface UseResizeHandleOpts {
  direction: 'horizontal' | 'vertical';
  /** For horizontal: which edge the handle sits on (controls the size formula). */
  handlePosition?: 'start' | 'end';
  minSize: number;
  maxSize: number;
  /** Element whose bounding rect is measured (the full-size panel body). */
  measureRef: RefObject<HTMLElement | null>;
  /** Live size during drag. */
  onResize: (size: number) => void;
  /** Called once on pointer-up with the final size. */
  onResizeEnd?: (size: number) => void;
}

/**
 * Controlled resize-handle behavior (pointer-capture drag → clamped size),
 * extracted from ResizablePanel so the panel width can be owned by the store
 * (and shared with the reflow spacer + opener tab) instead of local component
 * state. Returns `isResizing` (to suspend transitions during drag) and the
 * pointer handlers to spread onto the handle element.
 */
export function useResizeHandle({
  direction,
  handlePosition = 'end',
  minSize,
  maxSize,
  measureRef,
  onResize,
  onResizeEnd,
}: UseResizeHandleOpts) {
  const [isResizing, setIsResizing] = useState(false);
  const sizeRef = useRef(0);
  // Guard against a press-release with no movement persisting a bogus size 0.
  const movedRef = useRef(false);

  const onPointerDown = useCallback((e: PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    movedRef.current = false;
    setIsResizing(true);
  }, []);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!isResizing || !measureRef.current) return;
      const rect = measureRef.current.getBoundingClientRect();
      let next: number;
      if (direction === 'horizontal') {
        next = handlePosition === 'end' ? e.clientX - rect.left : rect.right - e.clientX;
      } else {
        next = rect.bottom - e.clientY;
      }
      next = Math.max(minSize, Math.min(maxSize, next));
      movedRef.current = true;
      sizeRef.current = next;
      onResize(next);
    },
    [isResizing, direction, handlePosition, minSize, maxSize, measureRef, onResize],
  );

  const onPointerUp = useCallback(() => {
    // Only persist when an actual drag occurred; clamp defensively.
    if (isResizing && movedRef.current) {
      onResizeEnd?.(Math.max(minSize, Math.min(maxSize, sizeRef.current)));
    }
    movedRef.current = false;
    setIsResizing(false);
  }, [isResizing, onResizeEnd, minSize, maxSize]);

  return {
    isResizing,
    handleProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  };
}
