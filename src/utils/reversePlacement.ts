/**
 * Mirroring import placement indices for the per-section reverse toggle (#24).
 *
 * The backend reverses a section's shots BEFORE creating it, so every index in
 * its `ImportPlacement` addresses the final, post-reverse order (decision q14).
 * The wizard, however, collects those indices while the user is looking at the
 * file's original order. Handing them over unchanged would silently connect the
 * section at a different physical station than the one the user clicked.
 *
 * These helpers mirror `i -> shotCount - i`, which is exactly the station
 * renumbering a reverse performs, so the user's pick stays on the physical
 * station they chose.
 */
import type { ImportPlacement } from '../types/commands';
import type { SectionEditState } from './batchImportHelpers';

/**
 * Resolve a from_importing target's post-deletion shot count, but only when
 * that target is itself being reversed (otherwise its indices must not move).
 * Returns `null` when there is nothing to mirror on the target side.
 */
export function targetShotCountForMirror(
  placement: ImportPlacement,
  targetImportIndex: number | null | undefined,
  sectionEdits: Map<number, SectionEditState> | undefined
): number | null {
  if (placement.type !== 'from_importing' || targetImportIndex == null) return null;
  const edits = sectionEdits?.get(targetImportIndex);
  if (!edits?.reverse) return null;
  return edits.shots.filter((s) => !s.isDeleted).length;
}

/** Mirror one station index within a section of `shotCount` shots (N+1 stations). */
export function mirrorStationIndex(stationIndex: number, shotCount: number): number {
  return shotCount - stationIndex;
}

/**
 * Rewrite a placement's indices for reverse.
 *
 * @param placement    the placement built against the file's original order
 * @param selfReversed whether THIS section is being reversed
 * @param selfShots    this section's shot count (post-deletion, as sent)
 * @param targetShots  for `from_importing`, the target section's shot count when
 *                     that section is also being reversed; `null` otherwise
 */
export function mirrorPlacementForReverse(
  placement: ImportPlacement,
  selfReversed: boolean,
  selfShots: number,
  targetShots: number | null
): ImportPlacement {
  let next = placement;

  if (selfReversed) {
    switch (next.type) {
      case 'zero_datum':
        next = { ...next, station_index: mirrorStationIndex(next.station_index, selfShots) };
        break;
      case 'from_existing':
      case 'from_importing':
        next = { ...next, import_station: mirrorStationIndex(next.import_station, selfShots) };
        break;
      case 'manual':
      case 'manual_snap':
        next = {
          ...next,
          align_station_index: mirrorStationIndex(next.align_station_index, selfShots),
        };
        break;
      case 'origin':
        // Station 0 of a reversed section is still the section's own origin.
        break;
    }
  }

  // The target of a from_importing connection renumbers independently: it is a
  // different section with its own reverse flag and its own shot count.
  if (next.type === 'from_importing' && targetShots !== null) {
    next = {
      ...next,
      target_station_index: mirrorStationIndex(next.target_station_index, targetShots),
    };
  }

  return next;
}
