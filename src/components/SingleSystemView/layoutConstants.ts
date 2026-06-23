/**
 * Shared layout bounds for the SingleSystemView panels.
 *
 * The bottom data-table ResizablePanel enforces these min/max heights, and the
 * section-focus height clamp (#50) reuses them so the focus height can never
 * drift out of the panel's own resize bounds if either is changed.
 */
export const DATA_TABLE_MIN_HEIGHT = 100;
export const DATA_TABLE_MAX_HEIGHT = 500;

/**
 * Per-panel resize bounds (px). Single source of truth shared by the
 * ResizablePanel `minSize`/`maxSize` props (SingleSystemView) and the
 * `savePanelSizes` persist-clamp (uiStore). Persisting a value below the minimum
 * (e.g. a degenerate 0 from a zero-height layout) would reload the panel
 * collapsed — there is no "unset" sentinel, the stored u32 is taken at face
 * value — so the clamp and the resize bounds must agree.
 */
export const PANEL_SIZE_BOUNDS = {
  sections: { min: 150, max: 400 },
  detail: { min: 200, max: 500 },
  'data-table': { min: DATA_TABLE_MIN_HEIGHT, max: DATA_TABLE_MAX_HEIGHT },
} as const satisfies Record<'sections' | 'detail' | 'data-table', { min: number; max: number }>;

/**
 * Panel reveal/close timing budget (ms). Centralized so the interacting graces are
 * tuned together (a short transit grace vs a generous post-resize grace — usePanelReveal's
 * scheduleClose has explicit "don't shorten a longer grace" logic precisely because
 * these collide at runtime), and so the slide duration is a single source driving
 * BOTH the CSS transition string and its unmount fallback timer (they previously
 * duplicated "150ms", kept in sync only by a comment).
 */
/** Transit grace bridging the bar/tab/floating-panel hover region. */
export const PANEL_CLOSE_GRACE_MS = 120;
/** Generous grace after a hover-mode resize so the cursor can move back over the panel. */
export const PANEL_RESIZE_GRACE_MS = 700;
/** Panel open/close slide duration. Builds the CSS transition AND sizes the
 *  unmount fallback timer — change it in one place. */
export const PANEL_SLIDE_MS = 150;
/** Auto-close for a PROGRAMMATIC hover-mode Details reveal (jump-to-warning): no
 *  mouseleave fires for a programmatic reveal, so it can't float open forever. */
export const DETAIL_REVEAL_AUTOCLOSE_MS = 6000;
