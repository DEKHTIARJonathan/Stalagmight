/**
 * Component test (#299) - the Plan-mode dive profile.
 *
 * The geometry itself is covered in `utils/__tests__/routeProfile.test.ts`; what is asserted here
 * is the wiring the chart owns: that it renders from the store rather than fetching, that the axis
 * toggle actually re-projects, and - the one that matters most - that it shows a "computing" state
 * rather than a stale chart while the reach field is null. Every plan input nulls `reachField`, so
 * that window opens on literally every edit, and a chart that kept painting the previous route
 * would be showing a depth profile for a plan the diver has already changed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ProfileChart } from './ProfileChart';
import { useGasPlanStore } from '../../store/gasPlanStore';
import { defaultConfig } from '../../types/config';
import type { GasReachField, RouteProfilePoint } from '../../types/ipc.generated';

const point = (over: Partial<RouteProfilePoint>): RouteProfilePoint => ({
  route_index: 0,
  station_ref: { section_id: 1, station_index: 0 },
  distance_m: 0,
  depth_m: 0,
  gas_l: 0,
  elapsed_min: 0,
  outbound: true,
  ...over,
});

/** 200 m in at 5 m/min, 200 m out at 10 m/min - so the axes disagree about the turnaround. */
const profile: RouteProfilePoint[] = [
  point({ route_index: 0, distance_m: 0, depth_m: 0, elapsed_min: 0 }),
  point({ route_index: 1, distance_m: 100, depth_m: 12, elapsed_min: 20 }),
  point({ route_index: 2, distance_m: 200, depth_m: 24, elapsed_min: 40 }),
  point({ route_index: 1, distance_m: 300, depth_m: 12, elapsed_min: 50, outbound: false }),
  point({ route_index: 0, distance_m: 400, depth_m: 0, elapsed_min: 60, outbound: false }),
];

const fakeField = (over: Partial<GasReachField> = {}): GasReachField =>
  ({
    station_refs: [],
    gas_to_reach: [],
    reachable: [],
    turn_frontier: [],
    max_reachable_gas: 0,
    budget_litres: 2000,
    route: [],
    stage_drop_refs: [],
    final_turn_ref: null,
    turn_toward_endpoint: false,
    backgas_turn_bar: null,
    stage_drop_bars: [],
    stage_drop_over_reserve: [],
    stage_drop_distances_m: [],
    cylinder_usable_bars: [],
    route_line_length_m: 200,
    route_max_depth_m: 24,
    route_avg_depth_m: 12,
    waypoint_gas_litres: [],
    route_profile: profile,
    stage_drop_route_indices: [],
    waypoint_route_indices: [],
    ...over,
  }) as GasReachField;

const seed = (reachField: GasReachField | null) => {
  useGasPlanStore.setState({
    origin: null,
    endpoint: null,
    waypoints: [],
    diver: { rmv_l_per_min: 20, label: null },
    cylinders: [],
    gasConfig: structuredClone(defaultConfig.gas),
    reachField,
    stageDropOverrides: [],
    loadedPlanId: null,
    loadedPlanBaseline: null,
    pushyAck: false,
    hydrated: true,
  });
};

beforeEach(() => seed(null));

describe('ProfileChart (#299)', () => {
  it('shows the computing state, not a stale chart, while the field is null', () => {
    render(<ProfileChart />);
    expect(screen.getByTestId('plan-profile-empty')).toBeTruthy();
    expect(screen.queryByTestId('plan-profile-svg')).toBeNull();
  });

  it('distinguishes "recomputing" from "this plan has no route"', () => {
    // Both render the same empty pane, and conflating them is a real UX bug: an unreachable
    // endpoint would sit there claiming to be computing forever.
    seed(fakeField({ route_profile: [] }));
    render(<ProfileChart />);
    expect(screen.getByTestId('plan-profile-empty').textContent).toContain('No route to plot');
  });

  it('draws the round trip from the store without asking for a compute', () => {
    seed(fakeField());
    render(<ProfileChart />);
    const svg = screen.getByTestId('plan-profile-svg');
    expect(svg.getAttribute('data-axis')).toBe('distance');
    const line = screen.getByTestId('plan-profile-line').getAttribute('d') ?? '';
    // One command per profile point - the whole round trip, not just the way in.
    expect(line.match(/[ML]/g)?.length).toBe(profile.length);
    expect(line).not.toContain('NaN');
    expect(screen.getByTestId('plan-profile-marker-turn')).toBeTruthy();
  });

  it('re-projects when the axis is toggled, and the turn moves because the legs differ in speed', () => {
    seed(fakeField());
    render(<ProfileChart />);
    const turnX = () => screen.getByTestId('plan-profile-turn-line').getAttribute('x1');
    const byDistance = turnX();

    fireEvent.click(screen.getByTestId('plan-profile-axis-time'));

    expect(screen.getByTestId('plan-profile-svg').getAttribute('data-axis')).toBe('time');
    // On distance the turn is at 200/400 = halfway; on time it is at 40/60 = two thirds. If the
    // toggle only relabelled the axis instead of re-projecting, these would be identical.
    expect(turnX()).not.toBe(byDistance);
    expect(screen.getByTestId('plan-profile-axis-time').getAttribute('aria-pressed')).toBe('true');
    expect(
      screen.getByTestId('plan-profile-axis-distance').getAttribute('aria-pressed')
    ).toBe('false');
  });

  it('marks each stage drop on its outbound pass and flags an over-reserve one', () => {
    seed(
      fakeField({
        stage_drop_route_indices: [1],
        stage_drop_over_reserve: [true],
        waypoint_route_indices: [2],
      })
    );
    render(<ProfileChart />);
    const drop = screen.getByTestId('plan-profile-marker-stage-drop-0');
    expect(drop.getAttribute('data-over-reserve')).toBe('true');
    expect(screen.getByTestId('plan-profile-marker-waypoint-0')).toBeTruthy();
    // Route index 1 also occurs on the return leg (at 300 m of 400). The drop must be drawn on the
    // outbound pass, i.e. left of the turnaround line.
    const dropX = Number(drop.querySelector('line')?.getAttribute('x1'));
    const turn = Number(screen.getByTestId('plan-profile-turn-line').getAttribute('x1'));
    expect(dropX).toBeLessThan(turn);
  });

  it('recovers when the field flips back to null mid-session', () => {
    // The blink is not a one-off at mount: it reopens on every single plan edit.
    const { rerender } = render(<ProfileChart />);
    seed(fakeField());
    rerender(<ProfileChart />);
    expect(screen.getByTestId('plan-profile-svg')).toBeTruthy();

    seed(null);
    rerender(<ProfileChart />);
    expect(screen.queryByTestId('plan-profile-svg')).toBeNull();
    expect(screen.getByTestId('plan-profile-empty')).toBeTruthy();
  });
});
