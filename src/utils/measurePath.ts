import type { PathShot } from '../types/project';
import { encodeFeatureId } from './ids';

/**
 * Tint color for the shots on the measured along-cave-line path (#26 ruler). A
 * bright cyan/teal, deliberately distinct from selection, hover, the snap
 * indicator, and the depth/distance gradient hues so a measured path reads
 * clearly over the normal section colors.
 */
export const MEASURE_TINT = '#22d3ee';

/**
 * Map the along-line path shots (from the `get_along_line_distance` IPC) to their
 * globally-unique MapLibre feature ids, for `setFeatureState`-based tinting.
 * Reuses the one canonical `encodeFeatureId` formula so it never drifts from
 * feature construction or the distance-gradient overlay.
 */
export function buildMeasuredPathIds(pathShots: PathShot[]): Set<number> {
  const ids = new Set<number>();
  for (const s of pathShots) {
    ids.add(encodeFeatureId(s.section_id, s.shot_id));
  }
  return ids;
}
