import { useRef, useCallback } from 'react';

interface LongPressOptions {
  /** Delay in ms before firing (default 500) */
  delay?: number;
  /** Max movement in px before cancelling (default 10) */
  moveThreshold?: number;
  /** Whether the hook is enabled (default true) */
  enabled?: boolean;
}

interface LongPressHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
}

/** How long the compatibility-event suppressor stays armed after a lift. */
const COMPAT_EVENT_WINDOW_MS = 700;

/** Tear-down for the armed suppressor, or null while none is armed. */
let disarmCompatEvents: (() => void) | null = null;

/**
 * Swallow the compatibility mouse events the lift synthesises.
 *
 * A touch device fires `mousedown`/`mouseup`/`click` (and sometimes
 * `contextmenu`) from the finger LIFT, not from the moment the hold completes -
 * so this is armed in `onPointerUp`, not when the timer fires. Arming it at
 * fire time would let any hold longer than the window leak its tap into the
 * menu the hold just opened.
 *
 * The listeners sit on `document` in the CAPTURE phase because that is the only
 * position that beats both React's root delegation and the bubble-phase
 * document `mousedown` that dismissable layers close themselves on. The
 * pointerdown would be the spec's suppression point, but preventing it there
 * kills the compat `mousedown` of every ordinary tap, and tap-to-select rides
 * on that.
 *
 * A platform that suppresses the compat events itself sends none of them, hence
 * the timeout: the window closes on the first `click` or when it expires.
 */
function armCompatEventSuppressor(): void {
  // Re-arm rather than stack, so a second long press just restarts the window.
  disarmCompatEvents?.();

  let timer: ReturnType<typeof setTimeout> | null = null;

  const swallow = (e: Event) => {
    e.stopPropagation();
  };
  const swallowClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    disarm();
  };

  const disarm = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    document.removeEventListener('mousedown', swallow, true);
    document.removeEventListener('mouseup', swallow, true);
    document.removeEventListener('contextmenu', swallow, true);
    document.removeEventListener('click', swallowClick, true);
    if (disarmCompatEvents === disarm) disarmCompatEvents = null;
  };

  document.addEventListener('mousedown', swallow, true);
  document.addEventListener('mouseup', swallow, true);
  document.addEventListener('contextmenu', swallow, true);
  document.addEventListener('click', swallowClick, true);
  timer = setTimeout(disarm, COMPAT_EVENT_WINDOW_MS);
  disarmCompatEvents = disarm;
}

/**
 * What the finger landed on, as an `HTMLElement`.
 *
 * The press target is the deepest node under the finger, which can be an
 * `SVGElement` (a row's icon) - one step up lands back on the HTML the caller
 * can position a menu against. Anything else means there is nothing to hand the
 * callback, and the press is not worth arming.
 */
function pressTarget(raw: EventTarget | null): HTMLElement | null {
  if (raw instanceof HTMLElement) return raw;
  if (raw instanceof Node && raw.parentElement instanceof HTMLElement) return raw.parentElement;
  return null;
}

/**
 * Hook for long-press detection on touch devices.
 * Only activates for `pointerType === 'touch'` - mouse events pass through untouched.
 * After firing, the compatibility mouse events the lift synthesises are swallowed
 * (see `armCompatEventSuppressor`), so the menu the press opened survives its own tap.
 */
export function useLongPress(
  callback: (position: { x: number; y: number }, target: HTMLElement) => void,
  options?: LongPressOptions,
): LongPressHandlers {
  const { delay = 500, moveThreshold = 10, enabled = true } = options ?? {};

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startPos.current = null;
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return;
      if (e.pointerType !== 'touch') return;

      const target = pressTarget(e.target);
      if (!target) return;

      firedRef.current = false;
      startPos.current = { x: e.clientX, y: e.clientY };

      const x = e.clientX;
      const y = e.clientY;

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        firedRef.current = true;
        callback({ x, y }, target);
      }, delay);
    },
    [enabled, delay, callback],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      if (!startPos.current || timerRef.current === null) return;

      const dx = e.clientX - startPos.current.x;
      const dy = e.clientY - startPos.current.y;
      if (dx * dx + dy * dy > moveThreshold * moveThreshold) {
        clear();
      }
    },
    [moveThreshold, clear],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      clear();
      if (firedRef.current) {
        firedRef.current = false;
        // Belt-and-braces: some engines honour a prevented pointerup and skip
        // the compat events entirely. The suppressor covers the ones that do not.
        e.preventDefault();
        armCompatEventSuppressor();
      }
    },
    [clear],
  );

  const onPointerCancel = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      clear();
      firedRef.current = false;
    },
    [clear],
  );

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
