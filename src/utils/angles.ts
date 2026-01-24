/**
 * Angle utilities for cave survey calculations.
 */

/**
 * Normalize an angle to the range [0, 360).
 *
 * @param degrees - Angle in degrees (can be any value, including negative)
 * @returns Normalized angle in range [0, 360)
 */
export function normalizeAngle(degrees: number): number {
  // Handle non-finite values
  if (!Number.isFinite(degrees)) {
    return 0;
  }

  let result = degrees % 360;
  if (result < 0) {
    result += 360;
  }
  // Handle -0 by adding 0
  return result + 0;
}

/**
 * Compute circular mean of two angles in degrees.
 * Handles wrap-around correctly (e.g., 350 and 10 averages to ~0, not 180).
 *
 * @param a - First angle in degrees
 * @param b - Second angle in degrees
 * @returns Circular mean in range [0, 360)
 */
export function circularMeanDegrees(a: number, b: number): number {
  const aRad = (a * Math.PI) / 180;
  const bRad = (b * Math.PI) / 180;

  // Average the unit vectors
  const x = (Math.cos(aRad) + Math.cos(bRad)) / 2;
  const y = (Math.sin(aRad) + Math.sin(bRad)) / 2;

  // Convert back to angle
  let result = Math.atan2(y, x) * (180 / Math.PI);
  if (result < 0) result += 360;
  // Normalize to [0, 360) range (handles edge case where result is exactly 360)
  if (result >= 360) result -= 360;
  return result;
}
