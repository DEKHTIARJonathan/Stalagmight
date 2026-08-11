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
 *
 * Since #567 the divider is also a keyboard control (a focusable ARIA
 * separator). It is the first resizer in the app with one - the side panels and
 * the data dock are still pointer-only, which is #396 - so the shape here is
 * the precedent: arrows nudge, Home/End jump to the bounds, and the keyboard
 * persists through the SAME `savePanelSizes` call the drag's release uses,
 * debounced so a burst of taps is one write.
 */
import { useCallback, useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useResizeHandle } from '../SingleSystemView/useResizeHandle';
import { useUIStore } from '../../store/uiStore';
import { clampRound } from '../../utils/clamp';
import {
  WIZARD_MAP_PANEL_DEFAULT_WIDTH,
  WIZARD_MAP_PANEL_MIN_WIDTH,
  WIZARD_MAP_PANEL_MAX_WIDTH,
  WIZARD_SETTINGS_MIN_WIDTH,
} from '../SingleSystemView/layoutConstants';

/** Starting width, and the bounds the divider clamps to. Defined in
 *  `layoutConstants` (the width is persisted, so the numbers sit with the other
 *  panel bounds and under the Rust/TS bounds mirror) and re-exported here under
 *  the names this panel's callers already use. */
export const MAP_PANEL_DEFAULT_WIDTH = WIZARD_MAP_PANEL_DEFAULT_WIDTH;
export const MAP_PANEL_MIN_WIDTH = WIZARD_MAP_PANEL_MIN_WIDTH;
export const MAP_PANEL_MAX_WIDTH = WIZARD_MAP_PANEL_MAX_WIDTH;

/** Arrow-key resize step (px), and the step Shift+Arrow uses instead. 16px
 *  places the divider precisely; 64px crosses the whole 280..900 range in ten
 *  presses, so the keyboard reaches every width a drag can without being a
 *  chore. */
const KEY_STEP = 16;
const KEY_STEP_COARSE = 64;

/** Quiet period (ms) after the last resize key before the width is persisted.
 *  A held arrow auto-repeats and a nudged divider is a burst of taps, so
 *  persisting per keydown would be one config round-trip per event - the same
 *  reason the drag persists on release only. */
const KEY_PERSIST_DELAY_MS = 300;

export interface WizardMapPanelProps {
  width: number;
  /** One viewport. The column is pinned at this height so it stays visible
   *  while long settings scroll past it, then leaves with the band. */
  height: number;
  onWidthChange: (width: number) => void;
  /** The side-by-side body, which the drag measures against. */
  bodyRef: RefObject<HTMLDivElement | null>;
  /** The panel itself, which the preview measures to fill (see usePreviewSize). */
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
  const { t } = useTranslation();
  const savePanelSizes = useUIStore((s) => s.savePanelSizes);

  // A keyboard resize persists on a trailing debounce - the keyboard's
  // equivalent of the drag's release - so a burst of arrow taps is one write.
  // Refs (not state) so a scheduled write survives re-renders, and so the
  // unmount flush below can read the pending value without re-subscribing.
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWidthRef = useRef<number | null>(null);

  /** The one persist path: a drag release calls it directly, the keyboard
   *  through `schedulePersist`. It drops any pending keyboard write first,
   *  which is what stops a drag that lands inside the debounce window from
   *  being overwritten by the older width a moment later. */
  const persist = useCallback(
    (size: number) => {
      if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
      pendingWidthRef.current = null;
      void savePanelSizes('wizard-map', size);
    },
    [savePanelSizes],
  );
  const persistRef = useRef(persist);
  persistRef.current = persist;

  const schedulePersist = useCallback((size: number) => {
    pendingWidthRef.current = size;
    if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      const pending = pendingWidthRef.current;
      if (pending !== null) persistRef.current(pending);
    }, KEY_PERSIST_DELAY_MS);
  }, []);

  // Flush a pending write on unmount, for the same reason useResizeHandle
  // persists an interrupted drag: closing the wizard inside the debounce window
  // (Escape right after nudging the divider) would otherwise silently drop the
  // width the user just chose. The pending width is non-null exactly while the
  // timer is armed, and `persist` clears both. Refs only, so it runs once.
  useEffect(() => () => {
    const pending = pendingWidthRef.current;
    if (pending !== null) persistRef.current(pending);
  }, []);

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
    onResizeEnd: persist,
  });

  // WAI-ARIA window splitter: Arrow Left/Right nudge (Shift = coarse), Home/End
  // jump to the bounds. Same clamp and same persist path as the drag, so a
  // keyboard resize and a pointer resize are indistinguishable downstream.
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? KEY_STEP_COARSE : KEY_STEP;
      let next: number;
      switch (e.key) {
        case 'ArrowLeft':
          next = width - step;
          break;
        case 'ArrowRight':
          next = width + step;
          break;
        case 'Home':
          next = MAP_PANEL_MIN_WIDTH;
          break;
        case 'End':
          next = MAP_PANEL_MAX_WIDTH;
          break;
        default:
          return;
      }
      // Claim the key before the no-op check below: at the bounds these would
      // otherwise scroll the wizard body behind the divider.
      e.preventDefault();
      next = clampRound(next, MAP_PANEL_MIN_WIDTH, MAP_PANEL_MAX_WIDTH);
      // Already at that bound - no render, and nothing to persist.
      if (next === width) return;
      onWidthChange(next);
      schedulePersist(next);
    },
    [width, onWidthChange, schedulePersist],
  );

  return (
    <div
      ref={panelRef}
      className="sticky top-0 self-start relative shrink-0 flex flex-col items-center justify-center p-4 border-r border-border"
      // `maxWidth` is the settings column's floor, and it is CSS rather than a
      // clamp on the stored number on purpose: the width persists across
      // sessions now (#404), so a column dragged wide on a large monitor is
      // restored on a laptop, where an absolute 900px would leave the settings
      // beside it a few dozen pixels wide with no way to grab the divider back.
      // Capping the RENDER leaves the user's number intact - widen the window
      // and the map is wide again - which a clamp on the value could not do.
      style={{ width, height, maxWidth: `calc(100% - ${WIZARD_SETTINGS_MIN_WIDTH}px)` }}
      data-testid="segment-preview-panel"
    >
      {children}
      {/* The divider. Sits on the column's trailing edge with a padded hit area,
          the same shape as the app's other resize handles - and, unlike them so
          far (#396 covers the rest), reachable by keyboard: a focusable
          `separator` is the WAI-ARIA window-splitter pattern.

          `aria-valuenow` reports the STORED width, not the rendered one. The
          `maxWidth` above can cap the render on a narrow window, but the value
          the user is steering (and the one that persists) is this number - the
          same thing the drag sets. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('common.a11y.wizardMapResize')}
        aria-valuenow={width}
        aria-valuemin={MAP_PANEL_MIN_WIDTH}
        aria-valuemax={MAP_PANEL_MAX_WIDTH}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className={`absolute right-0 top-0 h-full w-1 -mr-0.5 cursor-ew-resize px-1 transition-colors hover:bg-accent-50 focus:outline-none focus-visible:bg-accent-50 focus-visible:ring-1 focus-visible:ring-accent ${
          resize.isResizing ? 'bg-accent-50' : ''
        }`}
        style={{ touchAction: 'none' }}
        data-testid="wizard-map-resize"
        {...resize.handleProps}
      />
    </div>
  );
}
