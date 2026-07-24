import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';
import {
  emptySurveyData,
  STATION_FLAG_IS_ZERO_DATUM,
  type SurveyData,
} from '../../../../../types/survey-data';
import { SurveyCustomController, type CustomSyncParams } from '../controller';
import { CUSTOM_RENDER_SYNC_HOOK } from '../gate';

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

    updateCalls = 0;
    update(data: unknown): void {
      this.data = data;
      this.updateCalls++;
    }

    // Display toggles the controller re-applies on enable + on setShow* calls.
    shotsVisible = true;
    stationsVisible = true;
    referenceShotsVisible = true;
    setShotsVisible(v: boolean): void {
      this.shotsVisible = v;
    }
    setStationsVisible(v: boolean): void {
      this.stationsVisible = v;
    }
    setReferenceShotsVisible(v: boolean): void {
      this.referenceShotsVisible = v;
    }

    // Buffer sub-uploads the controller's incremental / color-only fast paths
    // call; the fake just records that they ran (no GL).
    updateColorsCalls = 0;
    updateColors(): void {
      this.updateColorsCalls++;
    }
    updateDim(): void {}
    updateHide(): void {}
    updateHighlight(): void {}
    uploadCalls = 0;
    uploadLineVertexRange(): void {
      this.uploadCalls++;
    }
    uploadCircleVertexRange(): void {
      this.uploadCalls++;
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

  it('propagates visibility toggles to the layer and persists them across re-enable', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { map } = makeFakeMap();
    const c = new SurveyCustomController(map);
    c.sync(makeParams());
    const layer1 = h.layerState.last;
    expect(layer1).not.toBeNull();

    // Toggles reach the live layer.
    c.setShotsVisible(false);
    c.setStationsVisible(false);
    c.setReferenceShotsVisible(false);
    expect(layer1?.shotsVisible).toBe(false);
    expect(layer1?.stationsVisible).toBe(false);
    expect(layer1?.referenceShotsVisible).toBe(false);

    // Re-enable (gate off then on) builds a FRESH layer; the stored toggles
    // must be re-applied so a re-create never silently shows hidden geometry.
    h.gate.enabled = false;
    c.sync(makeParams());
    h.gate.enabled = true;
    c.sync(makeParams());
    const layer2 = h.layerState.last;
    expect(layer2).not.toBe(layer1);
    expect(layer2?.shotsVisible).toBe(false);
    expect(layer2?.stationsVisible).toBe(false);
    expect(layer2?.referenceShotsVisible).toBe(false);
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

  it('restores stock layers to their REQUESTED visibility, not blindly visible', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { map, visibility } = makeFakeMap();
    const c = new SurveyCustomController(map);
    c.setShotsVisible(false); // user hid shots before the custom layer built
    c.sync(makeParams());
    for (const id of STOCK) expect(visibility[id]).toBe('none'); // suppressed while active
    // Gate off -> teardown restores. Shots (and their gradients) must stay hidden
    // per the stored toggle; stations, never hidden, come back visible.
    h.gate.enabled = false;
    c.sync(makeParams());
    expect(visibility['survey-shots']).toBe('none');
    expect(visibility['survey-shot-gradients']).toBe('none'); // follows the shots toggle
    expect(visibility['survey-stations']).toBe('visible');
  });
});

describe('SurveyCustomController dispose (unmount-lite hook + cache release)', () => {
  // The controller installs its window sync hook only when `window` is defined;
  // the node test env has none, so stub a bare window per test and restore it.
  const realWindow = (globalThis as unknown as { window?: unknown }).window;
  beforeEach(() => {
    h.layerState.disabledAfterAdd = false;
    h.layerState.last = null;
    h.gate.enabled = true;
    (globalThis as unknown as { window: unknown }).window = {};
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (realWindow === undefined) delete (globalThis as unknown as { window?: unknown }).window;
    else (globalThis as unknown as { window: unknown }).window = realWindow;
  });

  it('dispose() removes the window sync hook and a later sync() is inert', () => {
    const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
    const { map, visibility } = makeFakeMap();
    const c = new SurveyCustomController(map);
    c.sync(makeParams());
    const layer = h.layerState.last!;
    expect(typeof win[CUSTOM_RENDER_SYNC_HOOK]).toBe('function'); // hook installed
    const updatesBefore = layer.updateCalls;

    c.dispose();
    expect(win[CUSTOM_RENDER_SYNC_HOOK]).toBeUndefined(); // hook removed
    // dispose() must NOT touch the map: stock stays suppressed (map.remove()
    // handles GL teardown), and a later sync() rebuilds nothing.
    for (const id of STOCK) expect(visibility[id]).toBe('none');
    c.sync(makeParams());
    expect(layer.updateCalls).toBe(updatesBefore); // inert: disposed guard bails
  });
});

describe('SurveyCustomController onActiveChange (stock-suppression signal)', () => {
  beforeEach(() => {
    h.layerState.disabledAfterAdd = false;
    h.layerState.disabledReason = 'program-link-failed';
    h.layerState.last = null;
    h.gate.enabled = true;
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('fires true when the custom layer starts drawing, once, and false on gate-off', () => {
    const calls: boolean[] = [];
    const { map } = makeFakeMap();
    const c = new SurveyCustomController(map, undefined, { onActiveChange: (a) => calls.push(a) });
    c.sync(makeParams());
    expect(calls).toEqual([true]);
    // A re-sync while still enabled is not a transition — must NOT re-fire.
    c.sync(makeParams());
    expect(calls).toEqual([true]);
    // Gate off -> the stock pipeline must be told to come back.
    h.gate.enabled = false;
    c.sync(makeParams());
    expect(calls).toEqual([true, false]);
  });

  it('does NOT fire true when the custom layer fails to initialize (stock must stay)', () => {
    h.layerState.disabledAfterAdd = true;
    h.layerState.disabledReason = 'webgl2-unavailable';
    const calls: boolean[] = [];
    const { map } = makeFakeMap();
    const c = new SurveyCustomController(map, undefined, { onActiveChange: (a) => calls.push(a) });
    c.sync(makeParams());
    // active never became true, so no suppression signal — stock keeps publishing.
    expect(calls).toEqual([]);
  });

  it('fires false after a deferred fail-safe self-disable (re-publish trigger)', () => {
    const holder: { fn: (() => void) | null } = { fn: null };
    const calls: boolean[] = [];
    const { map } = makeFakeMap();
    const c = new SurveyCustomController(map, undefined, {
      onActiveChange: (a) => calls.push(a),
      scheduleRestore: (fn) => { holder.fn = fn; },
    });
    c.sync(makeParams());
    expect(calls).toEqual([true]);
    h.layerState.last?.onSelfDisable?.('gl-error-0x502');
    // Deferred: not yet restored, so no false yet.
    expect(calls).toEqual([true]);
    holder.fn?.();
    expect(calls).toEqual([true, false]);
  });

  it('fires false on destroy() when active', () => {
    const calls: boolean[] = [];
    const { map } = makeFakeMap();
    const c = new SurveyCustomController(map, undefined, { onActiveChange: (a) => calls.push(a) });
    c.sync(makeParams());
    c.destroy();
    expect(calls).toEqual([true, false]);
  });

  it('a re-entrant sync() during a fail-safe self-disable teardown does NOT re-enable', () => {
    // Mirrors production: the OFF signal drives a synchronous stock republish
    // that syncs the custom controller again. The gate is still ON here (a
    // GL-fault self-disable, NOT a gate opt-out), so without the tearingDown
    // guard this re-entrant sync() would see `!active` and re-enable the layer
    // that is being torn down (a flip-flop / infinite re-enable).
    const holder: { fn: (() => void) | null } = { fn: null };
    const calls: boolean[] = [];
    const { map } = makeFakeMap();
    let c!: SurveyCustomController;
    let layerPresentDuringOff: boolean | null = null;
    c = new SurveyCustomController(map, undefined, {
      onActiveChange: (a) => {
        calls.push(a);
        if (a === false) {
          // TEARDOWN ORDER: the OFF signal (stock republish) must fire while the
          // custom layer still exists, i.e. BEFORE removeLayer — otherwise the
          // survey blanks for a frame. Reverting the teardown to remove-first
          // flips this to false.
          layerPresentDuringOff = !!map.getLayer('survey-custom-render');
          c.sync(makeParams()); // re-entrant mirror-back
        }
      },
      scheduleRestore: (fn) => { holder.fn = fn; },
    });
    c.sync(makeParams());
    expect(calls).toEqual([true]);
    h.layerState.last?.onSelfDisable?.('gl-error-0x502');
    holder.fn?.(); // run the deferred teardown; onActiveChange(false) re-enters sync()
    // Gate is still on, yet the re-entrant sync must be a no-op: exactly
    // [true, false], never [true, false, true].
    expect(h.gate.enabled).toBe(true);
    expect(calls).toEqual([true, false]);
    // Reorder guard: stock came back before the custom layer was removed.
    expect(layerPresentDuringOff).toBe(true);
  });
});

describe('SurveyCustomController color-only fast path', () => {
  beforeEach(() => {
    h.layerState.disabledAfterAdd = false;
    h.layerState.last = null;
    h.gate.enabled = true;
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  // Shared geometry + themeColors refs so only the toggled color global differs
  // (mirrors production, where this.themeColors is a stable instance field).
  const scenario = () => {
    const themeColors = makeParams().colorCtx.themeColors;
    const surveyData = makeFixture();
    const base = { gpsOrigin: null, shotWidthPx: 2, stationRadiusPx: 3, stationStrokePx: 1 };
    const ctx = (over: Record<string, unknown>): CustomSyncParams['colorCtx'] =>
      ({ showDepthGradient: false, showIssueSeverity: false, depthRange: { min: 0, max: 1 }, themeColors, ...over }) as unknown as CustomSyncParams['colorCtx'];
    return { surveyData, base, ctx };
  };

  it('a pure color-global change re-uploads colors, no rebuild or layer re-create', () => {
    const { map } = makeFakeMap();
    const c = new SurveyCustomController(map);
    const { surveyData, base, ctx } = scenario();
    c.sync({ ...base, surveyData, colorCtx: ctx({}) });
    const layer = h.layerState.last!;
    expect(layer.updateColorsCalls).toBe(0);
    // Toggle depth gradient ON: same geometry + themeColors -> color-only path.
    c.sync({ ...base, surveyData, colorCtx: ctx({ showDepthGradient: true }) });
    expect(h.layerState.last).toBe(layer); // no re-create
    expect(layer.updateColorsCalls).toBe(1); // colors re-uploaded
    expect(layer.updateCalls).toBe(0); // NOT a full rebuild
    expect(layer.uploadCalls).toBe(0); // NOT the geometry-incremental path
  });

  it('a geometry edit with stable colors still takes the incremental path', () => {
    const { map } = makeFakeMap();
    const c = new SurveyCustomController(map);
    const { surveyData, base, ctx } = scenario();
    const color = ctx({});
    c.sync({ ...base, surveyData, colorCtx: color });
    const layer = h.layerState.last!;
    // Move a station (same colorCtx ref) -> geometry incremental, not color-only.
    const moved = makeFixture();
    moved.stationCoords[3] = 55; // station 1's x
    c.sync({ ...base, surveyData: moved, colorCtx: color });
    expect(layer.updateColorsCalls).toBe(0);
    expect(layer.updateCalls).toBe(0);
    expect(layer.uploadCalls).toBeGreaterThan(0);
  });

  it('a combined geometry + color change falls back to a full rebuild', () => {
    const { map } = makeFakeMap();
    const c = new SurveyCustomController(map);
    const { surveyData, base, ctx } = scenario();
    c.sync({ ...base, surveyData, colorCtx: ctx({}) });
    const layer = h.layerState.last!;
    const moved = makeFixture();
    moved.stationCoords[3] = 55;
    c.sync({ ...base, surveyData: moved, colorCtx: ctx({ showDepthGradient: true }) });
    expect(layer.updateColorsCalls).toBe(0);
    expect(layer.uploadCalls).toBe(0);
    expect(layer.updateCalls).toBe(1); // full rebuild via update()
  });
});
