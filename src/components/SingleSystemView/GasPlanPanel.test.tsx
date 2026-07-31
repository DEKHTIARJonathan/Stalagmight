/**
 * Component test (#241) - swim-speed disk-persist debounce.
 *
 * `PositiveNumberField` fires `onCommit` on every valid keystroke (not just
 * blur), and the swim-speed field's `onCommit` used to call
 * `useProjectStore.getState().updateGasConfig(...)` unsequenced on every one of
 * those commits - a fast typist fired one disk write per keystroke, and
 * out-of-order completion could persist an earlier intermediate value. The
 * fix debounces the disk write (keeping the in-memory `setGasConfig` update
 * immediate) so only the LATEST value is ever persisted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('./DivePlanBar', () => ({ DivePlanBar: () => null }));

import { GasPlanPanel } from './GasPlanPanel';
import { useGasPlanStore } from '../../store/gasPlanStore';
import { useProjectStore } from '../../store/projectStore';
import { flushGasConfigWrite } from '../../utils/gasConfigDisk';
import { defaultConfig } from '../../types/config';
import type { Config } from '../../types/config';
import type { DpvRig, GasReachField } from '../../types/ipc.generated';

const RIG: DpvRig = {
  primary: { speed_m_per_min: 24, burn_minutes: 60 },
  backup: { speed_m_per_min: 18, burn_minutes: 45 },
  range_reserve_fraction: 0.2,
};

/** A full GasReachField with a real turnaround (satisfies `hasRoute`), overridable per test. */
function makeReachField(overrides: Partial<GasReachField> = {}): GasReachField {
  const origin = { section_id: 1, station_index: 0 };
  const turn = { section_id: 1, station_index: 1 };
  return {
    station_refs: [origin, turn],
    gas_to_reach: [0, 100],
    reachable: [true, true],
    turn_frontier: [turn],
    max_reachable_gas: 100,
    budget_litres: 1000,
    route: [{ from: origin, to: turn, is_jump: false }],
    stage_drop_refs: [],
    final_turn_ref: turn,
    turn_toward_endpoint: false,
    backgas_turn_bar: 150,
    stage_drop_bars: [],
    stage_drop_over_reserve: [],
    stage_drop_distances_m: [],
    cylinder_usable_bars: [],
    route_line_length_m: 200,
    route_max_depth_m: 20,
    route_avg_depth_m: 10,
    waypoint_gas_litres: [],
    route_profile: [],
    stage_drop_route_indices: [],
    waypoint_route_indices: [],
    scooter_distance_m: 0,
    scooter_range_limit_m: null,
    scooter_drop_ref: null,
    route_runtime_min: 20,
    turn_on_scooter_range: false,
    ...overrides,
  };
}

beforeEach(async () => {
  // Drain anything a previous test left in the shared gas-config write queue into the OLD
  // mocks, so it cannot pollute this test's call counts.
  await flushGasConfigWrite();
  vi.useFakeTimers();
  useGasPlanStore.setState({
    origin: null,
    endpoint: null,
    diver: { rmv_l_per_min: 20, label: null },
    cylinders: [],
    gasConfig: structuredClone(defaultConfig.gas),
    reachField: null,
    stageDropOverrides: [],
    loadedPlanId: null,
    loadedPlanBaseline: null,
    pushyAck: false,
    hydrated: true, // skip the one-time re-seed effect so gasConfig sticks
  });
  useProjectStore.setState({
    config: structuredClone(defaultConfig) as Config,
    updateGasConfig: vi.fn(async () => ({ success: true, error: null, warnings: [], section_ids: [] })),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GasPlanPanel swim-speed persist debounce (#241)', () => {
  it('coalesces rapid keystrokes into a single debounced updateGasConfig call', async () => {
    render(<GasPlanPanel />);
    const input = screen.getByTestId('gas-swim-speed-input');

    fireEvent.change(input, { target: { value: '11' } });
    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.change(input, { target: { value: '13' } });

    // No disk write yet - only the debounce timer has been (re)armed.
    expect(useProjectStore.getState().updateGasConfig).not.toHaveBeenCalled();

    vi.runAllTimers();
    // The debounce timer only QUEUES the write onto the serialized chain - await it landing.
    await flushGasConfigWrite();

    const updateGasConfig = useProjectStore.getState().updateGasConfig;
    expect(updateGasConfig).toHaveBeenCalledTimes(1);
    expect(updateGasConfig).toHaveBeenCalledWith(
      expect.objectContaining({ swim_speed_m_per_min: 13 }),
    );
  });

  it('updates the in-memory working config immediately on every keystroke', () => {
    render(<GasPlanPanel />);
    const input = screen.getByTestId('gas-swim-speed-input');

    fireEvent.change(input, { target: { value: '14' } });

    expect(useGasPlanStore.getState().gasConfig.swim_speed_m_per_min).toBe(14);
    // Still debounced - the disk write hasn't fired.
    expect(useProjectStore.getState().updateGasConfig).not.toHaveBeenCalled();
  });

  it('flushes a pending write on unmount so a value typed right before leaving is not lost', async () => {
    const { unmount } = render(<GasPlanPanel />);
    const input = screen.getByTestId('gas-swim-speed-input');

    fireEvent.change(input, { target: { value: '15' } });
    expect(useProjectStore.getState().updateGasConfig).not.toHaveBeenCalled();

    // Leaving Plan mode unmounts the panel before the 450ms debounce elapses; the
    // pending value must still be persisted (parity with the pre-debounce behavior
    // that wrote every keystroke), not dropped.
    unmount();
    // Unmount flushes fire-and-forget; await the chain so the assertion sees the landed write.
    await flushGasConfigWrite();

    const updateGasConfig = useProjectStore.getState().updateGasConfig;
    expect(updateGasConfig).toHaveBeenCalledTimes(1);
    expect(updateGasConfig).toHaveBeenCalledWith(
      expect.objectContaining({ swim_speed_m_per_min: 15 }),
    );
  });
});

describe('GasPlanPanel scooter (DPV) readout (#317)', () => {
  it('does not render the scooter rows without a configured rig, but still shows runtime', () => {
    useGasPlanStore.setState({
      gasConfig: { ...defaultConfig.gas, dpv: null },
      reachField: makeReachField(),
    });
    render(<GasPlanPanel />);

    expect(screen.queryByTestId('gas-readout-scooter-range')).toBeNull();
    expect(screen.queryByTestId('gas-readout-scooter-turn-warning')).toBeNull();
    // Runtime is useful with or without a rig - the segment speed still applies either way.
    expect(screen.getByTestId('gas-readout-route-runtime')).toHaveTextContent('20.0 min');
  });

  it('renders the scooter distance/range row and runtime once a rig is configured', () => {
    useGasPlanStore.setState({
      gasConfig: { ...defaultConfig.gas, dpv: RIG },
      reachField: makeReachField({ scooter_distance_m: 150, scooter_range_limit_m: 220 }),
    });
    render(<GasPlanPanel />);

    expect(screen.getByTestId('gas-readout-scooter-range')).toHaveTextContent('150 m / 220 m');
    expect(screen.getByTestId('gas-readout-route-runtime')).toHaveTextContent('20.0 min');
    expect(screen.queryByTestId('gas-readout-scooter-turn-warning')).toBeNull();
  });

  it('reports a scooter-range turn ONLY from the engine flag, never re-derived from the numbers', () => {
    // Adversarial case: distance == limit (the two would read as "equal" under a naive
    // re-derivation) but the engine says gas, not scooter range, is what turned this dive.
    useGasPlanStore.setState({
      gasConfig: { ...defaultConfig.gas, dpv: RIG },
      reachField: makeReachField({
        scooter_distance_m: 220,
        scooter_range_limit_m: 220,
        turn_on_scooter_range: false,
      }),
    });
    render(<GasPlanPanel />);

    expect(screen.queryByTestId('gas-readout-scooter-turn-warning')).toBeNull();
  });

  it('shows the scooter-range turn message when the engine flag is true', () => {
    useGasPlanStore.setState({
      gasConfig: { ...defaultConfig.gas, dpv: RIG },
      reachField: makeReachField({
        scooter_distance_m: 200,
        scooter_range_limit_m: 220,
        turn_on_scooter_range: true,
      }),
    });
    render(<GasPlanPanel />);

    expect(screen.getByTestId('gas-readout-scooter-turn-warning')).toBeInTheDocument();
  });
});

/**
 * #317: the jump RMV multiplier (alongside the include-reference-legs toggle) has NO in-panel
 * control, so Settings is its only source. The panel's seed-once `hydrated` gate (#244, which
 * exists so a mode-switch remount cannot clobber working inputs or a loaded plan) therefore
 * swallowed it entirely: nudge the jump multiplier after opening Plan mode even once and the new
 * value never appeared, with nothing on screen to explain why.
 *
 * The fix mirrors a Settings-only field EDITED IN SETTINGS during the session into the working
 * config via `gasPlanStore.syncSettingsOnlyGasFields`, keyed on the persisted value changing
 * rather than differing - which is what keeps a loaded plan's own value from being silently
 * overwritten by a personal default it was never planned on. That diffing lives in the STORE, not
 * a component ref, because the panel remounts on every mode switch and a ref would lose its
 * "already observed this session" memory exactly when the fix needs it most (see the remount
 * test below - the bug this replaced was that exact ref losing its memory on remount).
 *
 * (The DPV rig used to be probed here too. It now has its own in-panel editor and its own store
 * setter, `setDpvRig` - see `gasPlanStore.test.ts` - so it is no longer part of this sync.)
 */
describe('GasPlanPanel Settings-only gas sync (#317)', () => {
  it('picks up a jump-multiplier edit made in Settings while the panel stays mounted', () => {
    // `hydrated: true` from beforeEach is the whole point: this is the state the bug lived in.
    const { rerender } = render(<GasPlanPanel />);
    expect(useGasPlanStore.getState().gasConfig.jump_rmv_multiplier).toBe(
      defaultConfig.gas.jump_rmv_multiplier
    );

    // The diver opens Settings > Gas and changes the jump multiplier.
    const next = structuredClone(defaultConfig) as Config;
    next.gas.jump_rmv_multiplier = 2.5;
    useProjectStore.setState({ config: next });
    rerender(<GasPlanPanel />);

    expect(useGasPlanStore.getState().gasConfig.jump_rmv_multiplier).toBe(2.5);
  });

  it('picks up a jump-multiplier edit made in Settings AFTER the panel unmounts and remounts (mode switch)', () => {
    // THE regression test: a real `unmount()` + fresh `render()`, not `rerender()` of the same
    // instance. `rerender` cannot reproduce the bug this guards - it never destroys the component,
    // so a component-local ref would still have its memory intact and the test would pass even
    // with the broken mechanism reinstated. The realistic flow is "leave Plan mode (unmounts the
    // panel), change the jump multiplier in Settings, come back to Plan (a brand-new component
    // instance)".
    const { unmount } = render(<GasPlanPanel />);
    expect(useGasPlanStore.getState().gasConfig.jump_rmv_multiplier).toBe(
      defaultConfig.gas.jump_rmv_multiplier
    );
    unmount();

    const next = structuredClone(defaultConfig) as Config;
    next.gas.jump_rmv_multiplier = 2.5;
    useProjectStore.setState({ config: next });

    render(<GasPlanPanel />);
    expect(useGasPlanStore.getState().gasConfig.jump_rmv_multiplier).toBe(2.5);
  });

  it('leaves a loaded plan’s own jump multiplier alone when Settings did not change', () => {
    // THE adversarial case, and the reason this syncs on CHANGE rather than on difference. A plan
    // carries its own gas config in its snapshot; a dive planned on a different jump multiplier
    // must not be re-configured just because the diver's personal default disagrees. A naive "if
    // working !== persisted, copy persisted" would fail here, so this is what separates the two
    // designs.
    const settingsConfig = structuredClone(defaultConfig) as Config;
    settingsConfig.gas.jump_rmv_multiplier = 2.5;
    useProjectStore.setState({ config: settingsConfig });
    useGasPlanStore.setState({
      gasConfig: { ...structuredClone(defaultConfig.gas), jump_rmv_multiplier: 3.5 },
    });

    const { rerender } = render(<GasPlanPanel />);
    rerender(<GasPlanPanel />);

    expect(useGasPlanStore.getState().gasConfig.jump_rmv_multiplier).toBe(3.5);
  });
});
