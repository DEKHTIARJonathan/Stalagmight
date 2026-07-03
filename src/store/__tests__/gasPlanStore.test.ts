import { describe, it, expect, beforeEach } from 'vitest';
import { useGasPlanStore } from '../gasPlanStore';
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
