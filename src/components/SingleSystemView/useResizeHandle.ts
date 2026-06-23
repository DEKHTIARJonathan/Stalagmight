import { useCallback, useRef, type PointerEvent, type RefObject } from 'react';
import { useResizingFlag } from '../../hooks/useResizingFlag';

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
  /** Called once on pointer-up with the release pointer position, so a hover
   *  panel can hit-test its own region (panel + handle overhang + tab) and
   *  decide whether/when to close. */
  onResizeSettled?: (pointer: { clientX: number; clientY: number }) => void;
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
  onResizeSettled,
}: UseResizeHandleOpts) {
  // `isResizing` drives rendering (suspend transitions / resize highlight); the
  // pointer handlers gate on the ref so the first pointermove after pointerdown
  // isn't dropped to a stale `false` (see useResizingFlag). For a one-move
  // flick-drag this also keeps onResizeEnd from being skipped (movedRef stays
  // false otherwise).
  const { isResizing, isResizingRef, beginResizing, endResizing } = useResizingFlag();
  const sizeRef = useRef(0);
  // Guard against a press-release with no movement persisting a bogus size 0.
  const movedRef = useRef(false);

  const onPointerDown = useCallback((e: PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    movedRef.current = false;
    beginResizing();
  }, [beginResizing]);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!isResizingRef.current || !measureRef.current) return;
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
    [isResizingRef, direction, handlePosition, minSize, maxSize, measureRef, onResize],
  );

  const onPointerUp = useCallback(
    (e: PointerEvent) => {
      if (!isResizingRef.current) return;
      // Only persist when an actual drag occurred; clamp defensively.
      if (movedRef.current) {
        onResizeEnd?.(Math.max(minSize, Math.min(maxSize, sizeRef.current)));
      }
      onResizeSettled?.({ clientX: e.clientX, clientY: e.clientY });
      movedRef.current = false;
      endResizing();
    },
    [isResizingRef, onResizeEnd, onResizeSettled, minSize, maxSize, endResizing],
  );

  return {
    isResizing,
    handleProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  };
}
