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
import { isEmittedShot } from '../components/common/emittedShots';
import type { SectionEditState } from './batchImportHelpers';

/**
 * Resolve the target section's post-deletion shot count, but only when that
 * target is itself being reversed (otherwise its indices must not move).
 * Returns `null` when there is nothing to mirror on the target side.
 *
 * Both connection shapes need this. A `from_importing` target renumbers when
 * the batch creates it reversed. A `from_existing` target normally must NOT be
 * mirrored - the user picked that index off the live project, where the section
 * already has its final numbering - with one exception: the wizard rewrites a
 * connection into `from_existing` when its target was created earlier in the
 * SAME run (early-import), and if that section was created reversed then its
 * stations were mirrored after the user's index was recorded.
 *
 * That exception is the only reason a `from_existing` index ever moves, so it is
 * gated on the connection's `targetType` being `importing` - the one case where
 * this batch decides the target's numbering. A connection to a section that was
 * already in the project is never mirrored, whatever the placement looks like.
 *
 * CALLER CONTRACT: pass the connection that *produced* `placement`, or nothing.
 * A placement built some other way - a segment "From existing" drop, or a manual
 * placement - addresses a live project section this batch never renumbers, and an
 * unrelated connection that happens to share the section index would mirror the
 * user's chosen station onto the wrong physical end.
 */
export function targetShotCountForMirror(
  placement: ImportPlacement,
  targetType: 'existing' | 'importing' | null | undefined,
  targetImportIndex: number | null | undefined,
  sectionEdits: Map<number, SectionEditState> | undefined
): number | null {
  if (placement.type !== 'from_importing' && placement.type !== 'from_existing') return null;
  if (targetType !== 'importing' || targetImportIndex == null) return null;
  const edits = sectionEdits?.get(targetImportIndex);
  if (!edits?.reverse) return null;
  // EMITTED, not merely non-deleted: the payload builders drop wholly blank new
  // rows, so mirroring across the longer count reflected the station about the
  // wrong midpoint and attached the import to the wrong physical station.
  return edits.shots.filter(isEmittedShot).length;
}

/**
 * Mirror one station index within a section of `shotCount` shots (N+1 stations).
 *
 * Clamped to the section's real station range `0..shotCount`. An index the
 * mirror would take out of range is already wrong - it addresses a station the
 * section does not have - but the two failure modes are not equal: a NEGATIVE
 * index cannot even be sent, because `station_index` is `u32` on the Rust side,
 * so serde rejects the whole batch with an opaque deserialization error instead
 * of the placement-level "index out of range" the un-reversed path reports.
 * Clamping keeps a bad index describable by the backend that validates it.
 * (The backend's station-comment mirror uses `checked_sub` and DROPS an
 * out-of-range comment instead - it can, a comment is optional. A placement is
 * not, so here the index is clamped rather than discarded.)
 */
export function mirrorStationIndex(stationIndex: number, shotCount: number): number {
  return Math.max(0, Math.min(shotCount, shotCount - stationIndex));
}

/**
 * Rewrite a placement's indices for reverse.
 *
 * @param placement    the placement built against the file's original order
 * @param selfReversed whether THIS section is being reversed
 * @param selfShots    this section's shot count (post-deletion, as sent)
 * @param targetShots  the target section's shot count when that section is also
 *                     being reversed; `null` otherwise. See
 *                     {@link targetShotCountForMirror}.
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
        // No index to mirror - `origin` carries none. The section does still
        // move: the backend adds the section's own displacement to its anchor
        // (see `execute_import_sections`), because station 0 is now the far end.
        break;
    }
  }

  // The target renumbers independently of this section: it is a different
  // section with its own reverse flag and its own shot count, so this applies
  // whether or not `selfReversed` is set.
  if (targetShots !== null) {
    if (next.type === 'from_importing') {
      next = {
        ...next,
        target_station_index: mirrorStationIndex(next.target_station_index, targetShots),
      };
    } else if (next.type === 'from_existing') {
      // Only reachable for an early-imported target that was created reversed -
      // see targetShotCountForMirror. Without this the section merges onto
      // station k of a section whose stations are now numbered N-k, attaching
      // the passage to the wrong physical end.
      next = {
        ...next,
        existing_station: {
          ...next.existing_station,
          station_index: mirrorStationIndex(next.existing_station.station_index, targetShots),
        },
      };
    }
  }

  return next;
}
