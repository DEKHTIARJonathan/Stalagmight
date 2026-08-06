import { getCurrentWebview } from '@tauri-apps/api/webview';
import { clamp } from './clamp';

export const UI_SCALE_MIN = 0.5;
export const UI_SCALE_MAX = 3.0;
export const UI_SCALE_STEP = 0.1;
export const UI_SCALE_DEFAULT = 1.0;

/**
 * Smallest CSS viewport the layout is designed to survive (#429).
 *
 * The webview page zoom divides the window by the scale factor, so the CSS
 * viewport the whole app lays out in is `window / scale`. At scale 3.0 in a
 * 1280x720 window that is 427x240 CSS px: the mode selector collapses to a
 * clipped icon stub, the Sections dock becomes a vertical sliver and the map is
 * a few hundred px wide. These two numbers are the floor that must hold, and
 * they sit at/below the 800x600 window minimum so a window at that minimum still
 * allows scale 1.0.
 */
export const MIN_UI_VIEWPORT_WIDTH = 800;
export const MIN_UI_VIEWPORT_HEIGHT = 500;

const STORAGE_KEY = 'ui-scale';

/** Dispatched on `window` whenever the UI scale changes, so open UI can sync. */
export const UI_SCALE_EVENT = 'ui-scale-change';

export function clampUiScale(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return clamp(rounded, UI_SCALE_MIN, UI_SCALE_MAX);
}

/** Current UI scale from storage, or the default if unset/invalid. */
export function getUiScale(): number {
  const raw = Number(localStorage.getItem(STORAGE_KEY));
  return Number.isFinite(raw) && raw > 0 ? clampUiScale(raw) : UI_SCALE_DEFAULT;
}

/**
 * The scale actually worth applying for a given window, i.e. the user's
 * preference capped so `window / scale` never falls below the minimum usable
 * viewport above.
 *
 * `windowWidth`/`windowHeight` are the window's UNZOOMED size in CSS px (what
 * the viewport would measure at scale 1). The cap is a DISPLAY-TIME decision
 * only, in the same spirit as the side-panel squeeze: the preference in storage
 * is never rewritten, so the user's 3.0 comes straight back when the window
 * grows enough to carry it.
 *
 * A non-positive or non-finite size means "not measured yet" and passes the
 * preference through untouched, so nothing is capped on a degenerate reading.
 */
export function effectiveUiScale(
  preferred: number,
  windowWidth: number,
  windowHeight: number
): number {
  const scale = clampUiScale(preferred);
  if (!Number.isFinite(windowWidth) || !Number.isFinite(windowHeight)) return scale;
  if (windowWidth <= 0 || windowHeight <= 0) return scale;
  // Floor to whole percent: the window size is recovered from an already-zoomed
  // (and therefore rounded) viewport reading, so a scale carried to full double
  // precision would jitter on every resize tick with no visible benefit.
  //
  // Scaling to percent BEFORE dividing, rather than flooring `w / MIN * 100`,
  // keeps the common exact cases exact: 720/500 is the double just below 1.44, so
  // `Math.floor(1.44 * 100)` is 143, and the cap would give away a whole percent
  // to representation noise. `720 * 100 / 500` is 144 on the nose.
  const floored =
    Math.min(
      Math.floor((windowWidth * 100) / MIN_UI_VIEWPORT_WIDTH),
      Math.floor((windowHeight * 100) / MIN_UI_VIEWPORT_HEIGHT)
    ) / 100;
  // Never cap below the scale slider's own floor - a window smaller than the
  // 800x600 window minimum has no scale that satisfies the viewport anyway, and
  // zooming out past 0.5 to chase it would only make the text unreadable.
  return Math.min(scale, Math.max(UI_SCALE_MIN, floored));
}

/**
 * Smallest scale change worth pushing to the webview.
 *
 * Setting the zoom resizes the CSS viewport, which fires `resize`, which
 * recomputes the cap from that very viewport - a loop that only terminates
 * because the recomputed scale settles. It does not settle exactly:
 * `innerWidth`/`innerHeight` are integers, so recovering the window size through
 * the applied zoom loses up to one CSS px per axis (at most UI_SCALE_MAX px of
 * window, i.e. under 3/MIN_UI_VIEWPORT_HEIGHT = 0.6% of scale). A deadband
 * comfortably wider than that bound turns "settles" into "settles in one step",
 * so a resize can never trip an endless setZoom/resize ping-pong. It is far
 * below the 0.1 slider/shortcut step, so no scale the user can ask for is
 * swallowed by it.
 */
export const UI_SCALE_APPLY_DEADBAND = 0.02;

/** Scale currently handed to the webview, or null before the first apply. */
let appliedScale: number | null = null;

/** Whether `next` moved far enough from what the webview already has to be worth
 *  a `setZoom`. The first apply always counts - the webview starts at 1.0. */
export function shouldApplyUiScale(applied: number | null, next: number): boolean {
  if (applied === null) return true;
  return Math.abs(next - applied) >= UI_SCALE_APPLY_DEADBAND;
}

/**
 * The window's size in unzoomed CSS px.
 *
 * `innerWidth`/`innerHeight` are already divided by the applied zoom, so
 * multiplying them back by it recovers a size that does not move when the zoom
 * does. Measuring afresh each time keeps the rounding error above bounded to a
 * single step rather than accumulating across resizes.
 */
function windowCssSize(): { width: number; height: number } {
  if (typeof window === 'undefined') return { width: 0, height: 0 };
  const applied = appliedScale ?? 1;
  return { width: window.innerWidth * applied, height: window.innerHeight * applied };
}

/**
 * Push the effective scale for the current window into the webview, if it moved.
 *
 * `appliedScale` is recorded optimistically, BEFORE the `setZoom` round trip
 * settles, and rolled back if it rejects. It has to be that way round: `setZoom`
 * is an IPC call, but the native side applies the zoom immediately, so the
 * `resize` it provokes can reach the page while the promise is still in flight.
 * That handler recovers the window as `innerSize * appliedScale` - reading an
 * already-zoomed `innerSize` through a stale scale would understate the window,
 * tighten the cap, and start the setZoom/resize ping-pong the deadband exists to
 * rule out. Rolling back on rejection keeps the other half of the contract: a
 * zoom that never happened must not be claimed, or `windowCssSize` overstates the
 * window and the cap goes slack (#429).
 */
function applyEffectiveScale(preferred: number): void {
  const { width, height } = windowCssSize();
  const effective = effectiveUiScale(preferred, width, height);
  if (!shouldApplyUiScale(appliedScale, effective)) return;
  const previous = appliedScale;
  appliedScale = effective;
  void getCurrentWebview()
    .setZoom(effective)
    .catch(() => {
      // Zoom unsupported on this platform, or this call lost a race with a newer
      // apply - only undo our own write.
      if (appliedScale === effective) appliedScale = previous;
    });
}

/**
 * Persist and apply a UI scale via the webview's native page zoom, then notify
 * listeners (e.g. the Settings slider) so they stay in sync. Returns the clamped
 * value that was stored.
 *
 * What is stored and broadcast is the user's PREFERENCE; what reaches the
 * webview is that preference capped to the current window (see
 * {@link effectiveUiScale}), so the slider keeps showing what they asked for.
 */
export function setUiScale(value: number): number {
  const scale = clampUiScale(value);
  localStorage.setItem(STORAGE_KEY, String(scale));
  applyEffectiveScale(scale);
  window.dispatchEvent(new CustomEvent(UI_SCALE_EVENT, { detail: scale }));
  return scale;
}

/**
 * Re-apply the stored preference against the window as it is now: on startup
 * (webview zoom resets to 1 each launch) and after every resize, so the cap
 * tightens as the window shrinks and releases as it grows. Touches neither
 * storage nor listeners - the preference did not change.
 */
export function refreshUiScale(): void {
  applyEffectiveScale(getUiScale());
}
