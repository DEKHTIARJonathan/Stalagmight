/**
 * Azimuth helpers shared by the warning-resolution flow (issue #57).
 *
 * Kept in lockstep with the Rust side so a frontend-computed fix lands on the
 * exact value the backend would compute and the warning recomputes away.
 */

/**
 * Normalize an azimuth (degrees) into the [0, 360) range.
 *
 * Mirrors `normalize_azimuth` in `src-tauri/src/models/angle.rs`, including the
 * two escapes a bare `x % 360` + `if (< 0) += 360` misses:
 *
 * - The `+= 360` ROUNDS for a tiny negative input, so it can return exactly
 *   `360`, which is out of range and trips a non-ignorable `INVALID_AZIMUTH`.
 *   `averageAzimuth(0.1, 359.9)` reached it - every fore/back pair whose
 *   circular mean is exactly north does.
 * - `-0 % 360` is `-0`, which is not `< 0`, so it survived the guard. `+ 0`
 *   folds it to `+0` so nothing serialises as `-0`.
 *
 * A non-finite value has no canonical form and passes through untouched.
 */
export function normalizeAzimuth(value: number): number {
  if (!Number.isFinite(value)) return value;
  let normalized = value % 360;
  if (normalized < 0) normalized += 360;
  if (normalized >= 360) normalized = 0;
  return normalized + 0;
}

/**
 * Wraparound-aware average of the two forward azimuth readings, mirroring
 * `Shot::average_azimuth` in `src-tauri/src/models/shot.rs`. Averages across
 * the short arc, so 350° and 10° average to 0° (not 180°).
 */
export function averageAzimuth(azimuthIn: number, azimuthOut: number): number {
  // diff is the signed short-arc delta in (-180, 180]. Wrapped with the
  // Euclidean `normalizeAzimuth`, not a bare `%`: Rust uses `rem_euclid`, which
  // keeps the sign of the DIVISOR, while JS `%` keeps the sign of the dividend.
  // The two agree only while `azimuthOut - azimuthIn + 540` is non-negative, and
  // an out-of-range reading breaks that - `averageAzimuth(400, -200)` came back
  // 280 here against the backend's 100, i.e. the ANTIPODE, silently steering the
  // "Average" fix for AZIMUTH_DEVIATION the wrong way down the passage.
  // Out-of-range readings are reachable: INVALID_AZIMUTH is only a warning and
  // the DMP parser stores its headings verbatim.
  const diff = normalizeAzimuth(azimuthOut - azimuthIn + 540) - 180;
  return normalizeAzimuth(azimuthIn + diff / 2);
}
