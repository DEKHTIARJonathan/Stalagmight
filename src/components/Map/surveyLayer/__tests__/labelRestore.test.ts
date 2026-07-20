import { describe, it, expect } from 'vitest';
import type maplibregl from 'maplibre-gl';
import {
  TEXT_LABEL_LAYER_IDS,
  LABEL_VT_GROUPS,
  LABEL_RESTORE_FALLBACK_MS,
  partitionDragFilters,
  shouldDeferTextRestore,
  type DragFilterMap,
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
