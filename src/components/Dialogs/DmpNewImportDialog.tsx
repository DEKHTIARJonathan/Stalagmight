import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invokeIpc } from '../../utils/ipc';
import { Button } from '../common/Button';
import { CheckCircleIcon } from '../common/icons';
import type { DmpFile, DmpShot, CrossSectionSuggestion, ImportSectionForSuggestion, CommandResult, SegmentGeometry } from '../../types/commands';
import type { DmpSelectionConfig } from './DmpSelectionDialog';
import type { Project, Station, ShotData } from '../../types/project';
import type { ImportSectionConfig as BackendImportSectionConfig, ImportPlacement } from '../../types/commands';
import type { ZeroDatumConfigResult } from './ZeroDatumConfigDialog';
import type { DmpSection } from '../../types/commands';
import type { OverlapMode } from '../../types/config';
import SectionPreview, { type MergePreviewConfig, type DmpMergePreviewConfig, type ContextSectionGeometry, computeStationsFromDmpShots, computeStationsFromShots } from './SectionPreview';
import { Select, type SelectOption } from '../common/Select';
import { DialogWrapper } from './DialogWrapper';
import { AlertDialog } from './AlertDialog';
import { SectionMetadataForm } from '../common/SectionMetadataForm';
import { ShotTableEditor, type EditableShot } from '../common/ShotTableEditor';
import { useProjectStore } from '../../store/projectStore';
import { convertToEditableShots } from '../../hooks/useImportState';
import { editableShotToShotData } from '../../utils/shotConversion';
import {
  computeMergeOptions,
  computeOverlapIds,
  computeActionableIds,
  computeTargetShotIndex,
  needsDirectionReversal,
  reverseTargetShot,
  applyTargetData,
  interpolateShots,
  type TargetShotLike,
} from '../../utils/overlapHelpers';
import {
  SECTION_COLORS,
  type VirtualConnection,
  type ExistingSectionGeoEntry,
  buildAdjacency,
  computeDmpBfsContext,
  stationPositionFromShotLines,
  discoverBridgedDmpSections,
  computeUnreachableSegments,
  computeSegmentLayout,
} from '../../utils/segmentContext';
import { useUIStore, type PlacementResult } from '../../store/uiStore';
import {
  adjustStationForDeletedShots,
  findReverseImportConnection,
  redirectDeletedTargets,
  type SectionEditState,
  type ConfirmedOverlapInfo,
} from '../../utils/batchImportHelpers';

interface DmpNewImportDialogProps {
  dmpFile: DmpFile;
  selectionConfig: DmpSelectionConfig;
  project: Project | null;
  stations: Station[];
  zeroDatumConfig?: ZeroDatumConfigResult | undefined;
  onCancel: () => void;
  onBack: () => void;
  onComplete: (newSectionIds?: number[]) => void;
  /** Saved state to restore after returning from manual map placement. */
  savedManualPlacingState?: SavedManualPlacingState | undefined;
  /** If true, immediately start map placement when the dialog opens in manual placing phase. */
  autoStartManualPlacement?: boolean;
}

// SectionEditState and ConfirmedOverlapInfo imported from batchImportHelpers

// ─── Direct placement (manual_placing phase) ─────────────────────────────────

/** A placement decision made during the manual_placing phase for a segment. */
export type DirectPlacement = {
  anchorSectionIndex: number;   // DMP file section index (anchor within segment)
  anchorStationIndex: number;   // station within that section
  placement: ImportPlacement;   // origin, zero_datum, manual, manual_snap, or from_existing
};

/** Saved state for restoring the dialog after manual map placement. */
export interface SavedManualPlacingState {
  connections: VirtualConnection[];
  skippedIndices: number[];
  segmentQueue: number[][];
  segmentAnchor: { sectionIndex: number; stationIndex: number };
  directPlacements: DirectPlacement[];
  skippedSuggestions: Array<[number, CrossSectionSuggestion]>;
  segmentSkipCounts: Array<[string, number]>;
  sectionEdits: Array<[number, SectionEditState]>;
  confirmedOverlaps?: Array<[number, ConfirmedOverlapInfo]>;
  earlyImported?: Array<[number, number]>;
  /** DMP indices of a segment just placed that needs immediate import on dialog restore. */
  pendingSegmentImport?: number[];
  /** DMP indices of segments the user chose to discard ("Do not place"). */
  discardedIndices?: number[];
}

// ─── Effective section helpers ────────────────────────────────────────────────

/**
 * Build a DmpSection reflecting edits (deleted shots removed, interpolated
 * values applied). Falls back to the raw section when no edits exist.
 */
function buildEffectiveDmpSection(raw: DmpSection, edits: SectionEditState | undefined): DmpSection {
  if (!edits) return raw;
  return {
    ...raw,
    name: edits.name,
    direction: edits.direction,
    shots: edits.shots
      .filter(s => !s.isDeleted)
      .map(s => ({
        shot_type: 'Standard' as const,
        heading_in: s.azimuth_in,
        heading_out: s.azimuth_out,
        length: s.length,
        depth_in: s.depth_in,
        depth_out: s.depth_out,
        pitch_in: s.pitch_in ?? 0,
        pitch_out: s.pitch_out ?? 0,
        left: s.left ?? 0,
        right: s.right ?? 0,
        up: s.up ?? 0,
        down: s.down ?? 0,
        temperature: 0, hour: 0, minute: 0, second: 0, marker_index: 0,
        ...(s.comment != null ? { comment: s.comment } : {}),
      })),
  };
}

/**
 * Adjust VirtualConnection station indices to account for deleted shots in
 * edited sections (so layout offsets align with post-treatment geometry).
 */
function adjustConnectionsForEdits(
  connections: VirtualConnection[],
  sectionEdits: Map<number, SectionEditState>,
): VirtualConnection[] {
  return connections.map(conn => {
    const importEdits = sectionEdits.get(conn.importSectionIndex);
    const adjustedImport = importEdits
      ? adjustStationForDeletedShots(importEdits.shots, conn.importStationIndex)
      : conn.importStationIndex;

    const adjustedTarget =
      conn.targetType === 'importing' && conn.targetImportIndex != null && conn.targetImportStationIndex != null
        ? (sectionEdits.get(conn.targetImportIndex)
            ? adjustStationForDeletedShots(sectionEdits.get(conn.targetImportIndex)!.shots, conn.targetImportStationIndex)
            : conn.targetImportStationIndex)
        : conn.targetImportStationIndex;

    return {
      ...conn,
      importStationIndex: adjustedImport,
      ...(adjustedTarget != null ? { targetImportStationIndex: adjustedTarget } : {}),
    };
  });
}

// ─── Graph helpers ───────────────────────────────────────────────────────────

/** BFS from a set of seed nodes, returning reachable nodes in traversal order. */
function bfsReachable(
  seeds: Set<number>,
  adjacency: Map<number, Array<{ neighbor: number; connection: VirtualConnection }>>,
): number[] {
  const visited = new Set<number>();
  const queue: number[] = [];
  const order: number[] = [];

  for (const seed of seeds) {
    if (!visited.has(seed)) {
      visited.add(seed);
      queue.push(seed);
    }
  }

  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);
    for (const edge of adjacency.get(node) ?? []) {
      if (!visited.has(edge.neighbor)) {
        visited.add(edge.neighbor);
        queue.push(edge.neighbor);
      }
    }
  }
  return order;
}

/** Check if a suggestion matches a confirmed overlap info by field comparison. */
function matchesConfirmed(s: CrossSectionSuggestion, info: ConfirmedOverlapInfo): boolean {
  return s.importStationIndex === info.importStationIndex
    && s.matchedShots === info.matchedShots
    && s.direction === info.direction
    && s.existingStationIndex === info.existingStationIndex
    && s.targetType === info.targetType
    && s.existingSectionId === info.existingSectionId
    && s.targetImportIndex === info.targetImportIndex;
}

/**
 * Apply overlap treatments for ALL known overlaps in a single pass.
 *
 * This is the single source of truth for overlap mutation. It runs once before
 * `buildBatchImport`. For confirmed suggestions, it uses the user-selected
 * merge station to determine actionable IDs. For unconfirmed suggestions,
 * it treats ALL overlap IDs.
 *
 * Mutates `sectionEdits` in-place.
 */
interface ExistingShotUpdateLocal {
  section_id: number;
  shot_id: number;
  updates: Record<string, number | null>;
}

function applyAllOverlapTreatments(
  fullPool: CrossSectionSuggestion[],
  confirmedOverlaps: Map<number, ConfirmedOverlapInfo>,
  sectionEdits: Map<number, SectionEditState>,
  dmpFile: DmpFile,
  overlapMode: OverlapMode,
): ExistingShotUpdateLocal[] {
  const existingShotUpdates: ExistingShotUpdateLocal[] = [];
  if (import.meta.env.DEV) {
    console.warn(
      `[applyAllOverlaps] START: pool=${fullPool.length} suggestions, confirmed=${confirmedOverlaps.size}, mode=${overlapMode}`,
      `edits keys=[${[...sectionEdits.keys()].join(',')}]`,
    );
  }
  // Track shots already treated by a previous suggestion to prevent double-treatment.
  // Key: "sectionIndex:shotId".  This replaced the old is_reference guard which was
  // removed so that is_reference only has user-facing semantics (keep_both mode).
  const treatedShots = new Set<string>();

  for (const suggestion of fullPool) {
    const {
      importSectionIndex,
      importStationIndex,
      matchedShots,
      existingStationIndex,
      direction,
      targetType,
      existingSectionId,
      targetImportIndex,
    } = suggestion;

    const allOverlapIds = computeOverlapIds(importStationIndex, matchedShots);
    if (allOverlapIds.size === 0) continue;

    // Determine actionable IDs: use merge station from confirmed info, or full overlap range
    const confirmed = confirmedOverlaps.get(importSectionIndex);
    const isConfirmed = !!(confirmed && matchesConfirmed(suggestion, confirmed));
    let actionableIds: Set<number>;
    if (isConfirmed) {
      actionableIds = computeActionableIds(importStationIndex, matchedShots, confirmed!.mergeImportStation);
    } else {
      actionableIds = allOverlapIds;
    }

    if (import.meta.env.DEV) {
      console.warn(
        `[applyAllOverlaps] processing suggestion: import=${importSectionIndex} impStn=${importStationIndex}`,
        `matched=${matchedShots} dir=${direction} target=${targetType === 'importing' ? targetImportIndex : existingSectionId}`,
        `targetType=${targetType} mode=${overlapMode}`,
        `confirmed=${!!confirmed && matchesConfirmed(suggestion, confirmed)}`,
        `actionableIds=[${[...actionableIds].join(',')}]`,
      );
    }

    // --- Import side: treat untreated overlap shots on the import section ---
    let importEdits = sectionEdits.get(importSectionIndex);
    if (!importEdits) {
      const section = dmpFile.sections[importSectionIndex];
      if (section) {
        importEdits = {
          name: section.name,
          surveyor: '',
          date: section.date?.split(/[T ]/)[0] ?? '',
          color: '',
          direction: section.direction === 'out' ? 'out' : 'in',
          quality: 1.0,
          shots: convertToEditableShots(section.shots),
        };
        sectionEdits.set(importSectionIndex, importEdits);
      }
    }
    // Save raw import shots BEFORE import-side treatment modifies them.
    // Target-side treatment needs original values to produce symmetric interpolation.
    const rawImportShots = importEdits?.shots;

    if (importEdits) {
      const hasUntreated = importEdits.shots.some(
        shot => !shot.isNew && !shot.isDeleted && actionableIds.has(shot.id)
          && !treatedShots.has(`${importSectionIndex}:${shot.id}`)
      );

      if (hasUntreated) {
        if (overlapMode === 'keep_both') {
          // keep_both: mark import overlap shots as reference (no deletion, no value change)
          const newShots = importEdits.shots.map(shot => {
            if (shot.isNew || shot.isDeleted) return shot;
            if (!actionableIds.has(shot.id)) return shot;
            if (treatedShots.has(`${importSectionIndex}:${shot.id}`)) return shot;
            treatedShots.add(`${importSectionIndex}:${shot.id}`);
            return { ...shot, is_reference: true };
          });
          if (import.meta.env.DEV) {
            const marked = newShots.filter(s => s.is_reference).length - importEdits.shots.filter(s => s.is_reference).length;
            console.warn(`[applyAllOverlaps]   import ${importSectionIndex}: keep_both marked ${marked} shots as reference`);
          }
          sectionEdits.set(importSectionIndex, { ...importEdits, shots: newShots });
        } else {
          // Build target map for interpolate/existing_data modes
          let targetMap: Map<number, TargetShotLike> | null = null;
          let targetMapDiag = '';
          if (overlapMode !== 'import_data') {
            let targetShotArray: TargetShotLike[] | null = null;
            if (targetType === 'existing' && existingSectionId != null) {
              const currentProject = useProjectStore.getState().project;
              const targetSection = currentProject?.sections.find(s => s.id === existingSectionId);
              if (targetSection) {
                targetShotArray = targetSection.shots;
                targetMapDiag = `existing section ${existingSectionId} (${targetSection.shots.length} shots)`;
              } else {
                targetMapDiag = `MISS: existing section ${existingSectionId} not found in project`;
              }
            } else if (targetType === 'importing' && targetImportIndex != null) {
              const targetEdits = sectionEdits.get(targetImportIndex);
              if (targetEdits) {
                targetShotArray = targetEdits.shots.filter(s => !s.isDeleted);
                targetMapDiag = `importing section ${targetImportIndex} from edits (${targetEdits.shots.length} total, ${targetShotArray.length} alive)`;
              } else {
                const targetDmpSection = dmpFile.sections[targetImportIndex];
                if (targetDmpSection) {
                  targetShotArray = convertToEditableShots(targetDmpSection.shots);
                  targetMapDiag = `importing section ${targetImportIndex} from DMP (${targetShotArray.length} shots)`;
                } else {
                  targetMapDiag = `MISS: importing section ${targetImportIndex} not in edits or DMP`;
                }
              }
            } else {
              targetMapDiag = `MISS: targetType=${targetType} existingSectionId=${existingSectionId} targetImportIndex=${targetImportIndex}`;
            }

            if (targetShotArray) {
              const shouldReverse = needsDirectionReversal(importStationIndex, direction);
              const overlapParams = { importStationIndex, matchedShots, existingStationIndex, direction };
              targetMap = new Map<number, TargetShotLike>();
              for (const overlapId of actionableIds) {
                const targetIdx = computeTargetShotIndex(overlapId, overlapParams);
                if (targetIdx >= 0 && targetIdx < targetShotArray.length) {
                  const raw = targetShotArray[targetIdx]!;
                  targetMap.set(overlapId, shouldReverse ? reverseTargetShot(raw) : raw);
                } else if (import.meta.env.DEV) {
                  console.warn(
                    `[applyAllOverlaps]   targetIdx OUT OF RANGE: overlapId=${overlapId} → targetIdx=${targetIdx} (array len=${targetShotArray.length})`,
                  );
                }
              }
            }
          } else {
            targetMapDiag = 'SKIPPED (import_data mode)';
          }

          if (import.meta.env.DEV) {
            console.warn(
              `[applyAllOverlaps]   import ${importSectionIndex}: targetMap=${targetMap ? targetMap.size : 'null'}`,
              `source: ${targetMapDiag}`,
            );
          }

          let diagInterpolated = 0, diagRefOnly = 0, diagAlreadyTreated = 0, diagDeleted = 0;
          const newShots = importEdits.shots.map(shot => {
            if (shot.isNew || shot.isDeleted) return shot;
            if (!actionableIds.has(shot.id)) return shot;
            const treatKey = `${importSectionIndex}:${shot.id}`;
            if (treatedShots.has(treatKey)) { diagAlreadyTreated++; return shot; }

            // Import-to-import: always delete — target section keeps the overlap (treated below).
            // Confirmed import-to-existing: delete — target section gets interpolated values.
            if (targetType === 'importing' || isConfirmed) {
              diagDeleted++;
              treatedShots.add(treatKey);
              return { ...shot, isDeleted: true };
            }

            const target = targetMap?.get(shot.id);
            treatedShots.add(treatKey);
            if (overlapMode === 'interpolate' && target) {
              diagInterpolated++;
              return interpolateShots(shot, target);
            } else if (overlapMode === 'existing_data' && target) {
              diagInterpolated++;
              return applyTargetData(shot, target);
            } else {
              diagRefOnly++;
              return shot;
            }
          });

          if (import.meta.env.DEV) {
            console.warn(
              `[applyAllOverlaps]   import ${importSectionIndex} RESULT:`,
              `interpolated=${diagInterpolated} deleted=${diagDeleted} refOnly=${diagRefOnly} alreadyTreated=${diagAlreadyTreated}`,
            );
            if (diagRefOnly > 0 && overlapMode !== 'import_data') {
              console.warn(
                `[applyAllOverlaps]   ⚠ ${diagRefOnly} shots WITHOUT target data (kept original values)`,
                `targetMap=${targetMap ? `size=${targetMap.size} keys=[${[...targetMap.keys()].join(',')}]` : 'null'}`,
                `actionableIds=[${[...actionableIds].join(',')}]`,
              );
            }
          }

          sectionEdits.set(importSectionIndex, { ...importEdits, shots: newShots });
          if (import.meta.env.DEV) {
            const alive = newShots.filter(s => !s.isDeleted).length;
            const deleted = newShots.filter(s => s.isDeleted).length;
            const refs = newShots.filter(s => s.is_reference && !s.isDeleted).length;
            console.warn(
              `[applyAllOverlaps]   import ${importSectionIndex} AFTER: ${newShots.length} total, ${alive} alive, ${deleted} deleted, ${refs} reference`,
            );
          }
        }
      }
    }

    // --- Target side (import-to-existing): collect shot updates for existing project sections ---
    // Confirmed import-to-existing: compute interpolated values and collect as ExistingShotUpdate.
    // These are sent to the backend as part of the atomic import transaction.
    if (overlapMode !== 'keep_both' && isConfirmed && targetType === 'existing' && existingSectionId != null) {
      const currentProject = useProjectStore.getState().project;
      const targetSection = currentProject?.sections.find(s => s.id === existingSectionId);
      if (targetSection) {
        const overlapParams = { importStationIndex, matchedShots, existingStationIndex, direction };
        const shouldReverse = needsDirectionReversal(importStationIndex, direction);
        const importShotsForInterp = rawImportShots ?? [];

        for (const overlapId of actionableIds) {
          const targetShotIdx = computeTargetShotIndex(overlapId, overlapParams);
          if (targetShotIdx < 0 || targetShotIdx >= targetSection.shots.length) continue;

          const existingShot = targetSection.shots[targetShotIdx];
          if (!existingShot) continue;
          const treatKey = `existing:${existingSectionId}:${existingShot.id}`;
          if (treatedShots.has(treatKey)) continue;

          const importShot = importShotsForInterp.find(
            s => !s.isNew && !s.isDeleted && s.id === overlapId
          );
          if (!importShot) continue;

          const importAsTarget: TargetShotLike = shouldReverse
            ? reverseTargetShot(importShot)
            : importShot;

          let updates: Record<string, number | null> | null = null;
          if (overlapMode === 'interpolate') {
            const interp = interpolateShots({ ...existingShot, id: existingShot.id, comment: existingShot.comment ?? null, is_reference: existingShot.is_reference, isNew: false, isDeleted: false }, importAsTarget);
            updates = {
              azimuth_in: interp.azimuth_in, azimuth_out: interp.azimuth_out,
              length: interp.length, depth_in: interp.depth_in, depth_out: interp.depth_out,
              pitch_in: interp.pitch_in, pitch_out: interp.pitch_out,
              left: interp.left, right: interp.right, up: interp.up, down: interp.down,
            };
          } else if (overlapMode === 'import_data') {
            updates = {
              azimuth_in: importAsTarget.azimuth_in, azimuth_out: importAsTarget.azimuth_out,
              length: importAsTarget.length, depth_in: importAsTarget.depth_in, depth_out: importAsTarget.depth_out,
              pitch_in: importAsTarget.pitch_in, pitch_out: importAsTarget.pitch_out,
              left: importAsTarget.left, right: importAsTarget.right, up: importAsTarget.up, down: importAsTarget.down,
            };
          }
          // existing_data: target keeps its own values — no update needed

          if (updates) {
            if (import.meta.env.DEV) {
              console.warn(
                `[applyAllOverlaps]   i2e update: section=${existingSectionId} shotId=${existingShot.id} shotIdx=${targetShotIdx}`,
                `existing len=${existingShot.length.toFixed(3)} → update len=${(updates.length as number)?.toFixed(3)}`,
                `existing az=${existingShot.azimuth_in.toFixed(1)} → update az=${(updates.azimuth_in as number)?.toFixed(1)}`,
              );
            }
            existingShotUpdates.push({
              section_id: existingSectionId,
              shot_id: existingShot.id,
              updates,
            });
            treatedShots.add(treatKey);
          }
        }

        if (import.meta.env.DEV) {
          console.warn(
            `[applyAllOverlaps]   existing target ${existingSectionId}: ${existingShotUpdates.length} shot updates collected`,
          );
        }
      }
    }

    // --- Target side (import-to-import): treat untreated overlap shots on the target section ---
    // keep_both: no target modification — both sections retain their original values.
    if (overlapMode !== 'keep_both' && targetType === 'importing' && targetImportIndex != null) {
      let targetEdits = sectionEdits.get(targetImportIndex);
      if (!targetEdits) {
        const section = dmpFile.sections[targetImportIndex];
        if (section) {
          targetEdits = {
            name: section.name,
            surveyor: '',
            date: section.date?.split(/[T ]/)[0] ?? '',
            color: '',
            direction: section.direction === 'out' ? 'out' : 'in',
            quality: 1.0,
            shots: convertToEditableShots(section.shots),
          };
          sectionEdits.set(targetImportIndex, targetEdits);
        }
      }
      if (targetEdits) {
        const overlapParams = { importStationIndex, matchedShots, existingStationIndex, direction };
        const shouldReverse = needsDirectionReversal(importStationIndex, direction);

        let hasUntreatedTarget = false;
        for (const overlapId of actionableIds) {
          const targetShotIdx = computeTargetShotIndex(overlapId, overlapParams);
          if (targetShotIdx >= 0 && targetShotIdx < targetEdits.shots.length) {
            const shot = targetEdits.shots[targetShotIdx];
            if (shot && !shot.isDeleted && !treatedShots.has(`${targetImportIndex}:${shot.id}`)) {
              hasUntreatedTarget = true;
              break;
            }
          }
        }

        if (hasUntreatedTarget) {
          // Use raw (pre-interpolation) import shots so both sides get symmetric results.
          // If we read from sectionEdits here, import-side treatment has already averaged
          // the values, and averaging again biases toward the target: avg(T, avg(I,T)) = (3T+I)/4.
          const importShotsForInterp = rawImportShots ?? [];
          const targetShots = targetEdits.shots.map(s => ({ ...s }));
          let treated = 0;
          let skippedOutOfRange = 0, skippedAlreadyTreated = 0, skippedNoImport = 0;

          for (const overlapId of actionableIds) {
            const targetShotIdx = computeTargetShotIndex(overlapId, overlapParams);
            if (targetShotIdx < 0 || targetShotIdx >= targetShots.length) { skippedOutOfRange++; continue; }

            const targetShot = targetShots[targetShotIdx];
            if (!targetShot || targetShot.isDeleted) { skippedAlreadyTreated++; continue; }
            const targetTreatKey = `${targetImportIndex}:${targetShot.id}`;
            if (treatedShots.has(targetTreatKey)) { skippedAlreadyTreated++; continue; }

            const importShot = importShotsForInterp.find(
              s => !s.isNew && !s.isDeleted && s.id === overlapId
            );
            if (!importShot) { skippedNoImport++; continue; }

            const importAsTarget: TargetShotLike = shouldReverse
              ? reverseTargetShot(importShot)
              : importShot;

            if (overlapMode === 'interpolate') {
              const interpResult = interpolateShots(targetShot, importAsTarget);
              if (import.meta.env.DEV) {
                console.warn(
                  `[applyAllOverlaps]   i2i target shot ${targetShotIdx} (id=${targetShot.id}):`,
                  `len ${targetShot.length.toFixed(3)}→${interpResult.length.toFixed(3)}`,
                  `az_in ${targetShot.azimuth_in.toFixed(1)}→${interpResult.azimuth_in.toFixed(1)}`,
                  `(import: len=${importAsTarget.length.toFixed(3)} az=${importAsTarget.azimuth_in.toFixed(1)})`,
                );
              }
              targetShots[targetShotIdx] = interpResult;
              treatedShots.add(targetTreatKey);
              treated++;
            } else if (overlapMode === 'existing_data') {
              // existing_data: target keeps its own values — nothing to change
              treatedShots.add(targetTreatKey);
            } else {
              targetShots[targetShotIdx] = applyTargetData(targetShot, importAsTarget);
              treatedShots.add(targetTreatKey);
              treated++;
            }
          }

          if (import.meta.env.DEV) {
            console.warn(
              `[applyAllOverlaps]   target ${targetImportIndex} RESULT: treated=${treated}`,
              `skippedOutOfRange=${skippedOutOfRange} skippedAlreadyTreated=${skippedAlreadyTreated} skippedNoImport=${skippedNoImport}`,
            );
          }

          if (treated > 0) {
            sectionEdits.set(targetImportIndex, { ...targetEdits, shots: targetShots });
          }
        }
      }
    }
  }

  // Post-pass: if a section would lose ALL shots to deletion (overlaps at both
  // ends where the section is the "import" side for both), convert the deletions
  // to is_reference instead.  This prevents sections from disappearing while
  // still avoiding un-marked duplication — adjacent target sections keep the
  // overlap shots with treated values, and this section keeps reference copies.
  for (const [sectionIdx, edits] of sectionEdits.entries()) {
    const aliveCount = edits.shots.filter(s => !s.isDeleted).length;
    const deletedCount = edits.shots.filter(s => s.isDeleted).length;
    if (aliveCount === 0 && deletedCount > 0) {
      const newShots = edits.shots.map(s =>
        s.isDeleted ? { ...s, isDeleted: false, is_reference: true } : s,
      );
      sectionEdits.set(sectionIdx, { ...edits, shots: newShots });
      if (import.meta.env.DEV) {
        console.warn(
          `[applyAllOverlaps] Section ${sectionIdx} would have 0 shots — converted ${deletedCount} deletions to reference`,
        );
      }
    }
  }

  return existingShotUpdates;
}

/** Build batch import configs from virtual connections + BFS order. */
function buildBatchImport(
  connections: VirtualConnection[],
  zeroDatumIndex: number | null,
  dmpFile: DmpFile,
  selectionConfig: DmpSelectionConfig,
  sectionEdits?: Map<number, SectionEditState>,
  fullPool?: CrossSectionSuggestion[],
  directPlacements?: DirectPlacement[],
  alreadyImported?: Map<number, number>,
): { configs: BackendImportSectionConfig[]; unreachable: number[]; emittedDmpIndices: number[] } {
  // Build adjacency + connections including any fallback anchors for disconnected components
  const allConnections = [...connections];
  const adjacency = buildAdjacency(allConnections);

  // Direct placement map: section index → ImportPlacement (for manual_placing phase)
  const directPlacementMap = new Map<number, ImportPlacement>();
  if (directPlacements) {
    for (const dp of directPlacements) {
      directPlacementMap.set(dp.anchorSectionIndex, dp.placement);
    }
  }

  // Sections connected to existing project sections (anchors)
  const anchored = new Set<number>();
  if (zeroDatumIndex != null) anchored.add(zeroDatumIndex);
  for (const c of allConnections) {
    if (c.targetType === 'existing') {
      anchored.add(c.importSectionIndex);
    }
  }
  // Direct placements also anchor their sections
  for (const dp of directPlacements ?? []) {
    anchored.add(dp.anchorSectionIndex);
  }

  // BFS from anchored sections
  let reachableOrder = bfsReachable(anchored, adjacency);
  let reachableSet = new Set(reachableOrder);

  // Find disconnected components with confirmed connections but no anchor.
  // For each, look for an existing-target suggestion in the full pool to create a fallback anchor.
  if (fullPool && fullPool.length > 0) {
    const connectedSections = new Set(allConnections.map((c) => c.importSectionIndex));
    const unreachableConnected = Array.from(connectedSections).filter((idx) => !reachableSet.has(idx));

    if (unreachableConnected.length > 0) {
      // Group unreachable connected sections into components via BFS on adjacency
      const visited = new Set<number>();
      for (const seed of unreachableConnected) {
        if (visited.has(seed)) continue;
        // BFS to find this component
        const component: number[] = [];
        const queue = [seed];
        visited.add(seed);
        while (queue.length > 0) {
          const node = queue.shift()!;
          component.push(node);
          for (const edge of adjacency.get(node) ?? []) {
            if (!visited.has(edge.neighbor) && !reachableSet.has(edge.neighbor)) {
              visited.add(edge.neighbor);
              queue.push(edge.neighbor);
            }
          }
        }

        // Find best existing-target suggestion for any section in this component
        const componentSet = new Set(component);
        let bestExisting: CrossSectionSuggestion | null = null;
        for (const s of fullPool) {
          if (s.targetType === 'existing' && s.existingSectionId != null && componentSet.has(s.importSectionIndex)) {
            if (!bestExisting || s.score > bestExisting.score) {
              bestExisting = s;
            }
          }
        }

        if (bestExisting) {
          // Create a fallback connection to anchor this component
          const fallbackConn: VirtualConnection = {
            importSectionIndex: bestExisting.importSectionIndex,
            importStationIndex: bestExisting.importStationIndex,
            targetType: 'existing',
            existingSectionId: bestExisting.existingSectionId!,
            existingStationIndex: bestExisting.existingStationIndex,
          };
          allConnections.push(fallbackConn);
          anchored.add(bestExisting.importSectionIndex);
        }
      }

      // Re-run BFS with new anchors
      if (anchored.size > reachableSet.size) {
        // Rebuild adjacency with new connections
        const newAdjacency = buildAdjacency(allConnections);
        reachableOrder = bfsReachable(anchored, newAdjacency);
        reachableSet = new Set(reachableOrder);
      }
    }
  }

  // Build connection map — fallback 'existing' connections override original 'importing' ones
  const connectionMap = new Map<number, VirtualConnection>();
  for (const c of allConnections) {
    const existing = connectionMap.get(c.importSectionIndex);
    if (!existing || c.targetType === 'existing') {
      connectionMap.set(c.importSectionIndex, c);
    }
  }

  // Track which sections are already emitted (by section_index) and their position in configs[]
  const emittedPosition = new Map<number, number>();

  const configs: BackendImportSectionConfig[] = [];
  const sortedSelected = Array.from(selectionConfig.selectedIndices).sort((a, b) => a - b);

  // Multi-pass: BFS order may not match dependency order for fallback-anchored
  // components, so retry sections whose from_importing target wasn't emitted yet.
  let lastConfigCount = -1;
  while (configs.length > lastConfigCount) {
    lastConfigCount = configs.length;
    for (const idx of reachableOrder) {
      if (emittedPosition.has(idx)) continue;
      // Skip zero datum — already imported
      if (idx === zeroDatumIndex) continue;
      // Skip sections already imported in a previous batch (early import)
      if (alreadyImported?.has(idx)) continue;

      const section = dmpFile.sections[idx];
      if (!section) continue;

      const edits = sectionEdits?.get(idx);

      // Use edited shots if available, otherwise fall back to DMP data
      let backendShots: ShotData[];
      if (edits) {
        const deletedCount = edits.shots.filter(s => s.isDeleted).length;
        backendShots = edits.shots
          .filter((s) => !s.isDeleted)
          .map(editableShotToShotData);
        if (import.meta.env.DEV && deletedCount > 0) {
          console.warn(
            `[buildBatchImport] Section ${idx} "${section.name}": ${edits.shots.length} total shots, ${deletedCount} deleted, ${backendShots.length} emitted`,
          );
        }
        // Compare edited shots to original DMP data to detect interpolation
        if (import.meta.env.DEV) {
          const origShots = convertToEditableShots(section.shots);
          let modifiedCount = 0;
          const aliveEdited = edits.shots.filter(s => !s.isDeleted);
          for (const edited of aliveEdited) {
            if (edited.isNew) continue;
            const orig = origShots.find(o => o.id === edited.id);
            if (orig && (
              Math.abs(orig.azimuth_in - edited.azimuth_in) > 0.01 ||
              Math.abs(orig.length - edited.length) > 0.001
            )) {
              modifiedCount++;
              if (modifiedCount <= 3) {
                console.warn(
                  `[buildBatchImport]   MODIFIED shot id=${edited.id}:`,
                  `az_in ${orig.azimuth_in.toFixed(1)}→${edited.azimuth_in.toFixed(1)}`,
                  `len ${orig.length.toFixed(3)}→${edited.length.toFixed(3)}`,
                  `is_ref=${edited.is_reference}`,
                );
              }
            }
          }
          if (modifiedCount > 0) {
            console.warn(`[buildBatchImport] Section ${idx} "${section.name}": ${modifiedCount} shots have INTERPOLATED values`);
          }
        }
      } else {
        const editableShots = convertToEditableShots(section.shots);
        backendShots = editableShots.map(editableShotToShotData);
        if (import.meta.env.DEV) {
          console.warn(`[buildBatchImport] Section ${idx} "${section.name}": no edits, using ${backendShots.length} DMP shots`);
        }
      }
      if (backendShots.length === 0) {
        if (import.meta.env.DEV) {
          console.warn(`[buildBatchImport] Section ${idx} "${section.name}": SKIPPED — 0 shots after filtering deleted`);
        }
        continue;
      }

      // Check for direct placement first (from manual_placing phase)
      const directPlacement = directPlacementMap.get(idx);
      let conn = connectionMap.get(idx);

      // Fallback: section is only the TARGET of an import-to-import connection
      if (!directPlacement && !conn) {
        conn = findReverseImportConnection(idx, allConnections, emittedPosition);
        // Also check if the reverse target was already imported in a previous batch
        if (!conn && alreadyImported) {
          for (const c of allConnections) {
            if (c.targetType !== 'importing') continue;
            if (c.targetImportIndex !== idx) continue;
            if (!alreadyImported.has(c.importSectionIndex)) continue;
            conn = {
              importSectionIndex: idx,
              importStationIndex: c.targetImportStationIndex ?? 0,
              targetType: 'importing',
              targetImportIndex: c.importSectionIndex,
              targetImportStationIndex: c.importStationIndex,
            };
            break;
          }
        }
        if (!conn) {
          if (import.meta.env.DEV) {
            console.warn(`[buildBatchImport] Section ${idx} "${section.name}": SKIPPED — no connection or direct placement`);
          }
          continue;
        }
        if (import.meta.env.DEV) {
          console.warn(`[buildBatchImport] Section ${idx} "${section.name}": using reverse import connection → ${conn.targetImportIndex}`);
        }
      }

      let placement: ImportPlacement;
      if (directPlacement) {
        placement = directPlacement;
      } else {
        // Derive placement from virtual connection
        // Adjust import station index for deleted shots (overlap removal shifts stations)
        const adjustedImportStation = edits
          ? adjustStationForDeletedShots(edits.shots, conn!.importStationIndex)
          : conn!.importStationIndex;

        if (conn!.targetType === 'existing' && conn!.existingSectionId != null && conn!.existingStationIndex != null) {
          placement = {
            type: 'from_existing',
            import_station: adjustedImportStation,
            existing_station: {
              section_id: conn!.existingSectionId,
              station_index: conn!.existingStationIndex,
            },
          };
        } else if (conn!.targetType === 'importing' && conn!.targetImportIndex != null && conn!.targetImportStationIndex != null) {
          // Check if the target was already imported in a previous batch
          const alreadyImportedSectionId = alreadyImported?.get(conn!.targetImportIndex);
          if (alreadyImportedSectionId != null) {
            // Convert from_importing → from_existing using the real section_id
            const targetEdits = sectionEdits?.get(conn!.targetImportIndex);
            const adjTargetStn = targetEdits
              ? adjustStationForDeletedShots(targetEdits.shots, conn!.targetImportStationIndex!)
              : conn!.targetImportStationIndex!;
            placement = {
              type: 'from_existing',
              import_station: adjustedImportStation,
              existing_station: {
                section_id: alreadyImportedSectionId,
                station_index: adjTargetStn,
              },
            };
          } else {
          // The target must already be emitted in configs[]
          let targetPos = emittedPosition.get(conn!.targetImportIndex);
          if (targetPos == null) {
            // Primary target not yet emitted — try reversed connection to an already-emitted section
            const reverseConn = findReverseImportConnection(idx, allConnections, emittedPosition);
            if (reverseConn) {
              conn = reverseConn;
              const adjustedImportStation2 = edits
                ? adjustStationForDeletedShots(edits.shots, conn.importStationIndex)
                : conn.importStationIndex;
              // Check if the reverse target was already imported
              const reverseAlreadyId = alreadyImported?.get(conn.targetImportIndex!);
              if (reverseAlreadyId != null) {
                const targetEdits2 = sectionEdits?.get(conn.targetImportIndex!);
                const adjTargetStn2 = targetEdits2
                  ? adjustStationForDeletedShots(targetEdits2.shots, conn.targetImportStationIndex!)
                  : conn.targetImportStationIndex!;
                placement = {
                  type: 'from_existing',
                  import_station: adjustedImportStation2,
                  existing_station: {
                    section_id: reverseAlreadyId,
                    station_index: adjTargetStn2,
                  },
                };
              } else {
              targetPos = emittedPosition.get(conn.targetImportIndex!);
              if (targetPos == null) {
                // Shouldn't happen — findReverseImportConnection checks emittedPosition
                continue;
              }
              const targetEdits2 = sectionEdits?.get(conn.targetImportIndex!);
              const adjustedTargetStation2 = targetEdits2
                ? adjustStationForDeletedShots(targetEdits2.shots, conn.targetImportStationIndex!)
                : conn.targetImportStationIndex!;
              placement = {
                type: 'from_importing',
                import_station: adjustedImportStation2,
                target_section_index: targetPos,
                target_station_index: adjustedTargetStation2,
              };
              }
            } else {
              // No reverse available — will retry in next pass
              if (import.meta.env.DEV) {
                console.warn(
                  `[buildBatchImport] Section ${idx} "${section.name}": DEFERRED — target import ${conn!.targetImportIndex} not yet emitted`,
                );
              }
              continue;
            }
          } else {
            // Target is emitted — original code path
            const targetEdits = sectionEdits?.get(conn!.targetImportIndex);
            const adjustedTargetStation = targetEdits
              ? adjustStationForDeletedShots(targetEdits.shots, conn!.targetImportStationIndex)
              : conn!.targetImportStationIndex;
            placement = {
              type: 'from_importing',
              import_station: adjustedImportStation,
              target_section_index: targetPos,
              target_station_index: adjustedTargetStation,
            };
          }
          }
        } else {
          continue;
        }
      }

      // Use edits for metadata if available, otherwise fall back to DMP data + selectionConfig
      const sectionName = edits?.name ?? section.name;
      const surveyorValue = edits?.surveyor ?? selectionConfig.defaultSurveyor ?? null;
      const dateStr = edits?.date ?? selectionConfig.defaultDate ?? section.date?.split(/[T ]/)[0] ?? null;
      const selectedPos = sortedSelected.indexOf(idx);
      const colorValue = (edits?.color || null) ?? SECTION_COLORS[(selectedPos >= 0 ? selectedPos : 0) % SECTION_COLORS.length] ?? '#4ecdc4';
      const directionValue = edits?.direction ?? section.direction;
      const qualityValue = edits?.quality ?? 1.0;

      const config: BackendImportSectionConfig = {
        section_index: configs.length,
        name: sectionName,
        surveyor: surveyorValue || null,
        date: dateStr,
        color: colorValue,
        direction: directionValue,
        quality: qualityValue,
        shots: backendShots,
        placement,
        station_comments: [],
      };

      emittedPosition.set(idx, configs.length);
      configs.push(config);
    }
  }

  // Unreachable = connected sections not in reachableSet + sections with no connection at all
  const allSelected = Array.from(selectionConfig.selectedIndices);
  const unreachable = allSelected.filter(
    (idx) => idx !== zeroDatumIndex && !reachableSet.has(idx),
  );

  if (import.meta.env.DEV) {
    // Summarize connection types
    let importingCount = 0;
    let existingCount = 0;
    let directCount = 0;
    for (const c of allConnections) {
      if (c.targetType === 'importing') importingCount++;
      else existingCount++;
    }
    for (const _dp of directPlacements ?? []) directCount++;
    const editedSections = sectionEdits ? Array.from(sectionEdits.keys()).length : 0;
    console.warn(
      `[buildBatchImport] SUMMARY: ${configs.length} configs emitted, ${unreachable.length} unreachable,`,
      `connections: ${existingCount} existing + ${importingCount} importing + ${directCount} direct,`,
      `sectionEdits has ${editedSections} entries`,
    );
    // Flag reachable sections that were never emitted (stuck in DEFERRED loop or skipped)
    for (const idx of reachableOrder) {
      if (idx === zeroDatumIndex) continue;
      if (!emittedPosition.has(idx)) {
        const s = dmpFile.sections[idx];
        const ed = sectionEdits?.get(idx);
        const alive = ed ? ed.shots.filter(sh => !sh.isDeleted).length : s?.shots.length ?? 0;
        const hasConn = connectionMap.has(idx);
        const hasDirect = directPlacementMap.has(idx);
        console.warn(
          `[buildBatchImport] ⚠ Section ${idx} "${s?.name}" REACHABLE but NOT EMITTED:`,
          `alive=${alive} hasConn=${hasConn} hasDirect=${hasDirect}`,
          hasConn ? `conn=${JSON.stringify(connectionMap.get(idx))}` : '',
        );
      }
    }
  }

  return { configs, unreachable, emittedDmpIndices: Array.from(emittedPosition.keys()) };
}

/**
 * Connection Wizard — pre-calculates all placements at startup, presents
 * suggestions sorted by score, records virtual connections on confirm,
 * then batch-places everything when suggestions are exhausted.
 */
export default function DmpNewImportDialog({
  dmpFile,
  selectionConfig,
  project: _project,
  stations: _stations,
  zeroDatumConfig,
  onCancel,
  onBack,
  onComplete,
  savedManualPlacingState,
  autoStartManualPlacement = false,
}: DmpNewImportDialogProps) {
  const { t } = useTranslation();
  const importSecondaryButtonClass = 'ring-1 ring-inset ring-border hover:bg-background-50';

  // Store selectors
  const importSections = useProjectStore((s) => s.importSections);
  const refreshProjectState = useProjectStore((s) => s.refreshProjectState);
  const config = useProjectStore((s) => s.config);
  const updateConfig = useProjectStore((s) => s.updateConfig);

  // Shorthand for restoring state
  const saved = savedManualPlacingState;

  // Core state — virtual connections instead of imported indices
  const [connections, setConnections] = useState<VirtualConnection[]>(saved?.connections ?? []);
  const [skippedIndices, setSkippedIndices] = useState<Set<number>>(
    saved ? new Set(saved.skippedIndices) : new Set()
  );
  const [currentSuggestion, setCurrentSuggestion] = useState<CrossSectionSuggestion | null>(null);
  const [alternatives, setAlternatives] = useState<CrossSectionSuggestion[]>([]);
  const [showAlternatives, setShowAlternatives] = useState(true);
  const [isCalculating, setIsCalculating] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [phase, setPhase] = useState<'init' | 'suggesting' | 'manual_placing' | 'placing' | 'done'>(
    saved ? 'manual_placing' : 'init'
  );
  const [autoStartManualPlacementPending, setAutoStartManualPlacementPending] = useState(
    autoStartManualPlacement
  );
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showBackConfirm, setShowBackConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placingRetry, setPlacingRetry] = useState(0);

  // Merge station selection
  const [selectedMergeOffset, setSelectedMergeOffset] = useState(0);

  // Overlap handling mode (persisted to config)
  const [overlapMode, setOverlapMode] = useState<OverlapMode>(
    config?.import?.overlap_mode ?? 'import_data'
  );

  // Section editing state
  const [editState, setEditState] = useState<SectionEditState | null>(null);
  // Tracks which import section index the current editState was loaded for.
  // Used to prevent the sync effect from writing stale editState to the wrong section
  // when currentSuggestion changes before editState catches up.
  const [editStateForSection, setEditStateForSection] = useState<number | null>(null);
  const sectionEditsRef = useRef<Map<number, SectionEditState>>(
    saved ? new Map(saved.sectionEdits) : new Map()
  );
  const confirmedOverlapsRef = useRef<Map<number, ConfirmedOverlapInfo>>(
    saved ? new Map(saved.confirmedOverlaps ?? []) : new Map()
  );
  const nextTempIdRef = useRef(1);

  // Unified segment context (import-side DMP BFS + existing anchors, target-side geometry)
  const [segmentContext, setSegmentContext] = useState<{
    importSide: ContextSectionGeometry[];
    targetSide: ContextSectionGeometry[];
  } | null>(null);

  // Cache all cross-section suggestions from startup calculation
  const suggestionPoolRef = useRef<CrossSectionSuggestion[]>([]);
  // Keep full pool (unfiltered) so buildBatchImport can find existing-target anchors
  const fullPoolRef = useRef<CrossSectionSuggestion[]>([]);

  // ─── Manual placing phase state ────────────────────────────────────────────
  const [segmentQueue, setSegmentQueue] = useState<number[][]>(saved?.segmentQueue ?? []);
  const currentSegment = segmentQueue[0] ?? null;

  const [segmentPlacementMode, setSegmentPlacementMode] = useState<
    'suggestion' | 'origin' | 'fromExisting' | 'manual' | 'discard'
  >('manual');
  const [segmentAnchor, setSegmentAnchor] = useState<{
    sectionIndex: number; stationIndex: number;
  } | null>(saved?.segmentAnchor ?? null);

  // Preview anchor tracks which station the SectionPreview highlights.
  // Follows dropdown hover; reverts to segmentAnchor on dropdown close.
  const [previewAnchor, setPreviewAnchor] = useState<{
    sectionIndex: number; stationIndex: number;
  } | null>(saved?.segmentAnchor ?? null);
  const segmentAnchorRef = useRef(segmentAnchor);

  // Commit a new anchor: updates committed value, preview, and ref together.
  const commitSegmentAnchor = useCallback((anchor: { sectionIndex: number; stationIndex: number } | null) => {
    setSegmentAnchor(anchor);
    setPreviewAnchor(anchor);
    segmentAnchorRef.current = anchor;
  }, []);

  // When a section dropdown hovers an option, preview it on the map;
  // when dropdown closes without selection, revert to the committed anchor.
  // Uses ref (not state) to avoid stale-closure race conditions.
  const handleAnchorSectionHover = useCallback((value: string | null) => {
    if (value !== null) {
      setPreviewAnchor({ sectionIndex: Number(value), stationIndex: 0 });
    } else {
      setPreviewAnchor(segmentAnchorRef.current);
    }
  }, []);

  // Same for station dropdown hover — reads current section from ref.
  const handleAnchorStationHover = useCallback((value: string | null) => {
    if (value !== null) {
      const current = segmentAnchorRef.current;
      if (current) {
        setPreviewAnchor({ sectionIndex: current.sectionIndex, stationIndex: Number(value) });
      }
    } else {
      setPreviewAnchor(segmentAnchorRef.current);
    }
  }, []);

  // Per-mode state for manual_placing
  const [fromExistingSectionId, setFromExistingSectionId] = useState<number | null>(null);
  const [fromExistingStationIdx, setFromExistingStationIdx] = useState<number>(0);

  // Track original suggestions for sections skipped during suggesting phase
  const skippedSuggestionsRef = useRef<Map<number, CrossSectionSuggestion>>(
    saved ? new Map(saved.skippedSuggestions) : new Map()
  );

  // Accumulated direct placements for manual_placing phase
  const directPlacementsRef = useRef<DirectPlacement[]>(saved?.directPlacements ?? []);

  // DMP index → project section_id for sections imported during early import
  const earlyImportedRef = useRef<Map<number, number>>(
    saved?.earlyImported ? new Map(saved.earlyImported) : new Map()
  );

  // DMP indices of segments the user chose to discard ("Do not place")
  const discardedIndicesRef = useRef<Set<number>>(
    new Set(saved?.discardedIndices ?? [])
  );

  // Skip counter per segment (prevent infinite loops)
  const segmentSkipCountRef = useRef<Map<string, number>>(
    saved ? new Map(saved.segmentSkipCounts) : new Map()
  );

  // Guard against React StrictMode double-firing the mount effect
  // When restoring from saved state, skip the init effect entirely
  const importStartedRef = useRef(!!saved);
  // Prevent duplicate "advance suggestion" actions (double-click skip/confirm)
  // from racing the suggesting→placing transition.
  const suggestionActionInFlightRef = useRef(false);
  // Prevent re-entering early-import transition before state updates land.
  const transitionToPlacingInFlightRef = useRef(false);

  // Accumulate all section IDs created during import for post-import orphan detection
  const importedSectionIdsRef = useRef<number[]>([]);

  // Refs to avoid stale closures
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;
  const skippedIndicesRef = useRef(skippedIndices);
  skippedIndicesRef.current = skippedIndices;

  const selectedIndices = useMemo(
    () => Array.from(selectionConfig.selectedIndices).sort((a, b) => a - b),
    [selectionConfig.selectedIndices]
  );

  // Section currently being edited in the right-side editor panel.
  // In suggesting mode this follows the current suggestion section.
  // In manual placing mode this follows the selected segment anchor section.
  const activeEditableSectionIndex = useMemo(() => {
    if (currentSuggestion) return currentSuggestion.importSectionIndex;
    if (phase === 'manual_placing' && segmentAnchor) return segmentAnchor.sectionIndex;
    return null;
  }, [currentSuggestion, phase, segmentAnchor]);

  const totalSelected = selectedIndices.length;

  // Set of section indices that already have a connection
  const connectedIndices = useMemo(() => {
    return new Set(connections.map((c) => c.importSectionIndex));
  }, [connections]);

  // Compute import shot count for current suggestion
  const importShotCount = useMemo(() => {
    if (!currentSuggestion) return 0;
    const section = dmpFile.sections[currentSuggestion.importSectionIndex];
    if (!section) return 0;
    return section.shots.filter((s) => s.shot_type === 'Standard').length;
  }, [currentSuggestion, dmpFile.sections]);

  // Compute merge options for the current suggestion
  const mergeOptions = useMemo(() => {
    if (!currentSuggestion) return [];
    return computeMergeOptions(currentSuggestion, importShotCount);
  }, [currentSuggestion, importShotCount]);

  // Selected merge pair
  const selectedMergePair = useMemo(() => {
    if (mergeOptions.length === 0) return null;
    return mergeOptions.find((o) => o.offset === selectedMergeOffset) ?? mergeOptions[mergeOptions.length - 1]!;
  }, [mergeOptions, selectedMergeOffset]);

  // Reset merge offset to last option (deepest overlap) when suggestion changes
  useEffect(() => {
    if (mergeOptions.length > 0) {
      setSelectedMergeOffset(mergeOptions[mergeOptions.length - 1]!.offset);
    }
  }, [currentSuggestion, mergeOptions]);

  // Check if the current suggestion targets an existing section that is doubly-anchored
  // (modified overlap shots sit between two positional constraints). When true, only
  // 'existing_data' and 'keep_both' are valid — interpolation / import_data would break
  // a closure or zero-datum constraint.
  //
  // A merge/closure is only an anchor if the partner can independently reach a zero datum
  // without going through this section.  A merge to a free-floating section is NOT a
  // positional constraint — the partner can follow via cascading offset adjustments.
  const isTargetDoublyAnchored = useMemo(() => {
    if (!currentSuggestion) return false;
    if (currentSuggestion.targetType !== 'existing' || currentSuggestion.existingSectionId == null) return false;
    if (currentSuggestion.matchedShots === 0) return false;

    const project = useProjectStore.getState().project;
    if (!project) return false;

    const sid = currentSuggestion.existingSectionId;

    // BFS: can `start` reach a zero datum via merges + aligned closures
    // without traversing through `excluded`?
    const hasDatumPathExcluding = (start: number, excluded: number): boolean => {
      const visited = new Set<number>();
      const queue = [start];
      while (queue.length > 0) {
        const current = queue.pop()!;
        if (current === excluded) continue;
        if (visited.has(current)) continue;
        visited.add(current);
        if (project.zero_datums.some((zd) => zd.station_ref.section_id === current)) {
          return true;
        }
        for (const m of project.station_merges) {
          if (m.station_a.section_id === current && !visited.has(m.station_b.section_id)) {
            queue.push(m.station_b.section_id);
          }
          if (m.station_b.section_id === current && !visited.has(m.station_a.section_id)) {
            queue.push(m.station_a.section_id);
          }
        }
        for (const c of project.loop_closures) {
          if (!c.is_aligned) continue;
          if (c.station_a.section_id === current && !visited.has(c.station_b.section_id)) {
            queue.push(c.station_b.section_id);
          }
          if (c.station_b.section_id === current && !visited.has(c.station_a.section_id)) {
            queue.push(c.station_a.section_id);
          }
        }
      }
      return false;
    };

    // Compute the range of target shot indices that would be modified
    let minShot: number;
    let maxShot: number;
    if (currentSuggestion.direction === 'forward') {
      minShot = currentSuggestion.existingStationIndex;
      maxShot = currentSuggestion.existingStationIndex + currentSuggestion.matchedShots - 1;
    } else {
      minShot = currentSuggestion.existingStationIndex - currentSuggestion.matchedShots;
      maxShot = currentSuggestion.existingStationIndex - 1;
    }

    // Collect anchor station indices on the target section.
    // Zero datums are always anchors.  Merges/closures are only anchors
    // if the partner is independently datum-backed.
    const anchors: number[] = [];

    for (const zd of project.zero_datums) {
      if (zd.station_ref.section_id === sid) anchors.push(zd.station_ref.station_index);
    }
    for (const m of project.station_merges) {
      if (m.station_a.section_id === sid && hasDatumPathExcluding(m.station_b.section_id, sid)) {
        anchors.push(m.station_a.station_index);
      }
      if (m.station_b.section_id === sid && hasDatumPathExcluding(m.station_a.section_id, sid)) {
        anchors.push(m.station_b.station_index);
      }
    }
    for (const c of project.loop_closures) {
      if (!c.is_aligned) continue;
      if (c.station_a.section_id === sid && hasDatumPathExcluding(c.station_b.section_id, sid)) {
        anchors.push(c.station_a.station_index);
      }
      if (c.station_b.section_id === sid && hasDatumPathExcluding(c.station_a.section_id, sid)) {
        anchors.push(c.station_b.station_index);
      }
    }

    const hasFront = anchors.some((idx) => idx <= minShot);
    const hasBack = anchors.some((idx) => idx > maxShot);
    return hasFront && hasBack;
  }, [currentSuggestion]);

  // Unified segment context — BFS through DMP connections + fetch existing segment geometry
  useEffect(() => {
    if (!currentSuggestion) {
      setSegmentContext(null);
      return;
    }

    let cancelled = false;

    const compute = async () => {
      const importIdx = currentSuggestion.importSectionIndex;
      const importSide: ContextSectionGeometry[] = [];
      const targetSide: ContextSectionGeometry[] = [];
      const coveredExistingSectionIds = new Set<number>();

      // Store raw segment geometry so we can position DMP sections relative to existing ones.
      // Maps existing section ID → { shotLines, frameOffsetX/Y, side }
      const existingSectionGeo = new Map<number, ExistingSectionGeoEntry>();

      // Import-side BFS through importing-type connections
      const importExclude = new Set<number>();
      if (currentSuggestion.targetType === 'importing' && currentSuggestion.targetImportIndex != null) {
        importExclude.add(currentSuggestion.targetImportIndex);
      }
      const importBfs = computeDmpBfsContext(importIdx, importExclude, connections, dmpFile.sections);
      importSide.push(...importBfs.dmpContext);

      // Target-side handling
      let targetBfsVisited: Set<number> | undefined;
      if (currentSuggestion.targetType === 'existing' && currentSuggestion.existingSectionId != null) {
        // Fetch segment geometry for the existing target section
        try {
          const result = await invokeIpc<SegmentGeometry>('get_segment_geometry', { sectionId: currentSuggestion.existingSectionId }, { purpose: 'fetch segment geometry for target section' });
          if (cancelled) return;

          for (const s of result.sections) {
            coveredExistingSectionIds.add(s.section_id);
            existingSectionGeo.set(s.section_id, {
              shotLines: s.shot_lines,
              frameOffsetX: 0,
              frameOffsetY: 0,
              side: 'target',
            });
          }

          const ctx: ContextSectionGeometry[] = result.sections
            .filter((s) => s.section_id !== currentSuggestion.existingSectionId)
            .map((s) => ({
              color: s.color,
              shots: s.shot_lines
                .filter((line) => line.length >= 2 && line[0]!.length >= 2 && line[1]!.length >= 2)
                .map((line) => ({
                  from: [line[0]![0]!, line[0]![1]!] as [number, number],
                  to: [line[1]![0]!, line[1]![1]!] as [number, number],
                })),
            }))
            .filter((s) => s.shots.length > 0);

          targetSide.push(...ctx);
        } catch {
          // Non-fatal
        }
      } else if (currentSuggestion.targetType === 'importing' && currentSuggestion.targetImportIndex != null) {
        // Target-side DMP BFS
        const targetExclude = new Set<number>([importIdx]);
        const targetBfs = computeDmpBfsContext(currentSuggestion.targetImportIndex, targetExclude, connections, dmpFile.sections);
        targetSide.push(...targetBfs.dmpContext);
        targetBfsVisited = targetBfs.visitedIndices;

        // Process target-side existing anchors
        for (const anchor of targetBfs.existingAnchors) {
          if (coveredExistingSectionIds.has(anchor.existingSectionId)) continue;
          coveredExistingSectionIds.add(anchor.existingSectionId);

          try {
            const result = await invokeIpc<SegmentGeometry>('get_segment_geometry', { sectionId: anchor.existingSectionId }, { purpose: 'fetch segment geometry for anchor section' });
            if (cancelled) return;

            const anchorGeo = result.sections.find((s) => s.section_id === anchor.existingSectionId);
            if (!anchorGeo) continue;

            const mergePos = stationPositionFromShotLines(anchorGeo.shot_lines, anchor.existingStationIdx);
            if (!mergePos) continue;

            const dx = anchor.x - mergePos.x;
            const dy = anchor.y - mergePos.y;

            for (const s of result.sections) {
              if (coveredExistingSectionIds.has(s.section_id)) continue;
              coveredExistingSectionIds.add(s.section_id);
              existingSectionGeo.set(s.section_id, {
                shotLines: s.shot_lines,
                frameOffsetX: dx,
                frameOffsetY: dy,
                side: 'target',
              });

              const shots = s.shot_lines
                .filter((line) => line.length >= 2 && line[0]!.length >= 2 && line[1]!.length >= 2)
                .map((line) => ({
                  from: [line[0]![0]! + dx, line[0]![1]! + dy] as [number, number],
                  to: [line[1]![0]! + dx, line[1]![1]! + dy] as [number, number],
                }));

              if (shots.length > 0) targetSide.push({ color: s.color, shots });
            }
          } catch {
            // Non-fatal
          }
        }
      }

      // Process import-side existing anchors
      for (const anchor of importBfs.existingAnchors) {
        if (coveredExistingSectionIds.has(anchor.existingSectionId)) continue;
        coveredExistingSectionIds.add(anchor.existingSectionId);

        try {
          const result = await invokeIpc<SegmentGeometry>('get_segment_geometry', { sectionId: anchor.existingSectionId }, { purpose: 'fetch segment geometry for import-side anchor' });
          if (cancelled) return;

          const anchorGeo = result.sections.find((s) => s.section_id === anchor.existingSectionId);
          if (!anchorGeo) continue;

          const mergePos = stationPositionFromShotLines(anchorGeo.shot_lines, anchor.existingStationIdx);
          if (!mergePos) continue;

          const dx = anchor.x - mergePos.x;
          const dy = anchor.y - mergePos.y;

          for (const s of result.sections) {
            if (coveredExistingSectionIds.has(s.section_id)) continue;
            coveredExistingSectionIds.add(s.section_id);
            existingSectionGeo.set(s.section_id, {
              shotLines: s.shot_lines,
              frameOffsetX: dx,
              frameOffsetY: dy,
              side: 'import',
            });

            const shots = s.shot_lines
              .filter((line) => line.length >= 2 && line[0]!.length >= 2 && line[1]!.length >= 2)
              .map((line) => ({
                from: [line[0]![0]! + dx, line[0]![1]! + dy] as [number, number],
                to: [line[1]![0]! + dx, line[1]![1]! + dy] as [number, number],
              }));

            if (shots.length > 0) importSide.push({ color: s.color, shots });
          }
        } catch {
          // Non-fatal
        }
      }

      // Bridge discovery: find DMP sections with confirmed existing connections
      // to sections we have geometry for, but not yet shown by BFS.
      // This handles the case where DMP sections A and B both connect to existing X
      // but have no importing-type edge between them.
      const shownDmpIndices = new Set(importBfs.visitedIndices);
      if (targetBfsVisited) {
        for (const idx of targetBfsVisited) shownDmpIndices.add(idx);
      }

      // Bridge discovery: find DMP sections connected through shared existing sections
      const bridged = discoverBridgedDmpSections(connections, shownDmpIndices, existingSectionGeo, dmpFile.sections);
      importSide.push(...bridged.importSide);
      targetSide.push(...bridged.targetSide);

      if (cancelled) return;
      setSegmentContext(
        importSide.length > 0 || targetSide.length > 0
          ? { importSide, targetSide }
          : null
      );
    };

    compute();
    return () => { cancelled = true; };
  }, [currentSuggestion, connections, dmpFile.sections]);

  // Initialize / restore section edit state when active editable section changes.
  useEffect(() => {
    if (activeEditableSectionIndex == null) {
      setEditStateForSection(null);
      setEditState(null);
      return;
    }

    const idx = activeEditableSectionIndex;

    // Restore from ref if previously edited
    const existing = sectionEditsRef.current.get(idx);
    if (existing) {
      if (import.meta.env.DEV) {
        console.warn(
          `[init-effect] RESTORE section=${idx} from sectionEditsRef`,
          `shots.length=${existing.shots.length}`,
          `deleted=${existing.shots.filter(s => s.isDeleted).length}`,
        );
      }
      setEditStateForSection(idx);
      setEditState(existing);
      return;
    }

    // Initialize from DMP data + selectionConfig defaults
    const section = dmpFile.sections[idx];
    if (!section) {
      setEditStateForSection(null);
      setEditState(null);
      return;
    }

    const shots = convertToEditableShots(section.shots);
    nextTempIdRef.current = shots.length + 1;
    if (import.meta.env.DEV) {
      console.warn(
        `[init-effect] INITIALIZE section=${idx} "${section.name}"`,
        `dmpShots=${section.shots.length} standardShots=${shots.length}`,
      );
    }

    // Color based on position in selection order (matches zero datum dialog)
    const selectedPos = selectedIndices.indexOf(idx);
    const newState: SectionEditState = {
      name: section.name,
      surveyor: selectionConfig.defaultSurveyor || '',
      date: selectionConfig.defaultDate ?? section.date?.split(/[T ]/)[0] ?? '',
      color: SECTION_COLORS[(selectedPos >= 0 ? selectedPos : 0) % SECTION_COLORS.length] ?? '#4ecdc4',
      direction: section.direction === 'out' ? 'out' : 'in',
      quality: 1.0,
      shots,
    };

    sectionEditsRef.current.set(idx, newState);
    setEditStateForSection(idx);
    setEditState(newState);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEditableSectionIndex]);

  // Keep sectionEditsRef in sync with editState changes (user edits to shots/metadata).
  // Guard: only write when editState actually belongs to the active edit section.
  // Without this guard, when the active section changes, this effect can briefly fire
  // with stale editState from the previous section before setEditState takes effect.
  useEffect(() => {
    if (!editState || activeEditableSectionIndex == null) return;
    if (editStateForSection !== activeEditableSectionIndex) {
      if (import.meta.env.DEV) {
        console.warn(
          `[sync-effect] SKIPPED stale write: editStateFor=${editStateForSection} !== active=${activeEditableSectionIndex}`,
        );
      }
      return;
    }
    if (import.meta.env.DEV) {
      console.warn(
        `[sync-effect] WRITING sectionEditsRef[${activeEditableSectionIndex}]`,
        `editState.shots.length=${editState.shots.length}`,
      );
    }
    sectionEditsRef.current.set(activeEditableSectionIndex, editState);
  }, [editState, activeEditableSectionIndex, editStateForSection]);

  // Compute frozen shot indices — matched overlap shots that must not be deleted
  const frozenShotIndices = useMemo(() => {
    if (!currentSuggestion || !editState) return new Set<number>();

    const { importStationIndex, matchedShots } = currentSuggestion;
    const frozenIds = computeOverlapIds(importStationIndex, matchedShots);

    // Map original IDs to current indices in editState.shots
    const indices = new Set<number>();
    editState.shots.forEach((shot, idx) => {
      if (!shot.isNew && frozenIds.has(shot.id)) indices.add(idx);
    });
    return indices;
  }, [currentSuggestion, editState]);

  // Compute effective shots: applies overlap mode transformations as a derived view.
  // Raw editState is never mutated by overlap settings — effectiveShots is computed.
  const effectiveShots = useMemo(() => {
    if (!editState || !currentSuggestion || currentSuggestion.matchedShots === 0) {
      return editState?.shots ?? [];
    }

    const { importStationIndex, matchedShots, direction } = currentSuggestion;
    const mergeImportStation = selectedMergePair?.importStation ?? importStationIndex;

    const allOverlapIds = computeOverlapIds(importStationIndex, matchedShots);
    const actionableIds = computeActionableIds(importStationIndex, matchedShots, mergeImportStation);

    // Get target shots for data replacement
    let targetShots: TargetShotLike[] | null = null;
    if (overlapMode !== 'import_data' && overlapMode !== 'keep_both') {
      const { targetType, existingSectionId, targetImportIndex, existingStationIndex } = currentSuggestion;

      if (targetType === 'existing' && existingSectionId != null) {
        const currentProject = useProjectStore.getState().project;
        const targetSection = currentProject?.sections.find((s) => s.id === existingSectionId);
        if (targetSection) targetShots = targetSection.shots;
      } else if (targetType === 'importing' && targetImportIndex != null) {
        const targetEdits = sectionEditsRef.current.get(targetImportIndex);
        if (targetEdits) {
          targetShots = targetEdits.shots.filter((s) => !s.isDeleted);
        } else {
          const targetDmpSection = dmpFile.sections[targetImportIndex];
          if (targetDmpSection) {
            targetShots = convertToEditableShots(targetDmpSection.shots);
          }
        }
      }

      // Build a mapping: import overlap shot ID → target shot.
      // The mapping is anchored by existingStationIndex (the suggestion's base),
      // NOT the merge-adjusted station — the merge picker only controls which
      // shots are actionable, not the overlap-to-target correspondence.
      if (targetShots) {
        const shouldReverse = needsDirectionReversal(importStationIndex, direction);
        const overlapParams = { importStationIndex, matchedShots, existingStationIndex, direction };
        const targetMap = new Map<number, TargetShotLike>();
        for (const overlapId of allOverlapIds) {
          const targetIdx = computeTargetShotIndex(overlapId, overlapParams);
          if (targetIdx >= 0 && targetIdx < targetShots.length) {
            const raw = targetShots[targetIdx]!;
            targetMap.set(overlapId, shouldReverse ? reverseTargetShot(raw) : raw);
          }
        }
        // Replace targetShots reference with the map for efficient lookup
        return editState.shots.map((shot) => {
          if (shot.isNew || shot.isDeleted) return shot;
          const isOverlap = !shot.isNew && allOverlapIds.has(shot.id);
          if (!isOverlap) return shot;

          const isActionable = actionableIds.has(shot.id);
          if (isActionable) {
            const target = targetMap.get(shot.id);
            if (target) {
              if (overlapMode === 'existing_data') {
                return applyTargetData(shot, target);
              } else if (overlapMode === 'interpolate') {
                return interpolateShots(shot, target);
              }
            }
            return shot;
          }
          // Past merge station: leave unchanged to keep geometry continuous in preview.
          // Deletion happens at import time in handleConfirm.
          return shot;
        });
      }
    }

    // For import_data / keep_both / no target data available:
    return editState.shots.map((shot) => {
      if (shot.isNew || shot.isDeleted) return shot;
      const isOverlap = !shot.isNew && allOverlapIds.has(shot.id);
      if (!isOverlap) return shot;

      const isActionable = actionableIds.has(shot.id);
      if (overlapMode === 'keep_both') {
        return { ...shot, is_reference: true };
      }
      if (!isActionable) {
        // Past merge station: leave unchanged to keep geometry continuous in preview.
        return shot;
      }
      // import_data: keep import values as-is
      return shot;
    });
  }, [editState, currentSuggestion, selectedMergePair, overlapMode, dmpFile.sections]);

  // Section edit callbacks
  const handleMetadataChange = useCallback((field: keyof SectionEditState, value: string | number) => {
    setEditState((prev) => prev ? { ...prev, [field]: value } : prev);
  }, []);

  const handleShotChange = useCallback(
    (index: number, field: keyof EditableShot, value: number | string | boolean | null) => {
      setEditState((prev) => {
        if (!prev) return prev;
        const newShots = [...prev.shots];
        const shot = newShots[index];
        if (shot) {
          newShots[index] = { ...shot, [field]: value };
        }
        return { ...prev, shots: newShots };
      });
    },
    []
  );

  const handleAddShot = useCallback(() => {
    const tempId = nextTempIdRef.current++;
    setEditState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        shots: [
          ...prev.shots,
          {
            id: -tempId,
            azimuth_in: 0,
            azimuth_out: 0,
            length: 0,
            depth_in: 0,
            depth_out: 0,
            pitch_in: null,
            pitch_out: null,
            left: null,
            right: null,
            up: null,
            down: null,
            comment: null,
            is_reference: false,
            isNew: true,
            tempId,
          },
        ],
      };
    });
  }, []);

  const handleDeleteShot = useCallback((index: number) => {
    if (frozenShotIndices.has(index)) return;
    setEditState((prev) => {
      if (!prev) return prev;
      const newShots = [...prev.shots];
      const shot = newShots[index];
      if (shot) {
        newShots[index] = { ...shot, isDeleted: true };
      }
      return { ...prev, shots: newShots };
    });
  }, [frozenShotIndices]);

  const handleInsertBefore = useCallback((index: number) => {
    const tempId = nextTempIdRef.current++;
    setEditState((prev) => {
      if (!prev) return prev;
      const newShots = [...prev.shots];
      newShots.splice(index, 0, {
        id: -tempId,
        azimuth_in: 0,
        azimuth_out: 0,
        length: 0,
        depth_in: 0,
        depth_out: 0,
        pitch_in: null,
        pitch_out: null,
        left: null,
        right: null,
        up: null,
        down: null,
        comment: null,
        is_reference: false,
        isNew: true,
        tempId,
      });
      return { ...prev, shots: newShots };
    });
  }, []);

  const handleInsertAfter = useCallback((index: number) => {
    const tempId = nextTempIdRef.current++;
    setEditState((prev) => {
      if (!prev) return prev;
      const newShots = [...prev.shots];
      newShots.splice(index + 1, 0, {
        id: -tempId,
        azimuth_in: 0,
        azimuth_out: 0,
        length: 0,
        depth_in: 0,
        depth_out: 0,
        pitch_in: null,
        pitch_out: null,
        left: null,
        right: null,
        up: null,
        down: null,
        comment: null,
        is_reference: false,
        isNew: true,
        tempId,
      });
      return { ...prev, shots: newShots };
    });
  }, []);

  // Persist overlap mode to config on change
  const handleOverlapModeChange = useCallback((value: OverlapMode) => {
    setOverlapMode(value);
    if (config) {
      updateConfig({ ...config, import: { ...config.import, overlap_mode: value } });
    }
  }, [config, updateConfig]);

  // Auto-switch to 'existing_data' when a doubly-anchored target disables the current mode
  useEffect(() => {
    if (isTargetDoublyAnchored && (overlapMode === 'interpolate' || overlapMode === 'import_data')) {
      handleOverlapModeChange('existing_data');
    }
  }, [isTargetDoublyAnchored, overlapMode, handleOverlapModeChange]);

  // Pick the next suggestion from the cached pool, filtering out connected/skipped sections.
  const pickFromPool = useCallback(() => {
    const connected = new Set(connectionsRef.current.map((c) => c.importSectionIndex));
    const skipped = skippedIndicesRef.current;

    // Build reverse map: for each import-to-import connection, record who targets whom.
    // Used to detect cycles: if A→B exists and we're considering B→A, skip it.
    const importingTargets = new Map<number, Set<number>>();
    for (const c of connectionsRef.current) {
      if (c.targetType === 'importing' && c.targetImportIndex != null) {
        let s = importingTargets.get(c.targetImportIndex);
        if (!s) { s = new Set(); importingTargets.set(c.targetImportIndex, s); }
        s.add(c.importSectionIndex);
      }
    }

    // Filter pool to only remaining sections, excluding cycle-forming connections
    const pool = suggestionPoolRef.current.filter((s) => {
      if (connected.has(s.importSectionIndex) || skipped.has(s.importSectionIndex)) return false;
      // Skip import-to-import suggestions that would create a direct cycle:
      // if the target already has an importing connection pointing back to this section
      if (s.targetType === 'importing' && s.targetImportIndex != null) {
        const sourcesTargetingMe = importingTargets.get(s.importSectionIndex);
        if (sourcesTargetingMe?.has(s.targetImportIndex)) return false;
      }
      return true;
    });
    suggestionPoolRef.current = pool;

    if (pool.length === 0) return false;

    const top = pool[0]!;
    setCurrentSuggestion(top);
    setAlternatives(
      pool
        .filter((s) => s !== top && s.importSectionIndex === top.importSectionIndex)
        .slice(0, 4)
    );
    return true;
  }, []);

  // Transition from suggesting phase: import reachable sections immediately (early import),
  // then enter manual_placing for unreachable segments, or complete if none.
  const transitionToPlacingOrManual = useCallback(async () => {
    if (transitionToPlacingInFlightRef.current) return;
    transitionToPlacingInFlightRef.current = true;
    setIsImporting(true);
    setError(null);

    try {
      let unreachable: number[] = [];
      try {
        // 1. Apply overlap treatments (single source of truth)
        let existingShotUpdates: ExistingShotUpdateLocal[] = [];
        if (fullPoolRef.current.length > 0) {
          existingShotUpdates = applyAllOverlapTreatments(
            fullPoolRef.current,
            confirmedOverlapsRef.current,
            sectionEditsRef.current,
            dmpFile,
            overlapMode,
          );
        }

        // 2. Redirect connections targeting deleted overlap zones
        redirectDeletedTargets(
          connectionsRef.current,
          sectionEditsRef.current,
          confirmedOverlapsRef.current,
          fullPoolRef.current,
        );

        // 3. Build batch import configs for reachable sections
        const zeroDatumIdx = zeroDatumConfig?.sectionIndex ?? null;
        let emittedDmpIndices: number[];
        let configs: BackendImportSectionConfig[];
        ({ configs, unreachable, emittedDmpIndices } = buildBatchImport(
          connectionsRef.current,
          zeroDatumIdx,
          dmpFile,
          selectionConfig,
          sectionEditsRef.current,
          fullPoolRef.current,
          directPlacementsRef.current,
        ));

        // 4. Import reachable sections immediately
        if (configs.length > 0) {
          const result = await invokeIpc<CommandResult>('import_sections', {
            sections: configs,
            fileHash: selectionConfig.fileHash ?? null,
            sectionHashes: selectionConfig.sectionHashes ?? null,
            existingShotUpdates: existingShotUpdates.length > 0 ? existingShotUpdates : null,
          }, { purpose: 'import reachable sections (early import)' });

          if (!result.success) {
            setError(result.error ?? 'Import failed');
            return;
          }

          if (result.section_ids.length > 0) {
            importedSectionIdsRef.current.push(...result.section_ids);
          }

          await refreshProjectState();

          // Build DMP index -> section_id mapping for late import.
          // Use backend response ordering directly; it matches submitted configs.
          for (let i = 0; i < emittedDmpIndices.length; i++) {
            const sectionId = result.section_ids[i];
            if (sectionId != null) {
              earlyImportedRef.current.set(emittedDmpIndices[i]!, sectionId);
            }
          }
        }
      } catch (e) {
        console.error('[earlyImport] Error during early import:', e);
        setError(String(e));
        return;
      } finally {
        setIsImporting(false);
      }

      // 5. Check for unreachable sections
      if (unreachable.length > 0) {
        const segments = computeUnreachableSegments(unreachable, connectionsRef.current);
        if (segments.length > 0) {
          setSegmentQueue(segments);
          segmentSkipCountRef.current = new Map();

          // Initialize anchor to first section's station 0
          const firstSegment = segments[0]!;
          commitSegmentAnchor({ sectionIndex: firstSegment[0]!, stationIndex: 0 });
          setSegmentPlacementMode('manual');
          setAutoStartManualPlacementPending(true);

          setPhase('manual_placing');
          return;
        }
      }

      // No unreachable — all done
      onComplete(importedSectionIdsRef.current);
    } finally {
      transitionToPlacingInFlightRef.current = false;
      suggestionActionInFlightRef.current = false;
    }
  }, [zeroDatumConfig, dmpFile, selectionConfig, overlapMode, onComplete, refreshProjectState]);

  // On mount: import zero datum section and fire suggest_all_import_placements
  useEffect(() => {
    if (importStartedRef.current) return;
    importStartedRef.current = true;

    const init = async () => {
      // 1. Import zero datum section if provided (this is the anchor)
      if (zeroDatumConfig) {
        setIsImporting(true);
        const { sectionIndex, stationIndex, gps, metadata, shots } = zeroDatumConfig;

        const backendShots: ShotData[] = shots
          .filter((s) => !s.isDeleted)
          .map(editableShotToShotData);

        const placement: ImportPlacement = {
          type: 'zero_datum',
          coordinates: gps,
          station_index: stationIndex,
        };

        const config: BackendImportSectionConfig = {
          section_index: sectionIndex,
          name: metadata.name,
          surveyor: metadata.surveyor,
          date: metadata.date,
          color: metadata.color,
          direction: metadata.direction,
          quality: metadata.quality,
          shots: backendShots,
          placement,
          station_comments: [],
        };

        const result = await importSections([config], selectionConfig.fileHash, selectionConfig.sectionHashes);
        setIsImporting(false);

        if (!result.success) {
          setError(result.error ?? 'Failed to import zero datum section');
          return;
        }

        if (result.section_ids.length > 0) {
          importedSectionIdsRef.current.push(...result.section_ids);
        }

        // Snap-fit to the newly placed zero datum section
        useUIStore.getState().triggerFitToBounds({ snap: true });

        // Check if only 1 section was selected — we're done
        if (selectedIndices.length === 1 && selectedIndices[0] === sectionIndex) {
          setPhase('done');
          return;
        }
      } else {
        // No zero datum — check if we can suggest
        const existingProject = useProjectStore.getState().project;
        const hasExistingSections = (existingProject?.sections.length ?? 0) > 0;

        if (!hasExistingSections && selectedIndices.length <= 1) {
          setPhase('done');
          return;
        }
      }

      // 2. Fire suggest_all_import_placements with all remaining sections
      setIsCalculating(true);
      const zeroDatumIdx = zeroDatumConfig?.sectionIndex ?? null;

      const remainingSections: ImportSectionForSuggestion[] = [];
      for (const idx of selectedIndices) {
        if (idx === zeroDatumIdx) continue;
        const section = dmpFile.sections[idx];
        if (!section) continue;

        const editableShots = convertToEditableShots(section.shots);
        const shotData: ShotData[] = editableShots.map(editableShotToShotData);
        if (shotData.length === 0) continue;

        remainingSections.push({
          index: idx,
          name: section.name,
          shots: shotData,
        });
      }

      if (remainingSections.length === 0) {
        setIsCalculating(false);
        setPhase('done');
        return;
      }

      try {
        const suggestions = await invokeIpc<CrossSectionSuggestion[]>(
          'suggest_all_import_placements',
          { importSections: remainingSections },
          { purpose: 'suggest import placements for remaining sections' },
        );

        suggestionPoolRef.current = suggestions;
        fullPoolRef.current = suggestions;
      } catch {
        // Suggestion failure is non-fatal
        suggestionPoolRef.current = [];
      }

      setIsCalculating(false);

      if (!pickFromPool()) {
        // No suggestions at all — check for unreachable sections
        transitionToPlacingOrManual();
        return;
      }

      setPhase('suggesting');
    };

    init();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On restore: import a just-placed segment immediately so it appears on the map
  const pendingSegmentImportedRef = useRef(false);
  useEffect(() => {
    if (!saved?.pendingSegmentImport || saved.pendingSegmentImport.length === 0) return;
    if (pendingSegmentImportedRef.current) return;
    pendingSegmentImportedRef.current = true;

    const importPendingSegment = async () => {
      setIsImporting(true);
      try {
        const zeroDatumIdx = zeroDatumConfig?.sectionIndex ?? null;
        const { configs, emittedDmpIndices } = buildBatchImport(
          connectionsRef.current,
          zeroDatumIdx,
          dmpFile,
          selectionConfig,
          sectionEditsRef.current,
          fullPoolRef.current,
          directPlacementsRef.current,
          earlyImportedRef.current,
        );

        // Filter to only the sections in the pending segment, remapping from_importing indices
        const pendingSet = new Set(saved.pendingSegmentImport);
        const segmentConfigs: BackendImportSectionConfig[] = [];
        const segmentDmpIndices: number[] = [];
        // Map original config position → new position in segmentConfigs
        const posRemap = new Map<number, number>();
        for (let i = 0; i < configs.length; i++) {
          const dmpIdx = emittedDmpIndices[i];
          if (dmpIdx != null && pendingSet.has(dmpIdx)) {
            posRemap.set(i, segmentConfigs.length);
            segmentConfigs.push({ ...configs[i]!, section_index: segmentConfigs.length });
            segmentDmpIndices.push(dmpIdx);
          }
        }
        // Remap from_importing target_section_index to new positions
        for (const cfg of segmentConfigs) {
          if (cfg.placement.type === 'from_importing') {
            const oldTarget = (cfg.placement as { target_section_index: number }).target_section_index;
            const newTarget = posRemap.get(oldTarget);
            if (newTarget != null) {
              (cfg.placement as { target_section_index: number }).target_section_index = newTarget;
            }
          }
        }

        if (segmentConfigs.length > 0) {
          const result = await invokeIpc<CommandResult>('import_sections', {
            sections: segmentConfigs,
            fileHash: selectionConfig.fileHash ?? null,
            sectionHashes: selectionConfig.sectionHashes ?? null,
            existingShotUpdates: null,
          }, { purpose: 'import segment sections' });

          if (result.success) {
            if (result.section_ids.length > 0) {
              importedSectionIdsRef.current.push(...result.section_ids);
            }

            await refreshProjectState();

            for (let i = 0; i < segmentDmpIndices.length; i++) {
              const sectionId = result.section_ids[i];
              if (sectionId != null) {
                earlyImportedRef.current.set(segmentDmpIndices[i]!, sectionId);
              }
            }
          }
        }
      } catch (e) {
        // Non-fatal — segment will be retried in late import
        console.error('[pendingSegmentImport] Error:', e);
      } finally {
        setIsImporting(false);
      }

      // If this was the last segment, finish the import — don't wait for the
      // placing phase which would race with isImporting state.
      if (segmentQueue.length === 0) {
        onComplete(importedSectionIdsRef.current);
      }
    };

    importPendingSegment();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When restored from manual placement with an empty segment queue, transition to placing.
  // Skip if a pending segment import is in progress — it will call onComplete directly.
  useEffect(() => {
    if (phase === 'manual_placing' && segmentQueue.length === 0 && !saved?.pendingSegmentImport?.length) {
      setPhase('placing');
    }
  }, [phase, segmentQueue.length, saved?.pendingSegmentImport?.length]);

  // Handle 'placing' phase — late import of remaining sections after manual_placing.
  // Overlap treatment and connection redirect already happened during early import.
  useEffect(() => {
    if (phase !== 'placing') return;
    if (isImporting) return;

    const doLateImport = async () => {
      setIsImporting(true);
      setError(null);

      let unreachable: number[] = [];
      try {
        const zeroDatumIdx = zeroDatumConfig?.sectionIndex ?? null;
        let configs: BackendImportSectionConfig[];
        ({ configs, unreachable } = buildBatchImport(
          connectionsRef.current,
          zeroDatumIdx,
          dmpFile,
          selectionConfig,
          sectionEditsRef.current,
          fullPoolRef.current,
          directPlacementsRef.current,
          earlyImportedRef.current,
        ));

        if (configs.length > 0) {
          const result = await invokeIpc<CommandResult>('import_sections', {
            sections: configs,
            fileHash: selectionConfig.fileHash ?? null,
            sectionHashes: selectionConfig.sectionHashes ?? null,
            existingShotUpdates: null,  // Already sent in early import
          }, { purpose: 'import remaining sections (late import)' });

          if (!result.success) {
            setError(result.error ?? 'Late import failed');
            return;
          }

          if (result.section_ids.length > 0) {
            importedSectionIdsRef.current.push(...result.section_ids);
          }

          await refreshProjectState();
        }
      } catch (e) {
        console.error('[lateImport] Error:', e);
        setError(String(e));
        return;
      } finally {
        setIsImporting(false);
      }

      // Filter out discarded segments — they should not be placed later.
      const remaining = unreachable.filter(idx => !discardedIndicesRef.current.has(idx));
      if (remaining.length > 0) {
        const segments = computeUnreachableSegments(remaining, connectionsRef.current);
        if (segments.length > 0) {
          setSegmentQueue(segments);
          segmentSkipCountRef.current = new Map();

          const firstSegment = segments[0]!;
          commitSegmentAnchor({ sectionIndex: firstSegment[0]!, stationIndex: 0 });
          const hasSuggestion = firstSegment.some(idx => skippedSuggestionsRef.current.has(idx));
          setSegmentPlacementMode(hasSuggestion ? 'suggestion' : 'manual');
          setFromExistingSectionId(null);
          setFromExistingStationIdx(0);
          setAutoStartManualPlacementPending(true);
          setError(null);
          setPhase('manual_placing');
          return;
        }
      }

      onComplete(importedSectionIdsRef.current);
    };

    doLateImport();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, placingRetry]);

  // Handle 'done' phase (only reached when no sections to place)
  useEffect(() => {
    if (phase !== 'done') return;
    if (isImporting || isCalculating) return;

    const remaining = selectedIndices.filter(
      (idx) => !connectedIndices.has(idx) && idx !== zeroDatumConfig?.sectionIndex
    );

    if (remaining.length > 0) {
      const segments = computeUnreachableSegments(remaining, connectionsRef.current);
      if (segments.length > 0) {
        setSegmentQueue(segments);
        segmentSkipCountRef.current = new Map();

        const firstSegment = segments[0]!;
        commitSegmentAnchor({ sectionIndex: firstSegment[0]!, stationIndex: 0 });
        const hasSuggestion = firstSegment.some(idx => skippedSuggestionsRef.current.has(idx));
        setSegmentPlacementMode(hasSuggestion ? 'suggestion' : 'manual');
        setFromExistingSectionId(null);
        setFromExistingStationIdx(0);
        setAutoStartManualPlacementPending(true);
        setError(null);
        setPhase('manual_placing');
        return;
      }
    }

    onComplete(importedSectionIdsRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, isImporting, isCalculating]);

  // Build preview section for import side from original shots (no mode modifications).
  // Both import and target sections display their original geometry so the user can
  // visually compare the overlap regardless of the selected overlap mode.
  const importPreviewSection = useMemo<DmpSection | null>(() => {
    if (!currentSuggestion) return null;
    const section = dmpFile.sections[currentSuggestion.importSectionIndex];
    if (!section) return null;
    if (!editState) return section;

    const syntheticShots: DmpShot[] = editState.shots
      .filter((s) => !s.isDeleted)
      .map((s) => ({
        shot_type: 'Standard' as const,
        heading_in: s.azimuth_in,
        heading_out: s.azimuth_out,
        length: s.length,
        depth_in: s.depth_in,
        depth_out: s.depth_out,
        pitch_in: s.pitch_in ?? 0,
        pitch_out: s.pitch_out ?? 0,
        left: s.left ?? 0,
        right: s.right ?? 0,
        up: s.up ?? 0,
        down: s.down ?? 0,
        temperature: 0, hour: 0, minute: 0, second: 0, marker_index: 0,
        ...(s.comment != null ? { comment: s.comment } : {}),
      }));

    return {
      ...section,
      name: editState.name,
      direction: editState.direction,
      shots: syntheticShots,
    };
  }, [currentSuggestion, dmpFile.sections, editState]);

  // Build merge preview config for SectionPreview (existing target)
  const mergePreviewConfig = useMemo((): MergePreviewConfig | null => {
    if (!currentSuggestion || currentSuggestion.targetType !== 'existing') return null;
    if (currentSuggestion.existingSectionId == null) return null;

    const currentProject = useProjectStore.getState().project;
    if (!currentProject) return null;

    const targetSection = currentProject.sections.find(
      (s) => s.id === currentSuggestion.existingSectionId
    );
    if (!targetSection) return null;

    return {
      targetSection,
      importStationIndex: selectedMergePair?.importStation ?? currentSuggestion.importStationIndex,
      targetStationIndex: selectedMergePair?.existingStation ?? currentSuggestion.existingStationIndex,
    };
  }, [currentSuggestion, selectedMergePair]);

  // Build DMP merge preview config for import-to-import targets
  const dmpMergePreviewConfig = useMemo((): DmpMergePreviewConfig | null => {
    if (!currentSuggestion || currentSuggestion.targetType !== 'importing') return null;
    if (currentSuggestion.targetImportIndex == null) return null;

    const targetSection = dmpFile.sections[currentSuggestion.targetImportIndex];
    if (!targetSection) return null;

    const targetColorIdx = (currentSuggestion.targetImportIndex ?? 0) % SECTION_COLORS.length;

    return {
      targetDmpSection: targetSection,
      targetColor: SECTION_COLORS[targetColorIdx] ?? '#95a5a6',
      importStationIndex: selectedMergePair?.importStation ?? currentSuggestion.importStationIndex,
      targetStationIndex: selectedMergePair?.existingStation ?? currentSuggestion.existingStationIndex,
    };
  }, [currentSuggestion, selectedMergePair, dmpFile.sections]);

  // Merge target-side + import-side context for SectionPreview.
  // Import-side context is relative to the import section's station 0 and needs the same
  // merge offset that SectionPreview applies to align the import section with the target.
  const mergedContextSections = useMemo((): ContextSectionGeometry[] | null => {
    const parts: ContextSectionGeometry[] = [];
    if (segmentContext?.targetSide) parts.push(...segmentContext.targetSide);
    if (segmentContext?.importSide && segmentContext.importSide.length > 0) {
      const activePreview = mergePreviewConfig ?? dmpMergePreviewConfig;
      let dx = 0;
      let dy = 0;
      if (activePreview && importPreviewSection) {
        // Compute the same importOffset that SectionPreview uses internally
        const importStations = computeStationsFromDmpShots(
          importPreviewSection.shots.filter((s) => s.shot_type === 'Standard')
        );
        let targetStations: Array<{ x: number; y: number }> = [];
        if (mergePreviewConfig) {
          targetStations = computeStationsFromShots(
            mergePreviewConfig.targetSection.shots
          );
        } else if (dmpMergePreviewConfig) {
          targetStations = computeStationsFromDmpShots(
            dmpMergePreviewConfig.targetDmpSection.shots.filter((s) => s.shot_type === 'Standard')
          );
        }
        const importStn = importStations[activePreview.importStationIndex];
        const targetStn = targetStations[activePreview.targetStationIndex];
        if (importStn && targetStn) {
          dx = targetStn.x - importStn.x;
          dy = targetStn.y - importStn.y;
        }
      }
      parts.push(...segmentContext.importSide.map((ctx) => ({
        color: ctx.color,
        shots: ctx.shots.map((shot) => ({
          from: [shot.from[0] + dx, shot.from[1] + dy] as [number, number],
          to: [shot.to[0] + dx, shot.to[1] + dy] as [number, number],
        })),
      })));
    }
    return parts.length > 0 ? parts : null;
  }, [segmentContext, mergePreviewConfig, dmpMergePreviewConfig, importPreviewSection]);

  // Import color for the current section (from editState, which tracks user changes)
  const importColor = useMemo(() => {
    if (editState?.color) return editState.color;
    const sectionIdx = currentSuggestion?.importSectionIndex ?? -1;
    const pos = selectedIndices.indexOf(sectionIdx);
    return SECTION_COLORS[(pos >= 0 ? pos : 0) % SECTION_COLORS.length] ?? '#4ecdc4';
  }, [editState?.color, currentSuggestion?.importSectionIndex, selectedIndices]);

  // Target section name for display
  const targetSectionName = useMemo(() => {
    if (!currentSuggestion) return '';
    return currentSuggestion.existingSectionName;
  }, [currentSuggestion]);

  // Confirm handler — records a virtual connection + overlap info (instant, no backend call).
  // Overlap treatment is deferred to applyAllOverlapTreatments which runs before batch import.
  const handleConfirm = useCallback(() => {
    if (!currentSuggestion) return;
    if (suggestionActionInFlightRef.current || transitionToPlacingInFlightRef.current) return;
    suggestionActionInFlightRef.current = true;
    try {
      if (import.meta.env.DEV) {
        console.warn(
          `[handleConfirm] import=${currentSuggestion.importSectionIndex} "${currentSuggestion.importSectionName}"`,
          `→ target=${currentSuggestion.targetType === 'importing' ? currentSuggestion.targetImportIndex : currentSuggestion.existingSectionId}`,
          `"${currentSuggestion.existingSectionName}"`,
          `type=${currentSuggestion.targetType}`,
          `impStn=${currentSuggestion.importStationIndex} exStn=${currentSuggestion.existingStationIndex}`,
          `matched=${currentSuggestion.matchedShots} dir=${currentSuggestion.direction}`,
        );
      }
      setError(null);

      // Read fresh edit state from the ref (synchronously up-to-date) instead of
      // the editState React state which may be one render behind when the user
      // confirms quickly after a suggestion change.
      const importIdx = currentSuggestion.importSectionIndex;
      const freshEditState = sectionEditsRef.current.get(importIdx);
      if (!freshEditState) return; // shouldn't happen — init-effect always populates

      // Save raw user edits unchanged — NO overlap treatment here.
      // applyAllOverlapTreatments will handle all overlap mutation before batch import.
      sectionEditsRef.current.set(importIdx, freshEditState);

      // Record confirmed overlap info so applyAllOverlapTreatments knows the merge station
      const mergeImportStation = selectedMergePair?.importStation ?? currentSuggestion.importStationIndex;
      confirmedOverlapsRef.current.set(importIdx, {
        importStationIndex: currentSuggestion.importStationIndex,
        matchedShots: currentSuggestion.matchedShots,
        direction: currentSuggestion.direction,
        existingStationIndex: currentSuggestion.existingStationIndex,
        targetType: currentSuggestion.targetType,
        existingSectionId: currentSuggestion.existingSectionId ?? null,
        targetImportIndex: currentSuggestion.targetImportIndex ?? null,
        mergeImportStation,
      });

      // Use selected merge pair for station indices (falls back to suggestion's original)
      const mergeExistingStation = selectedMergePair?.existingStation ?? currentSuggestion.existingStationIndex;

      const newConn: VirtualConnection = {
        importSectionIndex: currentSuggestion.importSectionIndex,
        importStationIndex: mergeImportStation,
        targetType: currentSuggestion.targetType,
        ...(currentSuggestion.existingSectionId != null && { existingSectionId: currentSuggestion.existingSectionId }),
        ...(currentSuggestion.targetType === 'existing' && { existingStationIndex: mergeExistingStation }),
        ...(currentSuggestion.targetImportIndex != null && { targetImportIndex: currentSuggestion.targetImportIndex }),
        ...(currentSuggestion.targetType === 'importing' && { targetImportStationIndex: mergeExistingStation }),
      };

      setConnections((prev) => [...prev, newConn]);
      // Update ref eagerly
      connectionsRef.current = [...connectionsRef.current, newConn];

      // Check if all sections are now connected or skipped
      const newConnected = new Set(connectionsRef.current.map((c) => c.importSectionIndex));
      const zeroDatumIdx = zeroDatumConfig?.sectionIndex ?? null;
      const remaining = selectedIndices.filter(
        (idx) => idx !== zeroDatumIdx && !newConnected.has(idx) && !skippedIndicesRef.current.has(idx)
      );

      if (remaining.length === 0) {
        // All handled — transition to placing (or manual_placing if unreachable)
        transitionToPlacingOrManual();
        return;
      }

      // Pick next from pool
      if (!pickFromPool()) {
        // Pool exhausted — check for unreachable sections
        transitionToPlacingOrManual();
        return;
      }
    } finally {
      if (!transitionToPlacingInFlightRef.current) {
        suggestionActionInFlightRef.current = false;
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSuggestion, selectedMergePair, zeroDatumConfig, selectedIndices, pickFromPool, transitionToPlacingOrManual]);

  // Skip handler (suggesting phase)
  const handleSkip = useCallback(() => {
    if (!currentSuggestion) return;
    if (suggestionActionInFlightRef.current || transitionToPlacingInFlightRef.current) return;
    suggestionActionInFlightRef.current = true;
    try {
      const skippedIdx = currentSuggestion.importSectionIndex;

      // Record the suggestion so it can be re-shown in manual_placing
      skippedSuggestionsRef.current.set(skippedIdx, currentSuggestion);

      setSkippedIndices((prev) => {
        const next = new Set(prev);
        next.add(skippedIdx);
        return next;
      });

      // Update ref eagerly
      const newSkipped = new Set(skippedIndicesRef.current);
      newSkipped.add(skippedIdx);
      skippedIndicesRef.current = newSkipped;

      const zeroDatumIdx = zeroDatumConfig?.sectionIndex ?? null;
      const newConnected = new Set(connectionsRef.current.map((c) => c.importSectionIndex));
      const remaining = selectedIndices.filter(
        (idx) => idx !== zeroDatumIdx && !newConnected.has(idx) && !newSkipped.has(idx)
      );

      if (remaining.length === 0) {
        transitionToPlacingOrManual();
        return;
      }

      if (!pickFromPool()) {
        transitionToPlacingOrManual();
        return;
      }
    } finally {
      if (!transitionToPlacingInFlightRef.current) {
        suggestionActionInFlightRef.current = false;
      }
    }
  }, [currentSuggestion, zeroDatumConfig, selectedIndices, pickFromPool, transitionToPlacingOrManual]);

  // Alternative click handler
  const handleAlternativeClick = useCallback((alt: CrossSectionSuggestion) => {
    setCurrentSuggestion(alt);
    setAlternatives((prev) => {
      const newAlts = prev.filter((a) => a !== alt);
      if (currentSuggestion) {
        newAlts.push(currentSuggestion);
        newAlts.sort((a, b) => b.score - a.score);
      }
      return newAlts.slice(0, 4);
    });
  }, [currentSuggestion]);

  // ─── Manual placing phase handlers ────────────────────────────────────────

  // Access UI store for map placement (use selectors to avoid full-store subscription)
  const startPlacementMode = useUIStore((s) => s.startPlacementMode);
  const closeDialog = useUIStore((s) => s.closeDialog);
  const openDialog = useUIStore((s) => s.openDialog);
  const showToast = useUIStore((s) => s.showToast);
  const setDmpImportWizardPhase = useUIStore((s) => s.setDmpImportWizardPhase);
  const onboardingWizardPhase = useMemo(() => {
    if (phase === 'suggesting' && !isCalculating && currentSuggestion) {
      return 'suggesting' as const;
    }
    if (phase === 'manual_placing' && currentSegment && !autoStartManualPlacementPending) {
      return 'manual_placing' as const;
    }
    return null;
  }, [phase, isCalculating, currentSuggestion, currentSegment, autoStartManualPlacementPending]);

  useEffect(() => {
    setDmpImportWizardPhase(onboardingWizardPhase);
  }, [onboardingWizardPhase, setDmpImportWizardPhase]);

  useEffect(
    () => () => {
      setDmpImportWizardPhase(null);
    },
    [setDmpImportWizardPhase]
  );

  // Project sections and merges for "From Existing" dropdown + preview
  const projectSections = useProjectStore((s) => s.project?.sections ?? []);
  const projectMerges = useProjectStore((s) => s.project?.station_merges ?? []);

  // Get target section stations for "From Existing" mode
  const fromExistingTargetSection = useMemo(() => {
    if (fromExistingSectionId == null) return null;
    return projectSections.find(s => s.id === fromExistingSectionId) ?? null;
  }, [fromExistingSectionId, projectSections]);

  const fromExistingStationCount = useMemo(() => {
    if (!fromExistingTargetSection) return 0;
    return fromExistingTargetSection.shots.length + 1;
  }, [fromExistingTargetSection]);

  // Compute segment preview for manual_placing.
  // Uses effective (post-treatment) sections so the preview reflects deleted
  // shots and interpolated values — matching what will be imported.
  const segmentPreviewSections = useMemo(() => {
    if (!currentSegment) return null;

    // Build effective DmpSections with edits applied
    const effectiveSections = dmpFile.sections.map((sec, idx) =>
      buildEffectiveDmpSection(sec, sectionEditsRef.current.get(idx)),
    );
    // Adjust connection station indices to match post-deletion geometry
    const effectiveConns = adjustConnectionsForEdits(connections, sectionEditsRef.current);
    const layout = computeSegmentLayout(currentSegment, effectiveConns, effectiveSections);

    return layout.map((entry) => {
      const section = effectiveSections[entry.sectionIndex];
      if (!section) return null;
      const edits = sectionEditsRef.current.get(entry.sectionIndex);
      const selectedPos = selectedIndices.indexOf(entry.sectionIndex);
      const sectionColor = (edits?.color || null) ?? SECTION_COLORS[(selectedPos >= 0 ? selectedPos : entry.sectionIndex) % SECTION_COLORS.length] ?? '#95a5a6';
      return {
        section,
        color: sectionColor,
        sectionIndex: entry.sectionIndex,
        offsetX: entry.offsetX,
        offsetY: entry.offsetY,
      };
    }).filter((x): x is NonNullable<typeof x> => x !== null);
  }, [currentSegment, connections, dmpFile.sections]);

  // Compute target segment context for "From Existing" preview (shows the target section's
  // connected segment as dimmed lines behind the import segment preview)
  const fromExistingContextSections = useMemo((): ContextSectionGeometry[] | null => {
    if (segmentPlacementMode !== 'fromExisting' || fromExistingSectionId == null) return null;
    if (!segmentAnchor || !segmentPreviewSections || segmentPreviewSections.length === 0) return null;

    // Build adjacency from project station_merges
    const mergeAdj = new Map<number, Array<{ neighborId: number; thisIdx: number; neighborIdx: number }>>();
    for (const m of projectMerges) {
      const a = m.station_a;
      const b = m.station_b;
      if (!mergeAdj.has(a.section_id)) mergeAdj.set(a.section_id, []);
      if (!mergeAdj.has(b.section_id)) mergeAdj.set(b.section_id, []);
      mergeAdj.get(a.section_id)!.push({ neighborId: b.section_id, thisIdx: a.station_index, neighborIdx: b.station_index });
      mergeAdj.get(b.section_id)!.push({ neighborId: a.section_id, thisIdx: b.station_index, neighborIdx: a.station_index });
    }

    // BFS from target section through merges to discover connected segment
    const visited = new Set<number>();
    const queue: Array<{ sectionId: number; offsetX: number; offsetY: number }> = [];
    visited.add(fromExistingSectionId);
    queue.push({ sectionId: fromExistingSectionId, offsetX: 0, offsetY: 0 });

    const entries: Array<{ sectionId: number; stations: Array<{ x: number; y: number }>; offsetX: number; offsetY: number }> = [];

    while (queue.length > 0) {
      const { sectionId, offsetX, offsetY } = queue.shift()!;
      const section = projectSections.find((s) => s.id === sectionId);
      if (!section) continue;

      const stnPositions = computeStationsFromShots(section.shots);
      entries.push({ sectionId, stations: stnPositions, offsetX, offsetY });

      for (const edge of mergeAdj.get(sectionId) ?? []) {
        if (visited.has(edge.neighborId)) continue;
        visited.add(edge.neighborId);

        const neighborSection = projectSections.find((s) => s.id === edge.neighborId);
        if (!neighborSection) continue;

        const neighborStns = computeStationsFromShots(neighborSection.shots);
        const thisPos = stnPositions[edge.thisIdx];
        const neighborPos = neighborStns[edge.neighborIdx];
        if (!thisPos || !neighborPos) continue;

        queue.push({
          sectionId: edge.neighborId,
          offsetX: offsetX + thisPos.x - neighborPos.x,
          offsetY: offsetY + thisPos.y - neighborPos.y,
        });
      }
    }

    // Align target segment to import segment: target station → import anchor station
    const targetEntry = entries.find((e) => e.sectionId === fromExistingSectionId);
    if (!targetEntry) return null;
    const targetStn = targetEntry.stations[fromExistingStationIdx];
    if (!targetStn) return null;

    const anchorEntry = segmentPreviewSections.find((e) => e.sectionIndex === segmentAnchor.sectionIndex);
    if (!anchorEntry) return null;
    const anchorStns = computeStationsFromDmpShots(
      anchorEntry.section.shots.filter((s) => s.shot_type === 'Standard'),
    );
    const anchorStn = anchorStns[segmentAnchor.stationIndex];
    if (!anchorStn) return null;

    const gx = (anchorEntry.offsetX + anchorStn.x) - (targetEntry.offsetX + targetStn.x);
    const gy = (anchorEntry.offsetY + anchorStn.y) - (targetEntry.offsetY + targetStn.y);

    // Build ContextSectionGeometry for each section in the target segment
    const result: ContextSectionGeometry[] = [];
    for (const entry of entries) {
      const shots: Array<{ from: [number, number]; to: [number, number] }> = [];
      for (let i = 0; i < entry.stations.length - 1; i++) {
        const from = entry.stations[i]!;
        const to = entry.stations[i + 1]!;
        shots.push({
          from: [from.x + entry.offsetX + gx, from.y + entry.offsetY + gy],
          to: [to.x + entry.offsetX + gx, to.y + entry.offsetY + gy],
        });
      }
      if (shots.length > 0) {
        result.push({
          color: entry.sectionId === fromExistingSectionId ? '#95a5a6' : '#6b7280',
          shots,
        });
      }
    }

    return result.length > 0 ? result : null;
  }, [segmentPlacementMode, fromExistingSectionId, fromExistingStationIdx, projectSections, projectMerges, segmentAnchor, segmentPreviewSections]);

  // Current segment's skipped suggestion (if any section in the segment had one)
  const segmentSkippedSuggestion = useMemo(() => {
    if (!currentSegment) return null;
    for (const idx of currentSegment) {
      const suggestion = skippedSuggestionsRef.current.get(idx);
      if (suggestion) return suggestion;
    }
    return null;
  }, [currentSegment]);

  // Advance to next segment or transition to placing
  const advanceSegmentQueue = useCallback(() => {
    setSegmentQueue((prev) => {
      const next = prev.slice(1);
      if (next.length === 0) {
        // Queue empty — transition to placing
        setPhase('placing');
        return [];
      }
      // Initialize anchor for next segment
      const firstSegment = next[0]!;
      commitSegmentAnchor({ sectionIndex: firstSegment[0]!, stationIndex: 0 });
      const hasSuggestion = firstSegment.some(idx => skippedSuggestionsRef.current.has(idx));
      setSegmentPlacementMode(hasSuggestion ? 'suggestion' : 'manual');
      setFromExistingSectionId(null);
      setFromExistingStationIdx(0);
      return next;
    });
  }, []);

  // Place segment handler
  const handleSegmentPlace = useCallback(() => {
    if (!currentSegment || !segmentAnchor) return;

    let placement: ImportPlacement;
    if (segmentPlacementMode === 'suggestion' && segmentSkippedSuggestion) {
      // Use the skipped suggestion as a from_existing connection
      const suggestion = segmentSkippedSuggestion;
      if (suggestion.targetType === 'existing' && suggestion.existingSectionId != null) {
        // Add as a virtual connection instead
        const newConn: VirtualConnection = {
          importSectionIndex: suggestion.importSectionIndex,
          importStationIndex: suggestion.importStationIndex,
          targetType: 'existing',
          existingSectionId: suggestion.existingSectionId,
          existingStationIndex: suggestion.existingStationIndex,
        };
        setConnections((prev) => [...prev, newConn]);
        connectionsRef.current = [...connectionsRef.current, newConn];
        advanceSegmentQueue();
        return;
      } else if (suggestion.targetType === 'importing' && suggestion.targetImportIndex != null) {
        const newConn: VirtualConnection = {
          importSectionIndex: suggestion.importSectionIndex,
          importStationIndex: suggestion.importStationIndex,
          targetType: 'importing',
          targetImportIndex: suggestion.targetImportIndex,
          targetImportStationIndex: suggestion.existingStationIndex,
        };
        setConnections((prev) => [...prev, newConn]);
        connectionsRef.current = [...connectionsRef.current, newConn];
        advanceSegmentQueue();
        return;
      }
      return;
    } else if (segmentPlacementMode === 'fromExisting') {
      if (fromExistingSectionId == null) return;
      placement = {
        type: 'from_existing',
        import_station: segmentAnchor.stationIndex,
        existing_station: {
          section_id: fromExistingSectionId,
          station_index: fromExistingStationIdx,
        },
      };
    } else if (segmentPlacementMode === 'discard') {
      // Discard: skip this segment entirely without creating a placement
      for (const idx of currentSegment) {
        discardedIndicesRef.current.add(idx);
      }
      advanceSegmentQueue();
      return;
    } else if (segmentPlacementMode === 'manual') {
      // Manual mode is handled by handleStartSegmentPlacement
      return;
    } else {
      return;
    }

    const dp: DirectPlacement = {
      anchorSectionIndex: segmentAnchor.sectionIndex,
      anchorStationIndex: segmentAnchor.stationIndex,
      placement,
    };
    directPlacementsRef.current = [...directPlacementsRef.current, dp];
    advanceSegmentQueue();
  }, [currentSegment, segmentAnchor, segmentPlacementMode, segmentSkippedSuggestion, fromExistingSectionId, fromExistingStationIdx, advanceSegmentQueue]);

  // Skip segment handler — appends to end of queue
  const handleSegmentSkip = useCallback(() => {
    if (!currentSegment) return;
    const key = currentSegment.join(',');
    const count = (segmentSkipCountRef.current.get(key) ?? 0) + 1;
    segmentSkipCountRef.current.set(key, count);

    setSegmentQueue((prev) => {
      if (prev.length <= 1) {
        // Only one segment left — can't skip, it stays
        return prev;
      }
      const [first, ...rest] = prev;
      const next = [...rest, first!];
      // Initialize anchor for next segment
      const nextSeg = next[0]!;
      commitSegmentAnchor({ sectionIndex: nextSeg[0]!, stationIndex: 0 });
      const hasSuggestion = nextSeg.some(idx => skippedSuggestionsRef.current.has(idx));
      setSegmentPlacementMode(hasSuggestion ? 'suggestion' : 'origin');
      setFromExistingSectionId(null);
      setFromExistingStationIdx(0);
      return next;
    });
  }, [currentSegment]);

  // Station click handler for segment preview
  const handleSegmentStationClick = useCallback((stationIndex: number, sectionIndex?: number) => {
    if (sectionIndex != null) {
      commitSegmentAnchor({ sectionIndex, stationIndex });
    } else if (currentSegment && currentSegment.length > 0) {
      commitSegmentAnchor({ sectionIndex: currentSegment[0]!, stationIndex });
    }
  }, [currentSegment, commitSegmentAnchor]);

  const buildSegmentPlacementPayload = useCallback(
    (segment: number[], anchor: { sectionIndex: number; stationIndex: number }) => {
      const anchorDmpSection = dmpFile.sections[anchor.sectionIndex];
      if (!anchorDmpSection) {
        return null;
      }

      const edits = sectionEditsRef.current.get(anchor.sectionIndex);
      const shots: ShotData[] = edits
        ? edits.shots.filter((s) => !s.isDeleted).map(editableShotToShotData)
        : convertToEditableShots(anchorDmpSection.shots).map(editableShotToShotData);

      const sectionData = {
        name: edits?.name ?? anchorDmpSection.name,
        surveyor: edits?.surveyor ?? selectionConfig.defaultSurveyor ?? null,
        date: edits?.date ?? selectionConfig.defaultDate ?? anchorDmpSection.date?.split(/[T ]/)[0] ?? null,
        color:
          (edits?.color || null) ??
          SECTION_COLORS[selectedIndices.indexOf(anchor.sectionIndex) % SECTION_COLORS.length] ??
          '#4ecdc4',
        direction: edits?.direction ?? anchorDmpSection.direction,
        quality: edits?.quality ?? 1.0,
        shots,
      };

      // Build additional sections for segment shadow using effective (post-treatment)
      // sections so the overlay reflects deleted shots and interpolated values.
      const effectiveSections = dmpFile.sections.map((sec, idx) =>
        buildEffectiveDmpSection(sec, sectionEditsRef.current.get(idx)),
      );
      const effectiveConns = adjustConnectionsForEdits(connectionsRef.current, sectionEditsRef.current);
      const layout = computeSegmentLayout(segment, effectiveConns, effectiveSections);
      // Offsets from computeSegmentLayout are relative to station 0 of the root
      // section (segmentIndices[0]). Re-base them relative to the anchor section's
      // station 0 so PlacementOverlay positions them correctly.
      const anchorLayoutEntry = layout.find((entry) => entry.sectionIndex === anchor.sectionIndex);
      const anchorLayoutOffsetX = anchorLayoutEntry?.offsetX ?? 0;
      const anchorLayoutOffsetY = anchorLayoutEntry?.offsetY ?? 0;
      const additionalSections = layout
        .filter((entry) => entry.sectionIndex !== anchor.sectionIndex)
        .map((entry) => {
          const sec = effectiveSections[entry.sectionIndex];
          if (!sec) return null;
          const secEdits = sectionEditsRef.current.get(entry.sectionIndex);
          const secSelectedPos = selectedIndices.indexOf(entry.sectionIndex);
          const secColor =
            (secEdits?.color || null) ??
            SECTION_COLORS[(secSelectedPos >= 0 ? secSelectedPos : entry.sectionIndex) % SECTION_COLORS.length] ??
            '#95a5a6';
          const secShots = secEdits
            ? secEdits.shots.filter((s) => !s.isDeleted).map(editableShotToShotData)
            : convertToEditableShots(sec.shots).map(editableShotToShotData);
          return {
            sectionData: {
              name: secEdits?.name ?? sec.name,
              surveyor: null,
              date: null,
              color: secColor,
              direction: secEdits?.direction ?? sec.direction,
              quality: secEdits?.quality ?? 1.0,
              shots: secShots,
            },
            color: secColor,
            offsetX: entry.offsetX - anchorLayoutOffsetX,
            offsetY: entry.offsetY - anchorLayoutOffsetY,
          };
        })
        .filter((value): value is NonNullable<typeof value> => value !== null);

      return { sectionData, additionalSections };
    },
    [dmpFile.sections, selectionConfig.defaultDate, selectionConfig.defaultSurveyor, selectedIndices],
  );

  const importPlacedSegmentNow = useCallback(
    async (segmentIndices: number[], directPlacements: DirectPlacement[]) => {
      const zeroDatumIdx = zeroDatumConfig?.sectionIndex ?? null;
      const { configs, emittedDmpIndices } = buildBatchImport(
        connectionsRef.current,
        zeroDatumIdx,
        dmpFile,
        selectionConfig,
        sectionEditsRef.current,
        fullPoolRef.current,
        directPlacements,
        earlyImportedRef.current,
      );

      const pendingSet = new Set(segmentIndices);
      const segmentConfigs: BackendImportSectionConfig[] = [];
      const segmentDmpIndices: number[] = [];
      // Map original config position -> new position in segmentConfigs
      const posRemap = new Map<number, number>();
      for (let i = 0; i < configs.length; i++) {
        const dmpIdx = emittedDmpIndices[i];
        if (dmpIdx != null && pendingSet.has(dmpIdx)) {
          posRemap.set(i, segmentConfigs.length);
          segmentConfigs.push({ ...configs[i]!, section_index: segmentConfigs.length });
          segmentDmpIndices.push(dmpIdx);
        }
      }

      for (const cfg of segmentConfigs) {
        if (cfg.placement.type === 'from_importing') {
          const placement = cfg.placement as {
            type: 'from_importing';
            import_station: number;
            target_section_index: number;
            target_station_index: number;
          };
          const oldTarget = placement.target_section_index;
          const newTarget = posRemap.get(oldTarget);
          if (newTarget != null) {
            placement.target_section_index = newTarget;
            continue;
          }
          const targetDmpIdx = emittedDmpIndices[oldTarget];
          const existingTargetId = targetDmpIdx != null
            ? earlyImportedRef.current.get(targetDmpIdx)
            : undefined;
          if (existingTargetId != null) {
            cfg.placement = {
              type: 'from_existing',
              import_station: placement.import_station,
              existing_station: {
                section_id: existingTargetId,
                station_index: placement.target_station_index,
              },
            };
            continue;
          }
          setError('Segment import failed: unresolved relative placement target');
          return false;
        }
      }

      if (segmentConfigs.length === 0) {
        return true;
      }

      const result = await invokeIpc<CommandResult>('import_sections', {
        sections: segmentConfigs,
        fileHash: selectionConfig.fileHash ?? null,
        sectionHashes: selectionConfig.sectionHashes ?? null,
        existingShotUpdates: null,
      }, { purpose: 'import placed segment sections' });

      if (!result.success) {
        setError(result.error ?? 'Segment import failed');
        return false;
      }

      if (result.section_ids.length > 0) {
        importedSectionIdsRef.current.push(...result.section_ids);
      }

      await refreshProjectState();

      for (let i = 0; i < segmentDmpIndices.length; i++) {
        const sectionId = result.section_ids[i];
        if (sectionId != null) {
          earlyImportedRef.current.set(segmentDmpIndices[i]!, sectionId);
        }
      }

      return true;
    },
    [buildBatchImport, dmpFile, refreshProjectState, selectionConfig, zeroDatumConfig?.sectionIndex],
  );

  // Manual map placement for a segment
  const handleStartSegmentPlacement = useCallback(() => {
    if (!currentSegment || !segmentAnchor) return;
    setAutoStartManualPlacementPending(false);

    // Reopen data (same as what App.tsx passes)
    const reopenData = {
      dmpFile,
      filePath: (useUIStore.getState().dialogData as Record<string, unknown>).filePath,
      selectionConfig,
      zeroDatumConfig,
    };

    const buildSavedState = (
      queue: number[][],
      anchor: { sectionIndex: number; stationIndex: number },
      directPlacements: DirectPlacement[],
    ): SavedManualPlacingState => ({
      connections: [...connectionsRef.current],
      skippedIndices: Array.from(skippedIndicesRef.current),
      segmentQueue: queue,
      segmentAnchor: anchor,
      directPlacements,
      skippedSuggestions: Array.from(skippedSuggestionsRef.current.entries()),
      segmentSkipCounts: Array.from(segmentSkipCountRef.current.entries()),
      sectionEdits: Array.from(sectionEditsRef.current.entries()),
      confirmedOverlaps: Array.from(confirmedOverlapsRef.current.entries()),
      earlyImported: Array.from(earlyImportedRef.current.entries()),
      discardedIndices: Array.from(discardedIndicesRef.current),
    });

    const openPlacementDialog = (
      queue: number[][],
      anchor: { sectionIndex: number; stationIndex: number },
      directPlacements: DirectPlacement[],
    ) => {
      openDialog('dmp-import-new', {
        ...reopenData,
        autoStartManualPlacement: false,
        savedManualPlacingState: buildSavedState(queue, anchor, directPlacements),
      });
    };

    const startSegmentPlacement = (
      queue: number[][],
      anchor: { sectionIndex: number; stationIndex: number },
      directPlacements: DirectPlacement[],
    ) => {
      const segment = queue[0];
      if (!segment) {
        openPlacementDialog([], anchor, directPlacements);
        return;
      }

      const payload = buildSegmentPlacementPayload(segment, anchor);
      if (!payload) {
        openPlacementDialog(queue, anchor, directPlacements);
        return;
      }

      startPlacementMode(
        payload.sectionData,
        anchor.stationIndex,
        (result: PlacementResult) => {
          const handlePlacementComplete = async () => {
            const placement: ImportPlacement = result.snappedToStation
              ? {
                  type: 'manual_snap',
                  align_station_index: anchor.stationIndex,
                  snapped_to_station: result.snappedToStation,
                }
              : {
                  type: 'manual',
                  align_station_index: anchor.stationIndex,
                  offset: result.position,
                };

            const dp: DirectPlacement = {
              anchorSectionIndex: anchor.sectionIndex,
              anchorStationIndex: anchor.stationIndex,
              placement,
            };

            const nextQueue = queue.slice(1);
            const nextDirectPlacements = [...directPlacements, dp];
            directPlacementsRef.current = nextDirectPlacements;

            let segmentImported = false;
            setIsImporting(true);
            try {
              segmentImported = await importPlacedSegmentNow(segment, nextDirectPlacements);
            } catch (e) {
              console.error('[manualPlacement] Immediate segment import failed:', e);
              setError(String(e));
            } finally {
              setIsImporting(false);
            }
            if (!segmentImported) {
              openPlacementDialog(queue, anchor, directPlacements);
              return;
            }

            if (nextQueue.length > 0) {
              const nextAnchor = {
                sectionIndex: nextQueue[0]![0]!,
                stationIndex: 0,
              };
              startSegmentPlacement(nextQueue, nextAnchor, nextDirectPlacements);
              return;
            }

            openPlacementDialog([], anchor, nextDirectPlacements);
          };

          void handlePlacementComplete();
        },
        () => {
          openPlacementDialog(queue, anchor, directPlacements);
        },
        payload.additionalSections.length > 0 ? payload.additionalSections : undefined,
      );

      showToast(
        'Placement: Click to place section. Esc for more placement options and metadata changes.',
        'dmp-manual-placement-hint'
      );
    };

    startSegmentPlacement(segmentQueue, segmentAnchor, [...directPlacementsRef.current]);

    // Close dialog so user can interact with the map
    closeDialog();
  }, [
    currentSegment,
    segmentAnchor,
    segmentQueue,
    buildSegmentPlacementPayload,
    dmpFile,
    selectionConfig,
    zeroDatumConfig,
    importPlacedSegmentNow,
    startPlacementMode,
    closeDialog,
    openDialog,
    showToast,
  ]);

  useEffect(() => {
    if (!autoStartManualPlacementPending) {
      return;
    }
    if (phase !== 'manual_placing' || !currentSegment || !segmentAnchor || isImporting) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      handleStartSegmentPlacement();
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    autoStartManualPlacementPending,
    phase,
    currentSegment,
    segmentAnchor,
    isImporting,
    handleStartSegmentPlacement,
  ]);

  // Cancel/Back
  const handleCancel = useCallback(() => {
    if (connections.length > 0) {
      setShowCancelConfirm(true);
    } else {
      onCancel();
    }
  }, [connections.length, onCancel]);

  const handleBack = useCallback(() => {
    if (connections.length > 0) {
      setShowBackConfirm(true);
    } else {
      onBack();
    }
  }, [connections.length, onBack]);

  // Confidence helpers
  const confidenceColors: Record<string, string> = {
    high: 'bg-success-10 text-success border-success-30',
    medium: 'bg-warning-10 text-warning border-warning-30',
    low: 'bg-background-50 text-text-secondary border-border',
  };

  const directionLabel = (direction: string) =>
    direction === 'forward' ? '\u2192' : '\u2190';

  // Progress — during manual_placing, compute from queue (which has ALL unplaced sections).
  // Otherwise, count connected sections + zero datum.
  const sectionsInQueue = useMemo(() => segmentQueue.flat().length, [segmentQueue]);
  const placedCount = phase === 'manual_placing' || phase === 'placing' || phase === 'done'
    ? totalSelected - sectionsInQueue
    : connectedIndices.size + (zeroDatumConfig ? 1 : 0);
  const skippedCount = skippedIndices.size;

  // Whether we're in the suggestion view with a current suggestion (side-by-side layout)
  const showSideBySide = phase === 'suggesting' && !isCalculating && currentSuggestion != null;

  // Whether we're in the manual_placing phase
  const showManualPlacing = phase === 'manual_placing' && currentSegment != null;

  // Keep segment placement mode synced with onboarding steps so each step shows
  // the intended controls and context while the user progresses.
  useEffect(() => {
    if (!showManualPlacing) {
      return;
    }

    const getSegmentPlacementOnboardingStepId = (): string | null => {
      const overlay = document.querySelector('[data-testid="onboarding-overlay"]');
      if (!overlay) {
        return null;
      }
      const flowId = overlay.getAttribute('data-onboarding-flow-id');
      const stepId = overlay.getAttribute('data-onboarding-step-id');
      return flowId === 'dmp-segment-placement' ? stepId : null;
    };

    const syncPlacementModeForStep = () => {
      const stepId = getSegmentPlacementOnboardingStepId();
      let requiredMode: 'fromExisting' | 'manual' | 'discard' | null = null;

      if (stepId === 'from-existing') {
        requiredMode = 'fromExisting';
      } else if (
        stepId === 'manual-placement' ||
        stepId === 'section-name' ||
        stepId === 'other-data' ||
        stepId === 'actions'
      ) {
        requiredMode = 'manual';
      } else if (stepId === 'do-not-place') {
        requiredMode = 'discard';
      }

      if (!requiredMode) {
        return;
      }

      setSegmentPlacementMode((current) => (current === requiredMode ? current : requiredMode));
    };

    syncPlacementModeForStep();

    if (typeof MutationObserver === 'undefined') {
      return;
    }

    const observer = new MutationObserver(syncPlacementModeForStep);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-onboarding-flow-id', 'data-onboarding-step-id'],
    });

    return () => {
      observer.disconnect();
    };
  }, [showManualPlacing]);

  // Target type label for import-to-import connections
  const isImportTarget = currentSuggestion?.targetType === 'importing';

  // Section names in current segment (for display)
  const segmentSectionNames = useMemo(() => {
    if (!currentSegment) return [];
    return currentSegment.map(idx => dmpFile.sections[idx]?.name ?? `Section ${idx}`);
  }, [currentSegment, dmpFile.sections]);

  // Whether current placement mode is valid for submission
  const isSegmentPlacementValid = useMemo(() => {
    if (!segmentAnchor) return false;
    if (segmentPlacementMode === 'suggestion') return segmentSkippedSuggestion != null;
    if (segmentPlacementMode === 'fromExisting') return fromExistingSectionId != null;
    if (segmentPlacementMode === 'manual') return false; // must use "Place on Map" button
    if (segmentPlacementMode === 'discard') return true;
    return false;
  }, [segmentAnchor, segmentPlacementMode, segmentSkippedSuggestion, fromExistingSectionId]);

  return (
    <DialogWrapper
      title={t('dialogs.dmpNewImport.title')}
      onClose={handleCancel}
      fixedSize={{ width: 'min(1000px, 95vw)', height: 'min(700px, 90vh)' }}
      overflow="hidden"
      bodyClassName="flex-1 flex flex-col p-0 min-h-0"
      hidden={autoStartManualPlacementPending}
      data-testid="dmp-new-import-dialog"
    >
      <div className="flex-1 flex flex-col min-h-0">
        {/* Progress header */}
        <div className="px-4 py-2 border-b border-border text-sm text-text-secondary">
          <span data-testid="wizard-progress">
            {t('dialogs.dmpNewImport.progress', { placed: placedCount, total: totalSelected })}
          </span>
          {skippedCount > 0 && (
            <span className="ml-2" data-testid="wizard-skipped">
              · {t('dialogs.dmpNewImport.skipped', { count: skippedCount })}
            </span>
          )}
        </div>

        {/* Body: side-by-side when showing suggestion, centered otherwise */}
        {showSideBySide ? (
          <div className="flex-1 flex min-h-0 overflow-hidden relative">
            {/* Left column: SectionPreview */}
            <div
              className="shrink-0 flex flex-col items-center p-4 border-r border-border"
              style={{ width: 380 }}
              data-testid="segment-preview-panel"
            >
              <SectionPreview
                section={importPreviewSection}
                color={importColor}
                size={340}
                mergePreview={mergePreviewConfig}
                dmpMergePreview={dmpMergePreviewConfig}
                focusStationIndex={selectedMergePair?.importStation ?? currentSuggestion!.importStationIndex}
                contextSections={mergedContextSections}
              />
            </div>

            {/* Right column: connection details */}
            <div className="flex-1 min-w-0 overflow-y-auto p-5 space-y-4" data-testid="wizard-suggestion">
              {/* Suggested connection — prominent card */}
              <div className="rounded-lg border border-accent/30 bg-accent/5 p-4 space-y-3">
                <div>
                  <h3 className="text-sm font-semibold text-text-primary">
                    {t('dialogs.dmpNewImport.connectionHeading')}
                  </h3>
                  <p className="text-xs text-text-secondary mt-0.5">
                    {t('dialogs.dmpNewImport.connectionDescription')}
                  </p>
                </div>

                {/* Connection description */}
                <div className="rounded border border-border bg-background p-3" data-testid="wizard-connection-description">
                  <div className="text-sm">
                    <span className="font-medium">&ldquo;{currentSuggestion!.importSectionName}&rdquo;</span>
                    {' '}{t('dialogs.dmpNewImport.station', { index: selectedMergePair?.importStation ?? currentSuggestion!.importStationIndex })}
                  </div>
                  <div className="text-text-secondary text-sm my-1">
                    {t('dialogs.dmpNewImport.connectsTo')}
                  </div>
                  <div className="text-sm">
                    <span className="font-medium">&ldquo;{targetSectionName}&rdquo;</span>
                    {' '}{t('dialogs.dmpNewImport.station', { index: selectedMergePair?.existingStation ?? currentSuggestion!.existingStationIndex })}
                    {isImportTarget && (
                      <span className="ml-1 text-xs text-text-secondary">(importing)</span>
                    )}
                  </div>
                </div>

                {/* Confidence badge */}
                <div className="flex items-center gap-2" data-testid="wizard-confidence">
                  <span className={`px-2 py-1 rounded border text-xs font-medium ${confidenceColors[currentSuggestion!.confidence] ?? ''}`}>
                    {t(`dialogs.dmpNewImport.confidence.${currentSuggestion!.confidence}`)}
                  </span>
                  <span className="text-xs text-text-secondary">
                    · {t('dialogs.dmpNewImport.matchedShots', { count: currentSuggestion!.matchedShots })} {directionLabel(currentSuggestion!.direction)}
                    {currentSuggestion!.isPartial && <span className="ml-0.5 opacity-60">~</span>}
                  </span>
                </div>

                {/* Merge station control */}
                <div className="flex items-center gap-2" data-testid="wizard-merge-station-control">
                  <label className="text-xs text-text-secondary whitespace-nowrap">
                    {t('dialogs.dmpNewImport.mergeStation')}
                  </label>
                  {mergeOptions.length > 1 ? (
                    <select
                      value={selectedMergeOffset}
                      onChange={(e) => setSelectedMergeOffset(Number(e.target.value))}
                      className="px-2 py-1 bg-background border border-border rounded text-xs"
                      data-testid="merge-station-select"
                    >
                      {mergeOptions.map((opt) => (
                        <option key={opt.offset} value={opt.offset}>
                          stn {opt.importStation} → {targetSectionName} stn {opt.existingStation}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-xs text-text-secondary">
                      stn {selectedMergePair?.importStation ?? currentSuggestion!.importStationIndex}
                      {' → '}
                      {targetSectionName} stn{' '}
                      {selectedMergePair?.existingStation ?? currentSuggestion!.existingStationIndex}
                    </span>
                  )}
                </div>

                {/* Overlap control */}
                <div className="flex items-center gap-2" data-testid="wizard-overlap-control">
                  <label className="text-xs text-text-secondary whitespace-nowrap">
                    {t('dialogs.dmpNewImport.overlapMode')}
                  </label>
                  {currentSuggestion && currentSuggestion.matchedShots > 0 ? (
                    <select
                      value={overlapMode}
                      onChange={(e) => handleOverlapModeChange(e.target.value as OverlapMode)}
                      className="px-2 py-1 bg-background border border-border rounded text-xs"
                      data-testid="overlap-mode-select"
                    >
                      <option value="interpolate" disabled={isTargetDoublyAnchored}>{t('dialogs.dmpNewImport.overlapMode_interpolate')}</option>
                      <option value="import_data" disabled={isTargetDoublyAnchored}>{t('dialogs.dmpNewImport.overlapMode_importData')}</option>
                      <option value="existing_data">{t('dialogs.dmpNewImport.overlapMode_existingData')}</option>
                      <option value="keep_both">{t('dialogs.dmpNewImport.overlapMode_keepBoth')}</option>
                    </select>
                  ) : (
                    <span className="text-xs text-text-secondary">
                      {t('dialogs.dmpNewImport.noOverlapShots')}
                    </span>
                  )}
                </div>

                {/* Prompt */}
                <div className="text-sm font-medium">
                  {t('dialogs.dmpNewImport.doesThisLookRight')}
                </div>
              </div>

              {/* Error */}
              {error && (
                <div className="text-sm text-error" data-testid="wizard-error">
                  {error}
                </div>
              )}

              {/* Alternatives */}
              {alternatives.length > 0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowAlternatives(!showAlternatives)}
                    className="text-xs text-accent hover:text-accent-hover flex items-center gap-1"
                    data-testid="toggle-alternatives"
                  >
                    <span className={`transition-transform ${showAlternatives ? 'rotate-90' : ''}`}>&#9654;</span>
                    {showAlternatives
                      ? t('dialogs.dmpNewImport.hideAlternatives')
                      : t('dialogs.dmpNewImport.showAlternatives', { count: alternatives.length })}
                  </button>

                  {showAlternatives && (
                    <div className="mt-2 space-y-1" data-testid="alternatives-list">
                      {alternatives.map((alt, idx) => (
                        <button
                          key={`${alt.importSectionIndex}-${alt.existingSectionId ?? alt.targetImportIndex}-${alt.existingStationIndex}-${alt.importStationIndex}-${alt.direction}`}
                          type="button"
                          className={`w-full p-2 rounded border text-left text-xs flex items-center gap-2 hover:bg-accent-5 transition-colors ${confidenceColors[alt.confidence] ?? ''}`}
                          onClick={() => handleAlternativeClick(alt)}
                          data-testid={`alternative-${idx}`}
                        >
                          <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${confidenceColors[alt.confidence] ?? ''}`}>
                            {t(`dialogs.dmpNewImport.confidence.${alt.confidence}`).split(' ')[0]}
                          </span>
                          <span className="flex-1 truncate">
                            <span className="text-text-secondary">stn {alt.importStationIndex}</span>
                            <span className="text-text-secondary"> → </span>
                            <span className="font-medium">{alt.existingSectionName}</span>
                            <span className="text-text-secondary"> stn {alt.existingStationIndex}</span>
                            {alt.targetType === 'importing' && (
                              <span className="text-text-secondary text-[10px] ml-0.5">(imp)</span>
                            )}
                          </span>
                          <span className="text-text-secondary">
                            {alt.matchedShots} {directionLabel(alt.direction)}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Section Settings */}
              {editState && (
                <>
                  <div className="border-t border-border" />
                  <div className="text-sm font-medium">
                    {t('dialogs.dmpNewImport.sectionSettings')}
                  </div>
                  <div>
                    <label className="block text-sm text-text-secondary mb-1" data-testid="section-name-label">
                      {t('common.labels.name')}
                    </label>
                    <input
                      type="text"
                      value={editState.name}
                      onChange={(e) => handleMetadataChange('name', e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded"
                      placeholder={t('sectionMetadata.placeholders.name')}
                      data-testid="section-name-input"
                    />
                  </div>
                  <div className="space-y-4" data-testid="wizard-editable-rest">
                    <SectionMetadataForm
                      name={editState.name}
                      surveyor={editState.surveyor}
                      date={editState.date}
                      color={editState.color}
                      direction={editState.direction}
                      quality={editState.quality}
                      onNameChange={(v) => handleMetadataChange('name', v)}
                      onSurveyorChange={(v) => handleMetadataChange('surveyor', v)}
                      onDateChange={(v) => handleMetadataChange('date', v)}
                      onColorChange={(v) => handleMetadataChange('color', v)}
                      onDirectionChange={(v) => handleMetadataChange('direction', v)}
                      onQualityChange={(v) => handleMetadataChange('quality', v)}
                      showName={false}
                      showDirection
                    />
                    <div className="border-t border-border" />
                    <ShotTableEditor
                      shots={effectiveShots}
                      onShotChange={handleShotChange}
                      onAddShot={handleAddShot}
                      onDeleteShot={handleDeleteShot}
                      onInsertBefore={handleInsertBefore}
                      onInsertAfter={handleInsertAfter}
                      frozenShotIndices={frozenShotIndices}
                      maxHeight="12rem"
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        ) : showManualPlacing ? (
          <div className="flex-1 flex min-h-0 overflow-hidden relative">
            {/* Left column: Segment Preview */}
            <div
              className="shrink-0 flex flex-col items-center p-4 border-r border-border"
              style={{ width: 380 }}
              data-testid="segment-preview-panel"
            >
              <SectionPreview
                segmentSections={segmentPreviewSections}
                contextSections={fromExistingContextSections}
                size={340}
                onStationClick={handleSegmentStationClick}
                selectedStationIndex={previewAnchor?.stationIndex ?? null}
                selectedSectionIndex={previewAnchor?.sectionIndex ?? null}
              />
            </div>

            {/* Right column: Placement configuration */}
            <div className="flex-1 min-w-0 overflow-y-auto p-5 space-y-4" data-testid="wizard-manual-placing">
              {/* Segment header */}
              <div>
                <div className="text-sm font-medium">
                  {t('dialogs.dmpNewImport.manualPlacing.segmentHeader', {
                    current: segmentQueue.length > 0 ? 1 : 0,
                    total: segmentQueue.length,
                  })}
                </div>
                <div className="text-xs text-text-secondary mt-0.5">
                  {t('dialogs.dmpNewImport.manualPlacing.sections')}: {segmentSectionNames.join(', ')}
                </div>
              </div>

              {/* Placement mode radio group */}
              <div className="space-y-2" data-testid="segment-placement-modes">
                <div className="text-xs font-medium text-text-secondary">
                  {t('dialogs.dmpNewImport.manualPlacing.placementMode')}
                </div>

                {/* Suggestion option (only if available) */}
                {segmentSkippedSuggestion && (
                  <label className="flex items-start gap-2 p-2 rounded border border-border hover:bg-accent-5 cursor-pointer">
                    <input
                      type="radio"
                      name="segmentPlacementMode"
                      checked={segmentPlacementMode === 'suggestion'}
                      onChange={() => setSegmentPlacementMode('suggestion')}
                      className="mt-0.5"
                    />
                    <div className="text-sm">
                      <div className="font-medium">{t('dialogs.dmpNewImport.manualPlacing.suggestion')}</div>
                      <div className="text-xs text-text-secondary">
                        → {segmentSkippedSuggestion.existingSectionName} stn {segmentSkippedSuggestion.existingStationIndex}
                        {' · '}{segmentSkippedSuggestion.matchedShots} shots matched
                      </div>
                    </div>
                  </label>
                )}

                {/* From existing station */}
                <label
                  className="flex items-start gap-2 p-2 rounded border border-border hover:bg-accent-5 cursor-pointer"
                  data-testid="segment-mode-from-existing"
                >
                  <input
                    type="radio"
                    name="segmentPlacementMode"
                    checked={segmentPlacementMode === 'fromExisting'}
                    onChange={() => setSegmentPlacementMode('fromExisting')}
                    className="mt-0.5"
                  />
                  <div className="text-sm flex-1">
                    <div>{t('dialogs.dmpNewImport.manualPlacing.fromExisting')}</div>
                    {segmentPlacementMode === 'fromExisting' && (
                      <div className="mt-2 space-y-2">
                        {/* Import side: segment section + station */}
                        <div className="text-xs font-medium text-text-secondary mt-1">Import station</div>
                        {currentSegment && currentSegment.length > 1 && (
                          <div className="flex items-center gap-2">
                            <label className="text-xs text-text-secondary whitespace-nowrap">Section</label>
                            <Select
                              value={String(segmentAnchor?.sectionIndex ?? '')}
                              onChange={(v) => {
                                const idx = Number(v);
                                commitSegmentAnchor({ sectionIndex: idx, stationIndex: 0 });
                              }}
                              options={currentSegment.map((idx): SelectOption => ({
                                value: String(idx),
                                label: sectionEditsRef.current.get(idx)?.name ?? dmpFile.sections[idx]?.name ?? `Section ${idx}`,
                              }))}
                              className="flex-1"
                              data-testid="from-existing-import-section-select"
                              onOptionHover={handleAnchorSectionHover}
                            />
                          </div>
                        )}
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-text-secondary whitespace-nowrap">Station</label>
                          <Select
                            value={String(segmentAnchor?.stationIndex ?? 0)}
                            onChange={(v) => {
                              const current = segmentAnchorRef.current;
                              if (!current) return;
                              commitSegmentAnchor({ sectionIndex: current.sectionIndex, stationIndex: Number(v) });
                            }}
                            options={(() => {
                              const secIdx = segmentAnchor?.sectionIndex;
                              const secEdits = secIdx != null ? sectionEditsRef.current.get(secIdx) : undefined;
                              const sec = secIdx != null ? dmpFile.sections[secIdx] : null;
                              const count = secEdits
                                ? secEdits.shots.filter(s => !s.isDeleted).length + 1
                                : sec ? sec.shots.filter(s => s.shot_type === 'Standard').length + 1 : 0;
                              return Array.from({ length: count }, (_, i): SelectOption => ({
                                value: String(i),
                                label: `Station ${i}`,
                              }));
                            })()}
                            className="flex-1"
                            data-testid="from-existing-import-station-select"
                            onOptionHover={handleAnchorStationHover}
                          />
                        </div>

                        {/* Target side: existing project section + station */}
                        <div className="text-xs font-medium text-text-secondary mt-1">Target station</div>
                        {projectSections.length > 0 ? (
                          <>
                            <div className="flex items-center gap-2">
                              <label className="text-xs text-text-secondary whitespace-nowrap">Section</label>
                              <Select
                                value={fromExistingSectionId != null ? String(fromExistingSectionId) : ''}
                                onChange={(v) => {
                                  const val = v ? Number(v) : null;
                                  setFromExistingSectionId(val);
                                  setFromExistingStationIdx(0);
                                }}
                                options={[
                                  { value: '', label: '—' } as SelectOption,
                                  ...projectSections.map((s): SelectOption => ({
                                    value: String(s.id),
                                    label: s.name ?? `Section ${s.id}`,
                                  })),
                                ]}
                                className="flex-1"
                                data-testid="from-existing-section-select"
                              />
                            </div>
                            {fromExistingSectionId != null && (
                              <div className="flex items-center gap-2">
                                <label className="text-xs text-text-secondary whitespace-nowrap">Station</label>
                                <Select
                                  value={String(fromExistingStationIdx)}
                                  onChange={(v) => setFromExistingStationIdx(Number(v))}
                                  options={Array.from({ length: fromExistingStationCount }, (_, i): SelectOption => ({
                                    value: String(i),
                                    label: `Station ${i}`,
                                  }))}
                                  className="flex-1"
                                  data-testid="from-existing-station-select"
                                />
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="text-xs text-text-secondary italic">
                            {t('dialogs.dmpNewImport.manualPlacing.noSections')}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </label>

                {/* Manual placement */}
                <label
                  className="flex items-start gap-2 p-2 rounded border border-border hover:bg-accent-5 cursor-pointer"
                  data-testid="segment-mode-manual"
                >
                  <input
                    type="radio"
                    name="segmentPlacementMode"
                    checked={segmentPlacementMode === 'manual'}
                    onChange={() => setSegmentPlacementMode('manual')}
                    className="mt-0.5"
                  />
                  <div className="text-sm flex-1">
                    <div>{t('dialogs.dmpNewImport.manualPlacing.manual')}</div>
                    {segmentPlacementMode === 'manual' && (
                      <div className="mt-2 space-y-2">
                        {currentSegment && currentSegment.length > 1 && (
                          <div className="flex items-center gap-2">
                            <label className="text-xs text-text-secondary whitespace-nowrap">Section</label>
                            <Select
                              value={String(segmentAnchor?.sectionIndex ?? '')}
                              onChange={(v) => {
                                const idx = Number(v);
                                commitSegmentAnchor({ sectionIndex: idx, stationIndex: 0 });
                              }}
                              options={currentSegment.map((idx): SelectOption => ({
                                value: String(idx),
                                label: sectionEditsRef.current.get(idx)?.name ?? dmpFile.sections[idx]?.name ?? `Section ${idx}`,
                              }))}
                              className="flex-1"
                              data-testid="manual-import-section-select"
                              onOptionHover={handleAnchorSectionHover}
                            />
                          </div>
                        )}
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-text-secondary whitespace-nowrap">Station</label>
                          <Select
                            value={String(segmentAnchor?.stationIndex ?? 0)}
                            onChange={(v) => {
                              const current = segmentAnchorRef.current;
                              if (!current) return;
                              commitSegmentAnchor({ sectionIndex: current.sectionIndex, stationIndex: Number(v) });
                            }}
                            options={(() => {
                              const secIdx = segmentAnchor?.sectionIndex;
                              const secEdits = secIdx != null ? sectionEditsRef.current.get(secIdx) : undefined;
                              const sec = secIdx != null ? dmpFile.sections[secIdx] : null;
                              const count = secEdits
                                ? secEdits.shots.filter(s => !s.isDeleted).length + 1
                                : sec ? sec.shots.filter(s => s.shot_type === 'Standard').length + 1 : 0;
                              return Array.from({ length: count }, (_, i): SelectOption => ({
                                value: String(i),
                                label: `Station ${i}`,
                              }));
                            })()}
                            className="flex-1"
                            data-testid="manual-import-station-select"
                            onOptionHover={handleAnchorStationHover}
                          />
                        </div>
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={handleStartSegmentPlacement}
                          data-testid="segment-place-on-map-button"
                        >
                          {t('dialogs.dmpNewImport.manualPlacing.placeOnMap')}
                        </Button>
                      </div>
                    )}
                  </div>
                </label>

                {/* Do not place (discard) */}
                <label
                  className="flex items-start gap-2 p-2 rounded border border-border hover:bg-accent-5 cursor-pointer"
                  data-testid="segment-mode-discard"
                >
                  <input
                    type="radio"
                    name="segmentPlacementMode"
                    checked={segmentPlacementMode === 'discard'}
                    onChange={() => setSegmentPlacementMode('discard')}
                    className="mt-0.5"
                  />
                  <div className="text-sm">
                    <div>{t('dialogs.dmpNewImport.manualPlacing.doNotPlace')}</div>
                    <div className="text-xs text-text-secondary">
                      {t('dialogs.dmpNewImport.manualPlacing.doNotPlaceDescription')}
                    </div>
                  </div>
                </label>
              </div>

              {/* Section settings (same editing surface as section connection / zero datum flows) */}
              {editState && (
                <>
                  <div className="space-y-2" data-testid="wizard-manual-section-settings">
                    <div className="border-t border-border" />
                    <div className="text-sm font-medium">
                      {t('dialogs.dmpNewImport.sectionSettings')}
                    </div>
                    <div>
                      <label className="block text-sm text-text-secondary mb-1">
                        {t('common.labels.name')}
                      </label>
                      <input
                        type="text"
                        value={editState.name}
                        onChange={(e) => handleMetadataChange('name', e.target.value)}
                        className="w-full px-3 py-2 bg-background border border-border rounded"
                        placeholder={t('sectionMetadata.placeholders.name')}
                        data-testid="section-name-input"
                      />
                    </div>
                  </div>
                  <div className="space-y-4" data-testid="wizard-manual-editable-rest">
                    <SectionMetadataForm
                      name={editState.name}
                      surveyor={editState.surveyor}
                      date={editState.date}
                      color={editState.color}
                      direction={editState.direction}
                      quality={editState.quality}
                      onNameChange={(v) => handleMetadataChange('name', v)}
                      onSurveyorChange={(v) => handleMetadataChange('surveyor', v)}
                      onDateChange={(v) => handleMetadataChange('date', v)}
                      onColorChange={(v) => handleMetadataChange('color', v)}
                      onDirectionChange={(v) => handleMetadataChange('direction', v)}
                      onQualityChange={(v) => handleMetadataChange('quality', v)}
                      showName={false}
                      showDirection
                    />
                    <div className="border-t border-border" />
                    <ShotTableEditor
                      shots={effectiveShots}
                      onShotChange={handleShotChange}
                      onAddShot={handleAddShot}
                      onDeleteShot={handleDeleteShot}
                      onInsertBefore={handleInsertBefore}
                      onInsertAfter={handleInsertAfter}
                      frozenShotIndices={frozenShotIndices}
                      maxHeight="12rem"
                    />
                  </div>
                </>
              )}

              {/* Error */}
              {error && (
                <div className="text-sm text-error" data-testid="wizard-error">
                  {error}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-6 min-h-0 overflow-auto">
            {/* Init/Importing zero datum */}
            {phase === 'init' && isImporting && (
              <div className="text-center" data-testid="wizard-importing-zero-datum">
                <div className="text-lg mb-2">{t('dialogs.dmpNewImport.importingZeroDatum')}</div>
                <div className="animate-pulse text-text-secondary">...</div>
              </div>
            )}

            {/* Calculating suggestions */}
            {(phase === 'init' || phase === 'suggesting') && isCalculating && (
              <div className="text-center" data-testid="wizard-calculating">
                <div className="text-lg mb-2">{t('dialogs.dmpNewImport.calculating')}</div>
                <div className="animate-pulse text-text-secondary">...</div>
              </div>
            )}

            {/* Placing — batch import in progress or failed */}
            {phase === 'placing' && (
              <div className="text-center" data-testid="wizard-placing">
                {error && !isImporting ? (
                  <>
                    <div className="text-lg mb-2 text-error">{error}</div>
                  </>
                ) : (
                  <>
                    <div className="text-lg mb-2">{t('dialogs.dmpNewImport.placing', { count: connectedIndices.size })}</div>
                    <div className="animate-pulse text-text-secondary">...</div>
                  </>
                )}
              </div>
            )}

            {/* Early import in progress (between suggesting and manual_placing/done) */}
            {phase === 'suggesting' && isImporting && (
              <div className="text-center" data-testid="wizard-early-importing">
                <div className="text-lg mb-2">{t('dialogs.dmpNewImport.placing', { count: connectedIndices.size })}</div>
                <div className="animate-pulse text-text-secondary">...</div>
              </div>
            )}

            {/* No suggestions — show status while transitioning to manual placement */}
            {phase === 'suggesting' && !isCalculating && !currentSuggestion && !isImporting && (
              <div className="text-center" data-testid="wizard-no-suggestions">
                <div className="text-lg mb-2">{t('dialogs.dmpNewImport.noSuggestions')}</div>
              </div>
            )}

            {/* Done — all placed */}
            {phase === 'done' && placedCount === totalSelected && (
              <div className="text-center" data-testid="wizard-all-placed">
                <CheckCircleIcon size={32} className="text-success mx-auto mb-2" />
                <div className="text-lg">{t('dialogs.dmpNewImport.allPlaced')}</div>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border flex justify-between items-center">
          <div className="flex gap-2">
            <Button onClick={handleCancel} className={importSecondaryButtonClass} data-testid="cancel-button">
              {t('common.actions.cancel')}
            </Button>
            <Button onClick={handleBack} className={importSecondaryButtonClass} data-testid="back-button">
              {t('common.actions.back')}
            </Button>
          </div>
          <div className="flex gap-2" data-testid="wizard-suggestion-actions">
            {phase === 'suggesting' && !isCalculating && currentSuggestion && (
              <>
                <Button
                  onClick={handleSkip}
                  disabled={isImporting}
                  className={importSecondaryButtonClass}
                  data-testid="skip-button"
                >
                  {t('dialogs.dmpNewImport.skip')}
                </Button>
                <Button
                  variant="primary"
                  onClick={handleConfirm}
                  disabled={isImporting}
                  data-testid="confirm-button"
                >
                  {t('dialogs.dmpNewImport.confirm')}
                </Button>
              </>
            )}
            {phase === 'manual_placing' && currentSegment && (
              <>
                {segmentQueue.length > 1 && (
                  <Button
                    onClick={handleSegmentSkip}
                    className={importSecondaryButtonClass}
                    data-testid="segment-skip-button"
                  >
                    {t('dialogs.dmpNewImport.manualPlacing.skip')}
                  </Button>
                )}
                <Button
                  variant="primary"
                  onClick={handleSegmentPlace}
                  disabled={!isSegmentPlacementValid}
                  data-testid="segment-place-button"
                >
                  {segmentPlacementMode === 'discard'
                    ? t('dialogs.dmpNewImport.manualPlacing.next')
                    : t('dialogs.dmpNewImport.manualPlacing.placeSegment')}
                </Button>
              </>
            )}
            {phase === 'placing' && error && !isImporting && (
              <Button
                variant="primary"
                onClick={() => setPlacingRetry((n) => n + 1)}
                data-testid="retry-button"
              >
                {t('common.actions.retry')}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Cancel confirmation */}
      <AlertDialog
        open={showCancelConfirm}
        title={t('dialogs.dmpNewImport.cancelWizard')}
        onClose={() => setShowCancelConfirm(false)}
        data-testid="cancel-confirm-dialog"
        actions={
          <>
            <Button onClick={() => setShowCancelConfirm(false)} className={importSecondaryButtonClass}>
              {t('common.actions.continue')}
            </Button>
            <Button variant="danger" onClick={onCancel} data-testid="confirm-cancel-button">
              {t('common.actions.cancel')}
            </Button>
          </>
        }
      >
        <p>
          {connections.length > 0
            ? t('dialogs.dmpNewImport.cancelWizardMessage')
            : t('dialogs.dmpNewImport.cancelWizardNoImports')}
        </p>
      </AlertDialog>

      {/* Back confirmation */}
      <AlertDialog
        open={showBackConfirm}
        title={t('dialogs.dmpNewImport.backWizard')}
        onClose={() => setShowBackConfirm(false)}
        data-testid="back-confirm-dialog"
        actions={
          <>
            <Button onClick={() => setShowBackConfirm(false)} className={importSecondaryButtonClass}>
              {t('common.actions.continue')}
            </Button>
            <Button variant="danger" onClick={onBack} data-testid="confirm-back-button">
              {t('common.actions.back')}
            </Button>
          </>
        }
      >
        <p>{t('dialogs.dmpNewImport.backWizardMessage')}</p>
      </AlertDialog>
    </DialogWrapper>
  );
}
