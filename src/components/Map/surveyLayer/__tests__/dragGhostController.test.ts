import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { DRAG_PREVIEW_SOURCE } from '../dragPreviewLayers';
import type { DragPreviewSet } from '../dragPreviewSource';

/**
 * Drag-ghost controller (#mem drag latency). Locks the behaviour that replaces
 * the async ghost-overshoot pipeline:
 *   - the CUSTOM path drives the preview with a single shader-uniform write +
 *     triggerRepaint and touches NO GeoJSON source / worker (the overshoot fix);
 *   - it falls back to the STOCK GeoJSON preview per-drag when the custom layer
 *     cannot initialize, and mid-drag when it self-disables on a GL error, so the
 *     user is never left without a preview.
 *
 * The custom ghost GL layer is mocked (no WebGL in node); the stock path runs the
 * REAL dragPreviewLayers + GhostFollow against a fake map that records sources,
 * layers, setData, and sourcedata listeners.
 */
const h = vi.hoisted(() => {
  const layerState = { disabledAfterAdd: false, last: null as FakeGhostLayer | null };

  class FakeGhostLayer {
    readonly id: string;
    readonly type = 'custom' as const;
    onSelfDisable: ((reason: string) => void) | null;
    private disabled: boolean;
    setOffsetCalls: Array<[number, number]> = [];

    constructor(id: string, _data: unknown, onSelfDisable: ((reason: string) => void) | null = null) {
      this.id = id;
      this.onSelfDisable = onSelfDisable;
      this.disabled = layerState.disabledAfterAdd;
      layerState.last = this;
    }
    isDisabled(): boolean {
      return this.disabled;
    }
    getDisabledReason(): string | null {
      return this.disabled ? 'program-link-failed' : null;
    }
    setOffset(dx: number, dy: number): void {
      this.setOffsetCalls.push([dx, dy]);
    }
  }

  return { layerState, FakeGhostLayer };
});

vi.mock('../customRender/surveyGhostLayer', () => ({ SurveyGhostLayer: h.FakeGhostLayer }));

import { DragGhostController, type DragGhostOptions } from '../dragGhostController';
import type { GhostRenderData } from '../customRender/surveyGhostLayer';

const GHOST_ID = 'survey-drag-ghost';

interface FakeMap {
  map: MaplibreMap;
  sources: Set<string>;
  layers: Set<string>;
  setDataCount: number;
  translateCount: number;
  repaintCount: number;
  sourcedataListeners: Array<(e: unknown) => void>;
}

function makeFakeMap(): FakeMap {
  const sources = new Set<string>();
  const layers = new Set<string>();
  const sourcedataListeners: Array<(e: unknown) => void> = [];
  const state = { setDataCount: 0, translateCount: 0, repaintCount: 0 };
  const map = {
    addSource: (id: string) => sources.add(id),
    getSource: (id: string) =>
      sources.has(id) ? { setData: () => { state.setDataCount++; } } : undefined,
    removeSource: (id: string) => sources.delete(id),
    addLayer: (layer: { id: string }) => layers.add(layer.id),
    getLayer: (id: string) => (layers.has(id) ? { id } : undefined),
    removeLayer: (id: string) => layers.delete(id),
    setPaintProperty: () => { state.translateCount++; },
    isSourceLoaded: () => true,
    triggerRepaint: () => { state.repaintCount++; },
    on: (_type: string, fn: (e: unknown) => void) => sourcedataListeners.push(fn),
    off: (_type: string, fn: (e: unknown) => void) => {
      const i = sourcedataListeners.indexOf(fn);
      if (i >= 0) sourcedataListeners.splice(i, 1);
    },
  } as unknown as MaplibreMap;
  return {
    map, sources, layers, sourcedataListeners,
    get setDataCount() { return state.setDataCount; },
    get translateCount() { return state.translateCount; },
    get repaintCount() { return state.repaintCount; },
  };
}

const SET: DragPreviewSet = {
  features: [
    { emit: 'point', coords: [[0, 0]], movingEnd: 'uniform', properties: { kind: 'station', color: '#00ff00' } },
    { emit: 'line', coords: [[0, 0], [1, 1]], movingEnd: 'uniform', properties: { kind: 'shot', color: '#ff0000' } },
  ],
};

const STUB_DATA = { anchorX: 0, anchorY: 0 } as unknown as GhostRenderData;

function makeOptions(over: Partial<DragGhostOptions> = {}): DragGhostOptions {
  return {
    customActive: () => true,
    ghostData: () => STUB_DATA,
    layerCtx: () => ({ colorExpr: ['get', 'color'], shotWidth: 3, stationRadius: 5, selectHighlight: '#fff' }),
    projector: () => ({ project: ([lng, lat]) => ({ x: lng, y: lat }), unproject: ([x, y]) => ({ lng: x, lat: y }) }),
    dpr: () => 2,
    // Synchronous restore so the self-disable fallback is observable in-test.
    scheduleRestore: (fn) => fn(),
    ...over,
  };
}

beforeEach(() => {
  h.layerState.disabledAfterAdd = false;
  h.layerState.last = null;
});
afterEach(() => vi.clearAllMocks());

describe('custom path: synchronous, no GeoJSON source / worker', () => {
  it('begins custom, drives the offset by uniform, and never touches the stock preview', () => {
    const fake = makeFakeMap();
    const ctrl = new DragGhostController(fake.map, makeOptions());
    expect(ctrl.begin(SET)).toBe('custom');
    expect(ctrl.isCustom()).toBe(true);
    expect(fake.layers.has(GHOST_ID)).toBe(true);
    // No stock ghost source / layers created, no setData.
    expect(fake.sources.has(DRAG_PREVIEW_SOURCE)).toBe(false);
    expect(fake.setDataCount).toBe(0);

    ctrl.move(30, -12);
    // dpr=2 -> device px offset; one repaint, still no setData/source.
    const calls = h.layerState.last!.setOffsetCalls;
    expect(calls[calls.length - 1]).toEqual([60, -24]);
    expect(fake.repaintCount).toBeGreaterThan(0);
    expect(fake.setDataCount).toBe(0);
    expect(fake.sources.has(DRAG_PREVIEW_SOURCE)).toBe(false);

    ctrl.end();
    expect(fake.layers.has(GHOST_ID)).toBe(false);
  });
});

describe('per-drag fallback: custom layer fails to initialize', () => {
  it('drops the dead layer and uses the stock GeoJSON preview', () => {
    h.layerState.disabledAfterAdd = true;
    const fake = makeFakeMap();
    const ctrl = new DragGhostController(fake.map, makeOptions());
    expect(ctrl.begin(SET)).toBe('stock');
    expect(ctrl.isCustom()).toBe(false);
    // Dead custom layer removed; stock source created + one bake@0 setData.
    expect(fake.layers.has(GHOST_ID)).toBe(false);
    expect(fake.sources.has(DRAG_PREVIEW_SOURCE)).toBe(true);
    expect(fake.setDataCount).toBe(1);

    // A move past the rebake threshold, once the @0 bake lands, re-bakes (setData).
    ctrl.move(200, 0);
    fake.sourcedataListeners.forEach((fn) => fn({ sourceId: DRAG_PREVIEW_SOURCE }));
    expect(fake.setDataCount).toBeGreaterThan(1);
    expect(fake.translateCount).toBeGreaterThan(0);
    ctrl.end();
    expect(fake.sources.has(DRAG_PREVIEW_SOURCE)).toBe(false);
  });
});

describe('stock path chosen when bulk geometry is not custom-rendered', () => {
  it('never adds the custom layer', () => {
    const fake = makeFakeMap();
    const ctrl = new DragGhostController(fake.map, makeOptions({ customActive: () => false }));
    expect(ctrl.begin(SET)).toBe('stock');
    expect(fake.layers.has(GHOST_ID)).toBe(false);
    expect(fake.sources.has(DRAG_PREVIEW_SOURCE)).toBe(true);
  });
});

describe('mid-drag self-disable falls back to stock at the live offset', () => {
  it('removes the disabled custom layer and spins up the stock ghost', () => {
    const fake = makeFakeMap();
    const ctrl = new DragGhostController(fake.map, makeOptions());
    expect(ctrl.begin(SET)).toBe('custom');
    ctrl.move(120, 40); // live offset the fallback must replay
    expect(fake.sources.has(DRAG_PREVIEW_SOURCE)).toBe(false);

    // The GL layer self-disables mid-render; scheduleRestore runs synchronously.
    h.layerState.last!.onSelfDisable!('gl-error-0x505');
    expect(ctrl.isCustom()).toBe(false);
    expect(fake.layers.has(GHOST_ID)).toBe(false);
    // Stock ghost now standing in, baked (the @0 start bake + the live-offset replay).
    expect(fake.sources.has(DRAG_PREVIEW_SOURCE)).toBe(true);
    expect(fake.setDataCount).toBeGreaterThan(0);
    ctrl.end();
  });
});
