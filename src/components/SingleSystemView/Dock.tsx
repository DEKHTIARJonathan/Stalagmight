import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { PanelOpenerTab, type PanelEdge } from './PanelOpenerTab';
import { useResizeHandle } from './useResizeHandle';
import type { PanelReveal } from './usePanelReveal';

/** Width/height of the always-present closed-state opener bar (px). */
const BAR = 12;
/** Slide/reflow duration; keep in sync with the Tailwind duration class. */
const SLIDE_MS = 150;

interface DockProps {
  reveal: PanelReveal;
  edge: PanelEdge;
  /** Controlled panel size (store width for left/right, height for bottom). */
  size: number;
  minSize: number;
  maxSize: number;
  onResize: (size: number) => void;
  onResizeEnd: (size: number) => void;
  /** Panel content (already wrapped with placement-dim if applicable). */
  children: ReactNode;
  label: string;
  openArrow: ReactNode;
  closeArrow: ReactNode;
  testId: string;
  tabLabels: { open: string; pin: string; unpin: string; close: string };
  /** Top offset (px) for the side tab so it aligns with the panel's header /
   *  content divider. Ignored for the bottom edge (the tab is bottom-anchored). */
  tabTop?: number;
  /** Data table only: render content as a fixed fullscreen overlay (no reparent). */
  fullscreen?: boolean;
}

/**
 * One dockable panel — the SOLE mount of its content. Reflows the map when
 * pinned (via a flow spacer that only the map reacts to) or floats over the map
 * in hover mode; the panel element itself never moves or remounts across
 * pin/unpin (only the spacer + z-index change), so the transition is seamless.
 * The opener tab is a child anchored to the panel's inner edge (`*:100%`) so it
 * rides the edge with zero gap. See the panel-reveal redesign blueprint.
 */
export function Dock({
  reveal,
  edge,
  size,
  minSize,
  maxSize,
  onResize,
  onResizeEnd,
  children,
  label,
  openArrow,
  closeArrow,
  testId,
  tabLabels,
  tabTop = 72,
  fullscreen = false,
}: DockProps) {
  const vertical = edge === 'left' || edge === 'right';
  const clipRef = useRef<HTMLDivElement>(null);

  const { isResizing, handleProps } = useResizeHandle({
    direction: vertical ? 'horizontal' : 'vertical',
    handlePosition: edge === 'right' ? 'start' : 'end',
    minSize,
    maxSize,
    measureRef: clipRef,
    onResize,
    onResizeEnd,
    // After a hover-mode resize that ended off the panel, resume the close —
    // onMouseLeave was suppressed during the drag.
    onResizeSettled: (pointerOverPanel) => {
      if (reveal.isFloatingOpen && !pointerOverPanel) reveal.onRegionLeave();
    },
  });

  // Resize affordance is "active" while hovering the handle or dragging it; both
  // the panel's inner-edge border and the opener tab border tint accent then, so
  // the highlight is identical on both and wraps around the tab.
  const [resizeHover, setResizeHover] = useState(false);
  const resizeActive = isResizing || resizeHover;

  // Keep content mounted through the slide-out so closing animates (single
  // instance — never remounts on pin/unpin/hover).
  const open = reveal.isOpen;
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const id = window.setTimeout(() => setMounted(false), SLIDE_MS);
    return () => window.clearTimeout(id);
  }, [open]);

  const sizeNow = open ? size : BAR;
  const spacerSize = reveal.isPinnedOpen ? size : BAR;
  // Inline transition (robust vs a Tailwind arbitrary value) — suspended while
  // dragging so the panel edge + spacer track the pointer 1:1.
  const sizeTransition = isResizing ? 'none' : 'width 150ms ease-out, height 150ms ease-out';

  // ── Reflow spacer (flow): only this pushes the map. ──
  const spacer = (
    <div
      className="flex-shrink-0"
      style={{
        ...(vertical ? { width: spacerSize } : { height: spacerSize }),
        transition: sizeTransition,
      }}
      aria-hidden
    />
  );

  // ── Overlay wrapper (absolute, overflow-visible so the tab can escape). ──
  const outerStyle: CSSProperties = {
    ...(edge === 'left' ? { top: 0, bottom: 0, left: 0, width: sizeNow } : {}),
    ...(edge === 'right' ? { top: 0, bottom: 0, right: 0, width: sizeNow } : {}),
    ...(edge === 'bottom' ? { left: 0, right: 0, bottom: 0, height: sizeNow } : {}),
  };
  const borderCls = edge === 'left' ? 'border-r' : edge === 'right' ? 'border-l' : 'border-t';
  const innerStyle: CSSProperties = vertical
    ? { position: 'absolute', top: 0, bottom: 0, width: size, [edge === 'right' ? 'right' : 'left']: 0 }
    : { position: 'absolute', left: 0, right: 0, bottom: 0, height: size };

  // Tab anchored flush to the inner edge (rides the wrapper's edge for free).
  // Side tabs sit at `tabTop` so their top aligns with the panel's header divider.
  const tabAnchor: CSSProperties =
    edge === 'left'
      ? { left: '100%', top: tabTop }
      : edge === 'right'
        ? { right: '100%', top: tabTop }
        : { bottom: '100%', right: 8 };

  // Resize handle on the inner edge (only while docked).
  const handleClass =
    edge === 'bottom'
      ? 'resize-handle-v left-0 right-0 top-0 h-1 -mt-0.5 cursor-ns-resize'
      : edge === 'right'
        ? 'resize-handle-h left-0 top-0 bottom-0 w-1 -ml-0.5 cursor-ew-resize'
        : 'resize-handle-h right-0 top-0 bottom-0 w-1 -mr-0.5 cursor-ew-resize';

  const overlay = (
    <div
      className={`absolute pointer-events-auto ${fullscreen ? 'z-40' : reveal.isFloatingOpen ? 'z-30' : 'z-20'}`}
      style={{ ...outerStyle, transition: sizeTransition }}
      onMouseEnter={reveal.onRegionEnter}
      // Don't let a hover panel close mid-drag when the pointer leaves the region.
      onMouseLeave={() => {
        if (!isResizing) reveal.onRegionLeave();
      }}
    >
      {/* Clip box = the visible panel body; collapses to the opener bar when closed.
          The accessible opener is the real <button> in PanelOpenerTab; this bar is
          only a pointer convenience, so it is not a focusable/announced control. */}
      <div
        ref={clipRef}
        className={`absolute inset-0 overflow-hidden bg-panel ${borderCls} ${resizeActive ? 'border-accent' : 'border-border'} transition-colors ${reveal.isFloatingOpen ? 'shadow-xl' : ''} ${!open ? 'cursor-pointer hover:bg-background-80' : ''}`}
        onClick={!open ? reveal.openClick : undefined}
        data-testid={`${testId}-panel-bar`}
      >
        {mounted &&
          (fullscreen ? (
            <div
              className="fixed inset-x-0 bottom-0 z-40 bg-panel"
              style={{ top: 'var(--toolbar-h, 48px)' }}
            >
              {children}
            </div>
          ) : (
            <div style={innerStyle}>{children}</div>
          ))}
      </div>

      {/* Resize handle on the inner edge whenever the panel is open (pinned or
          hover-floating), so hover panels can be resized too. Transparent hit
          area only — the visible highlight is the edge border + tab border tint
          (driven by resizeActive), so nothing draws under the tab. */}
      {reveal.isOpen && !fullscreen && (
        <div
          className={`absolute bg-transparent ${handleClass}`}
          style={{ touchAction: 'none', zIndex: 1 }}
          onMouseEnter={() => setResizeHover(true)}
          onMouseLeave={() => setResizeHover(false)}
          {...handleProps}
        />
      )}

      {!fullscreen && (
        <div className="absolute z-[2]" style={tabAnchor}>
          <PanelOpenerTab
            reveal={reveal}
            edge={edge}
            label={label}
            openArrow={openArrow}
            closeArrow={closeArrow}
            testId={testId}
            labels={tabLabels}
            resizing={resizeActive}
          />
        </div>
      )}
    </div>
  );

  return (
    <>
      {spacer}
      {overlay}
    </>
  );
}

export default Dock;
