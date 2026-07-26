/**
 * The toast stack: bottom-centre, newest nearest the bottom edge, older ones
 * pushed upward, capped at `MAX_VISIBLE_TOASTS`.
 *
 * Split of responsibilities with `uiStore`:
 *   - the store owns the DATA (push / de-dup-refresh / evict / dismiss). It runs
 *     no timers, so it stays deterministic and trivial to unit-test.
 *   - this component owns the CLOCK. Pausing is a DOM concern (hover / focus),
 *     which the store cannot see, so the dwell-then-fade lifecycle lives here and
 *     calls `removeToast` when a toast's life is over.
 *
 * Always mounted (App renders it unconditionally) so the screen-reader live
 * regions exist BEFORE their content changes - a live region injected at the same
 * moment as its text is unreliably announced.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useUIStore, type ToastItem, type ToastKind } from '../../store/uiStore';
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
/** Enter / exit slide duration. Skipped entirely under prefers-reduced-motion. */
const TRANSITION_MS = 180;

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

/** Per-toast clock bookkeeping, keyed by toast id. */
interface Clock {
  /** The revision this clock belongs to; a refresh bumps it and resets `elapsed`. */
  revision: number;
  /** Unpaused milliseconds since the toast appeared (or was last refreshed). */
  elapsed: number;
  /** Milliseconds since the exit animation started. Only used while `leaving`. */
  leftFor: number;
}

export function ToastStack() {
  const { t } = useTranslation();
  const toasts = useUIStore((s) => s.toasts);
  const dismissToast = useUIStore((s) => s.dismissToast);
  const reducedMotion = usePrefersReducedMotion();

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
  // The opacity ramp is computed at render time from `clocks`, which is a ref, so
  // the tick has to ask for a re-render explicitly.
  const [, bump] = useReducer((n: number) => n + 1, 0);

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

      bump();
    }, TICK_MS);
    return () => window.clearInterval(handle);
  }, [hasToasts]);

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
          // Bottom-anchored, so the column grows UPWARD as toasts arrive: the array
          // is oldest-first and this is a normal (non-reversed) column, which puts
          // the newest at the bottom, nearest where the eye already is.
          //
          // Left-aligned rather than centered: `items-start` keeps the left edges
          // of differently-sized toasts flush, so the stack reads as one column
          // instead of a ragged centered pile.
          className="absolute bottom-6 left-6 flex flex-col items-start gap-2 pointer-events-auto"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocusCapture={() => setPaused(true)}
          onBlurCapture={() => setPaused(false)}
        >
          {toasts.map((item) => (
            <Toast
              key={item.id}
              item={item}
              elapsed={clocks.current.get(item.id)?.elapsed ?? 0}
              paused={paused}
              reducedMotion={reducedMotion}
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
  paused: boolean;
  reducedMotion: boolean;
  dismissLabel: string;
  onDismiss: () => void;
}

function Toast({ item, elapsed, paused, reducedMotion, dismissLabel, onDismiss }: ToastProps) {
  const style = KIND_STYLES[item.kind];
  const { Icon } = style;

  // Opacity is driven off the tick rather than a CSS transition so that pausing
  // can freeze it and un-pausing can resume from where it stopped. Hover/focus
  // snaps straight back to full - "it lit back up" is the intended read.
  let opacity = 1;
  if (item.leaving) {
    opacity = 0;
  } else if (!paused && !reducedMotion) {
    const overdue = elapsed - dwellOf(item.kind);
    if (overdue > 0) opacity = Math.max(0, 1 - overdue / FADE_MS);
  }

  return (
    <div
      data-testid="toast"
      data-toast-kind={item.kind}
      data-toast-key={item.key}
      data-toast-leaving={item.leaving ? 'true' : undefined}
      className={[
        'bg-panel rounded-lg shadow-lg overflow-hidden max-w-[min(32rem,90vw)]',
        // Reduced motion: appear and disappear, no slide, no enter fade. The
        // total lifetime is unchanged - only the movement goes away.
        reducedMotion ? '' : 'animate-toast-in transition-[opacity,transform] ease-out',
        reducedMotion || !item.leaving ? '' : '-translate-y-1',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        opacity,
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
