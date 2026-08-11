/**
 * Numeric bounds shared with the Rust coordinate validator.
 *
 * Its own module rather than a literal in the dialog because two languages have
 * to agree on it: a value the frontend accepts and the backend then refuses is
 * a confirm button that fails at the far end with no way to see why. The Rust
 * side is `GpsCoordinates::validate` in
 * src-tauri/crates/models/src/station.rs, and the pair is pinned by
 * src/test/__tests__/configBoundsMirror.test.ts.
 */

/**
 * Largest magnitude a zero datum's depth reference may carry, in meters
 * (+down from the surface, so the sign is meaningful and a datum above the
 * surface is negative).
 *
 * Finiteness alone was the only check on either side, and finiteness is not a
 * range: `1e300` passed both and travelled into the project's geometry.
 * Generous rather than diving-realistic - the deepest point of any ocean is
 * ~10 935 m and the highest land ~8 849 m - so it refuses only values that are
 * meaningless for any point on Earth.
 */
export const MAX_DEPTH_REFERENCE_M = 11_000;
