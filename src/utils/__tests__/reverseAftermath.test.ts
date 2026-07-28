/**
 * Plan-pin mirroring after a section reverse (#24).
 *
 * The hazard these pin: a reverse renumbers station `i` to `N - i`, so a
 * positional `StationRef` stays IN RANGE and silently names a different physical
 * station. For the gas plan that means the same UI re-prices a different route,
 * with no error - so every assertion here compares against a mirrored index, and
 * every fixture uses a station index that differs from its mirror.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyTransform,
  composeReverseTransforms,
  isIdentityTransform,
  mirrorRef,
  mirrorPlanPins,
  planPinsAffected,
  singleReverseTransform,
  type PlanPins,
  type ReverseTransform,
} from '../reverseAftermath';
import { applyReverseAftermath } from '../reverseAftermath';
import { useGasPlanStore } from '../../store/gasPlanStore';
import type { Section } from '../../types/project';

const REVERSED = 7;
const UNTOUCHED = 9;
/** 7 shots -> 8 stations, so station 2 mirrors to 5. Deliberately not 4 (its own mirror). */
const counts = new Map([[REVERSED, singleReverseTransform(7)]]);

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

  it('is an involution for an in-range index', () => {
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

  it('leaves an out-of-range ref exactly where it is for an identity transform', () => {
    // The clamp is the reason `mirrorRef` skips an identity entry outright
    // instead of running `applyTransform`: `i -> i` still clamps, so a pin that
    // already sat past the end would be dragged onto the last station by an
    // operation that renumbered NOTHING.
    const identity = new Map([[REVERSED, { shift: 0, sign: 1 as const, maxIndex: 7 }]]);
    expect(mirrorRef(ref(REVERSED, 12), identity)).toEqual(ref(REVERSED, 12));
    expect(applyTransform(ref(REVERSED, 12), { shift: 0, sign: 1, maxIndex: 7 })).toEqual(
      ref(REVERSED, 7)
    );
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

  it('ignores a section whose reverses cancelled out', () => {
    // Nothing was renumbered there, so re-installing the plan would be pure churn
    // (and, for an out-of-range pin, an actual move - see the identity test above).
    const identity = new Map([[REVERSED, { shift: 0, sign: 1 as const, maxIndex: 7 }]]);
    expect(planPinsAffected(pins({ origin: ref(REVERSED, 2) }), identity)).toBe(false);
  });
});

/**
 * Which sections a reverse (or the undo/redo of one) renumbered, and against
 * which shot count, comes straight off `CommandResult.reversed_sections` (#24) -
 * the geometry cannot answer it, because a reverse keeps every world coordinate
 * and a section that was reversed AND moved in the same action matches neither
 * arrangement afterwards.
 *
 * From `undo_to`/`redo_to` that field is an ORDERED PER-STEP LOG with repeats
 * intact, so the entries have to be COMPOSED into one affine map and applied
 * once. Two folds that look obviously right are both wrong:
 *   - cancelling repeats (the old parity `Set`) assumes the count never changed
 *     between the two reverses, which a `CreateShot` in the range breaks;
 *   - replaying `i -> c - i` per entry clamps per step, so an out-of-range pin
 *     goes `p -> 0 -> c` across a pair that between them renumbered nothing.
 */
describe('composeReverseTransforms', () => {
  /** Only `id` and `shots.length` are read, so the shots are placeholders. */
  const section = (id: number, shotCount: number) =>
    ({ id, shots: Array.from({ length: shotCount }, () => ({})) }) as unknown as Pick<
      Section,
      'id' | 'shots'
    >;

  const sections = [section(REVERSED, 7), section(UNTOUCHED, 4)];
  const entry = (section_id: number, shot_count: number) => ({ section_id, shot_count });

  /** Run one index through the composed transform for `sectionId`. */
  const move = (
    transforms: Map<number, ReverseTransform>,
    sectionId: number,
    stationIndex: number
  ) => mirrorRef(ref(sectionId, stationIndex), transforms).station_index;

  it('pairs each reported section with the count it was reversed against', () => {
    expect(composeReverseTransforms([entry(REVERSED, 7)], sections)).toEqual(
      new Map([[REVERSED, singleReverseTransform(7)]])
    );
    expect(
      composeReverseTransforms([entry(UNTOUCHED, 4), entry(REVERSED, 7)], sections)
    ).toEqual(
      new Map([
        [REVERSED, singleReverseTransform(7)],
        [UNTOUCHED, singleReverseTransform(4)],
      ])
    );
  });

  it('is empty when the operation renumbered nothing', () => {
    // Absent is the wire truth for every command that reversed nothing.
    expect(composeReverseTransforms(undefined, sections).size).toBe(0);
    expect(composeReverseTransforms([], sections).size).toBe(0);
  });

  it('collapses two equal-count reverses of one section to the identity', () => {
    const composed = composeReverseTransforms(
      [entry(REVERSED, 7), entry(REVERSED, 7)],
      sections
    );
    const transform = composed.get(REVERSED);
    expect(transform).toBeDefined();
    expect(isIdentityTransform(transform as ReverseTransform)).toBe(true);
    expect(move(composed, REVERSED, 2)).toBe(2);
  });

  it('keeps a third listing as a single net flip', () => {
    const composed = composeReverseTransforms(
      [entry(REVERSED, 7), entry(REVERSED, 7), entry(REVERSED, 7)],
      sections
    );
    expect(composed.get(REVERSED)).toEqual(singleReverseTransform(7));
    expect(move(composed, REVERSED, 2)).toBe(5);
  });

  it('composes an interleaved log per section', () => {
    const composed = composeReverseTransforms(
      [entry(REVERSED, 7), entry(UNTOUCHED, 4), entry(REVERSED, 7)],
      sections
    );
    expect(isIdentityTransform(composed.get(REVERSED) as ReverseTransform)).toBe(true);
    expect(composed.get(UNTOUCHED)).toEqual(singleReverseTransform(4));
  });

  it('composes unequal counts into a pure shift, which neither naive fold gets', () => {
    // `[Reverse, CreateShot, Reverse]` undone as one range: the first step
    // mirrors against 4 shots, the second against 3, and the refreshed section
    // has 3. Composed that is `i -> 3 - (4 - i) = i - 1`.
    const composed = composeReverseTransforms(
      [entry(REVERSED, 4), entry(REVERSED, 3)],
      [section(REVERSED, 3)]
    );
    expect(composed.get(REVERSED)).toEqual({ shift: -1, sign: 1, maxIndex: 3 });
    // Cancelling the repeat (the old parity Set) leaves this at 2.
    expect(move(composed, REVERSED, 2)).toBe(1);
    expect(move(composed, REVERSED, 3)).toBe(2);
    // Keeping the repeat but dividing by the post-range count instead would give
    // `3 - 0 = 3`; the composed answer is `-1`, clamped once into range.
    expect(move(composed, REVERSED, 0)).toBe(0);
  });

  it('divides by the count in force at the step, not the post-range one', () => {
    // A single undone reverse whose section then lost a shot later in the range:
    // the entry says 4, the refreshed project says 3. Mirroring against 3 would
    // land station 3 on 0; against 4 it lands on 1.
    const composed = composeReverseTransforms(
      [entry(REVERSED, 4)],
      [section(REVERSED, 3)]
    );
    expect(composed.get(REVERSED)).toEqual({ shift: 4, sign: -1, maxIndex: 3 });
    expect(move(composed, REVERSED, 3)).toBe(1);
  });

  it('drops a section the refreshed project no longer has', () => {
    // Nothing left to mirror into, and no range to clamp against.
    expect(composeReverseTransforms([entry(REVERSED, 7)], []).size).toBe(0);
  });

  it('drops a shot-less section, which reverses to itself', () => {
    // A single station has no other end - mirroring it would only churn the UI
    // state `applyReverseAftermath` clears.
    expect(
      composeReverseTransforms([entry(REVERSED, 7)], [section(REVERSED, 0)]).size
    ).toBe(0);
  });
});

describe('applyReverseAftermath and the loaded-plan baseline', () => {
  beforeEach(() => {
    useGasPlanStore.setState({
      origin: ref(REVERSED, 2),
      endpoint: null,
      waypoints: [],
      markedPoints: [],
      stageDropOverrides: [],
      loadedPlanId: 1,
      loadedPlanBaseline: null,
    });
  });

  it('mirrors the saved-plan baseline alongside the pins', () => {
    // The baseline holds the same POSITIONAL refs as the live pins. Mirroring one without the
    // other makes selectIsPlanDirty compare two different numberings and call a plan the diver
    // never touched unsaved - nagging a save, or blocking a plan switch, over a route that is
    // still the same physical route.
    const store = useGasPlanStore.getState();
    store.applyLoadedPlan(1, {
      origin: ref(REVERSED, 2),
      endpoint: null,
      waypoints: [],
      diver: store.diver,
      cylinders: store.cylinders,
      gas_config: store.gasConfig,
      stage_drop_overrides: [],
      marked_points: [],
      segments: store.segments,
    });

    applyReverseAftermath(counts);

    const after = useGasPlanStore.getState();
    expect(after.origin).toEqual(ref(REVERSED, 5));
    expect(after.loadedPlanBaseline?.origin).toEqual(ref(REVERSED, 5));
  });

  it('leaves a baseline in an untouched section alone', () => {
    const store = useGasPlanStore.getState();
    store.applyLoadedPlan(1, {
      origin: ref(UNTOUCHED, 2),
      endpoint: null,
      waypoints: [],
      diver: store.diver,
      cylinders: store.cylinders,
      gas_config: store.gasConfig,
      stage_drop_overrides: [],
      marked_points: [],
      segments: store.segments,
    });

    applyReverseAftermath(counts);

    expect(useGasPlanStore.getState().loadedPlanBaseline?.origin).toEqual(ref(UNTOUCHED, 2));
  });
});
