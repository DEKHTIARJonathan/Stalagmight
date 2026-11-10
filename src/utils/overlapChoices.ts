/**
 * Per-shot decisions for repeated survey in the orphan-placement dialog (#681).
 *
 * When a placed section repeats shots the project already has, each repeated
 * shot gets one of three choices. Whatever the choice, the new section's copy
 * becomes a Reference shot (kept, never deleted, no longer counted as surveyed
 * length); the choice only decides which reading the EXISTING shot ends up
 * with, so its stations, connections, closures and comments stay where they are.
 */

import { averageAzimuth, normalizeAzimuth } from './azimuth';
import { interpolateShots, type TargetShotLike } from './overlapHelpers';

export type OverlapChoice = 'keep_existing' | 'use_new' | 'average';

export const OVERLAP_CHOICES: readonly OverlapChoice[] = ['keep_existing', 'use_new', 'average'];

/**
 * How far two readings of one shot may differ before the row is highlighted:
 * above the rounding any survey format stores (cm, tenths of a degree), below
 * a genuinely different measurement. The matcher's own limits are no use here -
 * they are reject cutoffs, so every matched shot is already inside them.
 */
export const REPEAT_DIFF_TOLERANCE = {
  length: 0.1,
  azimuth: 1,
  inclination: 1,
  depth: 0.1,
} as const;

/** How far apart two readings of the same shot are, per measurement. */
export interface ReadingDiff {
  length: number;
  azimuth: number;
  /** Null when either reading has no inclination. */
  inclination: number | null;
  /** The larger of the start-depth and end-depth differences. */
  depth: number;
}

/** The measured fields of a shot, without its identity, kind or comment. */
export function toReading(shot: TargetShotLike): TargetShotLike {
  return {
    azimuth_in: shot.azimuth_in,
    azimuth_out: shot.azimuth_out,
    length: shot.length,
    depth_in: shot.depth_in,
    depth_out: shot.depth_out,
    pitch_in: shot.pitch_in,
    pitch_out: shot.pitch_out,
    left: shot.left,
    right: shot.right,
    up: shot.up,
    down: shot.down,
  };
}

/** The shot's displayed bearing: the mean of its two legs. */
export function shotAzimuth(shot: TargetShotLike): number {
  return averageAzimuth(shot.azimuth_in, shot.azimuth_out);
}

/** The shot's displayed inclination: the mean of the legs it has, or null. */
export function shotInclination(shot: TargetShotLike): number | null {
  if (shot.pitch_in == null && shot.pitch_out == null) return null;
  if (shot.pitch_in == null) return shot.pitch_out;
  if (shot.pitch_out == null) return shot.pitch_in;
  return (shot.pitch_in + shot.pitch_out) / 2;
}

/** Absolute difference between two readings, both oriented the same way. */
export function readingDiff(existing: TargetShotLike, incoming: TargetShotLike): ReadingDiff {
  const existingInclination = shotInclination(existing);
  const incomingInclination = shotInclination(incoming);
  return {
    length: Math.abs(existing.length - incoming.length),
    azimuth: Math.abs(normalizeAzimuth(shotAzimuth(incoming) - shotAzimuth(existing) + 180) - 180),
    inclination:
      existingInclination == null || incomingInclination == null
        ? null
        : Math.abs(existingInclination - incomingInclination),
    depth: Math.max(
      Math.abs(existing.depth_in - incoming.depth_in),
      Math.abs(existing.depth_out - incoming.depth_out),
    ),
  };
}

/** Whether any measurement differs by more than `REPEAT_DIFF_TOLERANCE`. */
export function exceedsRepeatTolerance(diff: ReadingDiff): boolean {
  return (
    diff.length > REPEAT_DIFF_TOLERANCE.length ||
    diff.azimuth > REPEAT_DIFF_TOLERANCE.azimuth ||
    (diff.inclination != null && diff.inclination > REPEAT_DIFF_TOLERANCE.inclination) ||
    diff.depth > REPEAT_DIFF_TOLERANCE.depth
  );
}

/**
 * The reading the existing shot should take for `choice`, or null when it keeps
 * its own. `incoming` must already be oriented the way the existing shot runs.
 */
export function resolvedReading(
  choice: OverlapChoice,
  existing: TargetShotLike,
  incoming: TargetShotLike,
): TargetShotLike | null {
  switch (choice) {
    case 'keep_existing':
      return null;
    case 'use_new':
      return toReading(incoming);
    case 'average':
      return toReading(
        interpolateShots({ ...toReading(existing), id: 0, comment: null, kind: 'Normal' }, incoming),
      );
  }
}
