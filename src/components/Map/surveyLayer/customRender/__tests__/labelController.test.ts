import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { emptySurveyData, STATION_FLAG_IS_ZERO_DATUM, type SurveyData } from '../../../../../types/survey-data';
import type { MapThemeColors } from '../../../../../utils/themeColors';
import { GlyphAtlas, SDF_BUFFER, type GlyphRasterizer, type RasterizedGlyph } from '../glyphAtlas';
import { LABEL_KIND } from '../labelShaders';
import type { LabelRenderData } from '../surveyCustomLabelLayer';
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
/** All five stock text layers, with the kind each maps to (SurveyLayer ids). */
const STOCK_LAYERS: Record<number, string> = {
  [LABEL_KIND.SHOT_LABEL]: 'survey-shot-labels',
  [LABEL_KIND.STATION_LABEL]: 'survey-station-labels',
  [LABEL_KIND.SECTION_NAME]: 'survey-labels',
  [LABEL_KIND.STATION_COMMENT]: 'survey-station-comments',
  [LABEL_KIND.SHOT_COMMENT]: 'survey-shot-comments',
};

interface FakeMap {
  map: MaplibreMap;
  visibility: Record<string, string>;
  removed: string[];
}

function makeFakeMap(): FakeMap {
  const existing = new Set<string>(Object.values(STOCK_LAYERS));
  // All five stock text layers start 'visible' in the fake (the controller sets
  // the real desired state); tests assert transitions from there.
  const visibility: Record<string, string> = {};
  for (const id of Object.values(STOCK_LAYERS)) visibility[id] = 'visible';
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

describe('SurveyLabelController all-kinds suppression + toggle routing', () => {
  beforeEach(() => {
    h.layerState.disabledAfterAdd = false;
    h.layerState.last = null;
    h.gate.render = true;
    h.gate.labels = true;
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('suppresses all five stock text layers on enable', () => {
    const { map, visibility } = makeFakeMap();
    const c = makeController(map);
    c.sync(makeParams());
    for (const id of Object.values(STOCK_LAYERS)) expect(visibility[id]).toBe('none');
  });

  it('restores each stock layer to its kind default on gate-off (section names visible, rest hidden)', () => {
    const { map, visibility } = makeFakeMap();
    const c = makeController(map);
    c.sync(makeParams());
    h.gate.labels = false;
    c.sync(makeParams());
    expect(visibility[STOCK_LAYERS[LABEL_KIND.SECTION_NAME]!]).toBe('visible'); // default on
    expect(visibility[STOCK_LAYERS[LABEL_KIND.SHOT_LABEL]!]).toBe('none');
    expect(visibility[STOCK_LAYERS[LABEL_KIND.STATION_LABEL]!]).toBe('none');
    expect(visibility[STOCK_LAYERS[LABEL_KIND.STATION_COMMENT]!]).toBe('none');
    expect(visibility[STOCK_LAYERS[LABEL_KIND.SHOT_COMMENT]!]).toBe('none');
  });

  it('routes every setShow* toggle to its kind uniform without a rebuild', () => {
    const { map } = makeFakeMap();
    const c = makeController(map);
    c.sync(makeParams());
    const layer = h.layerState.last!;
    const updatesBefore = layer.updateCalls;

    c.setShotLabelsVisible(true);
    expect(layer.lastStyle?.kindEnabled[LABEL_KIND.SHOT_LABEL]).toBe(true);
    c.setSectionNamesVisible(false);
    expect(layer.lastStyle?.kindEnabled[LABEL_KIND.SECTION_NAME]).toBe(false);
    c.setStationCommentsVisible(true);
    expect(layer.lastStyle?.kindEnabled[LABEL_KIND.STATION_COMMENT]).toBe(true);
    c.setShotCommentsVisible(true);
    expect(layer.lastStyle?.kindEnabled[LABEL_KIND.SHOT_COMMENT]).toBe(true);
    // Uniform flips, never a buffer rebuild.
    expect(layer.updateCalls).toBe(updatesBefore);
  });

  it('a commentTint sync builds without error (palette-tint parity locked in labelTessellate)', () => {
    const { map } = makeFakeMap();
    const c = makeController(map);
    c.sync({ ...makeParams(), commentTint: true });
    expect(c.isActive()).toBe(true);
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

// ─── Phase 4: viewport scoping + collision + camera-triggered rebuild ─────────

/** Fixed-metric fake atlas (one 10x18 quad per non-space char) so a build
 *  produces real glyphs — needed to inspect which KINDS the zoom gate built. */
function fakeGlyphAtlas(): GlyphAtlas {
  const raster: GlyphRasterizer = (c: string): RasterizedGlyph => {
    const empty = c === ' ';
    const w = empty ? 0 : 10;
    const h = empty ? 0 : 18;
    return {
      data: new Uint8Array(Math.max(0, w * h)),
      width: w,
      height: h,
      glyphWidth: Math.max(0, w - 2 * SDF_BUFFER),
      glyphHeight: Math.max(0, h - 2 * SDF_BUFFER),
      glyphTop: 15,
      glyphLeft: 1,
      glyphAdvance: empty ? 6 : 12,
    };
  };
  return new GlyphAtlas({ rasterizer: raster });
}

interface CameraMap extends FakeMap {
  state: { zoom: number; moving: boolean };
  fire: (type: string) => void;
}

/** Fake map with camera hooks (getZoom / getBounds / getCanvas / isMoving /
 *  on / off) so the Phase-4 zoom gate + viewport + camera-settle rebuild run. A
 *  wide bounds admits the whole fixture; `state` drives zoom + isMoving. */
function makeCameraMap(zoom = 18): CameraMap {
  const base = makeFakeMap();
  const state = { zoom, moving: false };
  const listeners = new Map<string, Set<() => void>>();
  const extra = {
    getZoom: () => state.zoom,
    isMoving: () => state.moving,
    getBounds: () => ({
      getWest: () => -0.01,
      getEast: () => 0.01,
      getNorth: () => 0.01,
      getSouth: () => -0.01,
    }),
    getCanvas: () => ({ clientWidth: 800, clientHeight: 600, width: 800, height: 600 }),
    on: (type: string, fn: () => void) => {
      const set = listeners.get(type) ?? new Set<() => void>();
      set.add(fn);
      listeners.set(type, set);
    },
    off: (type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn);
    },
  };
  Object.assign(base.map as unknown as Record<string, unknown>, extra);
  const fire = (type: string): void => {
    for (const fn of listeners.get(type) ?? []) fn();
  };
  return { ...base, state, fire };
}

/** The distinct label KINDS present in the last-built buffer (via a_kind). */
function builtKinds(layer: FakeLabelLayer): Set<number> {
  const data = layer.data as LabelRenderData;
  return new Set(Array.from(data.buffers.kind));
}

/** Deferred rebuild scheduler holder (drives coalescing tests). */
function rebuildHolder(): { fn: (() => void) | null; count: number; run: () => void } {
  const h2 = {
    fn: null as (() => void) | null,
    count: 0,
    run(): void {
      const f = h2.fn;
      h2.fn = null;
      f?.();
    },
  };
  return h2;
}

type FakeLabelLayer = NonNullable<typeof h.layerState.last>;

function cameraController(map: MaplibreMap, opts: Record<string, unknown> = {}): SurveyLabelController {
  return new SurveyLabelController(map, undefined, { atlas: fakeGlyphAtlas(), ...opts });
}

describe('SurveyLabelController zoom gate (viewport build set)', () => {
  beforeEach(() => {
    h.layerState.disabledAfterAdd = false;
    h.layerState.last = null;
    h.gate.render = true;
    h.gate.labels = true;
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('builds all kinds above the build zoom (13.5)', () => {
    const cam = makeCameraMap(18);
    const c = cameraController(cam.map);
    c.sync(makeParams());
    const kinds = builtKinds(h.layerState.last!);
    // Fixture has shot labels, station labels, section names (no comments).
    expect(kinds.has(LABEL_KIND.SHOT_LABEL)).toBe(true);
    expect(kinds.has(LABEL_KIND.STATION_LABEL)).toBe(true);
    expect(kinds.has(LABEL_KIND.SECTION_NAME)).toBe(true);
  });

  it('builds ONLY section names between section-minzoom (10) and the build band', () => {
    const cam = makeCameraMap(12);
    const c = cameraController(cam.map);
    c.sync(makeParams());
    expect(builtKinds(h.layerState.last!)).toEqual(new Set([LABEL_KIND.SECTION_NAME]));
  });

  it('builds nothing below section minzoom (10)', () => {
    const cam = makeCameraMap(8);
    const c = cameraController(cam.map);
    c.sync(makeParams());
    const data = h.layerState.last!.data as LabelRenderData;
    expect(data.buffers.glyphCount).toBe(0);
  });

  it('keeps the full label set on the way down through the hysteresis band [13, 13.5)', () => {
    const cam = makeCameraMap(18);
    const c = cameraController(cam.map);
    c.sync(makeParams()); // build full at 18
    cam.state.zoom = 13.2; // inside the band, still >= drop (13)
    c.sync(makeParams());
    // Hysteresis: already-built stays full (shot labels present at 13.2).
    expect(builtKinds(h.layerState.last!).has(LABEL_KIND.SHOT_LABEL)).toBe(true);
    // A FRESH controller at the same 13.2 builds section-only (below build 13.5).
    const fresh = cameraController(makeCameraMap(13.2).map);
    fresh.sync(makeParams());
    expect(builtKinds(h.layerState.last!)).toEqual(new Set([LABEL_KIND.SECTION_NAME]));
  });
});

describe('SurveyLabelController camera-settle rebuild', () => {
  beforeEach(() => {
    h.layerState.disabledAfterAdd = false;
    h.layerState.last = null;
    h.gate.render = true;
    h.gate.labels = true;
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('rebuilds the viewport on a camera settle (moveend)', () => {
    const cam = makeCameraMap(18);
    const c = cameraController(cam.map, { scheduleRebuild: (fn: () => void) => fn() });
    c.sync(makeParams());
    const layer = h.layerState.last!;
    const before = layer.updateCalls;
    cam.fire('moveend');
    expect(layer.updateCalls).toBe(before + 1);
  });

  it('coalesces a moveend + zoomend burst into a single rebuild', () => {
    const cam = makeCameraMap(18);
    const hold = rebuildHolder();
    const c = cameraController(cam.map, {
      scheduleRebuild: (fn: () => void) => {
        hold.fn = fn;
        hold.count++;
      },
    });
    c.sync(makeParams());
    const layer = h.layerState.last!;
    const before = layer.updateCalls;
    cam.fire('moveend');
    cam.fire('zoomend');
    // Only one rebuild was scheduled (the second event coalesced).
    expect(hold.count).toBe(1);
    hold.run();
    expect(layer.updateCalls).toBe(before + 1);
    // A later settle schedules a fresh rebuild.
    cam.fire('moveend');
    expect(hold.count).toBe(2);
  });

  it('never rebuilds mid-animation (isMoving) — waits for the next settle', () => {
    const cam = makeCameraMap(18);
    const hold = rebuildHolder();
    const c = cameraController(cam.map, {
      scheduleRebuild: (fn: () => void) => {
        hold.fn = fn;
      },
    });
    c.sync(makeParams());
    const layer = h.layerState.last!;
    const before = layer.updateCalls;
    cam.state.moving = true;
    cam.fire('moveend');
    hold.run(); // camera still animating → skip
    expect(layer.updateCalls).toBe(before);
    cam.state.moving = false;
    cam.fire('moveend');
    hold.run(); // settled → rebuild
    expect(layer.updateCalls).toBe(before + 1);
  });

  it('an edit sync() rebuilds synchronously (no scheduler)', () => {
    const cam = makeCameraMap(18);
    let scheduled = 0;
    const c = cameraController(cam.map, { scheduleRebuild: () => scheduled++ });
    c.sync(makeParams());
    const layer = h.layerState.last!;
    const before = layer.updateCalls;
    c.sync(makeParams()); // an edit re-sync
    expect(layer.updateCalls).toBe(before + 1);
    expect(scheduled).toBe(0); // the edit path never defers
  });

  it('does not rebuild after destroy (listeners removed)', () => {
    const cam = makeCameraMap(18);
    const c = cameraController(cam.map, { scheduleRebuild: (fn: () => void) => fn() });
    c.sync(makeParams());
    const layer = h.layerState.last!;
    c.destroy();
    const after = layer.updateCalls;
    expect(() => cam.fire('moveend')).not.toThrow();
    expect(layer.updateCalls).toBe(after);
  });
});
