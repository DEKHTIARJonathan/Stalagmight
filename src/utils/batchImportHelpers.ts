/**
 * Pure helpers extracted from DmpNewImportDialog for testability.
 *
 * These functions handle connection resolution and overlap-aware redirect
 * logic during the batch import config-building phase.
 */

import type { EditableShot } from '../components/common/ShotTableEditor';
import type { VirtualConnection } from './segmentContext';
import type { CrossSectionSuggestion } from '../types/commands';
import { computeOverlapIds } from './overlapHelpers';

// ─── Shared types ────────────────────────────────────────────────────────────

export interface SectionEditState {
  name: string;
  surveyor: string;
  date: string;
  color: string;
  direction: 'in' | 'out';
  quality: number;
  shots: EditableShot[];
}

/** Merge station info recorded when user confirms a suggestion. */
export interface ConfirmedOverlapInfo {
  /** Fields to match the suggestion in the pool (reference equality breaks after save/restore). */
  importStationIndex: number;
  matchedShots: number;
  direction: 'forward' | 'reverse';
  existingStationIndex: number;
  targetType: 'existing' | 'importing';
  existingSectionId: number | null;
  targetImportIndex: number | null;
  /** User-selected merge station (determines which overlap shots are actionable). */
  mergeImportStation: number;
}

// ─── adjustStationForDeletedShots ────────────────────────────────────────────

/**
 * When overlap shots are deleted from an import section, station indices
 * shift. This counts non-deleted shots before the original station position
 * to compute the adjusted index in the filtered shot array.
 */
export function adjustStationForDeletedShots(
  shots: EditableShot[],
  originalStation: number,
): number {
  let adjusted = 0;
  for (const s of shots) {
    if (s.isDeleted) continue;
    if (!s.isNew && s.id >= originalStation) break;
    adjusted++;
  }
  return adjusted;
}

// ─── findOverlapForStation ───────────────────────────────────────────────────

/**
 * Find the overlap whose deleted zone contains `targetStation` for a section.
 *
 * Checks confirmedOverlaps first, then falls back to searching the suggestion
 * pool. Handles both existing-to-import and import-to-import overlaps.
 */
export function findOverlapForStation(
  sectionIndex: number,
  targetStation: number,
  confirmedOverlaps: Map<number, ConfirmedOverlapInfo>,
  fullPool: CrossSectionSuggestion[],
): ConfirmedOverlapInfo | null {
  // 1. Check confirmed overlap — the merge station determines the deleted zone boundary
  const confirmed = confirmedOverlaps.get(sectionIndex);
  if (confirmed) {
    const isFront = confirmed.importStationIndex === 0;
    const inDeletedZone = isFront
      ? targetStation < confirmed.mergeImportStation
      : targetStation > confirmed.mergeImportStation;
    if (inDeletedZone) return confirmed;
  }

  // 2. Fall back to suggestion pool — for unconfirmed overlaps ALL overlap shots
  //    are deleted, so the boundary is at the edge of the overlap region.
  for (const s of fullPool) {
    if (s.importSectionIndex !== sectionIndex) continue;

    const isFront = s.importStationIndex === 0;
    const mergeStation = isFront
      ? s.matchedShots
      : s.importStationIndex - s.matchedShots;

    const inDeletedZone = isFront
      ? targetStation < mergeStation
      : targetStation > mergeStation;

    if (inDeletedZone) {
      return {
        importStationIndex: s.importStationIndex,
        matchedShots: s.matchedShots,
        direction: s.direction,
        existingStationIndex: s.existingStationIndex,
        targetType: s.targetType as 'existing' | 'importing',
        existingSectionId: s.existingSectionId,
        targetImportIndex: s.targetImportIndex ?? null,
        mergeImportStation: mergeStation,
      };
    }
  }

  return null;
}

// ─── findReverseImportConnection ─────────────────────────────────────────────

/**
 * Find a reverse import-to-import connection for a section that is only a TARGET.
 * When section B is only referenced as the target of A→B, B has no connectionMap entry.
 * This searches allConnections for such a connection where the import side IS already
 * emitted, and returns a synthetic reversed connection so B can attach to A.
 */
export function findReverseImportConnection(
  idx: number,
  allConnections: VirtualConnection[],
  emittedPosition: Map<number, number>,
): VirtualConnection | undefined {
  for (const c of allConnections) {
    if (c.targetType !== 'importing') continue;
    if (c.targetImportIndex !== idx) continue;
    if (!emittedPosition.has(c.importSectionIndex)) continue;
    // Create a synthetic reversed connection: idx attaches to c.importSectionIndex
    return {
      importSectionIndex: idx,
      importStationIndex: c.targetImportStationIndex ?? 0,
      targetType: 'importing',
      targetImportIndex: c.importSectionIndex,
      targetImportStationIndex: c.importStationIndex,
    };
  }
  return undefined;
}

// ─── redirectDeletedTargets ──────────────────────────────────────────────────

/**
 * Redirect connections whose target station falls in a deleted overlap zone.
 *
 * When section B overlaps with A (existing) or C (importing) and B's overlap
 * shots are deleted, any connection targeting a deleted station in B must be
 * redirected to the corresponding station in the section that replaced those
 * shots. Handles both existing and importing overlaps, and follows chains
 * (B→C→D) up to MAX_DEPTH.
 *
 * Mutates connections in place.
 */
export function redirectDeletedTargets(
  connections: VirtualConnection[],
  sectionEdits: Map<number, SectionEditState>,
  confirmedOverlaps: Map<number, ConfirmedOverlapInfo>,
  fullPool: CrossSectionSuggestion[],
): void {
  const MAX_DEPTH = 10;

  for (const conn of connections) {
    if (conn.targetType !== 'importing') continue;
    if (conn.targetImportIndex == null || conn.targetImportStationIndex == null) continue;

    let targetIdx = conn.targetImportIndex;
    let targetStation = conn.targetImportStationIndex;
    let depth = 0;

    while (depth < MAX_DEPTH) {
      const overlap = findOverlapForStation(targetIdx, targetStation, confirmedOverlaps, fullPool);
      if (!overlap) break;

      // For import-to-import overlaps, the pool may contain suggestions for both
      // directions (A→B and B→A).  applyAllOverlapTreatments processes them in order
      // and only the first direction actually deletes the import side's shots; the
      // other direction's import side is already treated (interpolated, not deleted).
      // Verify by checking whether the overlap shots are actually deleted in sectionEdits.
      if (overlap.targetType === 'importing') {
        const edits = sectionEdits.get(targetIdx);
        if (edits) {
          const overlapIds = computeOverlapIds(overlap.importStationIndex, overlap.matchedShots);
          const hasDeletedOverlap = edits.shots.some(
            s => !s.isNew && overlapIds.has(s.id) && s.isDeleted,
          );
          if (!hasDeletedOverlap) {
            break;
          }
        }
      }

      // Compute the offset into the overlap and map to the next section
      const isFront = overlap.importStationIndex === 0;
      const offset = isFront
        ? targetStation
        : overlap.importStationIndex - targetStation;

      const newStation = overlap.direction === 'forward'
        ? overlap.existingStationIndex + offset
        : overlap.existingStationIndex - offset;

      depth++;

      if (overlap.targetType === 'existing' && overlap.existingSectionId != null) {
        // Redirect to existing section — end of chain
        conn.targetType = 'existing';
        conn.existingSectionId = overlap.existingSectionId;
        conn.existingStationIndex = newStation;
        delete conn.targetImportIndex;
        delete conn.targetImportStationIndex;
        break;
      } else if (overlap.targetImportIndex != null) {
        // Redirect to another import section — continue chain
        targetIdx = overlap.targetImportIndex;
        targetStation = newStation;
      } else {
        break;
      }
    }

    // Update connection if redirected to another import section (not existing)
    if (conn.targetType === 'importing' && depth > 0) {
      conn.targetImportIndex = targetIdx;
      conn.targetImportStationIndex = targetStation;
    }
  }
}
