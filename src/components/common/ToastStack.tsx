/**
 * The toast stack: bottom-left, newest nearest the bottom edge, older ones
 * pushed upward, capped at whatever fits in 20% of the window.
 *
 * Split of responsibilities with `uiStore`:
 *   - the store owns the DATA (push / de-dup-refresh / evict / dismiss). It runs
 *     no timers, so it stays deterministic and trivial to unit-test.
 *   - this component owns the CLOCK and the GEOMETRY. Pausing is a DOM concern
 *     (hover / focus) and so is "how tall is a toast", neither of which the store
 *     can see, so the dwell-then-fade lifecycle lives here and calls
 *     `removeToast` when a toast's life is over, and the measured capacity is fed
 *     back to the store through `setToastCapacity`.
 *
 * LAYOUT. The column is position-driven, not flex-driven: every toast is
 * absolutely positioned on the same bottom anchor and lifted into its slot with
 * `translateY(-offset)`, where the offset is the summed height of everything
 * newer than it. A flex column cannot animate an insertion or a removal - the
 * siblings jump - whereas a changed transform is transitioned for free, which is
 * what makes the three movements (a new toast rising in, the stack being pushed
 * up to make room, a dying toast drifting up and out) read as motion rather than
 * as a re-layout. Heights are MEASURED, never assumed: a toast wraps to two or
 * three lines depending on the message and the UI scale.
 *
 * Always mounted (App renders it unconditionally) so the screen-reader live
 * regions exist BEFORE their content changes - a live region injected at the same
 * moment as its text is unreliably announced.
 */
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useUIStore, type ToastItem, type ToastKind } from '../../store/uiStore';
import {
  ESTIMATED_TOAST_HEIGHT_PX,
  fitToastCapacity,
  toastStackHeight,
  toastStackOffsets,
} from '../../utils/toastCapacity';
import { UI_SCALE_EVENT } from '../../utils/uiScale';
import { AlertCircleIcon, AlertTriangleIcon, CheckCircleIcon, CloseIcon, InfoIcon } from './icons';

// ---------------------------------------------------------------------------
// Timing. One place, named, so the lifecycle is readable and tunable.
// ---------------------------------------------------------------------------

/** Time at full opacity before a toast starts fading out. */
const DWELL_MS = 5000;
/**
 * Errors get a longer read: they carry the most consequence, they are the ones a
 * user is most likely to glance away from and miss, and unlike a success there is
 * usually a decision to make about them.
 */
const ERROR_DWELL_MS = 9000;
/** Warnings sit between the two - actionable, but rarely a dead end. */
const WARNING_DWELL_MS = 7000;
/** How long the fade from full to gone takes once the dwell is over. */
const FADE_MS = 1500;
/**
 * Lifecycle clock resolution. ~30 opacity steps across FADE_MS reads as a smooth
 * fade, and the interval only runs while at least one toast is on screen.
 */
const TICK_MS = 50;
/**
 * Enter / push / exit duration. Skipped entirely under prefers-reduced-motion,
 * where every toast simply appears in its slot.
 */
const TRANSITION_MS = 180;
/** How far BELOW its slot a toast starts its entrance, in px. */
const ENTER_RISE_PX = 12;
/** How far ABOVE its slot a leaving toast drifts while it fades, in px. */
const EXIT_RISE_PX = 12;

/** Full lifetime of a toast of a given kind, dwell plus fade. */
function lifetimeOf(kind: ToastKind): number {
  return dwellOf(kind) + FADE_MS;
}

function dwellOf(kind: ToastKind): number {
  if (kind === 'error') return ERROR_DWELL_MS;
  if (kind === 'warning') return WARNING_DWELL_MS;
  return DWELL_MS;
}

// ---------------------------------------------------------------------------
// Appearance. Accents come from the theme tokens (--cc-success / -warning /
// -error) via their Tailwind aliases, never from hardcoded colour.
//
// Every box keeps the opaque `bg-panel` base it has always had - the stack floats
// over the map, and a 10%-alpha accent alone would be unreadable there. The tint
// is a nested layer that composites over that opaque base.
//
// Icons are deliberately drawn from `./icons`, which is FILLED throughout: WebKit
// fattens stroked geometry into blobs under the native page-zoom UI scale.
// ---------------------------------------------------------------------------

interface KindStyle {
  /** Tint + left accent rail, layered over the opaque panel background. */
  body: string;
  /** Accent colour for the leading icon. */
  icon: string;
  Icon: typeof InfoIcon;
}

const KIND_STYLES: Record<ToastKind, KindStyle> = {
  info: { body: 'border-border', icon: 'text-text-secondary', Icon: InfoIcon },
  success: { body: 'bg-success-10 border-success', icon: 'text-success', Icon: CheckCircleIcon },
  warning: { body: 'bg-warning-10 border-warning', icon: 'text-warning', Icon: AlertTriangleIcon },
  error: { body: 'bg-error-10 border-error', icon: 'text-error', Icon: AlertCircleIcon },
};

/** Which live region a kind is announced through. */
function isUrgent(kind: ToastKind): boolean {
  return kind === 'error' || kind === 'warning';
}

// ---------------------------------------------------------------------------

/** Live `(prefers-reduced-motion: reduce)`, defaulting to false where unsupported. */
export function usePrefersReducedMotion(): boolean {
  const query = useCallback((): MediaQueryList | null => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)');
    } catch {
      return null;
    }
  }, []);

  const [reduced, setReduced] = useState(() => query()?.matches ?? false);

  useEffect(() => {
    const mq = query();
    if (!mq) return;
    const onChange = () => setReduced(mq.matches);
    onChange();
    // Safari <14 only has the deprecated addListener; guard rather than assume.
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    return undefined;
  }, [query]);

  return reduced;
}

function readViewportHeight(): number {
  if (typeof window === 'undefined') return 0;
  // innerHeight can read 0 in a webview that has not sized itself yet; fall back
  // to the layout viewport before giving up, so a transient 0 does not become the
  // number the capacity is computed from.
  return window.innerHeight || document.documentElement?.clientHeight || 0;
}

/**
 * Window height in CSS px, kept current across ordinary window resizes AND the
 * app's UI-scale control.
 *
 * The scale control is native webview zoom (`utils/uiScale`), which changes the
 * CSS viewport and should therefore surface as a plain `resize`. Should is doing
 * work in that sentence - it depends on the platform webview - so this listens on
 * three independent sources rather than betting on one: `resize`, a
 * ResizeObserver on the document element (fires for any layout-viewport change),
 * and the app's own `ui-scale-change` event. `setZoom` is async, so the
 * ui-scale reading is taken again on the next frame; whichever source is right on
 * a given platform wins, and the duplicates cost nothing because setting state to
 * the same number does not re-render.
 */
function useViewportHeight(): number {
  const [height, setHeight] = useState(readViewportHeight);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const sync = () => setHeight(readViewportHeight());
    const syncSoon = () => {
      sync();
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(sync);
    };

    window.addEventListener('resize', sync);
    window.addEventListener(UI_SCALE_EVENT, syncSoon);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && document.documentElement) {
      observer = new ResizeObserver(sync);
      observer.observe(document.documentElement);
    }
    sync();

    return () => {
      window.removeEventListener('resize', sync);
      window.removeEventListener(UI_SCALE_EVENT, syncSoon);
      observer?.disconnect();
    };
  }, []);

  return height;
}

/** Per-toast clock bookkeeping, keyed by toast id. */
interface Clock {
  /** The revision this clock belongs to; a refresh bumps it and resets `elapsed`. */
  revision: number;
  /** Unpaused milliseconds since the toast appeared (or was last refreshed). */
  elapsed: number;
  /** Milliseconds since the exit animation started. Only used while `leaving`. */
  leftFor: number;
}

/** Measured box of one toast, in CSS px. */
interface Size {
  height: number;
  width: number;
}

export function ToastStack() {
  const { t } = useTranslation();
  const toasts = useUIStore((s) => s.toasts);
  const dismissToast = useUIStore((s) => s.dismissToast);
  const setToastCapacity = useUIStore((s) => s.setToastCapacity);
  const reducedMotion = usePrefersReducedMotion();
  const viewportHeight = useViewportHeight();

  // Pause scope is the WHOLE stack, not the single hovered toast. Toast positions
  // are derived from stack order, so letting the neighbours expire while the
  // pointer rests on one would reshuffle the column underneath the cursor - the
  // toast being read (and its dismiss button) would slide out from under the
  // pointer mid-click. Freezing the whole stack keeps the geometry still, and
  // "I am reading this" almost always means the batch, not one line of it.
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  const clocks = useRef(new Map<number, Clock>());
  /** The stack container, so the tick can re-check whether it is really hovered. */
  const stackRef = useRef<HTMLDivElement | null>(null);

  /**
   * Leave the paused state and give every surviving toast its FULL dwell back.
   *
   * A reset rather than a resume: having read the stack, the user has spent the
   * time the dwell exists to provide, and dropping them back into the last
   * fraction of a fade means a toast they just looked at vanishes almost
   * immediately.
   */
  const resume = useCallback(() => {
    for (const clock of clocks.current.values()) clock.elapsed = 0;
    setPaused(false);
  }, []);

  /** Live DOM node per toast id, so heights can be re-measured on demand. */
  const nodes = useRef(new Map<number, HTMLElement>());
  /** Last measured box per toast id. */
  const sizes = useRef(new Map<number, Size>());
  /** Slot offset each toast last occupied - where a leaving toast drifts up FROM. */
  const lastOffsets = useRef(new Map<number, number>());
  /** Toasts that have had their first frame and so are no longer entering. */
  const settled = useRef(new Set<number>());
  const observer = useRef<ResizeObserver | null>(null);

  // Geometry and the opacity ramp are computed at render time from refs, so
  // anything that changes them has to ask for a re-render explicitly.
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const measure = useCallback((el: HTMLElement): boolean => {
    const id = Number(el.dataset.toastId);
    if (!Number.isFinite(id)) return false;
    const rect = el.getBoundingClientRect();
    // getBoundingClientRect is the truth in a browser; offsetHeight/Width is the
    // fallback for environments that do not lay out (jsdom returns zeroes).
    const height = rect.height || el.offsetHeight || 0;
    const width = rect.width || el.offsetWidth || 0;
    const prev = sizes.current.get(id);
    if (prev && prev.height === height && prev.width === width) return false;
    sizes.current.set(id, { height, width });
    return true;
  }, []);

  // One ResizeObserver for the whole stack rather than one per toast: a toast can
  // change height without React re-rendering it (a font swap, a UI-scale change,
  // a wrap point moving), and that has to move every toast above it.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        if (measure(entry.target as HTMLElement)) changed = true;
      }
      if (changed) bump();
    });
    observer.current = ro;
    for (const el of nodes.current.values()) ro.observe(el);
    return () => {
      ro.disconnect();
      observer.current = null;
    };
  }, [measure]);

  // A single stable ref callback for every toast - the id is read back off the
  // element, so this never has to be re-created per item (which would detach and
  // re-attach every ref on every render).
  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return;
      const id = Number(el.dataset.toastId);
      if (!Number.isFinite(id)) return;
      nodes.current.set(id, el);
      observer.current?.observe(el);
      measure(el);
    },
    [measure],
  );

  // React 18 ref callbacks cannot return a cleanup, so the per-id bookkeeping is
  // pruned here instead: anything not in the current list is gone for good.
  // Re-measuring afterwards is what turns "a new toast mounted" into "everything
  // above it slides up", one frame later - by which time the newcomer is still at
  // opacity 0, so the correction is never visible.
  useLayoutEffect(() => {
    const liveIds = new Set(toasts.map((item) => item.id));
    for (const id of [...nodes.current.keys()]) if (!liveIds.has(id)) nodes.current.delete(id);
    for (const id of [...sizes.current.keys()]) if (!liveIds.has(id)) sizes.current.delete(id);
    for (const id of [...lastOffsets.current.keys()]) if (!liveIds.has(id)) lastOffsets.current.delete(id);
    for (const id of [...settled.current]) if (!liveIds.has(id)) settled.current.delete(id);

    let changed = false;
    for (const el of nodes.current.values()) if (measure(el)) changed = true;
    if (changed) bump();
  });

  const hasToasts = toasts.length > 0;
  useEffect(() => {
    if (!hasToasts) {
      clocks.current.clear();
      // Un-pause on the way to empty. Dismissing the last toast from under the
      // pointer (or with the keyboard) unmounts the container, so its
      // mouseleave/blur never fires - leaving `paused` stuck true would mean the
      // NEXT toast arrives pre-frozen and never dismisses itself.
      setPaused(false);
      return undefined;
    }
    const handle = window.setInterval(() => {
      const store = useUIStore.getState();
      const live = store.toasts;
      const map = clocks.current;


      for (const id of [...map.keys()]) {
        if (!live.some((item) => item.id === id)) map.delete(id);
      }

      for (const item of live) {
        let clock = map.get(item.id);
        if (!clock || clock.revision !== item.revision) {
          clock = { revision: item.revision, elapsed: 0, leftFor: 0 };
          map.set(item.id, clock);
        }
        if (item.leaving) {
          // An exit always runs to completion - it is already off the user's
          // reading path, and freezing it mid-slide on hover just leaves litter.
          clock.leftFor += TICK_MS;
          if (clock.leftFor >= (reducedMotionRef.current ? 0 : TRANSITION_MS)) {
            store.removeToast(item.id);
          }
          continue;
        }
        if (pausedRef.current) continue;
        clock.elapsed += TICK_MS;
        if (clock.elapsed >= lifetimeOf(item.kind)) store.removeToast(item.id);
      }

      // Backstop for the entrance flip below: a toast must never be stranded at
      // opacity 0 if the frame callback never runs (a backgrounded window).
      for (const item of live) settled.current.add(item.id);

      bump();
    }, TICK_MS);
    return () => window.clearInterval(handle);
  }, [hasToasts]);

  /**
   * Self-heal a stranded pause.
   *
   * `mouseleave` is not guaranteed to arrive. The node under the pointer can be
   * REMOVED - a toast finishing its exit, the stack reflowing, the container
   * unmounting - and a node that no longer exists fires no leave event, so
   * `paused` would stay true and nothing would ever dismiss again. That is the
   * "once I have hovered them they never go away" case.
   *
   * So do not rely solely on the enter/leave pair: while paused, any pointer
   * movement over something OUTSIDE the stack is positive evidence the pointer
   * has gone, and resumes. A keyboard pause is exempt, since focus is still held
   * regardless of where the mouse happens to be.
   */
  useEffect(() => {
    if (!paused) return undefined;
    const onMove = (e: Event) => {
      const el = stackRef.current;
      if (el && el.contains(document.activeElement)) return;
      const target = e.target;
      if (el && target instanceof Node && el.contains(target)) return;
      resume();
    };
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('mousemove', onMove, true);
    return () => {
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('mousemove', onMove, true);
    };
  }, [paused, resume]);

  // The entrance. A toast renders its first frame below its slot at opacity 0,
  // then flips to its real offset on the next frame, and the CSS transition does
  // the rising. Both halves have to be committed to the DOM as separate frames or
  // the browser collapses them into no transition at all.
  const entering = toasts.some((item) => !settled.current.has(item.id));
  useEffect(() => {
    if (!entering) return undefined;
    const flush = () => {
      let changed = false;
      for (const item of useUIStore.getState().toasts) {
        if (!settled.current.has(item.id)) {
          settled.current.add(item.id);
          changed = true;
        }
      }
      if (changed) bump();
    };
    if (typeof requestAnimationFrame === 'function') {
      const frame = requestAnimationFrame(flush);
      return () => cancelAnimationFrame(frame);
    }
    const timer = window.setTimeout(flush, 0);
    return () => window.clearTimeout(timer);
  }, [entering]);

  // Geometry. Leaving toasts are excluded from the stack so the survivors close
  // the gap smoothly; each leaver keeps the offset it last held and drifts up
  // from there.
  const live = toasts.filter((item) => !item.leaving);
  const liveHeights = live.map((item) => sizes.current.get(item.id)?.height ?? ESTIMATED_TOAST_HEIGHT_PX);
  const offsets = toastStackOffsets(liveHeights);
  live.forEach((item, index) => lastOffsets.current.set(item.id, offsets[index] ?? 0));
  const stackHeight = toastStackHeight(liveHeights);
  const stackWidth = live.reduce((widest, item) => Math.max(widest, sizes.current.get(item.id)?.width ?? 0), 0);

  // Capacity. The store owns eviction (so it stays deterministic and testable);
  // only the DOM knows how tall the window and the toasts actually are, so the
  // measurement is reported in and the store remains the single answer to "what
  // is on screen". Newest-first, because the newest toast is the last to be
  // given up. `setToastCapacity` is a no-op when the number has not moved, so
  // reporting on every render cannot loop.
  useEffect(() => {
    setToastCapacity(fitToastCapacity(viewportHeight, [...liveHeights].reverse()));
  });

  const urgent = toasts.filter((item) => isUrgent(item.kind));
  const polite = toasts.filter((item) => !isUrgent(item.kind));

  return createPortal(
    <div className="fixed inset-0 pointer-events-none z-[99999]">
      {/*
        A single container cannot vary politeness per item, so announcement is
        split off from presentation: two permanently-mounted screen-reader regions
        carry the text (polite for info/success, assertive for error/warning),
        while the visible stack below marks its message `aria-hidden` so nothing is
        read twice. Each region shows only its newest message, so it never re-reads
        older ones when the stack changes.
      */}
      <div className="sr-only" role="status" aria-live="polite">
        {polite[polite.length - 1]?.message ?? ''}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive">
        {urgent[urgent.length - 1]?.message ?? ''}
      </div>

      {hasToasts && (
        <div
          data-testid="toast-stack"
          // Bottom-anchored, so the column grows UPWARD as toasts arrive: the
          // array is oldest-first and every toast shares this bottom edge, which
          // puts the newest at the bottom, nearest where the eye already is.
          //
          // Left-aligned rather than centered: a common left edge makes
          // differently-sized toasts read as one column instead of a ragged
          // centered pile.
          //
          // The box is sized from the measurement so it covers the whole column,
          // gaps included: hover pauses the stack, and a gap that was not part of
          // the hit area would un-pause every time the pointer crossed one.
          className="absolute bottom-6 left-6 pointer-events-auto"
          style={{ height: stackHeight || undefined, width: stackWidth || undefined }}
          ref={stackRef}
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={resume}
          onFocusCapture={() => setPaused(true)}
          onBlurCapture={resume}
        >
          {toasts.map((item) => (
            <Toast
              key={item.id}
              item={item}
              elapsed={clocks.current.get(item.id)?.elapsed ?? 0}
              offset={lastOffsets.current.get(item.id) ?? 0}
              entering={!reducedMotion && !settled.current.has(item.id)}
              paused={paused}
              reducedMotion={reducedMotion}
              measureRef={attach}
              dismissLabel={t('common.toast.dismiss', { message: item.message })}
              onDismiss={() => dismissToast(item.id)}
            />
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

interface ToastProps {
  item: ToastItem;
  elapsed: number;
  /** Distance in px from the stack's bottom anchor to this toast's bottom edge. */
  offset: number;
  /** True for the one frame before the entrance transition starts. */
  entering: boolean;
  paused: boolean;
  reducedMotion: boolean;
  measureRef: (el: HTMLDivElement | null) => void;
  dismissLabel: string;
  onDismiss: () => void;
}

function Toast({
  item,
  elapsed,
  offset,
  entering,
  paused,
  reducedMotion,
  measureRef,
  dismissLabel,
  onDismiss,
}: ToastProps) {
  const style = KIND_STYLES[item.kind];
  const { Icon } = style;

  // Opacity is driven off the tick rather than a CSS transition so that pausing
  // can freeze it and un-pausing can resume from where it stopped. Hover/focus
  // snaps straight back to full - "it lit back up" is the intended read.
  let opacity = 1;
  // How far through the fade-out this toast is, 0 (untouched) to 1 (gone). Also
  // drives the exit RISE below, so the drift happens WHILE it fades rather than
  // after: expiring naturally used to reach opacity 0 on the tick and only then
  // be marked `leaving`, so the upward travel was applied to an already-invisible
  // box and the toast simply faded in place.
  let fade = 0;
  if (item.leaving || entering) {
    opacity = 0;
    fade = item.leaving ? 1 : 0;
  } else if (!paused && !reducedMotion) {
    const overdue = elapsed - dwellOf(item.kind);
    if (overdue > 0) {
      fade = Math.min(1, overdue / FADE_MS);
      opacity = 1 - fade;
    }
  }

  // Up is negative. A toast enters from below its slot, sits ON it, and leaves
  // above it. Under reduced motion there is no travel at all: it is placed in its
  // slot and taken away from it, with the same lifetime either way.
  let translate = -offset;
  if (!reducedMotion) {
    if (entering) translate = -(offset - ENTER_RISE_PX);
    else if (fade > 0) translate = -(offset + EXIT_RISE_PX * fade);
  }

  return (
    <div
      ref={measureRef}
      data-testid="toast"
      data-toast-id={item.id}
      data-toast-kind={item.kind}
      data-toast-key={item.key}
      data-toast-leaving={item.leaving ? 'true' : undefined}
      className={[
        // `w-max` so the box sizes to its own content rather than to the
        // measurement-sized container it lives in (which would be circular), and
        // still wraps at the cap.
        'absolute bottom-0 left-0 w-max bg-panel rounded-lg shadow-lg overflow-hidden max-w-[min(32rem,90vw)]',
        // Reduced motion: appear and disappear, no slide, no fade ramp. The total
        // lifetime is unchanged - only the movement goes away.
        reducedMotion ? '' : 'transition-[opacity,transform] ease-out',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        opacity,
        transform: `translateY(${translate}px)`,
        transitionDuration: reducedMotion ? undefined : `${TRANSITION_MS}ms`,
      }}
    >
      <div className={`flex items-start gap-2 border-l-4 px-4 py-2 ${style.body}`}>
        <Icon size={16} className={`shrink-0 mt-0.5 ${style.icon}`} />
        {/* aria-hidden: the live regions above already announce this text. */}
        <span className="text-text-primary text-sm leading-5" aria-hidden="true">
          {item.message}
        </span>
        <button
          type="button"
          aria-label={dismissLabel}
          onClick={onDismiss}
          className="shrink-0 -mr-1 mt-0.5 rounded p-1 text-text-secondary hover:text-text-primary hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <CloseIcon size={12} />
        </button>
      </div>
    </div>
  );
}

export default ToastStack;
