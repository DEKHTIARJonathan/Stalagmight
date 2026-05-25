// TEMPORARY: instrumentation for the macOS pan/zoom lockup investigation.
// See docs/debugging-macos-pan-zoom.md. Delete this file and revert the
// install call in MapCanvas.tsx once the bug is fixed.

import type maplibregl from 'maplibre-gl';

type RefLike<T> = { current: T };

interface DebugRefs {
  customPanActive: RefLike<boolean>;
  ctrlPanActive: RefLike<boolean>;
  placementJustConfirmed: RefLike<boolean>;
  ctrlPanMouseEventTime: RefLike<number>;
}

const HANDLER_NAMES = [
  'dragPan',
  'scrollZoom',
  'boxZoom',
  'dragRotate',
  'touchZoomRotate',
  'keyboard',
  'doubleClickZoom',
  'touchPitch',
] as const;

const LIFECYCLE_EVENTS = [
  'movestart',
  'moveend',
  'zoomstart',
  'zoomend',
  'rotatestart',
  'rotateend',
  'dragstart',
  'dragend',
  'boxzoomstart',
  'boxzoomend',
  'boxzoomcancel',
] as const;

const RAW_EVENTS = [
  'pointerdown',
  'pointerup',
  'pointercancel',
  'wheel',
  'gesturestart',
  'gesturechange',
  'gestureend',
] as const;

export function installPanZoomDebug(map: maplibregl.Map, refs: DebugRefs): void {
  const w = window as unknown as Record<string, unknown>;
  w.__map = map;
  w.__panRefs = refs;

  const log = (...args: unknown[]) => console.log('[pan-zoom-debug]', ...args);
  const shortStack = () =>
    new Error().stack?.split('\n').slice(2, 5).map((s) => s.trim()).join(' <- ') ?? '';

  log('install: map created, instrumentation active');

  for (const name of HANDLER_NAMES) {
    const h = (map as unknown as Record<string, { enable?: () => void; disable?: () => void; isEnabled?: () => boolean }>)[name];
    if (!h || typeof h.enable !== 'function' || typeof h.disable !== 'function') continue;
    const origEnable = h.enable.bind(h);
    const origDisable = h.disable.bind(h);
    h.enable = () => {
      log(`${name}.enable()  was=${h.isEnabled?.()}  ${shortStack()}`);
      return origEnable();
    };
    h.disable = () => {
      log(`${name}.disable() was=${h.isEnabled?.()}  ${shortStack()}`);
      return origDisable();
    };
  }

  // Wrap HandlerManager.run to (a) log every entry with stack so we can see
  // who initiated the still-in-flight run that the re-entry throw collides
  // with, and (b) swallow the "Attempting to run(), but is already running."
  // throw so a single timing race does not wedge the entire rAF render loop
  // and break all subsequent input. The first call's work continues; the
  // re-entrant attempt becomes a no-op for that frame.
  const hm = (map as unknown as { handlers?: { run?: (...args: unknown[]) => unknown; __debugPatched?: boolean } }).handlers;
  if (hm && typeof hm.run === 'function' && !hm.__debugPatched) {
    hm.__debugPatched = true;
    const origRun = hm.run.bind(hm);
    let callId = 0;
    let depth = 0;
    hm.run = (...args: unknown[]) => {
      const id = ++callId;
      depth++;
      const reentry = depth > 1;
      if (reentry) {
        log(`HandlerManager.run #${id} RE-ENTRY (depth=${depth}) ${shortStack()}`);
      }
      try {
        return origRun(...args);
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        if (msg.includes('already running')) {
          log(`HandlerManager.run #${id} swallowed re-entry throw (depth=${depth}) — see RE-ENTRY log above for the colliding call's stack`);
          return undefined;
        }
        throw e;
      } finally {
        depth--;
      }
    };
    log('HandlerManager.run wrapped (logs re-entries, swallows the throw)');
  } else {
    log(`HandlerManager.run NOT wrapped (handlers=${!!hm}, run=${typeof hm?.run})`);
  }

  for (const ev of LIFECYCLE_EVENTS) {
    map.on(ev as never, (e: unknown) => {
      const ee = e as { originalEvent?: { type?: string; button?: number } } | undefined;
      log(`map.${ev}`, {
        origType: ee?.originalEvent?.type,
        button: ee?.originalEvent?.button,
      });
    });
  }

  const canvas = map.getCanvas();
  for (const t of RAW_EVENTS) {
    canvas.addEventListener(
      t,
      (e: Event) => {
        const me = e as Partial<MouseEvent & WheelEvent & PointerEvent>;
        log(`canvas.${t}`, {
          button: me.button,
          buttons: me.buttons,
          ctrl: me.ctrlKey,
          meta: me.metaKey,
          pointerType: (me as PointerEvent).pointerType,
          deltaY: me.deltaY,
          defaultPrevented: e.defaultPrevented,
        });
      },
      { capture: true, passive: true },
    );
  }

  w.__debugSnapshot = () => {
    const handlerEnabled = Object.fromEntries(
      HANDLER_NAMES.map((n) => {
        const h = (map as unknown as Record<string, { isEnabled?: () => boolean }>)[n];
        return [n, h?.isEnabled?.()];
      }),
    );
    const snapshot = {
      handlerEnabled,
      isMoving: map.isMoving(),
      isZooming: map.isZooming(),
      isRotating: map.isRotating(),
      zoom: map.getZoom(),
      center: map.getCenter().toArray(),
      cursor: map.getCanvas().style.cursor,
      canvasTouchAction: getComputedStyle(map.getCanvas()).touchAction,
      refs: {
        customPanActive: refs.customPanActive.current,
        ctrlPanActive: refs.ctrlPanActive.current,
        placementJustConfirmed: refs.placementJustConfirmed.current,
        ctrlPanMouseEventTime: refs.ctrlPanMouseEventTime.current,
        msSinceCtrlPanEvent: Date.now() - refs.ctrlPanMouseEventTime.current,
      },
    };
    console.table(handlerEnabled);
    console.log('[pan-zoom-debug] snapshot', JSON.stringify(snapshot, null, 2));
    return snapshot;
  };

  log('install: call window.__debugSnapshot() when reproducing the bug');
}
