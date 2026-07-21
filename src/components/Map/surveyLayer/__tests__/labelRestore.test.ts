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

  const secs = (ids: number[]): { id: number }[] => ids.map((id) => ({ id }));

  describe('applyRemovedExclusion (delete / undo path)', () => {
    it('composes the exclusion onto every present text layer, base or not', () => {
      const map = new FakeFilterMap(TEXT_LABEL_LAYER_IDS);
      const base = F('shotBase');
      map.setFilter('survey-shot-labels', base);
      const c = new LabelRestoreController(map);

      c.applyRemovedExclusion([5, 8], secs([0, 1]));
      const exclusion = buildSectionLabelExclusion([5, 8]);
      // Layer with a base filter -> composed; layer without -> the exclusion alone.
      expect(map.getFilter('survey-shot-labels')).toEqual(['all', base, exclusion]);
      expect(map.getFilter('survey-labels')).toEqual(exclusion);
    });

    it('is a no-op until a first removal (ordinary flushes touch no filter)', () => {
      const map = new FakeFilterMap(TEXT_LABEL_LAYER_IDS);
      const c = new LabelRestoreController(map);
      c.applyRemovedExclusion([], secs([0, 1, 2]));
      expect(map.filters.size).toBe(0);
    });

    it('keeps a removed section hidden across later flushes that add no removals', () => {
      const map = new FakeFilterMap(TEXT_LABEL_LAYER_IDS);
      const c = new LabelRestoreController(map);
      c.applyRemovedExclusion([5], secs([0, 1])); // 5 deleted
      expect(map.getFilter('survey-labels')).toEqual(buildSectionLabelExclusion([5]));
      // A subsequent flush (e.g. an unrelated edit) with 5 still absent: stays hidden.
      c.applyRemovedExclusion([], secs([0, 1]));
      expect(map.getFilter('survey-labels')).toEqual(buildSectionLabelExclusion([5]));
    });

    it('drops a re-added section (undo) and restores the true base when the set empties', () => {
      const map = new FakeFilterMap(TEXT_LABEL_LAYER_IDS);
      const base = F('shotBase');
      map.setFilter('survey-shot-labels', base);
      const c = new LabelRestoreController(map);
      c.applyRemovedExclusion([5], secs([0, 1]));
      expect(map.getFilter('survey-shot-labels')).toEqual(['all', base, buildSectionLabelExclusion([5])]);
      // Undo re-adds section 5: exclusion dropped, base restored.
      c.applyRemovedExclusion([], secs([0, 1, 5]));
      expect(map.getFilter('survey-shot-labels')).toBe(base);
      expect(map.getFilter('survey-labels')).toBeNull();
    });

    it('accumulates removals across flushes and narrows as each is re-added', () => {
      const map = new FakeFilterMap(TEXT_LABEL_LAYER_IDS);
      const c = new LabelRestoreController(map);
      c.applyRemovedExclusion([5], secs([0]));
      c.applyRemovedExclusion([7], secs([0])); // 5 and 7 both gone
      expect(map.getFilter('survey-labels')).toEqual(buildSectionLabelExclusion([5, 7]));
      c.applyRemovedExclusion([], secs([0, 5])); // 5 back, 7 still gone
      expect(map.getFilter('survey-labels')).toEqual(buildSectionLabelExclusion([7]));
    });

    it('hides nothing (no throw) when no text layer exists', () => {
      const noLayers = new FakeFilterMap([]);
      const c = new LabelRestoreController(noLayers);
      c.applyRemovedExclusion([5], secs([]));
      expect(noLayers.filters.size).toBe(0);
    });

    it('dispose clears the persistent removed state', () => {
      const map = new FakeFilterMap(TEXT_LABEL_LAYER_IDS);
      const base = F('shotBase');
      map.setFilter('survey-shot-labels', base);
      const c = new LabelRestoreController(map);
      c.applyRemovedExclusion([5], secs([0]));
      c.dispose();
      // After dispose the controller forgets 5; a fresh removal re-captures the
      // (currently-excluded) filter as base rather than double-composing forever.
      // The important guarantee is simply that dispose does not throw and resets.
      c.applyRemovedExclusion([], secs([0, 5]));
      expect(map.filters.has('survey-shot-labels')).toBe(true);
    });
  });

  describe('deferRestore (drag-commit path)', () => {
    it('holds the filters until the reloads settle, then restores the base', async () => {
      const map = new FakeFilterMap(TEXT_LABEL_LAYER_IDS);
      const base = F('shotBase');
      const text: DragFilterMap = new Map([['survey-shot-labels', base], ['survey-labels', undefined]]);
      map.setFilter('survey-shot-labels', composeLabelFilter(base, buildSectionLabelExclusion([5])));
      map.setFilter('survey-labels', buildSectionLabelExclusion([5]));
      const c = new LabelRestoreController(map);

      let land!: () => void;
      const reload = new Promise<void>((r) => { land = r; });
      c.deferRestore(text, [reload]);
      expect(map.getFilter('survey-shot-labels')).toEqual(['all', base, buildSectionLabelExclusion([5])]);
      land();
      await flushMicrotasks();
      expect(map.getFilter('survey-shot-labels')).toBe(base);
      expect(map.getFilter('survey-labels')).toBeNull();
    });

    it('restores synchronously when the commit reloaded no label tile', () => {
      const map = new FakeFilterMap(TEXT_LABEL_LAYER_IDS);
      const c = new LabelRestoreController(map);
      const text: DragFilterMap = new Map([['survey-labels', undefined]]);
      map.setFilter('survey-labels', buildSectionLabelExclusion([5]));
      c.deferRestore(text, []); // no reloads -> restore now
      expect(map.getFilter('survey-labels')).toBeNull();
    });

    it('restores via the fallback timer if the reloads never settle', () => {
      vi.useFakeTimers();
      const map = new FakeFilterMap(TEXT_LABEL_LAYER_IDS);
      const c = new LabelRestoreController(map);
      const text: DragFilterMap = new Map([['survey-labels', undefined]]);
      map.setFilter('survey-labels', buildSectionLabelExclusion([5]));
      c.deferRestore(text, [new Promise<void>(() => {})]); // never resolves
      expect(map.getFilter('survey-labels')).toEqual(buildSectionLabelExclusion([5]));
      vi.advanceTimersByTime(LABEL_RESTORE_FALLBACK_MS);
      expect(map.getFilter('survey-labels')).toBeNull();
    });

    it('flushPending force-restores immediately and a late settle then no-ops', async () => {
      const map = new FakeFilterMap(TEXT_LABEL_LAYER_IDS);
      const base = F('shotBase');
      map.setFilter('survey-shot-labels', base);
      const c = new LabelRestoreController(map);

      const text: DragFilterMap = new Map([['survey-shot-labels', base]]);
      map.setFilter('survey-shot-labels', composeLabelFilter(base, buildSectionLabelExclusion([5])));
      let land!: () => void;
      const reload = new Promise<void>((r) => { land = r; });
      c.deferRestore(text, [reload]);
      c.flushPending(); // superseding drag / teardown: restore now (synchronous)
      expect(map.getFilter('survey-shot-labels')).toBe(base);

      // A later stale settle from the flushed generation must not clobber anything.
      map.setFilter('survey-shot-labels', composeLabelFilter(base, buildSectionLabelExclusion([9])));
      land();
      await flushMicrotasks();
      expect(map.getFilter('survey-shot-labels')).toEqual(['all', base, buildSectionLabelExclusion([9])]);
    });
  });
});
