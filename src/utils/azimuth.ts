/**
 * Azimuth helpers shared by the warning-resolution flow (issue #57).
 *
 * Kept in lockstep with the Rust side so a frontend-computed fix lands on the
 * exact value the backend would compute and the warning recomputes away.
 */

/** Normalize an azimuth (degrees) into the [0, 360) range. */
export function normalizeAzimuth(value: number): number {
  let normalized = value % 360;
  if (normalized < 0) normalized += 360;
  return normalized;
}

/**
 * Wraparound-aware average of the two forward azimuth readings, mirroring
 * `Shot::average_azimuth` in `src-tauri/src/models/shot.rs`. Averages across
 * the short arc, so 350° and 10° average to 0° (not 180°).
 */
export function averageAzimuth(azimuthIn: number, azimuthOut: number): number {
  // diff is the signed short-arc delta in (-180, 180].
  const diff = ((azimuthOut - azimuthIn + 540) % 360) - 180;
  return (azimuthIn + diff / 2 + 360) % 360;
}
