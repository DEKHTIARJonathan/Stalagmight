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
  netReversedShotCounts,
  planPinsAffected,
  type PlanPins,
} from '../reverseAftermath';
import type { Section } from '../../types/project';

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
 * Which sections a reverse (or the undo/redo of one) renumbered comes straight
 * off `CommandResult.reversed_section_ids` (#24) - the geometry cannot answer it,
 * because a reverse keeps every world coordinate and a section that was reversed
 * AND moved in the same action matches neither arrangement afterwards.
 */
describe('netReversedShotCounts', () => {
  /** Only `id` and `shots.length` are read, so the shots are placeholders. */
  const section = (id: number, shotCount: number) =>
    ({ id, shots: Array.from({ length: shotCount }, () => ({})) }) as unknown as Pick<
      Section,
      'id' | 'shots'
    >;

  const sections = [section(REVERSED, 7), section(UNTOUCHED, 4)];

  it('pairs each reported section with its shot count', () => {
    expect(netReversedShotCounts([REVERSED], sections)).toEqual(new Map([[REVERSED, 7]]));
    expect(netReversedShotCounts([UNTOUCHED, REVERSED], sections)).toEqual(
      new Map([
        [REVERSED, 7],
        [UNTOUCHED, 4],
      ])
    );
  });

  it('is empty when the operation renumbered nothing', () => {
    // Absent is the wire truth for every command that reversed nothing.
    expect(netReversedShotCounts(undefined, sections).size).toBe(0);
    expect(netReversedShotCounts([], sections).size).toBe(0);
  });

  it('cancels a section listed twice, and keeps a third listing', () => {
    // The ids arrive in command order WITH repeats, and the mirror is an
    // involution: two reverses of one section in a batch put the numbering back
    // where it started, so mirroring the pins at all would break them.
    expect(netReversedShotCounts([REVERSED, REVERSED], sections).size).toBe(0);
    expect(netReversedShotCounts([REVERSED, REVERSED, REVERSED], sections)).toEqual(
      new Map([[REVERSED, 7]])
    );
    expect(netReversedShotCounts([REVERSED, UNTOUCHED, REVERSED], sections)).toEqual(
      new Map([[UNTOUCHED, 4]])
    );
  });

  it('drops a section the refreshed project no longer has', () => {
    // Nothing left to mirror into, and no count to mirror against.
    expect(netReversedShotCounts([REVERSED], []).size).toBe(0);
  });

  it('drops a shot-less section, which reverses to itself', () => {
    // The backend reports it (the command names it either way), but a single
    // station has no other end - mirroring it would only churn the UI state
    // `applyReverseAftermath` clears.
    expect(netReversedShotCounts([REVERSED], [section(REVERSED, 0)]).size).toBe(0);
  });
});
