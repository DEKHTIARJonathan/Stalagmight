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
  captureStationPositions,
  mirrorRef,
  mirrorPlanPins,
  planPinsAffected,
  sectionsRenumberedByReverse,
  type PlanPins,
} from '../reverseAftermath';
import type { Station } from '../../types/project';

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

  it('clamps a ref that outlived the shots it was dropped on', () => {
    // Gas pins survive shot deletion (their only reset is a project switch), so
    // station_index can sit past the end of a now-shorter section. The raw
    // mirror would go NEGATIVE, and station_index is a u32 on the Rust side -
    // serde would reject the whole compute_gas_reach_field call and the reach
    // overlay would fail permanently on one poisoned pin.
    expect(mirrorRef(ref(REVERSED, 12), counts)).toEqual(ref(REVERSED, 0));
    expect(mirrorRef(ref(REVERSED, 8), counts)).toEqual(ref(REVERSED, 0));
    // Exactly at the end still mirrors normally - the clamp must not eat it.
    expect(mirrorRef(ref(REVERSED, 7), counts)).toEqual(ref(REVERSED, 0));
    expect(mirrorRef(ref(REVERSED, 6), counts)).toEqual(ref(REVERSED, 1));
  });

  it('never emits a negative index through a whole plan', () => {
    const out = mirrorPlanPins(
      pins({
        origin: ref(REVERSED, 40),
        waypoints: [ref(REVERSED, 9)],
        markedPoints: [{ station: ref(REVERSED, 30), label: null }],
        stageDropOverrides: [ref(REVERSED, 99)],
      }),
      counts
    );
    for (const idx of [
      out.origin?.station_index,
      out.waypoints[0]?.station_index,
      out.markedPoints[0]?.station.station_index,
      out.stageDropOverrides[0]?.station_index,
    ]) {
      expect(idx).toBeGreaterThanOrEqual(0);
    }
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

/**
 * Undo/redo of a reverse (#24). The undo IPC result names no sections, so which
 * sections flipped is read off the station geometry: a reverse keeps every world
 * coordinate and only renumbers, so station `i` landing where station `N - i`
 * used to be IS the flip the pins have to follow.
 */
describe('sectionsRenumberedByReverse', () => {
  const station = (section_id: number, station_index: number, x: number): Station => ({
    station_ref: { section_id, station_index },
    coordinates: { x, y: 0, z: 0 },
    is_zero_datum: false,
    gps_coordinates: null,
    merged_with: [],
    closures_with: [],
  });

  /** A section laid out along +x at the given offsets, in station order. */
  const line = (section_id: number, xs: number[]): Station[] =>
    xs.map((x, i) => station(section_id, i, x));

  const capture = (stations: Station[], ids: number[] = [REVERSED]) =>
    captureStationPositions(stations, new Set(ids));

  it('reports a flipped section with its shot count', () => {
    const before = capture(line(REVERSED, [0, 10, 25, 40]));
    // Same four places, numbered from the other end.
    const after = capture(line(REVERSED, [40, 25, 10, 0]));
    expect(sectionsRenumberedByReverse(before, after)).toEqual(new Map([[REVERSED, 3]]));
  });

  it('tolerates the few-ulp drift of a re-walked chain', () => {
    const before = capture(line(REVERSED, [0, 10, 25]));
    const after = capture(line(REVERSED, [25 + 1e-12, 10 - 1e-12, 0]));
    expect(sectionsRenumberedByReverse(before, after).has(REVERSED)).toBe(true);
  });

  it('says nothing flipped when the numbering is unchanged', () => {
    const stations = line(REVERSED, [0, 10, 25, 40]);
    expect(sectionsRenumberedByReverse(capture(stations), capture(stations)).size).toBe(0);
  });

  it('ignores an ordinary edit that moved the cave', () => {
    const before = capture(line(REVERSED, [0, 10, 25, 40]));
    const after = capture(line(REVERSED, [0, 10, 25, 41]));
    expect(sectionsRenumberedByReverse(before, after).size).toBe(0);
  });

  it('ignores a section whose station count changed', () => {
    // Undoing a shot delete puts a station back: not a renumbering, and a
    // mirror against the wrong count would land on an unrelated station.
    const before = capture(line(REVERSED, [0, 10, 25]));
    const after = capture(line(REVERSED, [25, 10, 5, 0]));
    expect(sectionsRenumberedByReverse(before, after).size).toBe(0);
  });

  it('leaves a palindromic section alone (mirroring it would be a no-op)', () => {
    // A section folding back exactly on itself matches BOTH ways; identity wins,
    // so an unrelated undo does not churn the pins for a move to a station at
    // the very same coordinate.
    const stations = line(REVERSED, [0, 10, 0]);
    expect(sectionsRenumberedByReverse(capture(stations), capture(stations)).size).toBe(0);
  });

  it('only looks at the sections it was asked to watch', () => {
    const ids = [REVERSED];
    const before = captureStationPositions(
      [...line(REVERSED, [0, 10]), ...line(UNTOUCHED, [0, 5])],
      new Set(ids)
    );
    const after = captureStationPositions(
      [...line(REVERSED, [0, 10]), ...line(UNTOUCHED, [5, 0])],
      new Set(ids)
    );
    // The unwatched section flipped, but nothing points into it.
    expect(sectionsRenumberedByReverse(before, after).size).toBe(0);
  });

  it('captures nothing when no ref holds a section', () => {
    expect(captureStationPositions(line(REVERSED, [0, 10]), new Set()).size).toBe(0);
  });
});
