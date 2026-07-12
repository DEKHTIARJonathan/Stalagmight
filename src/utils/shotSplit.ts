// Minimum length (meters) either child of an Insert Station split may end up
// with (issue #59). Keep in sync with the backend
// MIN_SPLIT_CHILD_LENGTH_M (src-tauri/src/models/project/shots.rs).
export const MIN_SPLIT_CHILD_LENGTH_M = 0.01;

/** Is `shotLength` long enough to offer a split at all (both children >= the floor)? */
export function canSplitShot(shotLength: number): boolean {
  return shotLength >= 2 * MIN_SPLIT_CHILD_LENGTH_M;
}
