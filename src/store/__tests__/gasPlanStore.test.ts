import { describe, it, expect, beforeEach } from 'vitest';
import { useGasPlanStore, selectIsPlanDirty } from '../gasPlanStore';
import { divePlanSnapshotOf } from '../../utils/divePlan';
import { defaultConfig } from '../../types/config';
import type { GasReachField } from '../../types/ipc.generated';

const fakeField = (): GasReachField => ({
  station_refs: [],
  gas_to_reach: [],
  reachable: [],
  turn_frontier: [],
  max_reachable_gas: 0,
  budget_litres: 0,
  route: [],
  stage_drop_refs: [],
  final_turn_ref: null,
  backgas_turn_bar: null,
  stage_drop_bars: [],
  stage_drop_over_reserve: [],
  stage_drop_distances_m: [],
  cylinder_usable_bars: [],
  route_line_length_m: 0,
  route_max_depth_m: null,
  route_avg_depth_m: null,
  waypoint_gas_litres: [],
});

describe('gasPlanStore', () => {
  beforeEach(() => {
    useGasPlanStore.getState().reset();
  });

  it('seeds gasConfig from defaultConfig.gas and a twin-AL80 back-gas default rig', () => {
    const s = useGasPlanStore.getState();
    expect(s.origin).toBeNull();
    expect(s.diver.rmv_l_per_min).toBe(20);
    expect(s.cylinders).toHaveLength(2);
    expect(s.cylinders.every((c) => c.role === 'back_gas')).toBe(true);
    expect(s.gasConfig.default_reserve).toBe(defaultConfig.gas.default_reserve);
    expect(s.gasConfig.units).toBe(defaultConfig.gas.units);
  });

  it('does not share the gasConfig object reference with defaultConfig (no mutation bleed)', () => {
    expect(useGasPlanStore.getState().gasConfig).not.toBe(defaultConfig.gas);
  });

  it.each([
    ['setOrigin', () => useGasPlanStore.getState().setOrigin({ section_id: 1, station_index: 0 })],
    ['setEndpoint', () => useGasPlanStore.getState().setEndpoint({ section_id: 1, station_index: 2 })],
    ['setDiver', () => useGasPlanStore.getState().setDiver({ rmv_l_per_min: 18, label: null })],
    ['setCylinders', () => useGasPlanStore.getState().setCylinders([])],
    ['setGasConfig', () => useGasPlanStore.getState().setGasConfig({ ...defaultConfig.gas })],
  ])('%s nulls the cached reachField (no stale overlay under changed inputs)', (_name, mutate) => {
    useGasPlanStore.setState({ reachField: fakeField() });
    expect(useGasPlanStore.getState().reachField).not.toBeNull();
    mutate();
    expect(useGasPlanStore.getState().reachField).toBeNull();
  });

  it('setReachField stores the field; reset clears it and restores defaults', () => {
    useGasPlanStore.getState().setOrigin({ section_id: 3, station_index: 2 });
    useGasPlanStore.getState().setReachField(fakeField());
    expect(useGasPlanStore.getState().reachField).not.toBeNull();
    useGasPlanStore.getState().reset();
    const s = useGasPlanStore.getState();
    expect(s.reachField).toBeNull();
    expect(s.origin).toBeNull();
    expect(s.cylinders).toHaveLength(2);
  });

  it('endpoint defaults null and is cleared by reset (no leak across plan sessions)', () => {
    expect(useGasPlanStore.getState().endpoint).toBeNull();
    useGasPlanStore.getState().setEndpoint({ section_id: 2, station_index: 4 });
    expect(useGasPlanStore.getState().endpoint).toEqual({ section_id: 2, station_index: 4 });
    useGasPlanStore.getState().reset();
    expect(useGasPlanStore.getState().endpoint).toBeNull();
  });

  it('pushyAck defaults false and is cleared by reset (re-prompt each Plan session)', () => {
    expect(useGasPlanStore.getState().pushyAck).toBe(false);
    useGasPlanStore.getState().setPushyAck(true);
    expect(useGasPlanStore.getState().pushyAck).toBe(true);
    useGasPlanStore.getState().reset();
    expect(useGasPlanStore.getState().pushyAck).toBe(false);
  });

  it('setStageDropOverride pins a drop by index and pads sparse slots with null (#246)', () => {
    const ref = { section_id: 1, station_index: 3 };
    useGasPlanStore.getState().setStageDropOverride(1, ref);
    // Index 0 was never set, so it pads with null; index 1 holds the pinned station.
    expect(useGasPlanStore.getState().stageDropOverrides).toEqual([null, ref]);
    // A negative index is a no-op (never grows the array).
    useGasPlanStore.getState().setStageDropOverride(-1, ref);
    expect(useGasPlanStore.getState().stageDropOverrides).toEqual([null, ref]);
    // Passing null resets that drop back to the strategy default.
    useGasPlanStore.getState().setStageDropOverride(1, null);
    expect(useGasPlanStore.getState().stageDropOverrides).toEqual([null, null]);
  });

  it('setStageDropOverride does NOT null reachField (markers stay put during refetch) (#246)', () => {
    useGasPlanStore.getState().setReachField(fakeField());
    useGasPlanStore.getState().setStageDropOverride(0, { section_id: 1, station_index: 2 });
    expect(useGasPlanStore.getState().reachField).not.toBeNull();
  });

  it.each([
    ['setOrigin', () => useGasPlanStore.getState().setOrigin({ section_id: 1, station_index: 0 })],
    ['setEndpoint', () => useGasPlanStore.getState().setEndpoint({ section_id: 1, station_index: 5 })],
    ['setDiver', () => useGasPlanStore.getState().setDiver({ rmv_l_per_min: 18, label: null })],
    ['setCylinders', () => useGasPlanStore.getState().setCylinders([])],
    ['setGasConfig', () => useGasPlanStore.getState().setGasConfig({ ...defaultConfig.gas })],
  ])('%s clears stageDropOverrides (a reshuffled rig invalidates pinned drops) (#246)', (_n, mutate) => {
    useGasPlanStore.getState().setStageDropOverride(0, { section_id: 1, station_index: 2 });
    expect(useGasPlanStore.getState().stageDropOverrides).toHaveLength(1);
    mutate();
    expect(useGasPlanStore.getState().stageDropOverrides).toEqual([]);
  });

  it('reset clears stageDropOverrides (no leak across plan sessions) (#246)', () => {
    useGasPlanStore.getState().setStageDropOverride(0, { section_id: 1, station_index: 2 });
    expect(useGasPlanStore.getState().stageDropOverrides).toHaveLength(1);
    useGasPlanStore.getState().reset();
    expect(useGasPlanStore.getState().stageDropOverrides).toEqual([]);
  });
});

describe('gasPlanStore way points (#298)', () => {
  const a = { section_id: 1, station_index: 1 };
  const b = { section_id: 1, station_index: 5 };

  beforeEach(() => {
    useGasPlanStore.getState().reset();
  });

  it('adds in click order and removes by index', () => {
    useGasPlanStore.getState().addWaypoint(a);
    useGasPlanStore.getState().addWaypoint(b);
    expect(useGasPlanStore.getState().waypoints).toEqual([a, b]);
    useGasPlanStore.getState().removeWaypoint(0);
    expect(useGasPlanStore.getState().waypoints).toEqual([b]);
  });

  it('moveWaypoint swaps with the neighbour and clamps at both ends', () => {
    useGasPlanStore.getState().addWaypoint(a);
    useGasPlanStore.getState().addWaypoint(b);
    useGasPlanStore.getState().moveWaypoint(1, -1);
    expect(useGasPlanStore.getState().waypoints).toEqual([b, a]);
    // Off either end is a no-op, so the panel's arrows need no bounds logic of their own.
    useGasPlanStore.getState().moveWaypoint(0, -1);
    useGasPlanStore.getState().moveWaypoint(1, 1);
    useGasPlanStore.getState().moveWaypoint(99, -1);
    expect(useGasPlanStore.getState().waypoints).toEqual([b, a]);
  });

  it('a stray remove index is a no-op (never truncates the list)', () => {
    useGasPlanStore.getState().addWaypoint(a);
    useGasPlanStore.getState().removeWaypoint(-1);
    useGasPlanStore.getState().removeWaypoint(7);
    expect(useGasPlanStore.getState().waypoints).toEqual([a]);
  });

  it.each([
    ['addWaypoint', () => useGasPlanStore.getState().addWaypoint(b)],
    ['removeWaypoint', () => useGasPlanStore.getState().removeWaypoint(0)],
    ['moveWaypoint', () => useGasPlanStore.getState().moveWaypoint(0, 1)],
  ])(
    '%s nulls reachField and clears stageDropOverrides (the route is re-based, so the old overlay and pinned drops are both wrong)',
    (_name, mutate) => {
      // Two way points so `moveWaypoint(0, 1)` is a real move rather than an out-of-range no-op.
      useGasPlanStore.getState().addWaypoint(a);
      useGasPlanStore.getState().addWaypoint(b);
      useGasPlanStore.getState().setStageDropOverride(0, { section_id: 1, station_index: 2 });
      useGasPlanStore.setState({ reachField: fakeField() });
      mutate();
      expect(useGasPlanStore.getState().reachField).toBeNull();
      expect(useGasPlanStore.getState().stageDropOverrides).toEqual([]);
    }
  );

  it('reset clears way points (no leak across plan sessions)', () => {
    useGasPlanStore.getState().addWaypoint(a);
    useGasPlanStore.getState().reset();
    expect(useGasPlanStore.getState().waypoints).toEqual([]);
  });
});

describe('gasPlanStore marked points (#298)', () => {
  const at = { section_id: 2, station_index: 3 };

  beforeEach(() => {
    useGasPlanStore.getState().reset();
  });

  it('adds unlabelled, relabels, and removes by index', () => {
    useGasPlanStore.getState().addMarkedPoint(at);
    expect(useGasPlanStore.getState().markedPoints).toEqual([{ station: at, label: null }]);
    useGasPlanStore.getState().setMarkedPointLabel(0, 'photo');
    expect(useGasPlanStore.getState().markedPoints[0]?.label).toBe('photo');
    useGasPlanStore.getState().removeMarkedPoint(0);
    expect(useGasPlanStore.getState().markedPoints).toEqual([]);
  });

  it('an all-whitespace label stores as null (a cleared input is "no label", not a blank one)', () => {
    useGasPlanStore.getState().addMarkedPoint(at);
    useGasPlanStore.getState().setMarkedPointLabel(0, 'photo');
    useGasPlanStore.getState().setMarkedPointLabel(0, '   ');
    expect(useGasPlanStore.getState().markedPoints[0]?.label).toBeNull();
  });

  it.each([
    ['addMarkedPoint', () => useGasPlanStore.getState().addMarkedPoint(at)],
    ['setMarkedPointLabel', () => useGasPlanStore.getState().setMarkedPointLabel(0, 'x')],
    ['removeMarkedPoint', () => useGasPlanStore.getState().removeMarkedPoint(0)],
  ])(
    '%s does NOT null reachField (an annotation cannot change the plan, so flashing the overlay off would be a lie)',
    (_name, mutate) => {
      useGasPlanStore.getState().addMarkedPoint(at);
      useGasPlanStore.setState({ reachField: fakeField() });
      mutate();
      expect(useGasPlanStore.getState().reachField).not.toBeNull();
    }
  );

  it('but marking IS dirty-tracked, so an unsaved mark still hits the close guard', () => {
    const snapshot = divePlanSnapshotOf(useGasPlanStore.getState());
    useGasPlanStore.getState().applyLoadedPlan(3, snapshot);
    expect(selectIsPlanDirty(useGasPlanStore.getState())).toBe(false);
    useGasPlanStore.getState().addMarkedPoint(at);
    expect(selectIsPlanDirty(useGasPlanStore.getState())).toBe(true);
  });

  it('reset clears marked points (no leak across plan sessions)', () => {
    useGasPlanStore.getState().addMarkedPoint(at);
    useGasPlanStore.getState().reset();
    expect(useGasPlanStore.getState().markedPoints).toEqual([]);
  });
});

describe('gasPlanStore dive-plan dirty tracking (#244)', () => {
  beforeEach(() => {
    useGasPlanStore.getState().reset();
  });

  it('is not dirty when no plan is loaded (a never-saved exploration is unguarded)', () => {
    useGasPlanStore.getState().setOrigin({ section_id: 1, station_index: 0 });
    expect(useGasPlanStore.getState().loadedPlanId).toBeNull();
    expect(selectIsPlanDirty(useGasPlanStore.getState())).toBe(false);
  });

  it('applyLoadedPlan sets inputs + baseline, nulls reachField, and reads clean', () => {
    useGasPlanStore.getState().setReachField(fakeField());
    const snapshot = divePlanSnapshotOf(useGasPlanStore.getState());
    snapshot.origin = { section_id: 4, station_index: 1 };
    useGasPlanStore.getState().applyLoadedPlan(7, snapshot);
    const s = useGasPlanStore.getState();
    expect(s.loadedPlanId).toBe(7);
    expect(s.origin).toEqual({ section_id: 4, station_index: 1 });
    expect(s.reachField).toBeNull(); // stale overlay dropped
    expect(selectIsPlanDirty(s)).toBe(false);
  });

  it('becomes dirty when an input diverges from the loaded baseline', () => {
    const snapshot = divePlanSnapshotOf(useGasPlanStore.getState());
    useGasPlanStore.getState().applyLoadedPlan(1, snapshot);
    expect(selectIsPlanDirty(useGasPlanStore.getState())).toBe(false);
    useGasPlanStore.getState().setOrigin({ section_id: 9, station_index: 9 });
    expect(selectIsPlanDirty(useGasPlanStore.getState())).toBe(true);
  });

  it('markPlanSaved rebaselines to the current inputs (clean again)', () => {
    const snapshot = divePlanSnapshotOf(useGasPlanStore.getState());
    useGasPlanStore.getState().applyLoadedPlan(1, snapshot);
    useGasPlanStore.getState().setDiver({ rmv_l_per_min: 15, label: null });
    expect(selectIsPlanDirty(useGasPlanStore.getState())).toBe(true);
    // markPlanSaved takes the exact persisted snapshot (the current inputs here) as the baseline.
    useGasPlanStore.getState().markPlanSaved(1, divePlanSnapshotOf(useGasPlanStore.getState()));
    expect(selectIsPlanDirty(useGasPlanStore.getState())).toBe(false);
    expect(useGasPlanStore.getState().loadedPlanId).toBe(1);
  });

  it('clearLoadedPlan forgets the plan without touching inputs (and reads clean)', () => {
    const snapshot = divePlanSnapshotOf(useGasPlanStore.getState());
    useGasPlanStore.getState().applyLoadedPlan(1, snapshot);
    useGasPlanStore.getState().setOrigin({ section_id: 2, station_index: 2 });
    useGasPlanStore.getState().clearLoadedPlan();
    const s = useGasPlanStore.getState();
    expect(s.loadedPlanId).toBeNull();
    expect(s.origin).toEqual({ section_id: 2, station_index: 2 }); // inputs untouched
    expect(selectIsPlanDirty(s)).toBe(false);
  });

  it('reset clears the loaded plan (no leak across plan sessions)', () => {
    const snapshot = divePlanSnapshotOf(useGasPlanStore.getState());
    useGasPlanStore.getState().applyLoadedPlan(3, snapshot);
    useGasPlanStore.getState().reset();
    expect(useGasPlanStore.getState().loadedPlanId).toBeNull();
    expect(useGasPlanStore.getState().loadedPlanBaseline).toBeNull();
  });

  it('markHydrated sets the session seed flag; reset clears it (re-seed on new session)', () => {
    // Gates the panel's one-time config seed so re-entering Plan mode does not clobber
    // a loaded plan / working inputs (the store persists across mode switches now).
    expect(useGasPlanStore.getState().hydrated).toBe(false);
    useGasPlanStore.getState().markHydrated();
    expect(useGasPlanStore.getState().hydrated).toBe(true);
    useGasPlanStore.getState().reset();
    expect(useGasPlanStore.getState().hydrated).toBe(false);
  });
});
