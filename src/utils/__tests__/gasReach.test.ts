import { describe, it, expect } from 'vitest';
import {
  buildGasReachFeatureState,
  gasReachColorExpression,
  reachableStationKeySet,
  UNREACHABLE_GAS,
} from '../gasReach';
import { encodeFeatureId } from '../ids';
import type { Section } from '../../types/project';
import type { GasReachField } from '../../types/ipc.generated';

describe('buildGasReachFeatureState', () => {
  // Section 1: shots id10 (st0→st1), id11 (st1→st2). Section 2: shot id20 (st0→st1).
  const sections = [
    { id: 1, shots: [{ id: 10 }, { id: 11 }] },
    { id: 2, shots: [{ id: 20 }] },
  ] as unknown as Section[];

  // (1,2) is finite-but-OVER-budget (gas_to_reach 1500 > budget 1000, reachable false)
  // — the adversarial case. (2,1) is disconnected (null). Budget is 1000.
  const field: GasReachField = {
    station_refs: [
      { section_id: 1, station_index: 0 },
      { section_id: 1, station_index: 1 },
      { section_id: 1, station_index: 2 },
      { section_id: 2, station_index: 0 },
      { section_id: 2, station_index: 1 },
    ],
    gas_to_reach: [0, 300, 1500, 200, null],
    reachable: [true, true, false, true, false],
    turn_frontier: [{ section_id: 1, station_index: 1 }],
    max_reachable_gas: 300,
    budget_litres: 1000,
    route: [],
    stage_drop_refs: [],
    final_turn_ref: null,
    backgas_turn_bar: null,
    stage_drop_bars: [],
    route_line_length_m: 0,
    route_max_depth_m: null,
    route_avg_depth_m: null,
  };

  it('maps each reachable station to its litres-to-reach, keyed by encodeFeatureId', () => {
    const { stations } = buildGasReachFeatureState(sections, field);
    expect(stations.get(encodeFeatureId(1, 0))).toBe(0);
    expect(stations.get(encodeFeatureId(1, 1))).toBe(300);
    expect(stations.get(encodeFeatureId(2, 0))).toBe(200);
  });

  it('greys a finite-but-OVER-budget station (the conservative direction — never paint it reachable)', () => {
    // gas_to_reach is Some(1500) but reachable=false; it must NOT leak the 1500 value.
    const { stations } = buildGasReachFeatureState(sections, field);
    expect(stations.get(encodeFeatureId(1, 2))).toBe(UNREACHABLE_GAS);
  });

  it('greys a disconnected station (null gas_to_reach)', () => {
    const { stations } = buildGasReachFeatureState(sections, field);
    expect(stations.get(encodeFeatureId(2, 1))).toBe(UNREACHABLE_GAS);
  });

  it('colors a shot by the average of its two reachable endpoints, keyed by shot id', () => {
    const { shots } = buildGasReachFeatureState(sections, field);
    // shot id10: endpoints st0=0, st1=300 → avg 150
    expect(shots.get(encodeFeatureId(1, 10))).toBe(150);
  });

  it('greys a shot when either endpoint is unreachable (over-budget OR disconnected)', () => {
    const { shots } = buildGasReachFeatureState(sections, field);
    // id11: st1=300 reachable, st2 over-budget → grey
    expect(shots.get(encodeFeatureId(1, 11))).toBe(UNREACHABLE_GAS);
    // id20: st0=200 reachable, st1 disconnected → grey
    expect(shots.get(encodeFeatureId(2, 20))).toBe(UNREACHABLE_GAS);
  });

  it('uses the turn budget (not max_reachable_gas) as the interpolate scale max', () => {
    // The scale must end at the budget so purple always means "at your turn pressure",
    // even when the whole reachable cave costs less than the budget.
    expect(buildGasReachFeatureState(sections, field).max).toBe(1000);
  });
});

describe('gasReachColorExpression', () => {
  it('greys negative (unreachable) gasReach and interpolates near→far over 0→budget', () => {
    const s = JSON.stringify(gasReachColorExpression('#aaaaaa', '#bbbbbb', 1000, '#888888'));
    expect(s).toContain('interpolate');
    expect(s).toContain('coalesce');
    expect(s).toContain('gasReach'); // reads the dedicated feature-state key
    expect(s).toContain('#888888'); // grey branch for the unreachable sentinel
  });

  it('guards a non-positive budget so the interpolate stops never collide', () => {
    const s = JSON.stringify(gasReachColorExpression('#aaaaaa', '#bbbbbb', 0, '#888888'));
    // safeMax falls back to 1 (no throw, valid expression).
    expect(s).toContain('interpolate');
  });
});

describe('reachableStationKeySet', () => {
  const field = {
    station_refs: [
      { section_id: 1, station_index: 0 },
      { section_id: 1, station_index: 1 },
      { section_id: 1, station_index: 2 },
      { section_id: 2, station_index: 0 },
    ],
    reachable: [true, false, true, true],
    // remaining GasReachField fields are unused by this helper
  } as unknown as GasReachField;

  it('keys only the reachable stations, by section_id:station_index', () => {
    const keys = reachableStationKeySet(field);
    expect(keys).toEqual(new Set(['1:0', '1:2', '2:0']));
    expect(keys.has('1:1')).toBe(false); // unreachable is excluded
  });

  it('returns an empty set when nothing is reachable', () => {
    const none = { ...field, reachable: [false, false, false, false] } as unknown as GasReachField;
    expect(reachableStationKeySet(none).size).toBe(0);
  });
});
