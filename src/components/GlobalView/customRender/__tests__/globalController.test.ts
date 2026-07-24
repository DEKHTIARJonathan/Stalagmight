/**
 * Controller tests for the global view's custom render (#customRender). The GL
 * layer is a scriptable fake so the gating, fail-safe restore, active-state
 * callback (bulk-publish suppression signal), and geometry-based pick can be
 * exercised without a real WebGL context. The pure buffer build + hit index run
 * for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { ProjectMetadata } from '../../../../types/project';
import type { GeometryShot, SurveyGeometry } from '../../../../types/survey';
import type { SystemGeometry } from '../../systemColor';
import { GlobalCustomController } from '../globalController';
import type { ProjectFn } from '../globalHitIndex';

const h = vi.hoisted(() => {
  const layerState = {
    disabledAfterAdd: false,
    disabledReason: 'program-link-failed' as string,
    last: null as FakeLayer | null,
  };
  const gate = { enabled: true };

  class FakeLayer {
    readonly id: string;
    onSelfDisable: ((reason: string) => void) | null;
    private disabled = false;
    private reason: string | null = null;
    hoverSystem = -1;
    visible = true;
    referenceShotsVisible = true;

    constructor(id: string, _data: unknown, onSelfDisable: ((reason: string) => void) | null = null) {
      this.id = id;
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
    update(): void {}
    updateDim(): void {}
    updateSelected(): void {}
    setVisible(v: boolean): void {
      this.visible = v;
    }
    setReferenceShotsVisible(v: boolean): void {
      this.referenceShotsVisible = v;
    }
    setHoverSystem(i: number): void {
      this.hoverSystem = i;
    }
  }

  return { layerState, gate, FakeLayer };
});

vi.mock('../globalCustomLayer', () => ({ GlobalCustomLayer: h.FakeLayer }));
vi.mock('../../../Map/surveyLayer/customRender/gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../Map/surveyLayer/customRender/gate')>();
  return { ...actual, readCustomRenderGate: () => h.gate.enabled };
});

const STOCK = [
  'global-survey-shots-layer',
  'global-survey-stations-layer',
  'global-survey-shots-hitbox',
  'global-survey-stations-hitbox',
] as const;
const CUSTOM_ID = 'global-survey-custom';

function makeFakeMap(): { map: MaplibreMap; visibility: Record<string, string>; removed: string[] } {
  const existing = new Set<string>([...STOCK]);
  const visibility: Record<string, string> = {};
  for (const id of STOCK) visibility[id] = 'visible';
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
    project: ([lng, lat]: [number, number]) => ({ x: lng, y: lat }),
    triggerRepaint: () => {},
  } as unknown as MaplibreMap;
  return { map, visibility, removed };
}

function shot(from: [number, number], to: [number, number], isReference = false): GeometryShot {
  return { from, to, is_reference: isReference, section_id: 0 };
}

function makeSystems(): SystemGeometry[] {
  const metadata = (fp: string): ProjectMetadata => ({
    name: fp,
    location: null,
    file_path: fp,
    modified_at: '2026-01-01T00:00:00Z',
    section_count: 1,
    total_length: 100,
    station_count: 2,
    gps_center: [0, 0],
    gps_bounds: null,
    collab_enabled: false,
    is_remote: false,
  });
  const geometry = (shots: GeometryShot[]): SurveyGeometry => ({ shots, origin: [0, 0] });
  return [{ metadata: metadata('a.tml'), geometry: geometry([shot([0, 0], [10, 0])]) }];
}

const project: ProjectFn = ([lng, lat]) => ({ x: lng, y: lat });

describe('GlobalCustomController', () => {
  beforeEach(() => {
    h.layerState.disabledAfterAdd = false;
    h.layerState.disabledReason = 'program-link-failed';
    h.layerState.last = null;
    h.gate.enabled = true;
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('gate on: hides stock layers, fires onActiveChange(true), becomes active', () => {
    const { map, visibility, removed } = makeFakeMap();
    const active: boolean[] = [];
    const c = new GlobalCustomController(map, undefined, { onActiveChange: (a) => active.push(a) });
    c.sync(makeSystems());
    for (const id of STOCK) expect(visibility[id]).toBe('none');
    expect(removed).not.toContain(CUSTOM_ID);
    expect(c.isActive()).toBe(true);
    expect(active).toEqual([true]);
  });

  it('gate off: never activates, stock layers stay visible', () => {
    h.gate.enabled = false;
    const { map, visibility } = makeFakeMap();
    const c = new GlobalCustomController(map);
    c.sync(makeSystems());
    for (const id of STOCK) expect(visibility[id]).toBe('visible');
    expect(c.isActive()).toBe(false);
  });

  it('gate flip off after active: disables + fires onActiveChange(false), restores stock', () => {
    const { map, visibility } = makeFakeMap();
    const active: boolean[] = [];
    const c = new GlobalCustomController(map, undefined, { onActiveChange: (a) => active.push(a) });
    c.sync(makeSystems());
    h.gate.enabled = false;
    c.sync(makeSystems());
    for (const id of STOCK) expect(visibility[id]).toBe('visible');
    expect(c.isActive()).toBe(false);
    expect(active).toEqual([true, false]);
  });

  it('onAdd-disabled: keeps stock layers visible, removes the dead layer, stays inactive', () => {
    h.layerState.disabledAfterAdd = true;
    h.layerState.disabledReason = 'webgl2-unavailable';
    const { map, visibility, removed } = makeFakeMap();
    const active: boolean[] = [];
    const c = new GlobalCustomController(map, undefined, { onActiveChange: (a) => active.push(a) });
    c.sync(makeSystems());
    for (const id of STOCK) expect(visibility[id]).toBe('visible');
    expect(removed).toContain(CUSTOM_ID);
    expect(c.isActive()).toBe(false);
    expect(active).toEqual([]); // never fired true
  });

  it('self-disable restores stock visibility, deferred off the render stack', () => {
    const holder: { fn: (() => void) | null } = { fn: null };
    const { map, visibility } = makeFakeMap();
    const c = new GlobalCustomController(map, undefined, { scheduleRestore: (fn) => (holder.fn = fn) });
    c.sync(makeSystems());
    for (const id of STOCK) expect(visibility[id]).toBe('none');
    // Simulate a GL error mid-render.
    h.layerState.last!.onSelfDisable?.('gl-error-0x505');
    // Deferred: stock still hidden until the scheduled restore runs.
    for (const id of STOCK) expect(visibility[id]).toBe('none');
    holder.fn?.();
    for (const id of STOCK) expect(visibility[id]).toBe('visible');
    expect(c.isActive()).toBe(false);
  });

  it('pick resolves a system only while active + visible', () => {
    const { map } = makeFakeMap();
    const c = new GlobalCustomController(map);
    // Inactive -> null.
    expect(c.pick(project, 0, 0)).toBeNull();
    c.sync(makeSystems());
    expect(c.pick(project, 0, 0)?.systemId).toBe('a.tml');
    // Markers mode hides the survey -> no hits.
    c.setVisible(false);
    expect(c.pick(project, 0, 0)).toBeNull();
  });

  it('destroy() while active tears down silently (no onActiveChange(false) / republish)', () => {
    const { map } = makeFakeMap();
    const active: boolean[] = [];
    const c = new GlobalCustomController(map, undefined, { onActiveChange: (a) => active.push(a) });
    c.sync(makeSystems());
    expect(active).toEqual([true]);
    c.destroy();
    expect(c.isActive()).toBe(false);
    // No trailing false: GlobalSurveyLayer clears the registry + removes the map
    // right after, so a stock republish on exit would be wasted work.
    expect(active).toEqual([true]);
  });

  it('markers-only (setVisible false) restores stock layers to HIDDEN on gate-off, not blindly visible', () => {
    const { map, visibility } = makeFakeMap();
    const c = new GlobalCustomController(map);
    c.sync(makeSystems());
    for (const id of STOCK) expect(visibility[id]).toBe('none');
    // User switches to markers-only: the survey geometry is stored hidden.
    c.setVisible(false);
    // Gate flips off -> fallback restore. Hidden survey geometry must stay hidden
    // (matching pick() which returns no hits while !visible); otherwise it
    // reappears over the markers view and becomes interactive again.
    h.gate.enabled = false;
    c.sync(makeSystems());
    for (const id of STOCK) expect(visibility[id]).toBe('none');
    expect(c.isActive()).toBe(false);
  });

  it('self-disable in markers-only mode restores stock layers to HIDDEN', () => {
    const holder: { fn: (() => void) | null } = { fn: null };
    const { map, visibility } = makeFakeMap();
    const c = new GlobalCustomController(map, undefined, { scheduleRestore: (fn) => (holder.fn = fn) });
    c.sync(makeSystems());
    c.setVisible(false);
    h.layerState.last!.onSelfDisable?.('gl-error-0x505');
    holder.fn?.();
    for (const id of STOCK) expect(visibility[id]).toBe('none');
    expect(c.isActive()).toBe(false);
  });

  it('normal restore (visible survey) still un-hides the stock layers', () => {
    const { map, visibility } = makeFakeMap();
    const c = new GlobalCustomController(map);
    c.sync(makeSystems());
    for (const id of STOCK) expect(visibility[id]).toBe('none');
    h.gate.enabled = false;
    c.sync(makeSystems());
    for (const id of STOCK) expect(visibility[id]).toBe('visible');
  });

  it('setHover maps a system id to its baked index (or -1)', () => {
    const { map } = makeFakeMap();
    const c = new GlobalCustomController(map);
    c.sync(makeSystems());
    c.setHover('a.tml');
    expect(h.layerState.last!.hoverSystem).toBe(0);
    c.setHover(null);
    expect(h.layerState.last!.hoverSystem).toBe(-1);
    c.setHover('missing.tml');
    expect(h.layerState.last!.hoverSystem).toBe(-1);
  });
});
