import { useCallback, useRef, useState } from 'react';

/**
 * Tracks an `isResizing` flag in BOTH React state and a ref.
 *
 * The state drives rendering (resize-handle highlight, suspending transitions);
 * the ref is read synchronously by the pointer handlers. setState is async, so
 * the first `pointermove` after `pointerdown` would otherwise read a stale
 * `false` from state and be dropped - losing the first frame and, for a one-move
 * flick-drag, never persisting the size. Reading the ref avoids that.
 *
 * Shared by ResizablePanel and useResizeHandle so the ref/state dance lives in
 * exactly one place. `beginResizing`/`endResizing` keep the two in sync.
 */
export function useResizingFlag() {
  const [isResizing, setIsResizing] = useState(false);
  const isResizingRef = useRef(false);

  const beginResizing = useCallback(() => {
    isResizingRef.current = true;
    setIsResizing(true);
  }, []);

  const endResizing = useCallback(() => {
    isResizingRef.current = false;
    setIsResizing(false);
  }, []);

  return { isResizing, isResizingRef, beginResizing, endResizing };
}
