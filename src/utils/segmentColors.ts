import type { GasReachField } from '../types/ipc/GasReachField';

/**
 * The per-segment identity colors (#317 feedback round): segment k of the plan - the span
 * between way point k-1 and k - is drawn in `segmentColor(k)` everywhere it appears, so the
 * map's route highlight and the Segments table rows read as the same object. Index 0 keeps
 * the route highlight's original cyan, so a plan with no way points looks exactly as before.
 * Purely presentational - no gas number is derived from a color.
 */
const SEGMENT_COLOR_PALETTE = [
  '#22d3ee', // cyan - the pre-#317 route color, kept for segment 0
  '#fbbf24', // amber
  '#a78bfa', // violet
  '#34d399', // emerald
  '#f472b6', // pink
  '#fb923c', // orange
] as const;

export function segmentColor(segmentIndex: number): string {
  const i = Number.isInteger(segmentIndex) && segmentIndex >= 0 ? segmentIndex : 0;
  return SEGMENT_COLOR_PALETTE[i % SEGMENT_COLOR_PALETTE.length] as string;
}

/**
 * Which plan segment each route leg belongs to, one entry per `field.route` leg.
 *
 * Uses the ENGINE's own placement of each way point on the route
 * (`waypoint_route_indices`, in `route_profile`'s station index space: way point w sits at
 * route STATION `idx[w]`, and leg i runs station i -> i + 1) rather than re-matching station
 * refs client-side - a route can double back over a station, and a merge/closure tie means
 * one physical station is several coincident refs, so ref-matching would misplace the
 * boundary exactly where the engine already had the answer.
 *
 * Leg i departs station i, so it belongs to segment `|{w : idx[w] <= i}|`: legs before way
 * point w's station stay in segment w, the leg leaving it starts segment w + 1. Entries are
 * `None` from the first way point that stalls (matching `waypoint_gas_litres`) - counting
 * stops there, leaving the remaining legs on the last placed segment, which is where the
 * walked route actually ends.
 */
export function routeLegSegmentIndices(field: GasReachField): number[] {
  const placed: number[] = [];
  for (const idx of field.waypoint_route_indices) {
    if (idx == null) break;
    placed.push(idx);
  }
  return field.route.map((_, leg) => placed.filter((stationIdx) => stationIdx <= leg).length);
}
