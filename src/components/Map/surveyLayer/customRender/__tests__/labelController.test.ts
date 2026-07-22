import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { emptySurveyData, STATION_FLAG_IS_ZERO_DATUM, type SurveyData } from '../../../../../types/survey-data';
import type { MapThemeColors } from '../../../../../utils/themeColors';
import { GlyphAtlas } from '../glyphAtlas';
import { LABEL_KIND } from '../labelShaders';
import { SurveyLabelController, type LabelSyncParams } from '../labelController';

/**
 * Label controller (#customRender labels, Phase 2). Same fake-GL idiom as
 * `controller.test.ts`: the label GL layer + both gate modules are mocked, and a
 * real (inert) `GlyphAtlas` is injected so the pure build runs with no font /
 * canvas. Covers the composed gate, fail-safe stock-label restore, and the
 * station-toggle / theme / reference wiring into the shader-uniform inputs.
 */
const h = vi.hoisted(() => {
  const gate = { render: true, labels: true };
  const layerState = {
    disabledAfterAdd: false,
    disabledReason: 'program-link-failed' as string,
    last: null as FakeLabelLayer | null,
  };

  class FakeLabelLayer {
    readonly id: string;
    data: unknown;
    onSelfDisable: ((reason: string) => void) | null;
    private disabled = false;
    private reason: string | null = null;
    updateCalls = 0;
    styleCalls = 0;
    lastStyle: { kindEnabled: boolean[]; haloColors: unknown[]; hideReference: boolean } | null = null;

    constructor(id: string, data: unknown, onSelfDisable: ((reason: string) => void) | null = null) {
      this.id = id;
      this.data = data;
      this.onSelfDisable = onSelfDisable;
      layerState.last = this;
    }
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
      this.updateCalls++;
    }
    setStyleInputs(style: { kindEnabled: boolean[]; haloColors: unknown[]; hideReference: boolean }): void {
      this.lastStyle = style;
      this.styleCalls++;
    }
  }

  return { gate, layerState, FakeLabelLayer };
});

vi.mock('../surveyCustomLabelLayer', () => ({ SurveyCustomLabelLayer: h.FakeLabelLayer }));
vi.mock('../gate', async (orig) => {
  const actual = await orig<typeof import('../gate')>();
  return { ...actual, readCustomRenderGate: () => h.gate.render };
});
vi.mock('../labelsGate', async (orig) => {
  const actual = await orig<typeof import('../labelsGate')>();
  return { ...actual, readCustomLabelsGate: () => h.gate.labels };
});

const STOCK_LABEL = 'survey-station-labels';
const CUSTOM_ID = 'survey-custom-labels';

interface FakeMap {
  map: MaplibreMap;
  visibility: Record<string, string>;
  removed: string[];
}

function makeFakeMap(): FakeMap {
  const existing = new Set<string>([STOCK_LABEL]);
  const visibility: Record<string, string> = { [STOCK_LABEL]: 'visible' };
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

const THEME = { textHalo: '#111111', textHaloAlt: '#222222', depthShallow: '#00bfff', depthDeep: '#ff4444', labelColor: '#eeeeee' } as unknown as MapThemeColors;

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

function makeParams(): LabelSyncParams {
  return {
    surveyData: makeFixture(),
    gpsOrigin: null,
    themeColors: THEME,
    showDepthGradient: false,
    depthRange: { min: 0, max: 1 },
    precision: undefined,
  };
}

/** Controller with an injected inert atlas (no async font load). */
function makeController(map: MaplibreMap, opts: Record<string, unknown> = {}): SurveyLabelController {
  return new SurveyLabelController(map, undefined, { atlas: new GlyphAtlas(), ...opts });
}

describe('SurveyLabelController gate composition', () => {
  beforeEach(() => {
    h.layerState.disabledAfterAdd = false;
    h.layerState.last = null;
    h.gate.render = true;
    h.gate.labels = true;
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('activates and hides the stock station-labels layer when BOTH gates are on', () => {
    const { map, visibility } = makeFakeMap();
    const c = makeController(map);
    c.sync(makeParams());
    expect(c.isActive()).toBe(true);
    expect(visibility[STOCK_LABEL]).toBe('none');
  });

  it('stays inactive when only the geometry gate is on (labels gate off)', () => {
    h.gate.labels = false;
    const { map, visibility } = makeFakeMap();
    const c = makeController(map);
    c.sync(makeParams());
    expect(c.isActive()).toBe(false);
    expect(visibility[STOCK_LABEL]).toBe('visible');
  });

  it('stays inactive when only the labels gate is on (geometry gate off)', () => {
    h.gate.render = false;
    const { map, visibility } = makeFakeMap();
    const c = makeController(map);
    c.sync(makeParams());
    expect(c.isActive()).toBe(false);
    expect(visibility[STOCK_LABEL]).toBe('visible');
  });

  it('restores the stock station-labels layer to the desired toggle state when a gate flips off', () => {
    const { map, visibility } = makeFakeMap();
    const c = makeController(map);
    c.setStationLabelsVisible(true); // desired: visible
    c.sync(makeParams());
    expect(visibility[STOCK_LABEL]).toBe('none'); // suppressed while active
    h.gate.labels = false;
    c.sync(makeParams());
    expect(c.isActive()).toBe(false);
    expect(visibility[STOCK_LABEL]).toBe('visible'); // restored to desired
  });
});

describe('SurveyLabelController fail-safe', () => {
  beforeEach(() => {
    h.layerState.disabledAfterAdd = false;
    h.layerState.disabledReason = 'program-link-failed';
    h.layerState.last = null;
    h.gate.render = true;
    h.gate.labels = true;
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('onAdd-disabled: keeps stock labels at the desired state and removes the dead layer', () => {
    h.layerState.disabledAfterAdd = true;
    h.layerState.disabledReason = 'webgl2-unavailable';
    const { map, visibility, removed } = makeFakeMap();
    const c = makeController(map);
    c.setStationLabelsVisible(true); // desired visible so restore keeps them on
    c.sync(makeParams());
    expect(c.isActive()).toBe(false);
    expect(visibility[STOCK_LABEL]).toBe('visible');
    expect(removed).toContain(CUSTOM_ID);
  });

  it('render-error self-disable restores stock labels, deferred off the render stack', () => {
    const holder: { fn: (() => void) | null; scheduled: number } = { fn: null, scheduled: 0 };
    const { map, visibility, removed } = makeFakeMap();
    const c = makeController(map, {
      scheduleRestore: (fn: () => void) => {
        holder.fn = fn;
        holder.scheduled += 1;
      },
    });
    c.setStationLabelsVisible(true);
    c.sync(makeParams());
    expect(visibility[STOCK_LABEL]).toBe('none');

    const layer = h.layerState.last;
    layer?.onSelfDisable?.('gl-error-0x502');
    // Deferred: not restored yet (must not mutate style mid-render).
    expect(visibility[STOCK_LABEL]).toBe('none');
    // A second self-disable before the restore runs is coalesced.
    layer?.onSelfDisable?.('gl-error-0x502');
    expect(holder.scheduled).toBe(1);

    holder.fn?.();
    expect(visibility[STOCK_LABEL]).toBe('visible');
    expect(removed).toEqual([CUSTOM_ID]);
    expect(c.isActive()).toBe(false);
  });
});

describe('SurveyLabelController style wiring', () => {
  beforeEach(() => {
    h.layerState.disabledAfterAdd = false;
    h.layerState.last = null;
    h.gate.render = true;
    h.gate.labels = true;
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('drives the station-label kind visibility via the style inputs (no rebuild), stock stays suppressed', () => {
    const { map, visibility } = makeFakeMap();
    const c = makeController(map);
    c.sync(makeParams());
    const layer = h.layerState.last!;
    const updatesBefore = layer.updateCalls;

    c.setStationLabelsVisible(true);
    expect(layer.lastStyle?.kindEnabled[LABEL_KIND.STATION_LABEL]).toBe(true);
    c.setStationLabelsVisible(false);
    expect(layer.lastStyle?.kindEnabled[LABEL_KIND.STATION_LABEL]).toBe(false);
    // A toggle is a uniform flip, not a buffer rebuild.
    expect(layer.updateCalls).toBe(updatesBefore);
    // Stock station labels never un-hide while active.
    expect(visibility[STOCK_LABEL]).toBe('none');
  });

  it('resolves theme halo colors into the style inputs on build', () => {
    const { map } = makeFakeMap();
    const c = makeController(map);
    c.sync(makeParams());
    const layer = h.layerState.last!;
    // Station labels use textHaloAlt (#222222) -> non-empty resolved halo set.
    expect(layer.lastStyle?.haloColors.length).toBeGreaterThan(0);
  });

  it('flips the reference-hide input when reference shots are hidden', () => {
    const { map } = makeFakeMap();
    const c = makeController(map);
    c.sync(makeParams());
    const layer = h.layerState.last!;
    expect(layer.lastStyle?.hideReference).toBe(false);
    c.setReferenceShotsVisible(false);
    expect(layer.lastStyle?.hideReference).toBe(true);
  });
});

describe('SurveyLabelController font readiness', () => {
  beforeEach(() => {
    h.layerState.disabledAfterAdd = false;
    h.layerState.last = null;
    h.gate.render = true;
    h.gate.labels = true;
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('defers the first build until the font resolves, then builds + activates', async () => {
    const { map, visibility } = makeFakeMap();
    // No injected atlas: the async font path runs (resolves false -> inert atlas).
    const c = new SurveyLabelController(map, undefined, {
      ensureFont: () => Promise.resolve(false),
      makeRasterizer: () => null,
    });
    c.sync(makeParams());
    // Font not resolved yet: nothing built.
    expect(c.isActive()).toBe(false);
    expect(visibility[STOCK_LABEL]).toBe('visible');
    // Flush the ensureFont().then(...) microtask chain.
    await Promise.resolve();
    await Promise.resolve();
    expect(c.isActive()).toBe(true);
    expect(visibility[STOCK_LABEL]).toBe('none');
  });
});

describe('SurveyLabelController teardown', () => {
  beforeEach(() => {
    h.layerState.disabledAfterAdd = false;
    h.layerState.last = null;
    h.gate.render = true;
    h.gate.labels = true;
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('destroy() removes the layer and restores the stock label visibility', () => {
    const { map, visibility, removed } = makeFakeMap();
    const c = makeController(map);
    c.setStationLabelsVisible(true);
    c.sync(makeParams());
    expect(visibility[STOCK_LABEL]).toBe('none');
    c.destroy();
    expect(removed).toContain(CUSTOM_ID);
    expect(visibility[STOCK_LABEL]).toBe('visible');
  });
});
