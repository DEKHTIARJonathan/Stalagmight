/**
 * Measures a container and returns the side of the largest SQUARE that fits in
 * it, clamped. The wizard's map preview is square, and a square sized from a
 * rectangle has to pick the smaller side or it overflows the column the user can
 * drag narrower.
 *
 * Its own module because `DmpNewImportDialog` is far past the file-size ratchet's
 * hard budget - anything that can leave, must.
 */
import { useCallback, useRef, useState } from 'react';

export /**
 * Returns a callback ref + a square pixel size that fits the ref'd container's
 * height (minus the preview panel's `p-4`), capped at `max`. The wizard's
 * SectionPreview is a fixed square, so without this it overflows and is clipped
 * by the dialog's `overflow-hidden` when the window is near its 600px minimum
 * height (#93 review). Reacts to window/layout resizes via ResizeObserver.
 */
function usePreviewSquareSize(
  max = 440,
  min = 240,
): [(el: HTMLDivElement | null) => void, number] {
  const [size, setSize] = useState(max);
  const elRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const measure = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    // Preview panel adds p-4 (1rem on every side = 32px per axis) around the
    // square. Fit BOTH axes: sizing off height alone left the map letterboxed
    // in its column, and made widening the column do nothing.
    const available = Math.min(el.clientHeight - 32, el.clientWidth - 32);
    setSize(Math.max(min, Math.min(max, Math.floor(available))));
  }, [max, min]);

  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      observerRef.current?.disconnect();
      elRef.current = el;
      if (el) {
        measure();
        observerRef.current = new ResizeObserver(measure);
        observerRef.current.observe(el);
      }
    },
    [measure],
  );

  return [setRef, size];
}
