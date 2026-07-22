import { describe, expect, it } from 'vitest';
import {
  shotStationDecimationModulus,
  decimationModulusForKind,
  decimationModuli,
  isLabelDecimatedOut,
} from '../labelDecimation';
import { LABEL_KIND, LABEL_KIND_COUNT } from '../labelShaders';

/**
 * Label decimation planning (#customRender labels, Phase 1). Locks the per-kind
 * zoom-band modulus against the stock `shotLabelsBaseFilter` /
 * `stationLabelsBaseFilter` bands, and the first-in-section override the shader
 * evaluates.
 */

describe('shotStationDecimationModulus', () => {
  it('matches the stock zoom bands (14->5, 16->2, 18->1)', () => {
    expect(shotStationDecimationModulus(14)).toBe(5);
    expect(shotStationDecimationModulus(15.9)).toBe(5);
    expect(shotStationDecimationModulus(16)).toBe(2);
    expect(shotStationDecimationModulus(17.9)).toBe(2);
    expect(shotStationDecimationModulus(18)).toBe(1);
    expect(shotStationDecimationModulus(22)).toBe(1);
  });
});

describe('decimationModulusForKind', () => {
  it('decimates shot + station labels, never section names or comments', () => {
    expect(decimationModulusForKind(LABEL_KIND.SHOT_LABEL, 15)).toBe(5);
    expect(decimationModulusForKind(LABEL_KIND.STATION_LABEL, 16)).toBe(2);
    expect(decimationModulusForKind(LABEL_KIND.SECTION_NAME, 15)).toBe(1);
    expect(decimationModulusForKind(LABEL_KIND.STATION_COMMENT, 15)).toBe(1);
    expect(decimationModulusForKind(LABEL_KIND.SHOT_COMMENT, 15)).toBe(1);
  });

  it('decimationModuli returns one slot per kind', () => {
    const arr = decimationModuli(16);
    expect(arr).toHaveLength(LABEL_KIND_COUNT);
    expect(Array.from(arr)).toEqual([2, 2, 1, 1, 1]); // shot, station, section, 2x comment
  });
});

describe('isLabelDecimatedOut', () => {
  it('keeps every N-th ordinal, hides the rest', () => {
    // modulus 5: 0,5,10 shown; others hidden.
    expect(isLabelDecimatedOut(0, 5, false)).toBe(false);
    expect(isLabelDecimatedOut(5, 5, false)).toBe(false);
    expect(isLabelDecimatedOut(3, 5, false)).toBe(true);
    expect(isLabelDecimatedOut(7, 5, false)).toBe(true);
  });

  it('always shows a first-in-section label regardless of ordinal', () => {
    expect(isLabelDecimatedOut(3, 5, true)).toBe(false);
    expect(isLabelDecimatedOut(7, 2, true)).toBe(false);
  });

  it('shows all when the modulus is <= 1 (zoom >= 18)', () => {
    expect(isLabelDecimatedOut(3, 1, false)).toBe(false);
    expect(isLabelDecimatedOut(999, 1, false)).toBe(false);
  });
});
