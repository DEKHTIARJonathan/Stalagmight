import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
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

interface DmpNewImportDialogProps {
  dmpFile: DmpFile;
  selectionConfig: DmpSelectionConfig;
  project: Project | null;
  stations: Station[];
  zeroDatumConfig?: ZeroDatumConfigResult | undefined;
  onCancel: () => void;
  onBack: () => void;
  onHandoffToLegacy: (remainingIndices: Set<number>, connections: VirtualConnection[]) => void;
  onComplete: () => void;
  /** Saved state to restore after returning from manual map placement. */
  savedManualPlacingState?: SavedManualPlacingState | undefined;
}

// ─── Section edit state ──────────────────────────────────────────────────────

interface SectionEditState {
  name: string;
  surveyor: string;
  date: string;
  color: string;
  direction: 'in' | 'out';
  quality: number;
  shots: EditableShot[];
}

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

/**
 * Adjust a station index for deleted shots.
 *
 * When overlap shots are deleted from an import section, station indices
 * shift. This counts non-deleted shots before the original station position
 * to compute the adjusted index in the filtered shot array.
 */
function adjustStationForDeletedShots(
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

/** Build batch import configs from virtual connections + BFS order. */
function buildBatchImport(
  connections: VirtualConnection[],
  zeroDatumIndex: number | null,
  dmpFile: DmpFile,
  selectionConfig: DmpSelectionConfig,
  sectionEdits?: Map<number, SectionEditState>,
  fullPool?: CrossSectionSuggestion[],
  directPlacements?: DirectPlacement[],
): { configs: BackendImportSectionConfig[]; unreachable: number[] } {
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
  let colorIdx = 0;

  // Multi-pass: BFS order may not match dependency order for fallback-anchored
  // components, so retry sections whose from_importing target wasn't emitted yet.
  let lastConfigCount = -1;
  while (configs.length > lastConfigCount) {
    lastConfigCount = configs.length;
    for (const idx of reachableOrder) {
      if (emittedPosition.has(idx)) continue;
      // Skip zero datum — already imported
      if (idx === zeroDatumIndex) continue;

      const section = dmpFile.sections[idx];
      if (!section) continue;

      const edits = sectionEdits?.get(idx);

      // Use edited shots if available, otherwise fall back to DMP data
      let backendShots: ShotData[];
      if (edits) {
        backendShots = edits.shots
          .filter((s) => !s.isDeleted)
          .map(editableShotToShotData);
      } else {
        const editableShots = convertToEditableShots(section.shots);
        backendShots = editableShots.map(editableShotToShotData);
      }
      if (backendShots.length === 0) continue;

      // Check for direct placement first (from manual_placing phase)
      const directPlacement = directPlacementMap.get(idx);
      const conn = connectionMap.get(idx);
      if (!directPlacement && !conn) continue;

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
          // The target must already be emitted in configs[]
          const targetPos = emittedPosition.get(conn!.targetImportIndex);
          if (targetPos == null) {
            // Target not yet placed — will retry in next pass
            continue;
          }
          // Adjust target station index for deleted shots in the target section
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
        } else {
          continue;
        }
      }

      // Use edits for metadata if available, otherwise fall back to DMP data + selectionConfig
      const sectionName = edits?.name ?? section.name;
      const surveyorValue = edits?.surveyor ?? selectionConfig.defaultSurveyor ?? null;
      const dateStr = edits?.date ?? selectionConfig.defaultDate ?? section.date?.split(/[T ]/)[0] ?? null;
      const colorValue = edits?.color ?? SECTION_COLORS[colorIdx % SECTION_COLORS.length] ?? '#4ecdc4';
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
      colorIdx++;
    }
  }

  // Unreachable = connected sections not in reachableSet + sections with no connection at all
  const allSelected = Array.from(selectionConfig.selectedIndices);
  const unreachable = allSelected.filter(
    (idx) => idx !== zeroDatumIndex && !reachableSet.has(idx),
  );

  return { configs, unreachable };
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
  onHandoffToLegacy,
  onComplete,
  savedManualPlacingState,
}: DmpNewImportDialogProps) {
  const { t } = useTranslation();

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
  const sectionEditsRef = useRef<Map<number, SectionEditState>>(
    saved ? new Map(saved.sectionEdits) : new Map()
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
    'suggestion' | 'origin' | 'fromExisting' | 'manual'
  >('origin');
  const [segmentAnchor, setSegmentAnchor] = useState<{
    sectionIndex: number; stationIndex: number;
  } | null>(saved?.segmentAnchor ?? null);

  // Per-mode state for manual_placing
  const [fromExistingSectionId, setFromExistingSectionId] = useState<number | null>(null);
  const [fromExistingStationIdx, setFromExistingStationIdx] = useState<number>(0);

  // Track original suggestions for sections skipped during suggesting phase
  const skippedSuggestionsRef = useRef<Map<number, CrossSectionSuggestion>>(
    saved ? new Map(saved.skippedSuggestions) : new Map()
  );

  // Accumulated direct placements for manual_placing phase
  const directPlacementsRef = useRef<DirectPlacement[]>(saved?.directPlacements ?? []);

  // Skip counter per segment (prevent infinite loops)
  const segmentSkipCountRef = useRef<Map<string, number>>(
    saved ? new Map(saved.segmentSkipCounts) : new Map()
  );

  // Guard against React StrictMode double-firing the mount effect
  // When restoring from saved state, skip the init effect entirely
  const importStartedRef = useRef(!!saved);

  // Refs to avoid stale closures
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;
  const skippedIndicesRef = useRef(skippedIndices);
  skippedIndicesRef.current = skippedIndices;

  const selectedIndices = useMemo(
    () => Array.from(selectionConfig.selectedIndices).sort((a, b) => a - b),
    [selectionConfig.selectedIndices]
  );

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
          const result = await invoke<SegmentGeometry>('get_segment_geometry', { sectionId: currentSuggestion.existingSectionId });
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
            const result = await invoke<SegmentGeometry>('get_segment_geometry', { sectionId: anchor.existingSectionId });
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
          const result = await invoke<SegmentGeometry>('get_segment_geometry', { sectionId: anchor.existingSectionId });
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

  // Initialize / restore section edit state when currentSuggestion changes
  useEffect(() => {
    if (!currentSuggestion) {
      setEditState(null);
      return;
    }

    const idx = currentSuggestion.importSectionIndex;

    // Restore from ref if previously edited
    const existing = sectionEditsRef.current.get(idx);
    if (existing) {
      setEditState(existing);
      return;
    }

    // Initialize from DMP data + selectionConfig defaults
    const section = dmpFile.sections[idx];
    if (!section) {
      setEditState(null);
      return;
    }

    const shots = convertToEditableShots(section.shots);
    nextTempIdRef.current = shots.length + 1;

    const colorIdx = connectedIndices.size % SECTION_COLORS.length;
    const newState: SectionEditState = {
      name: section.name,
      surveyor: selectionConfig.defaultSurveyor || '',
      date: selectionConfig.defaultDate ?? section.date?.split(/[T ]/)[0] ?? '',
      color: SECTION_COLORS[colorIdx] ?? '#4ecdc4',
      direction: section.direction === 'out' ? 'out' : 'in',
      quality: 1.0,
      shots,
    };

    sectionEditsRef.current.set(idx, newState);
    setEditState(newState);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSuggestion]);

  // Keep sectionEditsRef in sync with editState changes
  useEffect(() => {
    if (!editState || !currentSuggestion) return;
    sectionEditsRef.current.set(currentSuggestion.importSectionIndex, editState);
  }, [editState, currentSuggestion]);

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
                return { ...applyTargetData(shot, target), is_reference: true };
              } else if (overlapMode === 'interpolate') {
                return { ...interpolateShots(shot, target), is_reference: true };
              }
            }
            return { ...shot, is_reference: true };
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
      // import_data: keep import values but mark as reference for preview
      return { ...shot, is_reference: true };
    });
  }, [editState, currentSuggestion, selectedMergePair, overlapMode, dmpFile.sections]);

  // Compute reference shot indices for SectionPreview (0-based among visible shots)
  const referenceIndices = useMemo(() => {
    const indices = new Set<number>();
    let visibleIdx = 0;
    for (const shot of effectiveShots) {
      if (shot.isDeleted) continue;
      if (shot.is_reference) indices.add(visibleIdx);
      visibleIdx++;
    }
    return indices;
  }, [effectiveShots]);

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

  // Decide whether to enter manual_placing or go straight to placing.
  // Called when the suggesting phase is done (pool exhausted or all confirmed/skipped).
  const transitionToPlacingOrManual = useCallback(() => {
    const zeroDatumIdx = zeroDatumConfig?.sectionIndex ?? null;
    const { unreachable } = buildBatchImport(
      connectionsRef.current,
      zeroDatumIdx,
      dmpFile,
      selectionConfig,
      sectionEditsRef.current,
      fullPoolRef.current,
      directPlacementsRef.current,
    );

    if (unreachable.length > 0) {
      const segments = computeUnreachableSegments(unreachable, connectionsRef.current);
      if (segments.length > 0) {
        setSegmentQueue(segments);
        segmentSkipCountRef.current = new Map();

        // Initialize anchor to first section's station 0
        const firstSegment = segments[0]!;
        setSegmentAnchor({ sectionIndex: firstSegment[0]!, stationIndex: 0 });

        // Check if the first section has a skipped suggestion
        const hasSuggestion = firstSegment.some(idx => skippedSuggestionsRef.current.has(idx));
        setSegmentPlacementMode(hasSuggestion ? 'suggestion' : 'origin');

        setPhase('manual_placing');
        return;
      }
    }

    setPhase('placing');
  }, [zeroDatumConfig, dmpFile, selectionConfig]);

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

        const result = await importSections([config], selectionConfig.fileHash);
        setIsImporting(false);

        if (!result.success) {
          setError(result.error ?? 'Failed to import zero datum section');
          return;
        }

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
        const suggestions = await invoke<CrossSectionSuggestion[]>(
          'suggest_all_import_placements',
          { importSections: remainingSections },
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

  // When restored from manual placement with an empty segment queue, transition to placing
  useEffect(() => {
    if (phase === 'manual_placing' && segmentQueue.length === 0) {
      setPhase('placing');
    }
  }, [phase, segmentQueue.length]);

  // Handle 'placing' phase — build batch import and execute
  useEffect(() => {
    if (phase !== 'placing') return;
    if (isImporting) return;

    const doBatchImport = async () => {
      setIsImporting(true);
      setError(null);

      const zeroDatumIdx = zeroDatumConfig?.sectionIndex ?? null;
      const { configs, unreachable } = buildBatchImport(
        connectionsRef.current,
        zeroDatumIdx,
        dmpFile,
        selectionConfig,
        sectionEditsRef.current,
        fullPoolRef.current,
        directPlacementsRef.current,
      );

      if (configs.length > 0) {
        try {
          const result = await invoke<CommandResult>('import_sections', {
            sections: configs,
            fileHash: selectionConfig.fileHash ?? null,
          });

          if (!result.success) {
            setError(result.error ?? 'Batch import failed');
            setIsImporting(false);
            return;
          }

          await refreshProjectState();
        } catch (e) {
          setError(String(e));
          setIsImporting(false);
          return;
        }
      }

      setIsImporting(false);

      if (unreachable.length > 0) {
        onHandoffToLegacy(new Set(unreachable), connectionsRef.current);
      } else {
        onComplete();
      }
    };

    doBatchImport();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, placingRetry]);

  // Handle 'done' phase (only reached when no sections to place)
  useEffect(() => {
    if (phase !== 'done') return;
    if (isImporting || isCalculating) return;

    const remaining = new Set(
      selectedIndices.filter((idx) => !connectedIndices.has(idx) && idx !== zeroDatumConfig?.sectionIndex)
    );

    if (remaining.size > 0) {
      onHandoffToLegacy(remaining, connectionsRef.current);
    } else {
      onComplete();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, isImporting, isCalculating]);

  // Build preview section for import side (live from effectiveShots when available)
  const importPreviewSection = useMemo<DmpSection | null>(() => {
    if (!currentSuggestion) return null;
    const section = dmpFile.sections[currentSuggestion.importSectionIndex];
    if (!section) return null;
    if (!editState) return section;

    // Build synthetic DmpSection from effectiveShots for live preview
    const syntheticShots: DmpShot[] = effectiveShots
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
  }, [currentSuggestion, dmpFile.sections, editState, effectiveShots]);

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

  // Map target shot indices → resolved data for preview overlay (interpolate/import_data only)
  const resolvedTargetShotMap = useMemo((): Map<number, EditableShot> | null => {
    if (!currentSuggestion || currentSuggestion.matchedShots === 0) return null;
    if (overlapMode === 'existing_data' || overlapMode === 'keep_both') return null;

    const { importStationIndex, matchedShots, direction, existingStationIndex } = currentSuggestion;
    const mergeImportStation = selectedMergePair?.importStation ?? importStationIndex;

    const actionableIds = computeActionableIds(importStationIndex, matchedShots, mergeImportStation);

    // Resolved shots are in import direction; reverse back to target direction if needed.
    const shouldReverse = needsDirectionReversal(importStationIndex, direction);
    const overlapParams = { importStationIndex, matchedShots, existingStationIndex, direction };

    const map = new Map<number, EditableShot>();
    for (const overlapId of actionableIds) {
      const resolvedShot = effectiveShots.find(s => !s.isNew && !s.isDeleted && s.id === overlapId);
      if (!resolvedShot) continue;

      const targetIdx = computeTargetShotIndex(overlapId, overlapParams);
      if (targetIdx >= 0) {
        if (shouldReverse) {
          const reversed = reverseTargetShot({
            azimuth_in: resolvedShot.azimuth_in,
            azimuth_out: resolvedShot.azimuth_out,
            length: resolvedShot.length,
            depth_in: resolvedShot.depth_in,
            depth_out: resolvedShot.depth_out,
            pitch_in: resolvedShot.pitch_in,
            pitch_out: resolvedShot.pitch_out,
            left: resolvedShot.left,
            right: resolvedShot.right,
            up: resolvedShot.up,
            down: resolvedShot.down,
          });
          map.set(targetIdx, { ...resolvedShot, ...reversed });
        } else {
          map.set(targetIdx, resolvedShot);
        }
      }
    }
    return map.size > 0 ? map : null;
  }, [currentSuggestion, selectedMergePair, overlapMode, effectiveShots]);

  // Modified merge preview config — replaces target overlap shots with resolved data
  const previewMergeConfig = useMemo((): MergePreviewConfig | null => {
    if (!mergePreviewConfig) return null;
    if (!resolvedTargetShotMap) return mergePreviewConfig;

    const modifiedShots = mergePreviewConfig.targetSection.shots.map((shot, idx) => {
      const resolved = resolvedTargetShotMap.get(idx);
      if (!resolved) return shot;
      return {
        ...shot,
        azimuth_in: resolved.azimuth_in,
        azimuth_out: resolved.azimuth_out,
        length: resolved.length,
        depth_in: resolved.depth_in,
        depth_out: resolved.depth_out,
      };
    });

    return {
      ...mergePreviewConfig,
      targetSection: { ...mergePreviewConfig.targetSection, shots: modifiedShots },
    };
  }, [mergePreviewConfig, resolvedTargetShotMap]);

  // Modified DMP merge preview config — replaces target overlap shots with resolved data
  const previewDmpMergeConfig = useMemo((): DmpMergePreviewConfig | null => {
    if (!dmpMergePreviewConfig) return null;
    if (!resolvedTargetShotMap) return dmpMergePreviewConfig;

    let standardIdx = 0;
    const modifiedShots = dmpMergePreviewConfig.targetDmpSection.shots.map((shot) => {
      if (shot.shot_type !== 'Standard') return shot;
      const resolved = resolvedTargetShotMap.get(standardIdx);
      standardIdx++;
      if (!resolved) return shot;
      return {
        ...shot,
        heading_in: resolved.azimuth_in,
        heading_out: resolved.azimuth_out,
        length: resolved.length,
        depth_in: resolved.depth_in,
        depth_out: resolved.depth_out,
      };
    });

    return {
      ...dmpMergePreviewConfig,
      targetDmpSection: { ...dmpMergePreviewConfig.targetDmpSection, shots: modifiedShots },
    };
  }, [dmpMergePreviewConfig, resolvedTargetShotMap]);

  // Merge target-side + import-side context for SectionPreview.
  // Import-side context is relative to the import section's station 0 and needs the same
  // merge offset that SectionPreview applies to align the import section with the target.
  const mergedContextSections = useMemo((): ContextSectionGeometry[] | null => {
    const parts: ContextSectionGeometry[] = [];
    if (segmentContext?.targetSide) parts.push(...segmentContext.targetSide);
    if (segmentContext?.importSide && segmentContext.importSide.length > 0) {
      const activePreview = previewMergeConfig ?? previewDmpMergeConfig;
      let dx = 0;
      let dy = 0;
      if (activePreview && importPreviewSection) {
        // Compute the same importOffset that SectionPreview uses internally
        const importStations = computeStationsFromDmpShots(
          importPreviewSection.shots.filter((s) => s.shot_type === 'Standard')
        );
        let targetStations: Array<{ x: number; y: number }> = [];
        if (previewMergeConfig) {
          targetStations = computeStationsFromShots(
            previewMergeConfig.targetSection.shots.filter((s) => !s.is_reference)
          );
        } else if (previewDmpMergeConfig) {
          targetStations = computeStationsFromDmpShots(
            previewDmpMergeConfig.targetDmpSection.shots.filter((s) => s.shot_type === 'Standard')
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
  }, [segmentContext, previewMergeConfig, previewDmpMergeConfig, importPreviewSection]);

  // Import color for the current section
  const importColor = useMemo(() => {
    return SECTION_COLORS[connectedIndices.size % SECTION_COLORS.length] ?? '#4ecdc4';
  }, [connectedIndices.size]);

  // Target section name for display
  const targetSectionName = useMemo(() => {
    if (!currentSuggestion) return '';
    return currentSuggestion.existingSectionName;
  }, [currentSuggestion]);

  // Confirm handler — records a virtual connection (instant, no backend call)
  const handleConfirm = useCallback(() => {
    if (!currentSuggestion) return;
    setError(null);

    // Save edit state with effectiveShots applied to ref before moving on.
    // For non-keep_both modes, delete ALL overlap shots (both actionable/reference
    // and past-merge) — they're redundant with the target section.
    if (editState) {
      let importShots: EditableShot[];
      if (overlapMode === 'keep_both') {
        importShots = effectiveShots;
      } else {
        const { importStationIndex, matchedShots } = currentSuggestion;
        const allOverlapIds = computeOverlapIds(importStationIndex, matchedShots);
        importShots = effectiveShots.map(shot =>
          (shot.is_reference || (!shot.isNew && allOverlapIds.has(shot.id)))
            ? { ...shot, isDeleted: true, is_reference: false }
            : shot
        );
      }
      sectionEditsRef.current.set(currentSuggestion.importSectionIndex, { ...editState, shots: importShots });

      // For 'interpolate' mode with import-to-import connections, apply the
      // interpolated values to the TARGET section's corresponding overlap shots.
      // The import's overlap shots are deleted (above) to preserve station index
      // compatibility, so the averaged values must live on the target side.
      if (overlapMode === 'interpolate' && currentSuggestion.targetType === 'importing' && currentSuggestion.targetImportIndex != null) {
        const { importStationIndex, matchedShots, existingStationIndex, direction } = currentSuggestion;
        const mergeImportStation = selectedMergePair?.importStation ?? importStationIndex;
        const actionableIds = computeActionableIds(importStationIndex, matchedShots, mergeImportStation);
        const shouldReverse = needsDirectionReversal(importStationIndex, direction);
        const overlapParams = { importStationIndex, matchedShots, existingStationIndex, direction };

        // Get or create target section's edit state
        const targetIdx = currentSuggestion.targetImportIndex;
        let targetShots: EditableShot[];
        const existingTargetEdits = sectionEditsRef.current.get(targetIdx);
        if (existingTargetEdits) {
          targetShots = existingTargetEdits.shots.map(s => ({ ...s }));
        } else {
          const targetDmpSection = dmpFile.sections[targetIdx];
          if (targetDmpSection) {
            targetShots = convertToEditableShots(targetDmpSection.shots);
          } else {
            targetShots = [];
          }
        }

        if (targetShots.length > 0) {
          // Apply interpolated values from import shots to corresponding target shots
          const importShotsForInterp = editState.shots;
          let modified = false;
          for (const overlapId of actionableIds) {
            const importShot = importShotsForInterp.find(s => !s.isNew && !s.isDeleted && s.id === overlapId);
            if (!importShot) continue;

            const targetShotIdx = computeTargetShotIndex(overlapId, overlapParams);
            if (targetShotIdx < 0 || targetShotIdx >= targetShots.length) continue;

            const targetShot = targetShots[targetShotIdx]!;
            if (targetShot.isDeleted) continue;

            // The import shot needs direction reversal to match the target's frame
            const importAsTarget: TargetShotLike = shouldReverse
              ? reverseTargetShot(importShot)
              : importShot;

            targetShots[targetShotIdx] = interpolateShots(targetShot, importAsTarget);
            modified = true;
          }

          if (modified) {
            const targetDmpSection = dmpFile.sections[targetIdx]!;
            sectionEditsRef.current.set(targetIdx, existingTargetEdits
              ? { ...existingTargetEdits, shots: targetShots }
              : {
                  name: targetDmpSection.name,
                  surveyor: '',
                  date: targetDmpSection.date?.split(/[T ]/)[0] ?? '',
                  color: '',
                  direction: targetDmpSection.direction,
                  quality: 1.0,
                  shots: targetShots,
                },
            );
          }
        }
      }
    }

    // Use selected merge pair for station indices (falls back to suggestion's original)
    const mergeImportStation = selectedMergePair?.importStation ?? currentSuggestion.importStationIndex;
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
    }
  }, [currentSuggestion, selectedMergePair, editState, effectiveShots, overlapMode, zeroDatumConfig, selectedIndices, pickFromPool, transitionToPlacingOrManual]);

  // Skip handler (suggesting phase)
  const handleSkip = useCallback(() => {
    if (!currentSuggestion) return;

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
  const getMapViewportCenter = useUIStore((s) => s.getMapViewportCenter);
  const closeDialog = useUIStore((s) => s.closeDialog);
  const openDialog = useUIStore((s) => s.openDialog);

  // Project sections for "From Existing" dropdown
  const projectSections = useProjectStore((s) => s.project?.sections ?? []);

  // Get target section stations for "From Existing" mode
  const fromExistingTargetSection = useMemo(() => {
    if (fromExistingSectionId == null) return null;
    return projectSections.find(s => s.id === fromExistingSectionId) ?? null;
  }, [fromExistingSectionId, projectSections]);

  const fromExistingStationCount = useMemo(() => {
    if (!fromExistingTargetSection) return 0;
    return fromExistingTargetSection.shots.filter(s => !s.is_reference).length + 1;
  }, [fromExistingTargetSection]);

  // Compute segment preview for manual_placing
  const segmentPreviewSections = useMemo(() => {
    if (!currentSegment) return null;
    const layout = computeSegmentLayout(currentSegment, connections, dmpFile.sections);
    return layout.map((entry) => {
      const section = dmpFile.sections[entry.sectionIndex];
      if (!section) return null;
      const colorIdx = entry.sectionIndex % SECTION_COLORS.length;
      return {
        section,
        color: SECTION_COLORS[colorIdx] ?? '#95a5a6',
        sectionIndex: entry.sectionIndex,
        offsetX: entry.offsetX,
        offsetY: entry.offsetY,
      };
    }).filter((x): x is NonNullable<typeof x> => x !== null);
  }, [currentSegment, connections, dmpFile.sections]);

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
      setSegmentAnchor({ sectionIndex: firstSegment[0]!, stationIndex: 0 });
      const hasSuggestion = firstSegment.some(idx => skippedSuggestionsRef.current.has(idx));
      setSegmentPlacementMode(hasSuggestion ? 'suggestion' : 'origin');
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
    } else if (segmentPlacementMode === 'origin') {
      const viewportCenter = getMapViewportCenter();
      placement = {
        type: 'manual',
        align_station_index: segmentAnchor.stationIndex,
        offset: { x: viewportCenter.x, y: viewportCenter.y, z: 0 },
      };
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
  }, [currentSegment, segmentAnchor, segmentPlacementMode, segmentSkippedSuggestion, fromExistingSectionId, fromExistingStationIdx, getMapViewportCenter, advanceSegmentQueue]);

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
      setSegmentAnchor({ sectionIndex: nextSeg[0]!, stationIndex: 0 });
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
      setSegmentAnchor({ sectionIndex, stationIndex });
    } else if (currentSegment && currentSegment.length > 0) {
      setSegmentAnchor({ sectionIndex: currentSegment[0]!, stationIndex });
    }
  }, [currentSegment]);

  // Manual map placement for a segment
  const handleStartSegmentPlacement = useCallback(() => {
    if (!currentSegment || !segmentAnchor) return;

    // Build SectionData for anchor section
    const anchorDmpSection = dmpFile.sections[segmentAnchor.sectionIndex];
    if (!anchorDmpSection) return;

    const edits = sectionEditsRef.current.get(segmentAnchor.sectionIndex);
    const shots: ShotData[] = edits
      ? edits.shots.filter(s => !s.isDeleted).map(editableShotToShotData)
      : convertToEditableShots(anchorDmpSection.shots).map(editableShotToShotData);

    const colorIdx = segmentAnchor.sectionIndex % SECTION_COLORS.length;
    const sectionData = {
      name: edits?.name ?? anchorDmpSection.name,
      surveyor: edits?.surveyor ?? selectionConfig.defaultSurveyor ?? null,
      date: edits?.date ?? selectionConfig.defaultDate ?? anchorDmpSection.date?.split(/[T ]/)[0] ?? null,
      color: edits?.color ?? SECTION_COLORS[colorIdx] ?? '#4ecdc4',
      direction: edits?.direction ?? anchorDmpSection.direction,
      quality: edits?.quality ?? 1.0,
      shots,
    };

    // Build additional sections for segment shadow
    const layout = computeSegmentLayout(currentSegment, connections, dmpFile.sections);
    const additionalSections = layout
      .filter(entry => entry.sectionIndex !== segmentAnchor.sectionIndex)
      .map(entry => {
        const sec = dmpFile.sections[entry.sectionIndex];
        if (!sec) return null;
        const secColorIdx = entry.sectionIndex % SECTION_COLORS.length;
        const secShots = convertToEditableShots(sec.shots).map(editableShotToShotData);
        return {
          sectionData: {
            name: sec.name,
            surveyor: null,
            date: null,
            color: SECTION_COLORS[secColorIdx] ?? '#95a5a6',
            direction: sec.direction,
            quality: 1.0,
            shots: secShots,
          },
          color: SECTION_COLORS[secColorIdx] ?? '#95a5a6',
          offsetX: entry.offsetX,
          offsetY: entry.offsetY,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    // Serialize current state for restore after placement
    const savedState: SavedManualPlacingState = {
      connections: connectionsRef.current,
      skippedIndices: Array.from(skippedIndicesRef.current),
      segmentQueue: segmentQueue,
      segmentAnchor: segmentAnchor,
      directPlacements: [...directPlacementsRef.current],
      skippedSuggestions: Array.from(skippedSuggestionsRef.current.entries()),
      segmentSkipCounts: Array.from(segmentSkipCountRef.current.entries()),
      sectionEdits: Array.from(sectionEditsRef.current.entries()),
    };

    // Reopen data (same as what App.tsx passes)
    const reopenData = {
      dmpFile,
      filePath: (useUIStore.getState().dialogData as Record<string, unknown>).filePath,
      selectionConfig,
      zeroDatumConfig,
    };

    startPlacementMode(
      sectionData,
      segmentAnchor.stationIndex,
      // onComplete — advance queue and reopen dialog
      (result: PlacementResult) => {
        let placement: ImportPlacement;
        if (result.snappedToStation) {
          placement = {
            type: 'manual_snap',
            align_station_index: segmentAnchor.stationIndex,
            snapped_to_station: result.snappedToStation,
          };
        } else {
          placement = {
            type: 'manual',
            align_station_index: segmentAnchor.stationIndex,
            offset: result.position,
          };
        }

        const dp: DirectPlacement = {
          anchorSectionIndex: segmentAnchor.sectionIndex,
          anchorStationIndex: segmentAnchor.stationIndex,
          placement,
        };

        // Advance queue for restored state
        const nextQueue = savedState.segmentQueue.slice(1);
        const nextAnchor = nextQueue[0]
          ? { sectionIndex: nextQueue[0][0]!, stationIndex: 0 }
          : savedState.segmentAnchor;

        openDialog('dmp-import-new', {
          ...reopenData,
          savedManualPlacingState: {
            ...savedState,
            segmentQueue: nextQueue,
            segmentAnchor: nextAnchor,
            directPlacements: [...savedState.directPlacements, dp],
          },
        });
      },
      // onCancel — reopen dialog with original state
      () => {
        openDialog('dmp-import-new', {
          ...reopenData,
          savedManualPlacingState: savedState,
        });
      },
      additionalSections.length > 0 ? additionalSections : undefined,
    );

    // Close dialog so user can interact with the map
    closeDialog();
  }, [currentSegment, segmentAnchor, dmpFile, selectionConfig, connections, segmentQueue, zeroDatumConfig, startPlacementMode, closeDialog, openDialog]);

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
    if (segmentPlacementMode === 'origin') return true;
    if (segmentPlacementMode === 'fromExisting') return fromExistingSectionId != null;
    if (segmentPlacementMode === 'manual') return false; // must use "Place on Map" button
    return false;
  }, [segmentAnchor, segmentPlacementMode, segmentSkippedSuggestion, fromExistingSectionId]);

  return (
    <DialogWrapper
      title={t('dialogs.dmpNewImport.title')}
      onClose={handleCancel}
      fixedSize={{ width: 'min(1000px, 95vw)', height: 'min(700px, 90vh)' }}
      overflow="hidden"
      bodyClassName="flex-1 flex flex-col p-0 min-h-0"
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
            <div className="shrink-0 flex flex-col items-center p-4 border-r border-border" style={{ width: 380 }}>
              <SectionPreview
                section={importPreviewSection}
                color={importColor}
                size={340}
                mergePreview={previewMergeConfig}
                dmpMergePreview={previewDmpMergeConfig}
                focusStationIndex={selectedMergePair?.importStation ?? currentSuggestion!.importStationIndex}
                referenceIndices={referenceIndices}
                contextSections={mergedContextSections}
              />
            </div>

            {/* Right column: connection details */}
            <div className="flex-1 min-w-0 overflow-y-auto p-5 space-y-4" data-testid="wizard-suggestion">
              {/* Connection description */}
              <div data-testid="wizard-connection-description">
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

              {/* Merge station dropdown */}
              {mergeOptions.length > 1 && (
                <div className="flex items-center gap-2" data-testid="merge-station-picker">
                  <label className="text-xs text-text-secondary whitespace-nowrap">
                    {t('dialogs.dmpNewImport.mergeStation')}
                  </label>
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
                </div>
              )}

              {/* Overlap mode picker */}
              {currentSuggestion && currentSuggestion.matchedShots > 0 && (
                <div className="flex items-center gap-2" data-testid="overlap-mode-picker">
                  <label className="text-xs text-text-secondary whitespace-nowrap">
                    {t('dialogs.dmpNewImport.overlapMode')}
                  </label>
                  <select
                    value={overlapMode}
                    onChange={(e) => handleOverlapModeChange(e.target.value as OverlapMode)}
                    className="px-2 py-1 bg-background border border-border rounded text-xs"
                    data-testid="overlap-mode-select"
                  >
                    <option value="interpolate">{t('dialogs.dmpNewImport.overlapMode_interpolate')}</option>
                    <option value="import_data">{t('dialogs.dmpNewImport.overlapMode_importData')}</option>
                    <option value="existing_data">{t('dialogs.dmpNewImport.overlapMode_existingData')}</option>
                    <option value="keep_both">{t('dialogs.dmpNewImport.overlapMode_keepBoth')}</option>
                  </select>
                </div>
              )}

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

              {/* Prompt */}
              <div className="text-sm font-medium">
                {t('dialogs.dmpNewImport.doesThisLookRight')}
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
                    showDirection
                    showQuality
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
                </>
              )}
            </div>
          </div>
        ) : showManualPlacing ? (
          <div className="flex-1 flex min-h-0 overflow-hidden relative">
            {/* Left column: Segment Preview */}
            <div className="shrink-0 flex flex-col items-center p-4 border-r border-border" style={{ width: 380 }}>
              <SectionPreview
                segmentSections={segmentPreviewSections}
                size={340}
                onStationClick={handleSegmentStationClick}
                selectedStationIndex={segmentAnchor?.stationIndex ?? null}
                selectedSectionIndex={segmentAnchor?.sectionIndex ?? null}
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

              {/* Anchor station display */}
              <div className="text-xs text-text-secondary">
                {segmentAnchor ? (
                  t('dialogs.dmpNewImport.manualPlacing.anchorStation', {
                    section: dmpFile.sections[segmentAnchor.sectionIndex]?.name ?? `Section ${segmentAnchor.sectionIndex}`,
                    station: segmentAnchor.stationIndex,
                  })
                ) : (
                  t('dialogs.dmpNewImport.manualPlacing.selectAnchor')
                )}
              </div>

              {/* Placement mode radio group */}
              <div className="space-y-2">
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

                {/* Origin */}
                <label className="flex items-start gap-2 p-2 rounded border border-border hover:bg-accent-5 cursor-pointer">
                  <input
                    type="radio"
                    name="segmentPlacementMode"
                    checked={segmentPlacementMode === 'origin'}
                    onChange={() => setSegmentPlacementMode('origin')}
                    className="mt-0.5"
                  />
                  <div className="text-sm">{t('dialogs.dmpNewImport.manualPlacing.origin')}</div>
                </label>

                {/* From existing station */}
                <label className="flex items-start gap-2 p-2 rounded border border-border hover:bg-accent-5 cursor-pointer">
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
                        {projectSections.length > 0 ? (
                          <>
                            <div className="flex items-center gap-2">
                              <label className="text-xs text-text-secondary whitespace-nowrap">
                                {t('dialogs.dmpNewImport.manualPlacing.targetSection')}
                              </label>
                              <select
                                value={fromExistingSectionId ?? ''}
                                onChange={(e) => {
                                  const val = e.target.value ? Number(e.target.value) : null;
                                  setFromExistingSectionId(val);
                                  setFromExistingStationIdx(0);
                                }}
                                className="px-2 py-1 bg-background border border-border rounded text-xs flex-1"
                                data-testid="from-existing-section-select"
                              >
                                <option value="">—</option>
                                {projectSections.map((s) => (
                                  <option key={s.id} value={s.id}>{s.name}</option>
                                ))}
                              </select>
                            </div>
                            {fromExistingSectionId != null && (
                              <div className="flex items-center gap-2">
                                <label className="text-xs text-text-secondary whitespace-nowrap">
                                  {t('dialogs.dmpNewImport.manualPlacing.targetStation')}
                                </label>
                                <select
                                  value={fromExistingStationIdx}
                                  onChange={(e) => setFromExistingStationIdx(Number(e.target.value))}
                                  className="px-2 py-1 bg-background border border-border rounded text-xs flex-1"
                                  data-testid="from-existing-station-select"
                                >
                                  {Array.from({ length: fromExistingStationCount }, (_, i) => (
                                    <option key={i} value={i}>Station {i}</option>
                                  ))}
                                </select>
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
                <label className="flex items-start gap-2 p-2 rounded border border-border hover:bg-accent-5 cursor-pointer">
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
                      <div className="mt-2">
                        <Button
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
              </div>

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

            {/* No suggestions — show done phase briefly before handoff */}
            {phase === 'suggesting' && !isCalculating && !currentSuggestion && (
              <div className="text-center" data-testid="wizard-no-suggestions">
                <div className="text-lg mb-2">{t('dialogs.dmpNewImport.noSuggestions')}</div>
                {selectedIndices.filter((idx) => !connectedIndices.has(idx)).length > 0 && (
                  <div className="text-sm text-text-secondary">
                    {t('dialogs.dmpNewImport.handoffMessage', {
                      count: selectedIndices.filter((idx) => !connectedIndices.has(idx)).length,
                    })}
                  </div>
                )}
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
            <Button onClick={handleCancel} data-testid="cancel-button">
              {t('common.actions.cancel')}
            </Button>
            <Button onClick={handleBack} data-testid="back-button">
              {t('common.actions.back')}
            </Button>
          </div>
          <div className="flex gap-2">
            {phase === 'suggesting' && !isCalculating && currentSuggestion && (
              <>
                <Button
                  onClick={handleSkip}
                  disabled={isImporting}
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
                  {t('dialogs.dmpNewImport.manualPlacing.placeSegment')}
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
            <Button onClick={() => setShowCancelConfirm(false)}>
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
            <Button onClick={() => setShowBackConfirm(false)}>
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
