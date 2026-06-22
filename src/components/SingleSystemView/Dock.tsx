import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PanelOpenerTab, type PanelEdge } from './PanelOpenerTab';
import { useResizeHandle } from './useResizeHandle';
import type { PanelReveal } from './usePanelReveal';

/** Width/height of the always-present closed-state opener bar (px). */
export const BAR = 12;
/** Slide/reflow duration; keep in sync with the Tailwind duration class. */
const SLIDE_MS = 150;
/** Generous grace after a hover-mode resize so the user can move the cursor
 *  back over the panel before it closes. */
const RESIZE_GRACE_MS = 700;

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
  /** Right inset (px) for the bottom-edge tab, so it can be moved clear of the
   *  Details tab on the right. Ignored for left/right edges. */
  tabInset?: number;
  /** Side panels (left/right) only: while this panel is MINIMIZED (showing the
   *  opener bar), raise the bar's bottom by this many px so it doesn't run
   *  full-height alongside an open Data panel. The reflow spacer is unaffected,
   *  so the Data panel still sits between the two side panels. */
  closedBottomInset?: number;
  /** Data table only: render content as a fixed fullscreen overlay (no reparent). */
  fullscreen?: boolean;
  /** Bottom edge only: portal the absolute overlay into this element instead of
   *  rendering it inline, so it positions relative to that ancestor (lets the
   *  Data panel span the full Main width past the center column's side insets).
   *  The reflow spacer still renders in place. */
  overlayContainer?: HTMLElement | null;
  /** Bottom edge only: left/right offsets (px) for the overlay in the portal
   *  container's frame — so the Data panel stops at open side panels but fills
   *  the gap left by minimized ones. Default 0 (full width). */
  overlayLeft?: number;
  overlayRight?: number;
  /** Notified when this Dock's resize-drag starts/ends, so a sibling can react
   *  (e.g. side bars tracking the Data panel's edge live during its resize). */
  onResizingChange?: (resizing: boolean) => void;
  /** Drop the transition on the edges that follow a sibling panel's size so they
   *  track 1:1 (no easing lag): a side bar's `bottom` follows the Data panel, and
   *  the bottom panel's `left`/`right` follow the side panels. Set while that
   *  sibling is being dragged; kept otherwise so open/close still animates. */
  suspendSiblingTransition?: boolean;
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
  tabInset = 8,
  closedBottomInset = 0,
  fullscreen = false,
  overlayContainer,
  overlayLeft = 0,
  overlayRight = 0,
  onResizingChange,
  suspendSiblingTransition = false,
}: DockProps) {
  const vertical = edge === 'left' || edge === 'right';
  const clipRef = useRef<HTMLDivElement>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  // "active" while hovering the handle or dragging it; both the panel's
  // inner-edge border and the opener tab border tint accent then, identically.
  const [resizeHover, setResizeHover] = useState(false);
  // Hovering anywhere over the closed opener (the edge bar OR its tab, which
  // share the outer wrapper) highlights both as one unit.
  const [openerHover, setOpenerHover] = useState(false);

  const { isResizing, handleProps } = useResizeHandle({
    direction: vertical ? 'horizontal' : 'vertical',
    handlePosition: edge === 'right' ? 'start' : 'end',
    minSize,
    maxSize,
    measureRef: clipRef,
    onResize,
    onResizeEnd,
    // After a hover-mode resize, onMouseLeave was suppressed during the drag, so
    // re-evaluate the close here. The release pointer often lands on the handle's
    // overhang (just outside the panel body) — still part of the Dock region — so
    // hit-test the whole outer wrapper (panel + handle + tab). If the pointer
    // ended off it, close on a *generous* grace so the user can move back over.
    onResizeSettled: ({ clientX, clientY }) => {
      const el = document.elementFromPoint(clientX, clientY);
      // Keep the accent only if the release landed back on the handle (no
      // mouseenter re-fires on an in-place release); otherwise clear it.
      setResizeHover(!!el && !!handleRef.current && handleRef.current.contains(el));
      if (!reveal.isFloatingOpen) return;
      const overRegion = !!el && !!outerRef.current && outerRef.current.contains(el);
      if (!overRegion) reveal.scheduleClose(RESIZE_GRACE_MS);
    },
  });

  const resizeActive = isResizing || resizeHover;

  // Let a sibling (the side bars) track this panel's edge live during its drag.
  useEffect(() => {
    onResizingChange?.(isResizing);
  }, [isResizing, onResizingChange]);

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
  // Edges that follow a sibling's size: the bottom panel's left/right follow the
  // side panels; a side bar's bottom follows the Data panel. Drop their easing
  // while that sibling is dragged so they track 1:1 (no lag).
  const trackingEdges = edge === 'bottom' ? ['left', 'right'] : ['bottom'];
  const sizeTransition = isResizing
    ? 'none'
    : [
        'width 150ms ease-out',
        'height 150ms ease-out',
        ...(suspendSiblingTransition ? [] : trackingEdges.map((p) => `${p} 150ms ease-out`)),
      ].join(', ');

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
  // While a side panel is minimized, raise the bar's bottom clear of an open
  // Data panel (the reflow spacer is untouched, so layout is otherwise the same).
  const barBottom = !open ? closedBottomInset : 0;
  const outerStyle: CSSProperties = {
    ...(edge === 'left' ? { top: 0, bottom: barBottom, left: 0, width: sizeNow } : {}),
    ...(edge === 'right' ? { top: 0, bottom: barBottom, right: 0, width: sizeNow } : {}),
    ...(edge === 'bottom' ? { left: overlayLeft, right: overlayRight, bottom: 0, height: sizeNow } : {}),
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
        : { bottom: '100%', right: tabInset };

  // Resize handle on the inner edge (only while docked).
  const handleClass =
    edge === 'bottom'
      ? 'resize-handle-v left-0 right-0 top-0 h-1 -mt-0.5 cursor-ns-resize'
      : edge === 'right'
        ? 'resize-handle-h left-0 top-0 bottom-0 w-1 -ml-0.5 cursor-ew-resize'
        : 'resize-handle-h right-0 top-0 bottom-0 w-1 -mr-0.5 cursor-ew-resize';

  const overlay = (
    <div
      ref={outerRef}
      className={`absolute pointer-events-auto ${fullscreen ? 'z-40' : reveal.isFloatingOpen ? 'z-30' : 'z-20'}`}
      style={{ ...outerStyle, transition: sizeTransition }}
      onMouseEnter={() => {
        reveal.onRegionEnter();
        setOpenerHover(true);
      }}
      // Don't let a hover panel close mid-drag when the pointer leaves the region.
      onMouseLeave={() => {
        setOpenerHover(false);
        if (!isResizing) reveal.onRegionLeave();
      }}
      // Focus returning to an already-open floating panel (e.g. tabbing back in
      // within the close grace) cancels the pending close — mirrors the pointer
      // onRegionEnter. Guarded by isFloatingOpen so merely tab-focusing a CLOSED
      // panel's opener tab never auto-reveals it (only an explicit click does).
      onFocus={() => {
        if (reveal.isFloatingOpen) reveal.onRegionEnter();
      }}
      // Keyboard close: a hover panel opened via the keyboard (the opener tab is a
      // real button, so Enter/Space reveals it) gets no mouseleave to trigger the
      // grace close. When focus leaves the whole region — and the pointer isn't
      // over it — schedule the close so it can't stay floating open forever.
      onBlur={(e) => {
        const next = e.relatedTarget;
        const stayingInRegion = next instanceof Node && outerRef.current?.contains(next);
        if (reveal.isFloatingOpen && !openerHover && !stayingInRegion) {
          reveal.onRegionLeave();
        }
      }}
    >
      {/* Clip box = the visible panel body; collapses to the opener bar when closed.
          The accessible opener is the real <button> in PanelOpenerTab; this bar is
          only a pointer convenience, so it is not a focusable/announced control. */}
      {/* Background must be a SINGLE utility: applying `bg-panel` plus a hover
          `bg-background-80` lets bg-panel win (same-layer conflict), so the bar
          never highlighted. Pick one (mirrors the tab's exclusive ternary) so the
          closed opener bar + tab highlight together. */}
      <div
        ref={clipRef}
        className={`absolute inset-0 overflow-hidden ${!open && openerHover ? 'bg-background-80' : 'bg-panel'} ${borderCls} ${resizeActive ? 'border-accent' : 'border-border'} transition-colors ${reveal.isFloatingOpen ? 'shadow-xl' : ''} ${!open ? 'cursor-pointer' : ''}`}
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
          ref={handleRef}
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
            visuallyOpen={mounted}
            hovered={openerHover}
          />
        </div>
      )}
    </div>
  );

  // Portal mode (overlayContainer prop passed, even if momentarily null): render
  // into the container once the ref resolves, never inline — an inline first
  // paint would position against the wrong ancestor and then remount the whole
  // overlay (incl. the DataTable) when it reparents. The parent captures the
  // container via a callback ref in the commit phase; React flushes that setState
  // synchronously before the browser paints, so the container is non-null on the
  // first paint: the overlay attaches with no missing-content frame and the
  // DataTable mounts exactly once (into the portal). Inline mode (prop omitted)
  // renders the overlay in place, as the side Docks do.
  const portalMode = overlayContainer !== undefined;
  const overlayNode = portalMode
    ? overlayContainer
      ? createPortal(overlay, overlayContainer)
      : null
    : overlay;

  return (
    <>
      {spacer}
      {overlayNode}
    </>
  );
}

export default Dock;
