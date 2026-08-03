/**
 * The Connection Wizard's left-hand map column, with the divider that resizes
 * it.
 *
 * Its own component because the wizard renders it twice (the suggestion step and
 * the manual-placing step) and is already far past the file-size ratchet's hard
 * budget - anything added there has to come out somewhere, and a props-in /
 * children-out panel is the natural seam.
 *
 * The panel owns only its drag; the WIDTH lives in the wizard, so a drag on one
 * step is remembered on the other and the dialog does not change shape as the
 * user steps between them.
 */
import type { ReactNode, RefObject } from 'react';
import { useResizeHandle } from '../SingleSystemView/useResizeHandle';

/** Starting width, and the bounds the divider clamps to. The max also caps the
 *  preview square, so widening the column really does make the map bigger. */
export const MAP_PANEL_DEFAULT_WIDTH = 480;
export const MAP_PANEL_MIN_WIDTH = 280;
export const MAP_PANEL_MAX_WIDTH = 900;

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
  const resize = useResizeHandle({
    direction: 'horizontal',
    handlePosition: 'end',
    minSize: MAP_PANEL_MIN_WIDTH,
    maxSize: MAP_PANEL_MAX_WIDTH,
    measureRef: bodyRef,
    onResize: onWidthChange,
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
