import { describe, it, expect } from 'vitest';
import type { GasReachField, RouteProfilePoint } from '../../types/ipc.generated';
import {
  buildRouteProfile,
  projectProfile,
  niceTicks,
  axisTicks,
  depthTicks,
} from '../routeProfile';

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

/**
 * A 3-station route out to 200 m / 20 m deep and back, swum in at 5 m/min and out at 10 m/min -
 * so the two axes deliberately disagree about where the midpoint of the dive is.
 */
const routeProfile: RouteProfilePoint[] = [
  point({ route_index: 0, distance_m: 0, depth_m: 0, elapsed_min: 0, gas_l: 0 }),
  point({ route_index: 1, distance_m: 100, depth_m: 10, elapsed_min: 20, gas_l: 300 }),
  point({ route_index: 2, distance_m: 200, depth_m: 20, elapsed_min: 40, gas_l: 800 }),
  point({ route_index: 1, distance_m: 300, depth_m: 10, elapsed_min: 50, gas_l: 1100, outbound: false }),
  point({ route_index: 0, distance_m: 400, depth_m: 0, elapsed_min: 60, gas_l: 1300, outbound: false }),
];

const field = (over: Partial<GasReachField> = {}): GasReachField =>
  ({
    station_refs: [],
    gas_to_reach: [],
    reachable: [],
    turn_frontier: [],
    max_reachable_gas: 0,
    budget_litres: 1000,
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
    route_max_depth_m: 20,
    route_avg_depth_m: 10,
    waypoint_gas_litres: [],
    route_profile: routeProfile,
    stage_drop_route_indices: [],
    waypoint_route_indices: [],
    ...over,
  }) as GasReachField;

describe('buildRouteProfile', () => {
  it('returns null when there is nothing to plot', () => {
    expect(buildRouteProfile(null, 'distance')).toBeNull();
    expect(buildRouteProfile(undefined, 'distance')).toBeNull();
    expect(buildRouteProfile(field({ route_profile: [] }), 'distance')).toBeNull();
  });

  it('reads the chosen axis, and the two axes genuinely differ', () => {
    const byDistance = buildRouteProfile(field(), 'distance');
    const byTime = buildRouteProfile(field(), 'time');
    expect(byDistance?.xs).toEqual([0, 100, 200, 300, 400]);
    expect(byTime?.xs).toEqual([0, 20, 40, 50, 60]);
    // The turnaround is halfway along the distance axis but two thirds of the way through the
    // dive in time, because the exit is swum faster. A chart that mirrored one axis for the other
    // would put it at 50% on both - this is the whole reason the toggle exists.
    expect(byDistance?.turnX).toBe(200);
    expect(byDistance?.xMax).toBe(400);
    expect(byTime?.turnX).toBe(40);
    expect(byTime?.xMax).toBe(60);
    expect(byDistance?.depthMax).toBe(20);
  });

  it('always marks the turnaround, at the end of the outbound leg', () => {
    const geo = buildRouteProfile(field(), 'distance');
    const turn = geo?.markers.filter((m) => m.kind === 'turn') ?? [];
    expect(turn).toHaveLength(1);
    expect(turn[0]).toMatchObject({ x: 200, depth_m: 20 });
  });

  it('places markers by route index, so a route that doubles back marks the right pass', () => {
    // Route index 1 appears twice in the series - once outbound, once on the way home. A marker
    // keyed on the station ref could not tell them apart; this one has to land on the outbound pass.
    const geo = buildRouteProfile(
      field({ stage_drop_route_indices: [1], stage_drop_over_reserve: [true] }),
      'distance'
    );
    const drops = geo?.markers.filter((m) => m.kind === 'stage-drop') ?? [];
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ x: 100, depth_m: 10, ordinal: 0, overReserve: true });
    // ...and NOT at 300 m, which is the same route index on the return leg.
    expect(drops[0]?.x).not.toBe(300);
  });

  it('defaults the over-reserve flag rather than reading undefined off a short array', () => {
    const geo = buildRouteProfile(
      field({ stage_drop_route_indices: [1, 2], stage_drop_over_reserve: [] }),
      'distance'
    );
    const drops = geo?.markers.filter((m) => m.kind === 'stage-drop') ?? [];
    expect(drops).toHaveLength(2);
    expect(drops.every((d) => d.overReserve === false)).toBe(true);
  });

  it('marks resolvable way points and skips a stalled one', () => {
    const geo = buildRouteProfile(field({ waypoint_route_indices: [1, null] }), 'distance');
    const wps = geo?.markers.filter((m) => m.kind === 'waypoint') ?? [];
    expect(wps).toHaveLength(1);
    expect(wps[0]).toMatchObject({ x: 100, ordinal: 0 });
  });

  it('drops a marker whose route index is not on the route rather than plotting it at zero', () => {
    const geo = buildRouteProfile(field({ stage_drop_route_indices: [99] }), 'distance');
    expect(geo?.markers.filter((m) => m.kind === 'stage-drop')).toHaveLength(0);
  });
});

describe('projectProfile', () => {
  const box = { width: 400, height: 200, padLeft: 40, padRight: 10, padTop: 10, padBottom: 20 };

  it('maps the surface to the top and the deepest point to the bottom', () => {
    const geo = buildRouteProfile(field(), 'distance');
    if (!geo) throw new Error('geometry');
    const p = projectProfile(geo, box);
    expect(p.y(0)).toBe(10);
    expect(p.y(20)).toBe(180);
    expect(p.x(0)).toBe(40);
    expect(p.x(400)).toBe(390);
    expect(p.linePath.startsWith('M40.00,10.00')).toBe(true);
    // The area closes back along the surface so the water column fills downward.
    expect(p.areaPath.endsWith('Z')).toBe(true);
    expect(p.areaPath).toContain('L390.00,10.00 L40.00,10.00 Z');
  });

  it('never emits NaN for a degenerate route', () => {
    // A single-station plan (or an entirely flat one) has a zero span on an axis. Dividing by it
    // would put every coordinate at NaN, which renders as a silently blank chart rather than an
    // error - so the spans floor instead.
    const flat = buildRouteProfile(
      field({
        route_profile: [point({ route_index: 0, distance_m: 0, depth_m: 0, elapsed_min: 0 })],
        route_line_length_m: 0,
      }),
      'distance'
    );
    if (!flat) throw new Error('geometry');
    const p = projectProfile(flat, box);
    expect(Number.isFinite(p.x(0))).toBe(true);
    expect(Number.isFinite(p.y(0))).toBe(true);
    expect(p.linePath).not.toContain('NaN');
    expect(p.areaPath).not.toContain('NaN');
  });

  it('keeps the plot non-degenerate in a box smaller than its own padding', () => {
    // The panel is user-resizable down to 100 px and the chart shares that height with a tab strip
    // and an axis, so a box narrower/shorter than the padding is reachable by dragging.
    const geo = buildRouteProfile(field(), 'distance');
    if (!geo) throw new Error('geometry');
    const p = projectProfile(geo, { ...box, width: 10, height: 10 });
    expect(p.plotRight).toBeGreaterThan(p.plotLeft);
    expect(p.plotBottom).toBeGreaterThan(p.plotTop);
    expect(p.linePath).not.toContain('NaN');
  });
});

describe('niceTicks', () => {
  it('steps by a 1 / 2 / 5 figure and never overshoots the max', () => {
    expect(niceTicks(400, 4)).toEqual([0, 100, 200, 300, 400]);
    expect(niceTicks(60, 4)).toEqual([0, 20, 40, 60]);
    // `target` is a hint, not a count: 20/3 rounds UP to a step of 10, trading a tick for a round
    // number. Producing 6.67-spaced gridlines to hit the count exactly would be the wrong trade.
    expect(niceTicks(20, 3)).toEqual([0, 10, 20]);
    expect(niceTicks(25, 5)).toEqual([0, 5, 10, 15, 20, 25]);
    expect(niceTicks(400, 4).every((t) => t <= 400)).toBe(true);
  });

  it('degrades to a single surface tick on a non-positive or invalid max', () => {
    expect(niceTicks(0)).toEqual([0]);
    expect(niceTicks(-5)).toEqual([0]);
    expect(niceTicks(Number.NaN)).toEqual([0]);
    expect(niceTicks(Number.POSITIVE_INFINITY)).toEqual([0]);
    expect(niceTicks(100, 0)).toEqual([0]);
  });

  it('does not accumulate float drift across steps', () => {
    // 0.1-sized steps summed naively give 0.30000000000000004, which renders as a garbage label.
    expect(niceTicks(0.5, 5)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5]);
  });
});

describe('axis ticks', () => {
  it('chooses distance ticks in the diver own unit and maps them back to metres', () => {
    const geo = buildRouteProfile(field(), 'distance');
    if (!geo) throw new Error('geometry');
    // Metric: round metres, positioned at themselves.
    expect(axisTicks(geo, 'metric', 4).map((t) => t.display)).toEqual([0, 100, 200, 300, 400]);
    // Imperial: 400 m is 1312 ft, so the labels are round FEET - a diver reading feet must not be
    // given gridlines every 15.24 ft - and each maps back to the metres it is drawn at.
    const imperial = axisTicks(geo, 'imperial', 4);
    expect(imperial.map((t) => t.display)).toEqual([0, 500, 1000]);
    expect(imperial[1]?.value).toBeCloseTo(152.4, 3);
  });

  it('leaves the time axis unconverted, since minutes are not a length', () => {
    const geo = buildRouteProfile(field(), 'time');
    if (!geo) throw new Error('geometry');
    const ticks = axisTicks(geo, 'imperial', 3);
    expect(ticks.map((t) => t.display)).toEqual(ticks.map((t) => t.value));
    expect(ticks[ticks.length - 1]?.display).toBeLessThanOrEqual(60);
  });

  it('gives depth ticks in the diver own unit too', () => {
    const geo = buildRouteProfile(field(), 'distance');
    if (!geo) throw new Error('geometry');
    expect(depthTicks(geo, 'metric', 2).map((t) => t.display)).toEqual([0, 10, 20]);
    expect(depthTicks(geo, 'imperial', 2)[0]?.display).toBe(0);
  });
});
