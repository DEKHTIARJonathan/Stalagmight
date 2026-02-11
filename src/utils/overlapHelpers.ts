/**
 * Pure helper functions for overlap handling in the connection wizard.
 *
 * These functions compute overlap shot IDs, target index mappings,
 * merge options, and shot transformations for all 4 overlap cases:
 * (Front/Back) × (Forward/Reverse).
 *
 * Key insight: The Rust backend pre-reverses import shots for ImportEnd::Back
 * (import_from_n) via `.rev().map(reversed())` before matching. This means the
 * relationship between import overlap shot IDs and existing target shot indices
 * is inverted for Back compared to Front.
 */

import { circularMeanDegrees } from './angles';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A shot-like shape from a target section (existing project or another import). */
export interface TargetShotLike {
  azimuth_in: number;
  azimuth_out: number;
  length: number;
  depth_in: number;
  depth_out: number;
  pitch_in: number | null;
  pitch_out: number | null;
  left: number | null;
  right: number | null;
  up: number | null;
  down: number | null;
}

/** An editable shot with optional new/deleted/reference flags. */
export interface EditableShotLike extends TargetShotLike {
  id: number;
  comment: string | null;
  is_reference: boolean;
  isNew?: boolean;
  isDeleted?: boolean;
  tempId?: number;
}

export interface OverlapParams {
  importStationIndex: number;
  matchedShots: number;
  existingStationIndex: number;
  direction: 'forward' | 'reverse';
}

export interface MergeOption {
  offset: number;
  importStation: number;
  existingStation: number;
}

interface SuggestionLike {
  importStationIndex: number;
  existingStationIndex: number;
  matchedShots: number;
  direction: 'forward' | 'reverse';
  isPartial: boolean;
}

// ─── Core logic ─────────────────────────────────────────────────────────────

/**
 * Determine whether target shots need direction reversal to match import direction.
 *
 * The backend pre-reverses import shots for Back (importStationIndex > 0),
 * so the reversal logic must account for this:
 *
 * | importStationIndex | direction | needsReversal |
 * |--------------------|-----------|---------------|
 * | 0 (Front)          | forward   | false         |
 * | 0 (Front)          | reverse   | true          |
 * | >0 (Back)          | forward   | true          |
 * | >0 (Back)          | reverse   | false         |
 */
export function needsDirectionReversal(
  importStationIndex: number,
  direction: 'forward' | 'reverse',
): boolean {
  return (importStationIndex === 0) !== (direction === 'forward');
}

/**
 * Compute the set of import shot IDs that fall within the overlap region.
 *
 * Front (importStationIndex === 0): shots 0..matchedShots-1
 * Back  (importStationIndex > 0):   shots (importStationIndex-matchedShots)..(importStationIndex-1)
 */
export function computeOverlapIds(
  importStationIndex: number,
  matchedShots: number,
): Set<number> {
  const ids = new Set<number>();
  if (importStationIndex === 0) {
    for (let i = 0; i < matchedShots; i++) ids.add(i);
  } else {
    for (let i = importStationIndex - matchedShots; i < importStationIndex; i++) {
      if (i >= 0) ids.add(i);
    }
  }
  return ids;
}

/**
 * Compute the subset of overlap IDs that are "actionable" — shots up to
 * (but not past) the merge station.
 *
 * Front: shots 0..mergeImportStation-1
 * Back:  shots mergeImportStation..(importStationIndex-1)
 */
export function computeActionableIds(
  importStationIndex: number,
  matchedShots: number,
  mergeImportStation: number,
): Set<number> {
  const allOverlap = computeOverlapIds(importStationIndex, matchedShots);
  const actionable = new Set<number>();

  if (importStationIndex === 0) {
    for (let i = 0; i < mergeImportStation; i++) {
      if (allOverlap.has(i)) actionable.add(i);
    }
  } else {
    for (let i = mergeImportStation; i < importStationIndex; i++) {
      if (allOverlap.has(i)) actionable.add(i);
    }
  }
  return actionable;
}

/**
 * Map an overlap shot ID to the corresponding target section shot index.
 *
 * The mapping depends on whether the overlap is at the Front or Back of the
 * import section, and whether the direction is forward or reverse:
 *
 * Front + forward:  existingStationIndex + k
 * Front + reverse:  (existingStationIndex - 1) - k
 * Back  + forward:  (existingStationIndex + matchedShots - 1) - k
 * Back  + reverse:  (existingStationIndex - matchedShots) + k
 *
 * where k = overlapId - overlapStart, and overlapStart is computed from importStationIndex.
 */
export function computeTargetShotIndex(
  overlapId: number,
  params: OverlapParams,
): number {
  const { importStationIndex, matchedShots, existingStationIndex, direction } = params;
  const overlapStart = importStationIndex === 0 ? 0 : importStationIndex - matchedShots;
  const k = overlapId - overlapStart;

  if (importStationIndex === 0) {
    // Front
    return direction === 'forward'
      ? existingStationIndex + k
      : (existingStationIndex - 1) - k;
  } else {
    // Back
    return direction === 'forward'
      ? (existingStationIndex + matchedShots - 1) - k
      : (existingStationIndex - matchedShots) + k;
  }
}

/**
 * Compute merge station options for a suggestion.
 *
 * Each option pairs an import station with the corresponding existing station.
 * The formula does NOT branch on importStationIndex for existingStation:
 *
 *   importStation  = importStationIndex === 0 ? k : importStationIndex - k
 *   existingStation = direction === 'forward'
 *     ? existingStationIndex + k
 *     : existingStationIndex - k
 */
export function computeMergeOptions(
  suggestion: SuggestionLike,
  importShotCount: number,
): MergeOption[] {
  const { importStationIndex, existingStationIndex, matchedShots, direction, isPartial } = suggestion;
  const maxOffset = isPartial ? matchedShots - 1 : matchedShots;
  const options: MergeOption[] = [];

  for (let k = 0; k <= maxOffset; k++) {
    const importStation = importStationIndex === 0 ? k : importStationIndex - k;
    const existingStation = direction === 'forward'
      ? existingStationIndex + k
      : existingStationIndex - k;

    // Guard: stations must stay within valid ranges
    if (importStation < 0 || importStation > importShotCount) continue;
    if (existingStation < 0) continue;

    options.push({ offset: k, importStation, existingStation });
  }
  return options;
}

// ─── Shot transformations ───────────────────────────────────────────────────

/** Average two nullable numbers; returns null if both are null. */
export function avgNullable(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  if (a == null) return b;
  if (b == null) return a;
  return (a + b) / 2;
}

/** Reverse a target shot's direction so it matches the opposite traversal direction. */
export function reverseTargetShot(shot: TargetShotLike): TargetShotLike {
  return {
    azimuth_in: (shot.azimuth_out + 180) % 360,
    azimuth_out: (shot.azimuth_in + 180) % 360,
    length: shot.length,
    depth_in: shot.depth_out,
    depth_out: shot.depth_in,
    pitch_in: shot.pitch_out != null ? -shot.pitch_out : null,
    pitch_out: shot.pitch_in != null ? -shot.pitch_in : null,
    left: shot.right,
    right: shot.left,
    up: shot.up,
    down: shot.down,
  };
}

/** Replace an editable shot's measurement values with target data. */
export function applyTargetData<T extends EditableShotLike>(shot: T, target: TargetShotLike): T {
  return {
    ...shot,
    azimuth_in: target.azimuth_in,
    azimuth_out: target.azimuth_out,
    length: target.length,
    depth_in: target.depth_in,
    depth_out: target.depth_out,
    pitch_in: target.pitch_in,
    pitch_out: target.pitch_out,
    left: target.left,
    right: target.right,
    up: target.up,
    down: target.down,
  };
}

/** Average import and target shot values (circular mean for azimuths). */
export function interpolateShots<T extends EditableShotLike>(importShot: T, target: TargetShotLike): T {
  return {
    ...importShot,
    azimuth_in: circularMeanDegrees(importShot.azimuth_in, target.azimuth_in),
    azimuth_out: circularMeanDegrees(importShot.azimuth_out, target.azimuth_out),
    length: (importShot.length + target.length) / 2,
    depth_in: (importShot.depth_in + target.depth_in) / 2,
    depth_out: (importShot.depth_out + target.depth_out) / 2,
    pitch_in: avgNullable(importShot.pitch_in, target.pitch_in),
    pitch_out: avgNullable(importShot.pitch_out, target.pitch_out),
    left: avgNullable(importShot.left, target.left),
    right: avgNullable(importShot.right, target.right),
    up: avgNullable(importShot.up, target.up),
    down: avgNullable(importShot.down, target.down),
  };
}
