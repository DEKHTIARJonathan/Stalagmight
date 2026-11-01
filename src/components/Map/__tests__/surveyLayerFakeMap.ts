/**
 * A MapLibre stand-in rich enough for `new SurveyLayer(map)` under node, for the
 * lifecycle tests (#576). It is shaped like maplibre-gl 5.16 where lifecycle bugs
 * live: every style-backed call goes through `this.style`, and `remove()` deletes
 * it (Map.remove() -> setStyle(null) does exactly that), so a call that lands
 * after the map is gone throws the same "Cannot read properties of undefined"
 * TypeError the app logged. `loseStyle()` / `restoreStyle()` model a WebGL context
 * loss, during which MapLibre also has no style (it sets `this.style = null`).
 *
 * Anything the tests do not care about is a no-op: the map is a Proxy whose
 * unknown members resolve to a function returning undefined.
 */
import type { Map as MaplibreMap } from 'maplibre-gl';

type Listener = (e: unknown) => void;

/** EventTarget that also counts its live listeners per type. */
export class CountingTarget extends EventTarget {
  private readonly live = new Map<string, Set<unknown>>();
  style = { cursor: '' };
  width = 800;
  height = 600;
  clientWidth = 800;
  clientHeight = 600;

  override addEventListener(type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions): void {
    if (fn) {
      const set = this.live.get(type) ?? new Set();
      set.add(fn);
      this.live.set(type, set);
    }
    super.addEventListener(type, fn, opts);
  }

  override removeEventListener(type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions): void {
    if (fn) this.live.get(type)?.delete(fn);
    super.removeEventListener(type, fn, opts);
  }

  listenerCount(type: string): number {
    return this.live.get(type)?.size ?? 0;
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.width, height: this.height };
  }
}

interface FakeStyle {
  layers: string[];
  sources: Set<string>;
  layout: Map<string, string | undefined>;
}

export interface FakeSurveyMap {
  map: MaplibreMap;
  canvas: CountingTarget;
  container: CountingTarget;
  /** Fire a map event to every registered listener. */
  fire(type: string, event?: unknown): void;
  listenerCount(type: string): number;
  /** Layer ids bottom to top (only meaningful while the style is alive). */
  layerOrder(): string[];
  /** Map.remove(): the style is deleted. */
  remove(): void;
  /** WebGL context loss: MapLibre drops the style (custom layers included). */
  loseStyle(): void;
  /** Context restore: the serialized style (custom layers excluded) comes back. */
  restoreStyle(): void;
  /** Ids of the custom layers currently on the map. */
  customLayers(): string[];
  /** The errors of `addLayer` calls refused because their `beforeId` was not on the
   *  map - MapLibre fires an ErrorEvent and does NOT add the layer. */
  rejectedAdds(): string[];
}

export function makeFakeSurveyMap(): FakeSurveyMap {
  const listeners = new Map<string, Set<Listener>>();
  const onceWrappers = new Map<Listener, Listener>();
  const canvas = new CountingTarget();
  const container = new CountingTarget();
  const custom = new Set<string>();
  const rejected: string[] = [];
  let serialized: FakeStyle | null = null;

  const newStyle = (): FakeStyle => ({ layers: [], sources: new Set(), layout: new Map() });

  const styleApi = (s: FakeStyle) => ({
    getLayer: (id: string) => (s.layers.includes(id) ? { id } : undefined),
    getSource: (id: string) =>
      s.sources.has(id) ? { type: 'geojson', setData: () => {} } : undefined,
  });

  type StyleRef = ReturnType<typeof styleApi> & { _s: FakeStyle };
  const target = {
    // Optional so remove() can `delete` it, as MapLibre does.
    style: undefined as StyleRef | null | undefined,
    getLayer(id: string) {
      return target.style!.getLayer(id);
    },
    getSource(id: string) {
      return target.style!.getSource(id);
    },
    addSource(id: string) {
      target.style!._s.sources.add(id);
    },
    removeSource(id: string) {
      target.style!._s.sources.delete(id);
    },
    addLayer(layer: { id: string; type?: string; onAdd?: (m: unknown, gl: unknown) => void }, beforeId?: string) {
      const s = target.style!._s;
      const at = beforeId !== undefined ? s.layers.indexOf(beforeId) : -1;
      // Like MapLibre's Style.addLayer (maplibre-gl 5.16): a beforeId that is not
      // on the map is an ErrorEvent, and the layer is NOT added.
      if (beforeId !== undefined && at < 0) {
        rejected.push(`Cannot add layer "${layer.id}" before non-existing layer "${beforeId}".`);
        return;
      }
      if (at >= 0) s.layers.splice(at, 0, layer.id);
      else s.layers.push(layer.id);
      if (layer.type === 'custom') {
        custom.add(layer.id);
        layer.onAdd?.(proxy, {});
      }
    },
    removeLayer(id: string) {
      const s = target.style!._s;
      s.layers = s.layers.filter((l) => l !== id);
      custom.delete(id);
    },
    getLayersOrder() {
      return [...target.style!._s.layers];
    },
    getLayoutProperty(id: string) {
      return target.style!._s.layout.get(id);
    },
    setLayoutProperty(id: string, _name: string, value: string) {
      target.style!._s.layout.set(id, value);
    },
    on(type: string, fn: Listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    // Like MapLibre, off() also removes a listener registered with once().
    once(type: string, fn: Listener) {
      const wrapped: Listener = (e) => {
        listeners.get(type)?.delete(wrapped);
        onceWrappers.delete(fn);
        fn(e);
      };
      onceWrappers.set(fn, wrapped);
      target.on(type, wrapped);
    },
    off(type: string, fn: Listener) {
      listeners.get(type)?.delete(fn);
      const wrapped = onceWrappers.get(fn);
      if (wrapped) listeners.get(type)?.delete(wrapped);
      onceWrappers.delete(fn);
    },
    getCanvas: () => canvas,
    getCanvasContainer: () => container,
    unproject: ([x, y]: [number, number]) => ({ lng: x, lat: y }),
    project: ([lng, lat]: [number, number]) => ({ x: lng, y: lat }),
    isSourceLoaded: () => true,
    isStyleLoaded: () => Boolean(target.style),
    getZoom: () => 18,
  };

  const s0 = newStyle();
  target.style = { ...styleApi(s0), _s: s0 };

  const proxy = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return (t as Record<string | symbol, unknown>)[prop];
      return () => undefined;
    },
  }) as unknown as MaplibreMap;

  const fire = (type: string, event: unknown = {}): void => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
  };

  return {
    map: proxy,
    canvas,
    container,
    fire,
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
    layerOrder: () => [...(target.style?._s.layers ?? [])],
    remove: () => {
      delete (target as { style?: StyleRef | null }).style;
    },
    loseStyle: () => {
      const s = target.style!._s;
      serialized = {
        layers: s.layers.filter((id) => !custom.has(id)),
        sources: new Set(s.sources),
        layout: new Map(s.layout),
      };
      custom.clear();
      target.style = null;
    },
    restoreStyle: () => {
      const s = serialized ?? newStyle();
      serialized = null;
      target.style = { ...styleApi(s), _s: s };
    },
    customLayers: () => [...custom],
    rejectedAdds: () => [...rejected],
  };
}
