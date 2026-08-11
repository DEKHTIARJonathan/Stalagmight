/**
 * The Connection Wizard's left-hand map column, with the divider that resizes
 * it.
 *
 * Its own component because the wizard renders it twice (the suggestion step and
 * the manual-placing step) and is already far past the file-size ratchet's hard
 * budget - anything added there has to come out somewhere, and a props-in /
 * children-out panel is the natural seam.
 *
 * The panel owns only its drag; the WIDTH lives in `uiStore`, so a drag on one
 * step is remembered on the other - and, since #404, across sessions and across
 * wizards: the drag's release persists it here rather than in each caller, so a
 * new wizard that renders this panel gets the memory for free.
 */
import type { ReactNode, RefObject } from 'react';
import { useResizeHandle } from '../SingleSystemView/useResizeHandle';
import { useUIStore } from '../../store/uiStore';
import {
  WIZARD_MAP_PANEL_DEFAULT_WIDTH,
  WIZARD_MAP_PANEL_MIN_WIDTH,
  WIZARD_MAP_PANEL_MAX_WIDTH,
} from '../SingleSystemView/layoutConstants';

/** Starting width, and the bounds the divider clamps to. Defined in
 *  `layoutConstants` (the width is persisted, so the numbers sit with the other
 *  panel bounds and under the Rust/TS bounds mirror) and re-exported here under
 *  the names this panel's callers already use. */
export const MAP_PANEL_DEFAULT_WIDTH = WIZARD_MAP_PANEL_DEFAULT_WIDTH;
export const MAP_PANEL_MIN_WIDTH = WIZARD_MAP_PANEL_MIN_WIDTH;
export const MAP_PANEL_MAX_WIDTH = WIZARD_MAP_PANEL_MAX_WIDTH;

export interface WizardMapPanelProps {
  width: number;
  /** One viewport. The column is pinned at this height so it stays visible
   *  while long settings scroll past it, then leaves with the band. */
  height: number;
  onWidthChange: (width: number) => void;
  /** The side-by-side body, which the drag measures against. */
  bodyRef: RefObject<HTMLDivElement | null>;
  /** The panel itself, which the preview measures to size its square. */
  panelRef: (el: HTMLDivElement | null) => void;
  children: ReactNode;
}

export function WizardMapPanel({
  width,
  height,
  onWidthChange,
  bodyRef,
  panelRef,
  children,
}: WizardMapPanelProps) {
  const savePanelSizes = useUIStore((s) => s.savePanelSizes);
  const resize = useResizeHandle({
    direction: 'horizontal',
    handlePosition: 'end',
    minSize: MAP_PANEL_MIN_WIDTH,
    maxSize: MAP_PANEL_MAX_WIDTH,
    measureRef: bodyRef,
    onResize: onWidthChange,
    // Persist on release only, like the app's other dividers: `savePanelSizes`
    // is undebounced, and a per-frame write during the drag would be one config
    // round-trip per pointermove.
    onResizeEnd: (size) => void savePanelSizes('wizard-map', size),
  });

  return (
    <div
      ref={panelRef}
      className="sticky top-0 self-start relative shrink-0 flex flex-col items-center justify-center p-4 border-r border-border"
      style={{ width, height }}
      data-testid="segment-preview-panel"
    >
      {children}
      {/* The divider. Sits on the column's trailing edge with a padded hit area,
          the same shape as the app's other resize handles. */}
      <div
        className={`absolute right-0 top-0 h-full w-1 -mr-0.5 cursor-ew-resize px-1 transition-colors hover:bg-accent-50 ${
          resize.isResizing ? 'bg-accent-50' : ''
        }`}
        style={{ touchAction: 'none' }}
        data-testid="wizard-map-resize"
        {...resize.handleProps}
      />
    </div>
  );
}
