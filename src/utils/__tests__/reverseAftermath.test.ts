/**
 * Plan-pin mirroring after a section reverse (#24).
 *
 * The hazard these pin: a reverse renumbers station `i` to `N - i`, so a
 * positional `StationRef` stays IN RANGE and silently names a different physical
 * station. For the gas plan that means the same UI re-prices a different route,
 * with no error - so every assertion here compares against a mirrored index, and
 * every fixture uses a station index that differs from its mirror.
 */
import { describe, it, expect } from 'vitest';
import {
  mirrorRef,
  mirrorPlanPins,
  planPinsAffected,
  type PlanPins,
} from '../reverseAftermath';

const REVERSED = 7;
const UNTOUCHED = 9;
/** 7 shots -> 8 stations, so station 2 mirrors to 5. Deliberately not 4 (its own mirror). */
const counts = new Map([[REVERSED, 7]]);

const ref = (section_id: number, station_index: number) => ({ section_id, station_index });

function pins(overrides: Partial<PlanPins> = {}): PlanPins {
  return {
    origin: null,
    endpoint: null,
    waypoints: [],
    markedPoints: [],
    stageDropOverrides: [],
    ...overrides,
  };
}

describe('mirrorRef', () => {
  it('maps i to N - i inside a reversed section', () => {
    expect(mirrorRef(ref(REVERSED, 2), counts)).toEqual(ref(REVERSED, 5));
    expect(mirrorRef(ref(REVERSED, 0), counts)).toEqual(ref(REVERSED, 7));
  });

  it('leaves a section this batch did not reverse alone', () => {
    expect(mirrorRef(ref(UNTOUCHED, 2), counts)).toEqual(ref(UNTOUCHED, 2));
  });

  it('is an involution', () => {
    const once = mirrorRef(ref(REVERSED, 2), counts);
    expect(mirrorRef(once, counts)).toEqual(ref(REVERSED, 2));
  });
});

describe('mirrorPlanPins', () => {
  it('mirrors every pin kind, and only in the reversed section', () => {
    const before = pins({
      origin: ref(REVERSED, 0),
      endpoint: ref(UNTOUCHED, 1),
      waypoints: [ref(REVERSED, 2), ref(UNTOUCHED, 3)],
      markedPoints: [{ station: ref(REVERSED, 1), label: 'restriction' }],
      stageDropOverrides: [ref(REVERSED, 6), null],
    });

    expect(mirrorPlanPins(before, counts)).toEqual(
      pins({
        origin: ref(REVERSED, 7),
        endpoint: ref(UNTOUCHED, 1),
        waypoints: [ref(REVERSED, 5), ref(UNTOUCHED, 3)],
        markedPoints: [{ station: ref(REVERSED, 6), label: 'restriction' }],
        stageDropOverrides: [ref(REVERSED, 1), null],
      })
    );
  });

  it('keeps a marked point label attached to its station', () => {
    const out = mirrorPlanPins(
      pins({ markedPoints: [{ station: ref(REVERSED, 2), label: 'lead' }] }),
      counts
    );
    expect(out.markedPoints[0]).toEqual({ station: ref(REVERSED, 5), label: 'lead' });
  });

  it('leaves a null origin/endpoint null rather than inventing station 0', () => {
    const out = mirrorPlanPins(pins(), counts);
    expect(out.origin).toBeNull();
    expect(out.endpoint).toBeNull();
  });
});

describe('planPinsAffected', () => {
  it('is false when no pin sits in a reversed section', () => {
    expect(planPinsAffected(pins(), counts)).toBe(false);
    expect(planPinsAffected(pins({ origin: ref(UNTOUCHED, 0) }), counts)).toBe(false);
  });

  it('detects a pin in any slot', () => {
    expect(planPinsAffected(pins({ origin: ref(REVERSED, 0) }), counts)).toBe(true);
    expect(planPinsAffected(pins({ endpoint: ref(REVERSED, 0) }), counts)).toBe(true);
    expect(planPinsAffected(pins({ waypoints: [ref(REVERSED, 1)] }), counts)).toBe(true);
    expect(
      planPinsAffected(
        pins({ markedPoints: [{ station: ref(REVERSED, 1), label: null }] }),
        counts
      )
    ).toBe(true);
    expect(
      planPinsAffected(pins({ stageDropOverrides: [null, ref(REVERSED, 1)] }), counts)
    ).toBe(true);
  });
});
