import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';
import {
  emptySurveyData,
  STATION_FLAG_IS_ZERO_DATUM,
  type SurveyData,
} from '../../../../../types/survey-data';
import { SurveyCustomController, type CustomSyncParams } from '../controller';

/**
 * Controller fail-safe tests (#customRender). The GL layer is replaced with a
 * scriptable fake so we can drive the two failure modes the hardening added:
 *  - onAdd disabled itself  -> stock layers must stay visible, dead layer removed
 *  - GL error mid-render     -> deferred restore of stock-layer visibility
 * The pure buffer build (tessellate/mercator/colorPack/features) runs for real.
 */

// Shared, hoisted state so the mocked module + the test body see the same object.
const h = vi.hoisted(() => {
  const layerState = {
    disabledAfterAdd: false,
    disabledReason: 'program-link-failed' as string,
    last: null as FakeLayer | null,
  };
  const gate = { enabled: true };

  class FakeLayer {
    readonly id: string;
    data: unknown;
    onSelfDisable: ((reason: string) => void) | null;
    private disabled = false;
    private reason: string | null = null;

    constructor(id: string, data: unknown, onSelfDisable: ((reason: string) => void) | null = null) {
      this.id = id;
      this.data = data;
      this.onSelfDisable = onSelfDisable;
      layerState.last = this;
    }

    /** Modelled after MapLibre calling onAdd inside addLayer(). */
    onAdd(): void {
      if (layerState.disabledAfterAdd) {
        this.disabled = true;
        this.reason = layerState.disabledReason;
      }
    }

    isDisabled(): boolean {
      return this.disabled;
    }

    getDisabledReason(): string | null {
      return this.reason;
    }

    update(data: unknown): void {
      this.data = data;
    }
  }

  return { layerState, gate, FakeLayer };
});

vi.mock('../surveyCustomLayer', () => ({ SurveyCustomLayer: h.FakeLayer }));
vi.mock('../gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gate')>();
  return { ...actual, readCustomRenderGate: () => h.gate.enabled };
});

const STOCK = ['survey-shots', 'survey-shot-gradients', 'survey-stations'] as const;
const CUSTOM_ID = 'survey-custom-render';

interface FakeMap {
  map: MaplibreMap;
  visibility: Record<string, string>;
  removed: string[];
}

function makeFakeMap(): FakeMap {
  const existing = new Set<string>([...STOCK]);
  const visibility: Record<string, string> = {
    'survey-shots': 'visible',
    'survey-shot-gradients': 'visible',
    'survey-stations': 'visible',
  };
  const removed: string[] = [];
  const map = {
    getStyle: () => ({}),
    getLayer: (id: string) => (existing.has(id) ? { id } : undefined),
    addLayer: (layer: { id: string; onAdd?: (m: unknown, gl: unknown) => void }) => {
      existing.add(layer.id);
      layer.onAdd?.(map, {});
    },
    removeLayer: (id: string) => {
      existing.delete(id);
      removed.push(id);
    },
    setLayoutProperty: (id: string, prop: string, v: string) => {
      if (prop === 'visibility') visibility[id] = v;
    },
    triggerRepaint: () => {},
  } as unknown as MaplibreMap;
  return { map, visibility, removed };
}

/** Two-section fixture identical in shape to the tessellation suite's. */
function makeFixture(): SurveyData {
  const d = emptySurveyData();
  d.sections = [
    { id: 1, name: 'A', surveyor: null, date: null, color: '#ff0000', direction: 'in' as never, quality: 0, next_shot_id: 2, shotOffset: 0, shotCount: 2 },
    { id: 2, name: 'B', surveyor: null, date: null, color: '#00ff00', direction: 'in' as never, quality: 0, next_shot_id: 1, shotOffset: 2, shotCount: 1 },
  ];
  d.shotCount = 3;
  d.shotIds = new Int32Array([0, 1, 0]);
  d.shotSectionIds = new Int32Array([1, 1, 2]);
  d.shotFlags = new Uint8Array([0, 0, 0]);
  d.stationCount = 4;
  d.stationSectionIds = new Int32Array([1, 1, 1, 2]);
  d.stationIndices = new Uint32Array([0, 1, 2, 0]);
  d.stationCoords = new Float64Array([0, 0, 0, 10, 0, -1, 10, 10, -2, 100, 100, 0]);
  d.stationFlags = new Uint8Array([STATION_FLAG_IS_ZERO_DATUM, 0, 0, 0]);
  return d;
}

function makeParams(): CustomSyncParams {
  const themeColors = {
    stationDefault: '#ffffff',
    zeroDatum: '#00ffff',
    strokeColor: '#000000',
    depthShallow: '#0000ff',
    depthDeep: '#ff0000',
    severityError: '#ff0000',
    severityWarning: '#ffff00',
    severityClear: '#00000000',
  };
  const colorCtx = {
    showDepthGradient: false,
    showIssueSeverity: false,
    depthRange: { min: 0, max: 1 },
    themeColors,
  } as unknown as CustomSyncParams['colorCtx'];
  return {
    surveyData: makeFixture(),
    gpsOrigin: null,
    colorCtx,
    shotWidthPx: 2,
    stationRadiusPx: 3,
    stationStrokePx: 1,
  };
}

describe('SurveyCustomController fail-safe visibility', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.layerState.disabledAfterAdd = false;
    h.layerState.disabledReason = 'program-link-failed';
    h.layerState.last = null;
    h.gate.enabled = true;
    vi.spyOn(console, 'info').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it('hides stock layers when the custom layer initializes cleanly', () => {
    const { map, visibility, removed } = makeFakeMap();
    const c = new SurveyCustomController(map);
    c.sync(makeParams());
    for (const id of STOCK) expect(visibility[id]).toBe('none');
    expect(removed).not.toContain(CUSTOM_ID);
    expect(warn).not.toHaveBeenCalled();
  });

  it('onAdd-disabled: keeps stock layers visible and removes the dead layer', () => {
    h.layerState.disabledAfterAdd = true;
    h.layerState.disabledReason = 'webgl2-unavailable';
    const { map, visibility, removed } = makeFakeMap();
    const c = new SurveyCustomController(map);
    c.sync(makeParams());
    // Fail-safe: stock survey stays on screen, dead custom layer removed.
    for (const id of STOCK) expect(visibility[id]).toBe('visible');
    expect(removed).toContain(CUSTOM_ID);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('webgl2-unavailable');
  });

  it('render-error callback restores stock visibility, deferred off the render stack', () => {
    // Object holder (not a bare `let`) so TS control-flow doesn't narrow away
    // the deferred assignment; also lets us count how often it was scheduled.
    const holder: { fn: (() => void) | null; scheduled: number } = { fn: null, scheduled: 0 };
    const { map, visibility, removed } = makeFakeMap();
    const c = new SurveyCustomController(map, undefined, {
      scheduleRestore: (fn) => {
        holder.fn = fn;
        holder.scheduled += 1;
      },
    });
    c.sync(makeParams());
    for (const id of STOCK) expect(visibility[id]).toBe('none'); // enabled

    const layer = h.layerState.last;
    expect(layer).not.toBeNull();
    // Simulate the layer self-disabling mid-render.
    layer?.onSelfDisable?.('gl-error-0x502');
    // Deferred: visibility NOT yet restored (must not mutate style mid-render).
    for (const id of STOCK) expect(visibility[id]).toBe('none');
    const lastWarn = warn.mock.calls[warn.mock.calls.length - 1];
    expect(lastWarn?.[0]).toContain('self-disabled (gl-error-0x502)');

    // A second self-disable before the restore runs is coalesced (re-entrancy).
    layer?.onSelfDisable?.('gl-error-0x502');
    expect(holder.scheduled).toBe(1);

    expect(holder.fn).not.toBeNull();
    holder.fn?.();
    for (const id of STOCK) expect(visibility[id]).toBe('visible');
    expect(removed).toEqual([CUSTOM_ID]); // torn down exactly once
  });

  it('sync hook prefers a fresh-geometry resync over the stale snapshot', () => {
    // Regression (#customRender): replaying the cached `lastParams` after a
    // project switch stranded the custom layer on the previous project's
    // geometry (store 502 shots, custom stuck at 420). The hook must call the
    // injected resync (which reads current store geometry) and NOT replay.
    const { map } = makeFakeMap();
    const resync = vi.fn();
    const c = new SurveyCustomController(map, undefined, { resync });
    c.sync(makeParams()); // populates lastParams with this snapshot
    const syncSpy = vi.spyOn(c, 'sync');
    (c as unknown as { runSyncHook(): void }).runSyncHook();
    expect(resync).toHaveBeenCalledOnce();
    expect(syncSpy).not.toHaveBeenCalled();
  });

  it('sync hook falls back to the cached snapshot when no resync is wired', () => {
    const { map } = makeFakeMap();
    const c = new SurveyCustomController(map);
    const params = makeParams();
    c.sync(params);
    const syncSpy = vi.spyOn(c, 'sync');
    (c as unknown as { runSyncHook(): void }).runSyncHook();
    expect(syncSpy).toHaveBeenCalledOnce();
    expect(syncSpy.mock.calls[0]?.[0]).toBe(params);
  });

  it('restores stock layers when the gate flips off', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { map, visibility } = makeFakeMap();
    const c = new SurveyCustomController(map);
    c.sync(makeParams());
    for (const id of STOCK) expect(visibility[id]).toBe('none');
    h.gate.enabled = false;
    c.sync(makeParams());
    for (const id of STOCK) expect(visibility[id]).toBe('visible');
    expect(info.mock.calls.some((cl) => String(cl[0]).includes('disabled'))).toBe(true);
  });
});
