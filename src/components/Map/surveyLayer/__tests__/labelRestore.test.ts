import { describe, it, expect, vi, afterEach } from 'vitest';
import type maplibregl from 'maplibre-gl';
import {
  TEXT_LABEL_LAYER_IDS,
  LABEL_VT_GROUPS,
  LABEL_RESTORE_FALLBACK_MS,
  partitionDragFilters,
  shouldDeferTextRestore,
  diffRemovedSectionIds,
  buildSectionLabelExclusion,
  composeLabelFilter,
  LabelRestoreController,
  type DragFilterMap,
  type LabelFilterMap,
} from '../labelRestore';

// A distinct stand-in filter per layer so we can assert values survive the split.
const F = (tag: string): maplibregl.FilterSpecification =>
  (['==', ['get', 'tag'], tag] as unknown as maplibregl.FilterSpecification);

describe('labelRestore constants', () => {
  it('classifies exactly the five VT-label-backed text layers as text', () => {
    expect([...TEXT_LABEL_LAYER_IDS].sort()).toEqual([
      'survey-labels',
      'survey-shot-comments',
      'survey-shot-labels',
      'survey-station-comments',
      'survey-station-labels',
    ]);
  });

  it('tracks the three label feature groups whose reload the restore waits on', () => {
    expect([...LABEL_VT_GROUPS].sort()).toEqual([
      'sectionLabelFeatures',
      'shotLabelFeatures',
      'stationLabelFeatures',
    ]);
  });

  it('has a positive fallback timeout so labels can never be stranded hidden', () => {
    expect(LABEL_RESTORE_FALLBACK_MS).toBeGreaterThan(0);
  });
});

describe('partitionDragFilters', () => {
  it('routes label + comment layers to text and everything else to geometry', () => {
    const saved: DragFilterMap = new Map([
      ['survey-shots', F('shots')],
      ['survey-shot-gradients', F('grad')],
      ['survey-stations', F('stations')],
      ['survey-loop-closures', F('closures')],
      ['survey-shot-labels', F('shotLabels')],
      ['survey-station-labels', F('stationLabels')],
      ['survey-labels', F('sectionLabels')],
      ['survey-station-comments', F('stComments')],
      ['survey-shot-comments', F('shComments')],
    ]);

    const { geometry, text } = partitionDragFilters(saved);

    expect([...geometry.keys()].sort()).toEqual([
      'survey-loop-closures',
      'survey-shot-gradients',
      'survey-shots',
      'survey-stations',
    ]);
    expect([...text.keys()].sort()).toEqual([
      'survey-labels',
      'survey-shot-comments',
      'survey-shot-labels',
      'survey-station-comments',
      'survey-station-labels',
    ]);
  });

  it('preserves the saved filter value (including undefined) for each layer', () => {
    const shotFilter = F('shotLabels');
    const saved: DragFilterMap = new Map([
      ['survey-shots', undefined],
      ['survey-shot-labels', shotFilter],
      ['survey-station-labels', undefined],
    ]);

    const { geometry, text } = partitionDragFilters(saved);

    expect(geometry.has('survey-shots')).toBe(true);
    expect(geometry.get('survey-shots')).toBeUndefined();
    expect(text.get('survey-shot-labels')).toBe(shotFilter);
    // A key mapped to undefined must still be present (restore sets filter null).
    expect(text.has('survey-station-labels')).toBe(true);
    expect(text.get('survey-station-labels')).toBeUndefined();
  });

  it('returns empty maps for an empty input', () => {
    const { geometry, text } = partitionDragFilters(new Map());
    expect(geometry.size).toBe(0);
    expect(text.size).toBe(0);
  });
});

describe('shouldDeferTextRestore', () => {
  it('defers only when the commit reloaded at least one label tile source', () => {
    expect(shouldDeferTextRestore(0)).toBe(false); // Escape / cancel / no label change
    expect(shouldDeferTextRestore(1)).toBe(true);
    expect(shouldDeferTextRestore(3)).toBe(true);
  });
});

describe('diffRemovedSectionIds', () => {
  it('returns section ids in prev but not in next, in prev order', () => {
    const prev = [{ id: 1 }, { id: 5 }, { id: 8 }, { id: 12 }];
    const next = [{ id: 1 }, { id: 8 }];
    expect(diffRemovedSectionIds(prev, next)).toEqual([5, 12]);
  });

  it('returns [] when nothing was removed (edit / add only)', () => {
    const prev = [{ id: 1 }, { id: 2 }];
    const next = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(diffRemovedSectionIds(prev, next)).toEqual([]);
  });

  it('returns every id when the project emptied', () => {
    expect(diffRemovedSectionIds([{ id: 4 }, { id: 9 }], [])).toEqual([4, 9]);
  });

  it('short-circuits an empty prev (app start / project open)', () => {
    expect(diffRemovedSectionIds([], [{ id: 1 }])).toEqual([]);
  });
});

describe('buildSectionLabelExclusion', () => {
  it('hides features whose sectionId is in the removed set', () => {
    expect(buildSectionLabelExclusion([5, 12])).toEqual([
      '!',
      ['in', ['get', 'sectionId'], ['literal', [5, 12]]],
    ]);
  });
});

describe('composeLabelFilter', () => {
  const exclusion = buildSectionLabelExclusion([7]);

  it('uses the exclusion directly when there is no base filter', () => {
    expect(composeLabelFilter(undefined, exclusion)).toBe(exclusion);
  });

  it('ANDs the exclusion onto an existing base filter (preserving zoom / ref gating)', () => {
    const base = F('base');
    expect(composeLabelFilter(base, exclusion)).toEqual(['all', base, exclusion]);
  });
});

// A minimal map surface for the controller: records filters + layer existence.
class FakeFilterMap implements LabelFilterMap {
  filters = new Map<string, maplibregl.FilterSpecification | null | undefined>();
  private present = new Set<string>();
  constructor(layerIds: Iterable<string>) {
    for (const id of layerIds) this.present.add(id);
  }
  getLayer(id: string) {
    return this.present.has(id) ? ({ id } as unknown as maplibregl.StyleLayer) : undefined;
  }
  getFilter(id: string) {
    return this.filters.get(id) as maplibregl.FilterSpecification | void;
  }
  setFilter(id: string, filter?: maplibregl.FilterSpecification | null) {
    this.filters.set(id, filter);
    return this as unknown as maplibregl.Map;
  }
}

const flushMicrotasks = () => Promise.resolve().then(() => Promise.resolve());

describe('LabelRestoreController', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('composes the exclusion onto every present text layer and saves the base', () => {
    const map = new FakeFilterMap(TEXT_LABEL_LAYER_IDS);
    const base = F('shotBase');
    map.setFilter('survey-shot-labels', base);
    const c = new LabelRestoreController(map);

    expect(c.hideRemovedSections([5, 8])).toBe(true);
    const exclusion = buildSectionLabelExclusion([5, 8]);
    // Layer with a base filter -> composed; layer without -> the exclusion alone.
    expect(map.getFilter('survey-shot-labels')).toEqual(['all', base, exclusion]);
    expect(map.getFilter('survey-labels')).toEqual(exclusion);
  });

  it('is a no-op for an empty removed set and hides nothing when no text layer exists', () => {
    const withLayers = new FakeFilterMap(TEXT_LABEL_LAYER_IDS);
    expect(new LabelRestoreController(withLayers).hideRemovedSections([])).toBe(false);
    expect(withLayers.filters.size).toBe(0);
    const noLayers = new FakeFilterMap([]);
    expect(new LabelRestoreController(noLayers).hideRemovedSections([5])).toBe(false);
    expect(noLayers.filters.size).toBe(0);
  });

  it('holds the hidden filters until the reloads settle, then restores the base', async () => {
    const map = new FakeFilterMap(TEXT_LABEL_LAYER_IDS);
    const base = F('shotBase');
    map.setFilter('survey-shot-labels', base);
    const c = new LabelRestoreController(map);
    c.hideRemovedSections([5]);

    let land!: () => void;
    const reload = new Promise<void>((r) => { land = r; });
    c.settleRemoval([reload]);

    // Still hidden while the reload is in flight.
    expect(map.getFilter('survey-shot-labels')).toEqual(['all', base, buildSectionLabelExclusion([5])]);
    land();
    await flushMicrotasks();
    // Base restored; a layer that had no base filter goes back to null.
    expect(map.getFilter('survey-shot-labels')).toBe(base);
    expect(map.getFilter('survey-labels')).toBeNull();
  });

  it('restores synchronously when the flush reloaded no label tile', () => {
    const map = new FakeFilterMap(TEXT_LABEL_LAYER_IDS);
    const c = new LabelRestoreController(map);
    c.hideRemovedSections([5]);
    c.settleRemoval([]); // no reloads -> nothing stale to hide -> restore now
    expect(map.getFilter('survey-labels')).toBeNull();
  });

  it('restores via the fallback timer if the reloads never settle', () => {
    vi.useFakeTimers();
    const map = new FakeFilterMap(TEXT_LABEL_LAYER_IDS);
    const c = new LabelRestoreController(map);
    c.hideRemovedSections([5]);
    c.settleRemoval([new Promise<void>(() => {})]); // never resolves
    expect(map.getFilter('survey-labels')).toEqual(buildSectionLabelExclusion([5]));
    vi.advanceTimersByTime(LABEL_RESTORE_FALLBACK_MS);
    expect(map.getFilter('survey-labels')).toBeNull();
  });

  it('flushPending force-restores immediately and a late settle then no-ops', async () => {
    const map = new FakeFilterMap(TEXT_LABEL_LAYER_IDS);
    const base = F('shotBase');
    map.setFilter('survey-shot-labels', base);
    const c = new LabelRestoreController(map);
    c.hideRemovedSections([5]);

    let land!: () => void;
    const reload = new Promise<void>((r) => { land = r; });
    c.settleRemoval([reload]);
    c.flushPending(); // superseding op / teardown: restore now
    expect(map.getFilter('survey-shot-labels')).toBe(base);

    // Re-hide so we could detect an erroneous double restore from the stale settle.
    c.hideRemovedSections([9]);
    land();
    await flushMicrotasks();
    // The late gen-1 settle must not touch the gen-2 hide.
    expect(map.getFilter('survey-shot-labels')).toEqual(['all', base, buildSectionLabelExclusion([9])]);
  });

  it('a superseding hide captures the true base, and the superseded late settle no-ops', async () => {
    const map = new FakeFilterMap(TEXT_LABEL_LAYER_IDS);
    const base = F('shotBase');
    map.setFilter('survey-shot-labels', base);
    const c = new LabelRestoreController(map);

    c.hideRemovedSections([5]);
    let landA!: () => void;
    const reloadA = new Promise<void>((r) => { landA = r; });
    c.settleRemoval([reloadA]); // gen 1 pending

    // Second removal supersedes: flushes gen 1 (base restored) then hides [7] on base.
    c.hideRemovedSections([7]);
    expect(map.getFilter('survey-shot-labels')).toEqual(['all', base, buildSectionLabelExclusion([7])]);
    let landB!: () => void;
    const reloadB = new Promise<void>((r) => { landB = r; });
    c.settleRemoval([reloadB]); // gen 2 pending

    landA(); // late gen-1 settle
    await flushMicrotasks();
    expect(map.getFilter('survey-shot-labels')).toEqual(['all', base, buildSectionLabelExclusion([7])]);
    landB();
    await flushMicrotasks();
    expect(map.getFilter('survey-shot-labels')).toBe(base);
  });

  it('dispose drops the pending fallback timer without restoring', () => {
    vi.useFakeTimers();
    const map = new FakeFilterMap(TEXT_LABEL_LAYER_IDS);
    const c = new LabelRestoreController(map);
    c.hideRemovedSections([5]);
    c.settleRemoval([new Promise<void>(() => {})]);
    c.dispose();
    // Timer cleared: advancing does not fire a restore on the torn-down map.
    vi.advanceTimersByTime(LABEL_RESTORE_FALLBACK_MS * 2);
    expect(map.getFilter('survey-labels')).toEqual(buildSectionLabelExclusion([5]));
  });
});
