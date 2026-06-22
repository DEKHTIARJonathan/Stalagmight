import { useCallback, useEffect, useRef, useState } from 'react';
import { useUIStore, type PanelId } from '../../store/uiStore';

/** Grace period bridging mouse moves between the bar, tab, and floating panel
 *  (separate DOM elements) so the panel doesn't flicker closed in transit. */
const CLOSE_GRACE_MS = 120;

export interface PanelReveal {
  /** Pinned and open → rendered in the flex layout (reflows the map). */
  isPinnedOpen: boolean;
  /** Hover mode and currently hovered → rendered as a floating overlay. */
  isFloatingOpen: boolean;
  /** Either kind of open. */
  isOpen: boolean;
  /** Attach to the bar, the tab, and the floating panel: together they form one
   *  hover region, so moving between them keeps a hover-revealed panel open. */
  onRegionEnter: () => void;
  onRegionLeave: () => void;
  /** Schedule a close after `ms` (cancelled by onRegionEnter). Used to give a
   *  longer grace after a resize so the user can move back over the panel. */
  scheduleClose: (ms?: number) => void;
  /** Click the closed bar/tab: pin mode opens pinned; hover mode reveals it. */
  openClick: () => void;
  /** Pin the panel open (hover → pin). */
  pin: () => void;
  /** Un-pin to hover mode; stays visible while the pointer remains over it. */
  unpin: () => void;
  /** Close a pinned panel (stays in pin mode). */
  close: () => void;
}

/**
 * Drives the two-mode (hover/pin) reveal behavior for one in-project panel.
 * Persisted `mode`/`open` live in the UI store; transient hover visibility is
 * local React state with a short close-grace timer. See the panel-reveal plan.
 */
export function usePanelReveal(panel: PanelId): PanelReveal {
  const mode = useUIStore((s) =>
    panel === 'sections'
      ? s.sectionsPanelMode
      : panel === 'detail'
        ? s.detailPanelMode
        : s.dataTableMode,
  );
  const open = useUIStore((s) =>
    panel === 'sections'
      ? s.sectionsPanelOpen
      : panel === 'detail'
        ? s.detailPanelOpen
        : s.dataTableOpen,
  );
  const setPanelMode = useUIStore((s) => s.setPanelMode);
  const setPanelOpen = useUIStore((s) => s.setPanelOpen);

  const [hovering, setHovering] = useState(false);
  const graceRef = useRef<number | null>(null);
  const graceDeadlineRef = useRef(0);

  const clearGrace = useCallback(() => {
    if (graceRef.current !== null) {
      clearTimeout(graceRef.current);
      graceRef.current = null;
    }
    graceDeadlineRef.current = 0;
  }, []);

  useEffect(() => clearGrace, [clearGrace]);

  // Drop the transient hover state whenever the panel is (re-)pinned — by the
  // user, or programmatically (section-focus, data-table fullscreen, keyboard /
  // menu toggles all force mode='pin'). Otherwise a `hovering=true` captured
  // before the pin would survive a later return to hover mode and float the panel
  // open with no pointer over it (e.g. exiting section-focus restores 'hover').
  useEffect(() => {
    if (mode === 'pin') {
      setHovering(false);
      clearGrace();
    }
  }, [mode, clearGrace]);

  const onRegionEnter = useCallback(() => {
    clearGrace();
    setHovering(true);
  }, [clearGrace]);

  const scheduleClose = useCallback(
    (ms: number = CLOSE_GRACE_MS) => {
      // Don't let a shorter grace shorten a longer one already pending — e.g. the
      // reconciling mouseleave fired on resize pointer-capture release must not
      // clobber the generous post-resize grace down to the default.
      const deadline = Date.now() + ms;
      if (graceRef.current !== null && graceDeadlineRef.current > deadline) return;
      clearGrace();
      graceDeadlineRef.current = deadline;
      graceRef.current = window.setTimeout(() => {
        graceRef.current = null;
        graceDeadlineRef.current = 0;
        setHovering(false);
      }, ms);
    },
    [clearGrace],
  );

  const onRegionLeave = useCallback(() => scheduleClose(), [scheduleClose]);

  const isPinnedOpen = mode === 'pin' && open;
  const isFloatingOpen = mode === 'hover' && hovering;
  const isOpen = isPinnedOpen || isFloatingOpen;

  const openClick = useCallback(() => {
    if (mode === 'pin') {
      setPanelOpen(panel, true);
    } else {
      clearGrace();
      setHovering(true);
    }
  }, [mode, panel, setPanelOpen, clearGrace]);

  const pin = useCallback(() => {
    setPanelMode(panel, 'pin');
  }, [panel, setPanelMode]);

  const unpin = useCallback(() => {
    setPanelMode(panel, 'hover');
    // The pointer is over the tab when un-pinning, so keep it floating-open until
    // the user actually leaves the region.
    clearGrace();
    setHovering(true);
  }, [panel, setPanelMode, clearGrace]);

  const close = useCallback(() => {
    setPanelOpen(panel, false);
    clearGrace();
    setHovering(false);
  }, [panel, setPanelOpen, clearGrace]);

  return {
    isPinnedOpen,
    isFloatingOpen,
    isOpen,
    onRegionEnter,
    onRegionLeave,
    scheduleClose,
    openClick,
    pin,
    unpin,
    close,
  };
}
