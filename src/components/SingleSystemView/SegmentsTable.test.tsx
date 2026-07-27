/**
 * Component test (#317) - the Segments tab: one row per span between way points, the
 * length-sync invariant is exercised at the store level (gasPlanStore.test.ts), so this
 * covers the table's OWN responsibilities: labeling a span's endpoints, editing speed,
 * gating the scooter checkbox on a configured DPV rig, and marking the engine-derived park
 * point without re-deriving it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SegmentsTable } from './SegmentsTable';
import { useGasPlanStore } from '../../store/gasPlanStore';
import { defaultConfig } from '../../types/config';
import type { GasReachField } from '../../types/ipc.generated';

const A = { section_id: 1, station_index: 2 };
const B = { section_id: 1, station_index: 5 };

function fakeField(overrides: Partial<GasReachField> = {}): GasReachField {
  return {
    station_refs: [],
    gas_to_reach: [],
    reachable: [],
    turn_frontier: [],
    max_reachable_gas: 0,
    budget_litres: 0,
    route: [],
    stage_drop_refs: [],
    final_turn_ref: null,
    turn_toward_endpoint: false,
    backgas_turn_bar: null,
    stage_drop_bars: [],
    stage_drop_over_reserve: [],
    stage_drop_distances_m: [],
    cylinder_usable_bars: [],
    route_line_length_m: 0,
    route_max_depth_m: null,
    route_avg_depth_m: null,
    waypoint_gas_litres: [],
    scooter_distance_m: 0,
    scooter_range_limit_m: null,
    scooter_drop_ref: null,
    route_runtime_min: null,
    turn_on_scooter_range: false,
    ...overrides,
  };
}

beforeEach(() => {
  useGasPlanStore.getState().reset();
});

describe('SegmentsTable', () => {
  it('renders one row per segment, labeling the first Entrance and the last Onward', () => {
    useGasPlanStore.getState().addWaypoint(A);
    useGasPlanStore.getState().addWaypoint(B);
    render(<SegmentsTable />);

    expect(screen.getByTestId('segment-row-0')).toHaveTextContent('Entrance');
    expect(screen.getByTestId('segment-row-2')).toHaveTextContent('Onward');
  });

  it('labels the origin instead of Entrance once one is set', () => {
    useGasPlanStore.getState().setOrigin(A);
    render(<SegmentsTable />);
    expect(screen.getByTestId('segment-row-0')).toHaveTextContent('1:2');
    expect(screen.queryByTestId('segment-row-0')).not.toHaveTextContent('Entrance');
  });

  it('committing a speed edit updates the store and nulls the cached reach field', async () => {
    const user = userEvent.setup();
    useGasPlanStore.setState({ reachField: fakeField() });
    render(<SegmentsTable />);

    const input = screen.getByTestId('segment-speed-0');
    await user.clear(input);
    await user.type(input, '18');
    await user.tab();

    expect(useGasPlanStore.getState().segments[0]?.speed_m_per_min).toBe(18);
    expect(useGasPlanStore.getState().reachField).toBeNull();
  });

  it('disables the scooter checkbox with a hint when no DPV rig is configured', () => {
    useGasPlanStore.setState({ gasConfig: { ...defaultConfig.gas, dpv: null } });
    render(<SegmentsTable />);
    expect(screen.getByTestId('segment-scooter-0')).toBeDisabled();
    expect(screen.getByTestId('segments-no-rig-hint')).toBeInTheDocument();
  });

  it('enables the scooter checkbox once a rig is configured, and toggling it updates the store', async () => {
    const user = userEvent.setup();
    useGasPlanStore.setState({
      gasConfig: {
        ...defaultConfig.gas,
        dpv: {
          primary: { speed_m_per_min: 24, burn_minutes: 60, label: null },
          backup: { speed_m_per_min: 18, burn_minutes: 45, label: null },
          range_reserve_fraction: 0.2,
        },
      },
    });
    render(<SegmentsTable />);

    const checkbox = screen.getByTestId('segment-scooter-0');
    expect(checkbox).not.toBeDisabled();
    expect(screen.queryByTestId('segments-no-rig-hint')).not.toBeInTheDocument();

    await user.click(checkbox);
    expect(useGasPlanStore.getState().segments[0]?.on_scooter).toBe(true);
  });

  it('marks the segment boundary the engine names as the DPV park point, and no other', () => {
    useGasPlanStore.getState().addWaypoint(A);
    useGasPlanStore.getState().addWaypoint(B);
    useGasPlanStore.setState({ reachField: fakeField({ scooter_drop_ref: A }) });
    render(<SegmentsTable />);

    // Segment 0 spans Entrance -> A: the drop is named at A, so it marks the END of row 0.
    expect(screen.getByTestId('segment-park-0')).toBeInTheDocument();
    expect(screen.queryByTestId('segment-park-1')).not.toBeInTheDocument();
  });

  it('shows no park marker when the engine has not derived one (null scooter_drop_ref)', () => {
    useGasPlanStore.getState().addWaypoint(A);
    useGasPlanStore.setState({ reachField: fakeField({ scooter_drop_ref: null }) });
    render(<SegmentsTable />);

    expect(screen.queryByTestId('segment-park-0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('segment-park-1')).not.toBeInTheDocument();
  });
});
