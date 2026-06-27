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
});
