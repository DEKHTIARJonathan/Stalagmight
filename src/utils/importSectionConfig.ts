/**
 * Building the backend `ImportSectionConfig` for an imported DMP section (#24).
 *
 * The wizard has two import paths - the zero-datum anchor, imported on mount
 * straight from `ZeroDatumConfigDialog`, and the batch built from virtual
 * connections - and both have to hand the backend placement indices that
 * address the FINAL, post-edit, post-reverse station order. Keeping that
 * rewrite here (rather than inline in DmpNewImportDialog) gives both paths one
 * implementation and makes it unit-testable without mounting the wizard.
 */
import type { ImportPlacement, ImportSectionConfig } from '../types/commands';
import type { ShotData } from '../types/project';
import type { ZeroDatumConfigResult } from '../components/Dialogs/ZeroDatumConfigDialog';
import type { VirtualConnection } from './segmentContext';
import { adjustStationForDeletedShots, type SectionEditState } from './batchImportHelpers';
import { editableShotToShotData } from './shotConversion';
import { mirrorPlacementForReverse, targetShotCountForMirror } from './reversePlacement';

/**
 * Rewrite a placement's indices for reverse, on both sides of a connection.
 *
 * q14: the backend reverses a section BEFORE creating it, so every index in its
 * placement addresses the post-reverse order, while the wizard collected those
 * indices against the file's original order.
 *
 * The target side is mirrored ONLY when the placement was derived from a
 * connection, so `connection` must be the connection that produced `placement`
 * or `null`. A direct placement (segment "From existing", or a manual /
 * manual_snap drop) targets a live project section, which this batch does not
 * renumber - while an unrelated auto-derived connection for the same section
 * would mirror the user's chosen station onto the wrong physical end (or out of
 * range, failing the whole batch in merge_stations).
 */
export function finalizePlacementForReverse(
  placement: ImportPlacement,
  selfReversed: boolean,
  selfShots: number,
  connection: VirtualConnection | null | undefined,
  sectionEdits: Map<number, SectionEditState> | undefined,
): ImportPlacement {
  const targetShots = targetShotCountForMirror(
    placement,
    connection?.targetType,
    connection?.targetImportIndex,
    sectionEdits,
  );
  return mirrorPlacementForReverse(placement, selfReversed, selfShots, targetShots);
}

/**
 * Build the backend config for the zero-datum anchor section.
 *
 * The GPS station is picked off the section preview, which draws the file's
 * ORIGINAL shots, so the index is pre-deletion; the shots actually sent are
 * post-deletion. `adjustStationForDeletedShots` bridges the two, and only then
 * can the reverse mirror (`shotCount - index`) land on the station the user
 * clicked - mirroring the raw index would be off by the number of deleted shots
 * ahead of it, and for a pick near the end could go negative (`station_index`
 * is `u32`, so serde would reject the whole import).
 */
export function buildZeroDatumSectionConfig(config: ZeroDatumConfigResult): ImportSectionConfig {
  const { sectionIndex, stationIndex, gps, metadata, shots } = config;
  const backendShots: ShotData[] = shots.filter((s) => !s.isDeleted).map(editableShotToShotData);
  const reverse = metadata.reverse ?? false;

  const placement: ImportPlacement = {
    type: 'zero_datum',
    coordinates: gps,
    station_index: adjustStationForDeletedShots(shots, stationIndex),
  };

  return {
    section_index: sectionIndex,
    name: metadata.name,
    surveyor: metadata.surveyor,
    date: metadata.date,
    color: metadata.color,
    direction: metadata.direction,
    quality: metadata.quality,
    shots: backendShots,
    placement: mirrorPlacementForReverse(placement, reverse, backendShots.length, null),
    station_comments: [],
    reverse,
  };
}
