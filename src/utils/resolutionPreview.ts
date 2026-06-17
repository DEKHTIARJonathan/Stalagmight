/**
 * Geometry for the on-map preview of a proposed shot edit in the warning
 * resolution flow (issue #57).
 *
 * Mirrors the backend solve (`src-tauri/src/core/state/commands.rs`): a shot's
 * plan-view step is `average_azimuth` with `dx = horizontal·sin(az)`,
 * `dy = horizontal·cos(az)`. The ghost is anchored to the *real solved*
 * endpoint and shows only the delta, so when the proposed value equals the
 * current one the ghost overlaps reality exactly.
 */
import { calculatePosition } from './coordinates';

export interface Pt {
  x: number;
  y: number;
}

/** Horizontal (plan) projection of a slope length given its depth change. */
export function horizontalLength(slopeLength: number, depthChange: number): number {
  return Math.sqrt(Math.max(0, slopeLength * slopeLength - depthChange * depthChange));
}

/**
 * Ghost endpoint for a proposed shot edit, or `null` when the planar model
 * can't reproduce the current solved endpoint within tolerance — e.g. a
 * rotated/offset section whose solved frame differs from raw azimuths. The
 * caller shows no ghost in that case rather than a misleading one.
 *
 * @param start          solved coords of the shot's start station (meters)
 * @param end            solved coords of the shot's end station (meters)
 * @param currentAzimuth the shot's current average azimuth (deg)
 * @param currentHoriz   the shot's current horizontal length (m)
 * @param proposedAzimuth proposed average azimuth (deg)
 * @param proposedHoriz  proposed horizontal length (m)
 */
export function computeGhostEnd(
  start: Pt,
  end: Pt,
  currentAzimuth: number,
  currentHoriz: number,
  proposedAzimuth: number,
  proposedHoriz: number,
): Pt | null {
  const predicted = calculatePosition({ x: start.x, y: start.y, z: 0 }, currentAzimuth, currentHoriz, 0);
  // Tolerance scales a little with length to absorb float noise on long shots.
  if (Math.hypot(predicted.x - end.x, predicted.y - end.y) > 0.1 + 0.05 * currentHoriz) {
    return null;
  }
  const proposedVec = calculatePosition({ x: 0, y: 0, z: 0 }, proposedAzimuth, proposedHoriz, 0);
  const currentVec = calculatePosition({ x: 0, y: 0, z: 0 }, currentAzimuth, currentHoriz, 0);
  return { x: end.x + (proposedVec.x - currentVec.x), y: end.y + (proposedVec.y - currentVec.y) };
}
