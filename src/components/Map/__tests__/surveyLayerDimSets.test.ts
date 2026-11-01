/**
 * Dim-set pushes skip no-op changes (#576 D8). Outside the move tools MapCanvas
 * handed SurveyLayer FRESH empty anchored / immovable sets on every edit, and each
 * push re-ran the custom renderer's dim pass: two O(shots) per-vertex
 * recomputes, four GPU buffer uploads and a label-flag upload per edit, for a
 * dimming that was "nothing" before and after. An unchanged set - or empty to
 * empty - must not reach the renderer; a real change, including back to empty,
 * still must.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('maplibre-gl', () => ({ default: {} }));

import SurveyLayer from '../SurveyLayer';
import { makeFakeSurveyMap } from './surveyLayerFakeMap';

interface DimTargets {
  customRender: { setDimming: (s: unknown) => void };
  customLabels: { setDimming: (s: unknown) => void };
}

let layer: SurveyLayer;
let geometryDim: ReturnType<typeof vi.fn>;
let labelDim: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  layer = new SurveyLayer(makeFakeSurveyMap().map);
  const targets = layer as unknown as DimTargets;
  geometryDim = vi.spyOn(targets.customRender, 'setDimming') as unknown as ReturnType<typeof vi.fn>;
  labelDim = vi.spyOn(targets.customLabels, 'setDimming') as unknown as ReturnType<typeof vi.fn>;
});

afterEach(() => {
  layer.release();
  vi.restoreAllMocks();
});

describe('SurveyLayer dim-set pushes', () => {
  it('fresh empty sets on every edit do not re-run the dim pass', () => {
    for (let edit = 0; edit < 3; edit++) {
      layer.setAnchoredSections(new Set());
      layer.setImmovableFeatures(new Set(), new Set());
    }
    expect(geometryDim).not.toHaveBeenCalled();
    expect(labelDim).not.toHaveBeenCalled();
  });

  it('immovable: a change dims, the same set again does not, back to empty clears', () => {
    const stations = new Set([100001]);
    const shots = new Set<number>();
    layer.setImmovableFeatures(stations, shots);
    expect(geometryDim).toHaveBeenCalledTimes(1);
    layer.setImmovableFeatures(stations, shots);
    expect(geometryDim).toHaveBeenCalledTimes(1);
    layer.setImmovableFeatures(new Set(), new Set());
    expect(geometryDim).toHaveBeenCalledTimes(2);
    expect(geometryDim.mock.calls[1]![0]).toMatchObject({ immovableStationFeatureIds: new Set() });
    expect(labelDim).toHaveBeenCalledTimes(2);
  });

  it('anchored: a change dims, the same set again does not, back to empty clears', () => {
    const anchored = new Set([3]);
    layer.setAnchoredSections(anchored);
    layer.setAnchoredSections(anchored);
    expect(geometryDim).toHaveBeenCalledTimes(1);
    layer.setAnchoredSections(new Set());
    expect(geometryDim).toHaveBeenCalledTimes(2);
    expect(geometryDim.mock.calls[1]![0]).toMatchObject({ anchoredSectionIds: new Set() });
  });
});
