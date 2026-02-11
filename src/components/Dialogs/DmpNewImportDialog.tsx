import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '../common/Button';
import { CheckCircleIcon } from '../common/icons';
import type { DmpFile, DmpShot, CrossSectionSuggestion, ImportSectionForSuggestion, CommandResult } from '../../types/commands';
import type { DmpSelectionConfig } from './DmpSelectionDialog';
import type { Project, Station, ShotData } from '../../types/project';
import type { ImportSectionConfig as BackendImportSectionConfig, ImportPlacement } from '../../types/commands';
import type { ZeroDatumConfigResult } from './ZeroDatumConfigDialog';
import type { DmpSection } from '../../types/commands';
import type { OverlapMode } from '../../types/config';
import SectionPreview, { type MergePreviewConfig, type DmpMergePreviewConfig } from './SectionPreview';
import { DialogWrapper } from './DialogWrapper';
import { AlertDialog } from './AlertDialog';
import { SectionMetadataForm } from '../common/SectionMetadataForm';
import { ShotTableEditor, type EditableShot } from '../common/ShotTableEditor';
import { useProjectStore } from '../../store/projectStore';
import { convertToEditableShots } from '../../hooks/useImportState';
import { editableShotToShotData } from '../../utils/shotConversion';
import { circularMeanDegrees } from '../../utils/angles';

const SECTION_COLORS = [
  '#4ecdc4', '#ff6b6b', '#95a5a6', '#3498db',
  '#9b59b6', '#1abc9c', '#e67e22', '#f39c12',
];

/** A virtual connection recorded by the user — no backend import yet. */
type VirtualConnection = {
  importSectionIndex: number;
  importStationIndex: number;
  targetType: 'existing' | 'importing';
  existingSectionId?: number;
  existingStationIndex?: number;
  targetImportIndex?: number;
  targetImportStationIndex?: number;
};

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
}

// ─── Merge station helpers ────────────────────────────────────────────────────

interface MergeOption {
  offset: number;
  importStation: number;
  existingStation: number;
}

function computeMergeOptions(suggestion: CrossSectionSuggestion, importShotCount: number): MergeOption[] {
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

/** Build adjacency map from virtual connections. */
function buildAdjacency(
  connections: VirtualConnection[],
): Map<number, Array<{ neighbor: number; connection: VirtualConnection }>> {
  const adj = new Map<number, Array<{ neighbor: number; connection: VirtualConnection }>>();
  const ensure = (k: number) => { if (!adj.has(k)) adj.set(k, []); };

  for (const c of connections) {
    ensure(c.importSectionIndex);
    if (c.targetType === 'importing' && c.targetImportIndex != null) {
      ensure(c.targetImportIndex);
      adj.get(c.importSectionIndex)!.push({ neighbor: c.targetImportIndex, connection: c });
      adj.get(c.targetImportIndex)!.push({ neighbor: c.importSectionIndex, connection: c });
    }
    // 'existing' connections anchor this node to the project graph — no import neighbor
  }
  return adj;
}

/** Build batch import configs from virtual connections + BFS order. */
function buildBatchImport(
  connections: VirtualConnection[],
  zeroDatumIndex: number | null,
  dmpFile: DmpFile,
  selectionConfig: DmpSelectionConfig,
  sectionEdits?: Map<number, SectionEditState>,
): { configs: BackendImportSectionConfig[]; unreachable: number[] } {
  const adjacency = buildAdjacency(connections);

  // Sections connected to existing project sections (anchors)
  const anchored = new Set<number>();
  if (zeroDatumIndex != null) anchored.add(zeroDatumIndex);
  for (const c of connections) {
    if (c.targetType === 'existing') {
      anchored.add(c.importSectionIndex);
    }
  }

  // BFS from anchored sections
  const reachableOrder = bfsReachable(anchored, adjacency);
  const reachableSet = new Set(reachableOrder);

  // Track which sections are already emitted (by section_index) and their position in configs[]
  const emittedPosition = new Map<number, number>();

  const configs: BackendImportSectionConfig[] = [];
  let colorIdx = 0;

  for (const idx of reachableOrder) {
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

    // Find the connection that placed this section
    const conn = connections.find((c) => c.importSectionIndex === idx);
    if (!conn) continue;

    let placement: ImportPlacement;
    if (conn.targetType === 'existing' && conn.existingSectionId != null && conn.existingStationIndex != null) {
      placement = {
        type: 'from_existing',
        import_station: conn.importStationIndex,
        existing_station: {
          section_id: conn.existingSectionId,
          station_index: conn.existingStationIndex,
        },
      };
    } else if (conn.targetType === 'importing' && conn.targetImportIndex != null && conn.targetImportStationIndex != null) {
      // The target must already be emitted in configs[]
      const targetPos = emittedPosition.get(conn.targetImportIndex);
      if (targetPos == null) {
        // Target not yet placed — shouldn't happen with BFS order, but skip gracefully
        continue;
      }
      placement = {
        type: 'from_importing',
        import_station: conn.importStationIndex,
        target_section_index: targetPos,
        target_station_index: conn.targetImportStationIndex,
      };
    } else {
      continue;
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

  // Unreachable = connected sections not in reachableSet + sections with no connection at all
  const allSelected = Array.from(selectionConfig.selectedIndices);
  const unreachable = allSelected.filter(
    (idx) => idx !== zeroDatumIndex && !reachableSet.has(idx),
  );

  return { configs, unreachable };
}

// ─── Overlap mode helpers ─────────────────────────────────────────────────────

/** Average two nullable numbers; returns null if both are null. */
function avgNullable(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  if (a == null) return b;
  if (b == null) return a;
  return (a + b) / 2;
}

/** A shot-like shape from a target section (existing project or another import). */
interface TargetShotLike {
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

/** Replace an editable shot's measurement values with target data. */
function applyTargetData(shot: EditableShot, target: TargetShotLike): EditableShot {
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
function interpolateShots(importShot: EditableShot, target: TargetShotLike): EditableShot {
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
}: DmpNewImportDialogProps) {
  const { t } = useTranslation();

  // Store selectors
  const importSections = useProjectStore((s) => s.importSections);
  const refreshProjectState = useProjectStore((s) => s.refreshProjectState);
  const config = useProjectStore((s) => s.config);
  const updateConfig = useProjectStore((s) => s.updateConfig);

  // Core state — virtual connections instead of imported indices
  const [connections, setConnections] = useState<VirtualConnection[]>([]);
  const [skippedIndices, setSkippedIndices] = useState<Set<number>>(new Set());
  const [currentSuggestion, setCurrentSuggestion] = useState<CrossSectionSuggestion | null>(null);
  const [alternatives, setAlternatives] = useState<CrossSectionSuggestion[]>([]);
  const [showAlternatives, setShowAlternatives] = useState(true);
  const [isCalculating, setIsCalculating] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [phase, setPhase] = useState<'init' | 'suggesting' | 'placing' | 'done'>('init');
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showBackConfirm, setShowBackConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Merge station selection
  const [selectedMergeOffset, setSelectedMergeOffset] = useState(0);

  // Overlap handling mode (persisted to config)
  const [overlapMode, setOverlapMode] = useState<OverlapMode>(
    config?.import?.overlap_mode ?? 'import_data'
  );

  // Section editing state
  const [editState, setEditState] = useState<SectionEditState | null>(null);
  const sectionEditsRef = useRef<Map<number, SectionEditState>>(new Map());
  const nextTempIdRef = useRef(1);

  // Cache all cross-section suggestions from startup calculation
  const suggestionPoolRef = useRef<CrossSectionSuggestion[]>([]);

  // Guard against React StrictMode double-firing the mount effect
  const importStartedRef = useRef(false);

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
    // Compute original shot IDs in the overlap
    const frozenIds = new Set<number>();
    if (importStationIndex === 0) {
      // Forward from station 0: shots 0..matchedShots-1
      for (let i = 0; i < matchedShots; i++) frozenIds.add(i);
    } else {
      // Backward from end: shots (importStationIndex-matchedShots)..(importStationIndex-1)
      for (let i = importStationIndex - matchedShots; i < importStationIndex; i++) {
        if (i >= 0) frozenIds.add(i);
      }
    }

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

    // Compute all overlap shot IDs (same logic as frozenShotIndices)
    const allOverlapIds = new Set<number>();
    if (importStationIndex === 0) {
      for (let i = 0; i < matchedShots; i++) allOverlapIds.add(i);
    } else {
      for (let i = importStationIndex - matchedShots; i < importStationIndex; i++) {
        if (i >= 0) allOverlapIds.add(i);
      }
    }

    // Actionable = overlap shots up to (but not past) merge station
    const actionableIds = new Set<number>();
    if (importStationIndex === 0) {
      // Forward: shots 0..mergeImportStation-1 are actionable
      for (let i = 0; i < mergeImportStation; i++) {
        if (allOverlapIds.has(i)) actionableIds.add(i);
      }
    } else {
      // Backward: shots mergeImportStation..(importStationIndex-1) are actionable
      for (let i = mergeImportStation; i < importStationIndex; i++) {
        if (allOverlapIds.has(i)) actionableIds.add(i);
      }
    }

    // Get target shots for data replacement
    let targetShots: TargetShotLike[] | null = null;
    if (overlapMode !== 'import_data' && overlapMode !== 'keep_both') {
      const { targetType, existingSectionId, targetImportIndex, existingStationIndex } = currentSuggestion;
      const mergeExistingStation = selectedMergePair?.existingStation ?? existingStationIndex;

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

      // Build a mapping: import overlap shot ID → target shot
      if (targetShots) {
        const targetMap = new Map<number, TargetShotLike>();
        for (const overlapId of allOverlapIds) {
          let targetIdx: number;
          if (importStationIndex === 0) {
            // Forward: import shot k → target shot mergeExistingStation + k (or - k for reverse)
            targetIdx = direction === 'forward'
              ? mergeExistingStation + overlapId
              : mergeExistingStation - 1 - overlapId;
          } else {
            // Backward: import shot offset from overlap start
            const overlapStart = importStationIndex - matchedShots;
            const k = overlapId - overlapStart;
            targetIdx = direction === 'forward'
              ? (mergeExistingStation - matchedShots) + k
              : (mergeExistingStation + matchedShots) - 1 - k;
          }
          if (targetIdx >= 0 && targetIdx < targetShots.length) {
            targetMap.set(overlapId, targetShots[targetIdx]!);
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
          // Past merge station: delete (redundant when using target data)
          return { ...shot, isDeleted: true };
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
        return { ...shot, isDeleted: true };
      }
      return shot;
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

    // Filter pool to only remaining sections
    const pool = suggestionPoolRef.current.filter(
      (s) => !connected.has(s.importSectionIndex) && !skipped.has(s.importSectionIndex)
    );
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
      } catch {
        // Suggestion failure is non-fatal
        suggestionPoolRef.current = [];
      }

      setIsCalculating(false);

      if (!pickFromPool()) {
        // No suggestions at all — go straight to placing
        setPhase('placing');
        return;
      }

      setPhase('suggesting');
    };

    init();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  }, [phase]);

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

    // Save edit state with effectiveShots applied to ref before moving on
    if (editState) {
      sectionEditsRef.current.set(currentSuggestion.importSectionIndex, { ...editState, shots: effectiveShots });
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
      // All handled — transition to placing
      setPhase('placing');
      return;
    }

    // Pick next from pool
    if (!pickFromPool()) {
      // Pool exhausted — transition to placing with whatever we have
      setPhase('placing');
    }
  }, [currentSuggestion, selectedMergePair, editState, effectiveShots, zeroDatumConfig, selectedIndices, pickFromPool]);

  // Skip handler
  const handleSkip = useCallback(() => {
    if (!currentSuggestion) return;

    const skippedIdx = currentSuggestion.importSectionIndex;
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
      setPhase('placing');
      return;
    }

    if (!pickFromPool()) {
      setPhase('placing');
    }
  }, [currentSuggestion, zeroDatumConfig, selectedIndices, pickFromPool]);

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

  // Progress
  const placedCount = connectedIndices.size + (zeroDatumConfig ? 1 : 0);
  const skippedCount = skippedIndices.size;

  // Whether we're in the suggestion view with a current suggestion (side-by-side layout)
  const showSideBySide = phase === 'suggesting' && !isCalculating && currentSuggestion != null;

  // Target type label for import-to-import connections
  const isImportTarget = currentSuggestion?.targetType === 'importing';

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
                mergePreview={mergePreviewConfig}
                dmpMergePreview={dmpMergePreviewConfig}
                focusStationIndex={selectedMergePair?.importStation ?? currentSuggestion!.importStationIndex}
                referenceIndices={referenceIndices}
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

            {/* Placing — batch import in progress */}
            {phase === 'placing' && isImporting && (
              <div className="text-center" data-testid="wizard-placing">
                <div className="text-lg mb-2">{t('dialogs.dmpNewImport.placing', { count: connectedIndices.size })}</div>
                <div className="animate-pulse text-text-secondary">...</div>
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
            {phase === 'done' && connectedIndices.size + (zeroDatumConfig ? 1 : 0) === totalSelected && (
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
