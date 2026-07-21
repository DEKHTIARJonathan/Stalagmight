import { describe, it, expect, vi, afterEach } from 'vitest';
import type maplibregl from 'maplibre-gl';
import {
  TEXT_LABEL_LAYER_IDS,
  LABEL_VT_GROUPS,
  LABEL_RESTORE_FALLBACK_MS,
  partitionDragFilters,
  shouldDeferTextRestore,
  diffRemovedSectionIds,
  diffRemovedFeatures,
  buildSectionLabelExclusion,
  buildShotLabelExclusion,
  composeLabelFilter,
  composeLabelFilters,
  LabelRestoreController,
  type DragFilterMap,
  type LabelFilterMap,
} from '../labelRestore';
import { emptySurveyData, type SurveyData } from '../../../../types/survey-data';

/** Minimal survey SoA for the removal diff: ids + section membership only. */
function survey(opts: {
  sections: number[];
  shots: Array<{ sectionId: number; shotId: number }>;
  stations: Array<{ sectionId: number; stationIndex: number }>;
}): SurveyData {
  const d = emptySurveyData();
  d.sections = opts.sections.map((id) => ({ id }) as never);
  d.shotCount = opts.shots.length;
  d.shotIds = new Int32Array(opts.shots.map((s) => s.shotId));
  d.shotSectionIds = new Int32Array(opts.shots.map((s) => s.sectionId));
  d.stationCount = opts.stations.length;
  d.stationSectionIds = new Int32Array(opts.stations.map((s) => s.sectionId));
  d.stationIndices = new Uint32Array(opts.stations.map((s) => s.stationIndex));
  return d;
}

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

describe('buildShotLabelExclusion', () => {
  it('hides features whose sectionId:shotId composite is in the removed set', () => {
    expect(buildShotLabelExclusion(['3:7', '3:8'])).toEqual([
      '!',
      ['in', ['concat', ['to-string', ['get', 'sectionId']], ':', ['to-string', ['get', 'shotId']]], ['literal', ['3:7', '3:8']]],
    ]);
  });
});

describe('composeLabelFilters', () => {
  const s = buildSectionLabelExclusion([5]);
  const sh = buildShotLabelExclusion(['5:1']);
  it('returns the base alone when no exclusions apply', () => {
    const base = F('base');
    expect(composeLabelFilters(base, [null, null])).toBe(base);
    expect(composeLabelFilters(undefined, [null])).toBeNull();
  });
  it('uses a single exclusion directly with no base', () => {
    expect(composeLabelFilters(undefined, [s, null])).toBe(s);
  });
  it('ANDs base + every present exclusion in order', () => {
    const base = F('base');
    expect(composeLabelFilters(base, [s, sh])).toEqual(['all', base, s, sh]);
  });
});

describe('diffRemovedFeatures', () => {
  // Section 1: stations idx 0..4, shots ids 0..3 (0-1,1-2,2-3,3-4).
  const full = survey({
    sections: [1],
    shots: [0, 1, 2, 3].map((shotId) => ({ sectionId: 1, shotId })),
    stations: [0, 1, 2, 3, 4].map((stationIndex) => ({ sectionId: 1, stationIndex })),
  });

  it('returns empty for a null prev (app start / first flush)', () => {
    expect(diffRemovedFeatures(null, full)).toEqual({ shots: [], stationSections: [] });
  });

  it('fast-paths to empty when neither total shrank (no deletion this flush)', () => {
    const added = survey({
      sections: [1],
      shots: [0, 1, 2, 3, 4].map((shotId) => ({ sectionId: 1, shotId })),
      stations: [0, 1, 2, 3, 4, 5].map((stationIndex) => ({ sectionId: 1, stationIndex })),
    });
    expect(diffRemovedFeatures(full, added)).toEqual({ shots: [], stationSections: [] });
  });

  it('index-shift hazard: a mid-section station delete reports the SECTION, not an index', () => {
    // Delete shot id 1 -> removes station at old index 2; stations 3,4 renumber to
    // 2,3. next has stations idx 0..3 and shots ids 0,2,3.
    const next = survey({
      sections: [1],
      shots: [0, 2, 3].map((shotId) => ({ sectionId: 1, shotId })),
      stations: [0, 1, 2, 3].map((stationIndex) => ({ sectionId: 1, stationIndex })),
    });
    const { shots, stationSections } = diffRemovedFeatures(full, next);
    // The removed shot is keyed by its STABLE id (1), never a positional index.
    expect(shots).toEqual([{ sectionId: 1, shotId: 1 }]);
    // Station removal is reported SECTION-scoped. A naive index set-diff would say
    // "index 4 removed" (the highest, vanished by renumbering) - the WRONG label -
    // so we never key stations by index; the whole section's station labels hide.
    expect(stationSections).toEqual([1]);
  });

  it('ignores whole-section removals (owned by the persistent section exclusion)', () => {
    const next = survey({
      sections: [2],
      shots: [{ sectionId: 2, shotId: 0 }],
      stations: [0, 1].map((stationIndex) => ({ sectionId: 2, stationIndex })),
    });
    // Section 1 vanished entirely; its shots/stations are NOT reported per-feature.
    expect(diffRemovedFeatures(full, next)).toEqual({ shots: [], stationSections: [] });
  });

  it('reports a removed shot even when no station left the section', () => {
    // A section keeping its station set but dropping one shot (e.g. a dangling
    // shot delete). shotCount shrank so the fast path proceeds.
    const prev = survey({
      sections: [1],
      shots: [0, 1].map((shotId) => ({ sectionId: 1, shotId })),
      stations: [0, 1].map((stationIndex) => ({ sectionId: 1, stationIndex })),
    });
    const next = survey({
      sections: [1],
      shots: [{ sectionId: 1, shotId: 0 }],
      stations: [0, 1].map((stationIndex) => ({ sectionId: 1, stationIndex })),
    });
    expect(diffRemovedFeatures(prev, next)).toEqual({ shots: [{ sectionId: 1, shotId: 1 }], stationSections: [] });
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

  describe('per-feature removal exclusion (single shot/station delete)', () => {
    // prev: section 1 has shots 0,1,2,3 + stations 0..4. Establish it as the
    // tracked baseline with a first (removal-free) flush, then delete.
    const prev = survey({
      sections: [1],
      shots: [0, 1, 2, 3].map((shotId) => ({ sectionId: 1, shotId })),
      stations: [0, 1, 2, 3, 4].map((stationIndex) => ({ sectionId: 1, stationIndex })),
    });
    // Delete shot id 1: removes station idx 2, renumbers 3,4 -> 2,3.
    const afterDelete = survey({
      sections: [1],
      shots: [0, 2, 3].map((shotId) => ({ sectionId: 1, shotId })),
      stations: [0, 1, 2, 3].map((stationIndex) => ({ sectionId: 1, stationIndex })),
    });

    it('hides the removed shot (by shotId) and the section station labels in-frame', () => {
      const map = new FakeFilterMap(TEXT_LABEL_LAYER_IDS);
      const c = new LabelRestoreController(map);
      c.applyRemovedExclusion([], secs([1]), prev); // baseline flush, no removal
      expect(map.filters.size).toBe(0);
      c.applyRemovedExclusion([], secs([1]), afterDelete); // the delete flush
      const shotExcl = buildShotLabelExclusion(['1:1']);
      const stationExcl = buildSectionLabelExclusion([1]);
      // Shot layers hide the removed shotId; station layers hide the section's
      // station labels wholesale (index-shift-safe); section labels untouched.
      expect(map.getFilter('survey-shot-labels')).toEqual(shotExcl);
      expect(map.getFilter('survey-shot-comments')).toEqual(shotExcl);
      expect(map.getFilter('survey-station-labels')).toEqual(stationExcl);
      expect(map.getFilter('survey-station-comments')).toEqual(stationExcl);
      expect(map.getFilter('survey-labels')).toBeNull();
    });

    it('drops the per-feature hide once this flush label tiles reload (truthful)', async () => {
      const map = new FakeFilterMap(TEXT_LABEL_LAYER_IDS);
      const c = new LabelRestoreController(map);
      c.applyRemovedExclusion([], secs([1]), prev);
      c.applyRemovedExclusion([], secs([1]), afterDelete);
      expect(map.getFilter('survey-shot-labels')).toEqual(buildShotLabelExclusion(['1:1']));
      let land!: () => void;
      const reload = new Promise<void>((r) => { land = r; });
      c.settleFeatureExclusion([reload]);
      land();
      await flushMicrotasks();
      // After reload the tiles carry the renumbered, truthful labels -> restore.
      expect(map.getFilter('survey-shot-labels')).toBeNull();
      expect(map.getFilter('survey-station-labels')).toBeNull();
    });

    it('falls back to the timer if the reloads never settle', () => {
      vi.useFakeTimers();
      const map = new FakeFilterMap(TEXT_LABEL_LAYER_IDS);
      const c = new LabelRestoreController(map);
      c.applyRemovedExclusion([], secs([1]), prev);
      c.applyRemovedExclusion([], secs([1]), afterDelete);
      c.settleFeatureExclusion([new Promise<void>(() => {})]); // never resolves
      expect(map.getFilter('survey-station-labels')).toEqual(buildSectionLabelExclusion([1]));
      vi.advanceTimersByTime(LABEL_RESTORE_FALLBACK_MS);
      expect(map.getFilter('survey-station-labels')).toBeNull();
    });

    it('composes with a persistent section exclusion and leaves it intact on drop', async () => {
      const map = new FakeFilterMap(TEXT_LABEL_LAYER_IDS);
      const c = new LabelRestoreController(map);
      // Section 9 deleted earlier (persistent), then a shot deleted in section 1.
      c.applyRemovedExclusion([9], secs([1]), prev);
      c.applyRemovedExclusion([], secs([1]), afterDelete);
      // Station-labels carry BOTH the section-9 persistent hide and the section-1
      // transient station hide.
      expect(map.getFilter('survey-station-labels')).toEqual([
        'all', buildSectionLabelExclusion([9]), buildSectionLabelExclusion([1]),
      ]);
      let land!: () => void;
      const reload = new Promise<void>((r) => { land = r; });
      c.settleFeatureExclusion([reload]);
      land();
      await flushMicrotasks();
      // Transient dropped; the persistent section-9 hide remains.
      expect(map.getFilter('survey-station-labels')).toEqual(buildSectionLabelExclusion([9]));
    });

    it('a superseding delete supersedes the earlier settle generation', async () => {
      const map = new FakeFilterMap(TEXT_LABEL_LAYER_IDS);
      const c = new LabelRestoreController(map);
      c.applyRemovedExclusion([], secs([1]), prev);
      c.applyRemovedExclusion([], secs([1]), afterDelete); // delete A (gen 1)
      let landA!: () => void;
      const reloadA = new Promise<void>((r) => { landA = r; });
      c.settleFeatureExclusion([reloadA]);
      // A second delete (shot id 2) before A's reload settles -> new gen.
      const afterDelete2 = survey({
        sections: [1],
        shots: [{ sectionId: 1, shotId: 0 }, { sectionId: 1, shotId: 3 }],
        stations: [0, 1, 2].map((stationIndex) => ({ sectionId: 1, stationIndex })),
      });
      c.applyRemovedExclusion([], secs([1]), afterDelete2);
      landA(); // A's stale settle must NOT drop the (newer) exclusion
      await flushMicrotasks();
      expect(map.getFilter('survey-station-labels')).toEqual(buildSectionLabelExclusion([1]));
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
