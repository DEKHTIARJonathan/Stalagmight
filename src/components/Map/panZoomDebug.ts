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
