/**
 * The Connection Wizard's scrolling body: a map/settings band one viewport tall,
 * with the shot table full width beneath it.
 *
 * Scrolling down therefore carries the map and the settings up and out of the
 * way, leaving the table the whole dialog - which it could not get while it was
 * a child of the right-hand column, boxed into that column's width.
 *
 * The band and the table are each sized to the scroller's own height, measured
 * rather than assumed: one scroll of the wheel moves cleanly from one to the
 * other whatever the window size, and the table's grid needs a definite pixel
 * height for virtualization regardless.
 *
 * Its own component (like `WizardMapPanel`) because the wizard renders this
 * shape twice and sits far past the file-size ratchet's hard budget - it may
 * shrink but never grow, so anything added there has to leave as a component.
 */
import { useCallback, useRef, useState, type MutableRefObject, type ReactNode } from 'react';

/** Height to assume before the first measurement, and under jsdom (no
 *  ResizeObserver). */
const FALLBACK_BAND_HEIGHT = 520;
/** Never squeeze the band below this on a short window. */
const MIN_BAND_HEIGHT = 320;

export interface WizardScrollBodyProps {
  /** The scroller, shared with the map divider's drag, which measures against
   *  it to clamp the column width. */
  bodyRef: MutableRefObject<HTMLDivElement | null>;
  /** The full-width section under the band. Omit for a step that has no table. */
  table?: ReactNode;
  /** The band, given the measured height so it fills exactly one viewport. */
  children: (bandHeight: number) => ReactNode;
}

export function WizardScrollBody({ bodyRef, table, children }: WizardScrollBodyProps) {
  const [bandHeight, setBandHeight] = useState(FALLBACK_BAND_HEIGHT);
  const observerRef = useRef<ResizeObserver | null>(null);

  // Callback ref so the observer attaches when the step actually mounts - the
  // wizard swaps these blocks in and out, so a mount-only effect would miss it.
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      bodyRef.current = el;
      if (!el || typeof ResizeObserver === 'undefined') return;
      const measure = () => {
        const h = Math.max(MIN_BAND_HEIGHT, el.clientHeight);
        setBandHeight((prev) => (Math.abs(prev - h) > 1 ? h : prev));
      };
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      observerRef.current = ro;
    },
    [bodyRef]
  );

  return (
    <div
      ref={setRef}
      className="relative min-h-0 flex-1 overflow-y-auto"
      data-testid="wizard-body-scroll"
    >
      {children(bandHeight)}
      {table && (
        <div
          className="flex flex-col p-5"
          style={{ height: bandHeight }}
          data-testid="wizard-shot-table-section"
        >
          {table}
        </div>
      )}
    </div>
  );
}
