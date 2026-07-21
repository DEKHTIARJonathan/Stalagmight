import { describe, it, expect } from 'vitest';
import {
  buildDistanceFeatureState,
  distanceColorExpression,
  overlayApplyAction,
  UNREACHABLE_DIST,
} from '../distanceGradient';
import { encodeFeatureId, FEATURE_ID_STRIDE } from '../ids';
import type { DistanceField } from '../../types/project';
import type { SurveyData } from '../../types/survey-data';

describe('encodeFeatureId', () => {
  it('matches the features.ts formula sectionId * STRIDE + scopedId', () => {
    expect(encodeFeatureId(5, 17)).toBe(5 * FEATURE_ID_STRIDE + 17);
    expect(encodeFeatureId(0, 0)).toBe(0);
    expect(encodeFeatureId(2, 3)).toBe(200003);
  });
});

describe('buildDistanceFeatureState', () => {
  // Section 1: shots id10 (st0→st1), id11 (st1→st2). Section 2: empty (st0 only).
  // SoA shape: section metadata (shotOffset/shotCount) + a flat shotIds array.
  const data = {
    sections: [
      { id: 1, shotOffset: 0, shotCount: 2 },
      { id: 2, shotOffset: 2, shotCount: 0 },
    ],
    shotIds: new Int32Array([10, 11]),
  } as unknown as Pick<SurveyData, 'sections' | 'shotIds'>;

  const field: DistanceField = {
    station_refs: [
      { section_id: 1, station_index: 0 },
      { section_id: 1, station_index: 1 },
      { section_id: 1, station_index: 2 },
      { section_id: 2, station_index: 0 },
    ],
    distances: [0, 10, null, 5], // st(1,2) unreachable
    max_reachable: 10,
  };

  it('maps each station to its own distance, keyed by encodeFeatureId(section, index)', () => {
    const { stations } = buildDistanceFeatureState(data, field);
    expect(stations.get(encodeFeatureId(1, 0))).toBe(0);
    expect(stations.get(encodeFeatureId(1, 1))).toBe(10);
    expect(stations.get(encodeFeatureId(2, 0))).toBe(5);
  });

  it('marks unreachable stations with the sentinel', () => {
    const { stations } = buildDistanceFeatureState(data, field);
    expect(stations.get(encodeFeatureId(1, 2))).toBe(UNREACHABLE_DIST);
  });

  it('colors a shot by the average of its two endpoint distances, keyed by shot id', () => {
    const { shots } = buildDistanceFeatureState(data, field);
    // shot id10: endpoints st0=0, st1=10 → avg 5
    expect(shots.get(encodeFeatureId(1, 10))).toBe(5);
  });

  it('marks a shot unreachable when either endpoint is unreachable', () => {
    const { shots } = buildDistanceFeatureState(data, field);
    // shot id11: endpoints st1=10, st2=unreachable → sentinel
    expect(shots.get(encodeFeatureId(1, 11))).toBe(UNREACHABLE_DIST);
  });

  it('passes through max_reachable', () => {
    expect(buildDistanceFeatureState(data, field).max).toBe(10);
  });
});

describe('distanceColorExpression', () => {
  it('greys unset/unreachable (negative) dist and interpolates near→far over 0→max', () => {
    const s = JSON.stringify(distanceColorExpression('#aaaaaa', '#bbbbbb', 100, '#888888'));
    expect(s).toContain('interpolate');
    expect(s).toContain('coalesce');
    expect(s).toContain('#888888'); // grey branch
    expect(s).toContain('#aaaaaa'); // near
    expect(s).toContain('#bbbbbb'); // far
    expect(s).toContain('"#aaaaaa",100,"#bbbbbb"'); // 0→100 stops
  });

  it('guards a degenerate max<=0 by using a strictly-ascending stop (1)', () => {
    const s = JSON.stringify(distanceColorExpression('#aaaaaa', '#bbbbbb', 0, '#888888'));
    expect(s).toContain('"#aaaaaa",1,"#bbbbbb"'); // safeMax = 1, not 0
  });
});

describe('overlayApplyAction (origin-change blink guard)', () => {
  it('ramps when the mode is on, the field is ready, and geometry exists', () => {
    expect(overlayApplyAction(true, true, true)).toBe('ramp');
  });

  it('HOLDS the current ramp when the field is transiently null mid-recompute', () => {
    // The fix: origin change clears the field -> mode still on, geometry present,
    // field null -> keep the old ramp (no base-color frame) until the new one lands.
    expect(overlayApplyAction(true, false, true)).toBe('hold');
  });

  it('turns OFF immediately on real deactivation, regardless of field/geometry', () => {
    // Deactivation must restore base now (never held), whether or not a stale
    // field object lingers.
    expect(overlayApplyAction(false, true, true)).toBe('off');
    expect(overlayApplyAction(false, false, true)).toBe('off');
    expect(overlayApplyAction(false, true, false)).toBe('off');
  });

  it('turns OFF when there is no geometry to color (even with the mode on)', () => {
    expect(overlayApplyAction(true, true, false)).toBe('off');
    expect(overlayApplyAction(true, false, false)).toBe('off');
  });

  it('a genuinely empty result is a non-null field -> ramp (all-grey), not hold', () => {
    // The caller passes hasField=true for a non-null-but-empty field, so it
    // renders the all-grey ramp instead of holding stale colors.
    expect(overlayApplyAction(true, true, true)).toBe('ramp');
  });
});
