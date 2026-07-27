/**
 * Geometry for the Plan-mode dive profile (#299).
 *
 * The backend hands over `GasReachField.route_profile`: an ordered depth / distance / runtime / gas
 * series for the whole round trip, outbound then back. Everything here is presentation - choosing an
 * axis, resolving markers, picking ticks, projecting to SVG space. Nothing re-derives a survey
 * number, deliberately: the engine already excluded zero-distance ties, priced the exit leg and
 * placed the stage drops, and re-doing any of that in TypeScript is how the chart would start
 * disagreeing with the Plan readout beside it.
 *
 * Kept separate from the component so the interesting part is a plain node test.
 */

import type { GasReachField, GasUnits, RouteProfilePoint } from '../types/ipc.generated';
import { lengthToDisplay, lengthFromDisplay } from './formatGas';

/** Which quantity runs along the x axis. User-switchable; both are real, neither is estimated. */
export type ProfileAxis = 'distance' | 'time';

/** What a marker on the profile points at. */
export type ProfileMarkerKind = 'turn' | 'stage-drop' | 'waypoint';

export interface ProfileMarker {
  kind: ProfileMarkerKind;
  /** Axis value (metres or minutes, matching the chosen axis). */
  x: number;
  depth_m: number;
  /** 0-based ordinal within its kind, for labelling ("Stage 2", "WP 3"). */
  ordinal: number;
  /** Stage drops only: the diver dragged this drop past its gas-safe point. */
  overReserve: boolean;
}

export interface ProfileGeometry {
  /** The full round trip, in swim order. */
  points: RouteProfilePoint[];
  /** Axis value per point, aligned 1:1 with `points`. */
  xs: number[];
  markers: ProfileMarker[];
  /** Axis value at the turnaround - where the diver stops going in and starts coming out. */
  turnX: number;
  /**
   * One-way swum PENETRATION in metres: the turnaround's `distance_m`, always, whichever axis is
   * selected. Distinct from `xMax`, which on the distance axis is the round trip at 2L - reporting
   * that as penetration doubles the number a diver plans against.
   */
  turnDistanceM: number;
  xMax: number;
  /** Deepest point on the route; the depth axis runs 0 (surface) to here. */
  depthMax: number;
  axis: ProfileAxis;
}

function axisValue(point: RouteProfilePoint, axis: ProfileAxis): number {
  return axis === 'distance' ? point.distance_m : point.elapsed_min;
}

/**
 * Build the profile geometry, or `null` when there is nothing to plot (no plan, or a plan whose
 * route cannot be flown - a stalled way point makes the whole field unreachable).
 *
 * Markers are resolved by `route_index`, never by station ref: a way-point route can double back
 * over a station, so a ref names the station but not the pass, and a ref-keyed marker would land on
 * whichever crossing happened to be found first. Only outbound points are searched, since a drop or
 * a way point is something the diver does on the way in.
 */
export function buildRouteProfile(
  field: GasReachField | null | undefined,
  axis: ProfileAxis
): ProfileGeometry | null {
  // `< 2`, not `=== 0`: a one-point series is a dive of zero distance over zero duration. The engine
  // already refuses to publish one, so this is belt-and-braces - but this is also the check that
  // decides whether the export buttons light up, and offering to write a file describing a dive that
  // never happened is the failure this guards.
  if (!field || field.route_profile.length < 2) {
    return null;
  }
  const points = field.route_profile;
  const xs = points.map((p) => axisValue(p, axis));
  const outbound = points.filter((p) => p.outbound);
  const turn = outbound[outbound.length - 1];
  const atIndex = (routeIndex: number): RouteProfilePoint | undefined =>
    outbound.find((p) => p.route_index === routeIndex);

  const markers: ProfileMarker[] = [];
  // `?? []` on the arrays, not `?.` on `field`: the guard above already proves `field` is present,
  // while the arrays are the part an older or partial field could genuinely be missing.
  (field.stage_drop_route_indices ?? []).forEach((routeIndex, i) => {
    const point = atIndex(routeIndex);
    if (point) {
      markers.push({
        kind: 'stage-drop',
        x: axisValue(point, axis),
        depth_m: point.depth_m,
        ordinal: i,
        overReserve: (field.stage_drop_over_reserve ?? [])[i] ?? false,
      });
    }
  });
  (field.waypoint_route_indices ?? []).forEach((routeIndex, i) => {
    // `null` from the first way point that stalls - there is no pass to mark.
    const point = routeIndex === null ? undefined : atIndex(routeIndex);
    if (point) {
      markers.push({
        kind: 'waypoint',
        x: axisValue(point, axis),
        depth_m: point.depth_m,
        ordinal: i,
        overReserve: false,
      });
    }
  });
  if (turn) {
    markers.push({
      kind: 'turn',
      x: axisValue(turn, axis),
      depth_m: turn.depth_m,
      ordinal: 0,
      overReserve: false,
    });
  }

  // Reduced rather than spread: `Math.max(...xs)` passes one argument per point, and V8 throws
  // RangeError past ~125k of them. A long route in a big cave is 2n-1 points.
  const maxOf = (values: number[]) => values.reduce((a, b) => (b > a ? b : a), 0);

  return {
    points,
    xs,
    markers,
    turnX: turn ? axisValue(turn, axis) : 0,
    turnDistanceM: turn?.distance_m ?? 0,
    xMax: maxOf(xs),
    depthMax: maxOf(points.map((p) => p.depth_m)),
    axis,
  };
}

export interface ProfileBox {
  width: number;
  height: number;
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
}

export interface ProfileProjection {
  /** Axis value (metres or minutes) → SVG x. */
  x: (value: number) => number;
  /** Depth in metres → SVG y. Surface is the top of the plot. */
  y: (depth_m: number) => number;
  /** The depth polyline, `M ... L ...`. */
  linePath: string;
  /** The same line closed down to the surface, for the filled water column. */
  areaPath: string;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
}

/**
 * Project the geometry into an SVG box.
 *
 * A degenerate span (a one-station route, or a plan whose whole route sits at one depth) would
 * divide by zero and put the line at NaN, which renders as an invisible chart rather than an error -
 * so both spans floor at 1, drawing a flat line at the top instead.
 */
export function projectProfile(geo: ProfileGeometry, box: ProfileBox): ProfileProjection {
  const plotLeft = box.padLeft;
  const plotRight = Math.max(box.width - box.padRight, plotLeft + 1);
  const plotTop = box.padTop;
  const plotBottom = Math.max(box.height - box.padBottom, plotTop + 1);
  const xSpan = geo.xMax > 0 ? geo.xMax : 1;
  const depthSpan = geo.depthMax > 0 ? geo.depthMax : 1;

  const x = (value: number) => plotLeft + (value / xSpan) * (plotRight - plotLeft);
  // Clamped to the plot box. A station above the datum has a negative depth - the exporter has a
  // guard for exactly that case - and unclamped it would map above `plotTop`, painting the line out
  // through the header band and inverting the filled water column, which closes back to `plotTop`.
  const y = (depth_m: number) => {
    const t = Math.min(Math.max(depth_m / depthSpan, 0), 1);
    return plotTop + t * (plotBottom - plotTop);
  };

  const linePath = geo.points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(geo.xs[i] ?? 0).toFixed(2)},${y(p.depth_m).toFixed(2)}`)
    .join(' ');
  const first = x(geo.xs[0] ?? 0).toFixed(2);
  const last = x(geo.xs[geo.xs.length - 1] ?? 0).toFixed(2);
  const areaPath = `${linePath} L${last},${plotTop.toFixed(2)} L${first},${plotTop.toFixed(2)} Z`;

  return { x, y, linePath, areaPath, plotLeft, plotRight, plotTop, plotBottom };
}

/**
 * Round tick values from 0 to at most `max`, stepping by a 1 / 2 / 5 x 10^n figure.
 *
 * Chosen in whatever unit is passed in, so the caller converts to display units first: a diver
 * reading feet wants gridlines every 50 ft, not every 15.24 m.
 */
export function niceTicks(max: number, target: number = 4): number[] {
  if (!Number.isFinite(max) || max <= 0 || target < 1) {
    return [0];
  }
  const raw = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;
  // A denormal `max` underflows `magnitude` to 0, making `step` 0 - and `v += 0` never terminates,
  // hanging the render thread rather than drawing a bad axis. Unreachable from real cave depths,
  // but a hang is not a pixel bug.
  if (!(step > 0)) {
    return [0];
  }
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 1e-9; v += step) {
    ticks.push(Number(v.toFixed(10)));
  }
  return ticks;
}

/** A distance-axis tick: the round value to label, and the metres it sits at. */
export interface AxisTick {
  /** Value in display units - feet when imperial, metres/minutes otherwise. */
  display: number;
  /** Canonical axis value (metres or minutes) to position it at. */
  value: number;
}

/**
 * Ticks for the x axis. Distance ticks are chosen in the diver's length unit and mapped back to
 * metres; time is unit-agnostic, so its ticks are already canonical.
 */
export function axisTicks(geo: ProfileGeometry, units: GasUnits, target: number = 4): AxisTick[] {
  if (geo.axis === 'time') {
    return niceTicks(geo.xMax, target).map((v) => ({ display: v, value: v }));
  }
  return niceTicks(lengthToDisplay(geo.xMax, units), target).map((display) => ({
    display,
    value: lengthFromDisplay(display, units),
  }));
}

/** Ticks for the depth axis, chosen in the diver's length unit. Always includes the surface (0). */
export function depthTicks(geo: ProfileGeometry, units: GasUnits, target: number = 3): AxisTick[] {
  return niceTicks(lengthToDisplay(geo.depthMax, units), target).map((display) => ({
    display,
    value: lengthFromDisplay(display, units),
  }));
}
