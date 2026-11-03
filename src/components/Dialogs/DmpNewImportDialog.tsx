import { usePreviewSize } from './usePreviewSize';
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useLatest } from '../../hooks/useLatest';
import { useLiveShots } from './dmpWizard/useLiveShots';
import { useTranslation } from 'react-i18next';
import { invokeIpc, getErrorMessage } from '../../utils/ipc';
import { Button } from '../common/Button';
import { CheckCircleIcon } from '../common/icons';
import type { DmpFile, CrossSectionSuggestion, ImportSectionForSuggestion } from '../../types/commands';
import type { DmpSelectionConfig } from './DmpSelectionDialog';
import type { Project, Station, ShotData } from '../../types/project';
import type { ImportPlacement } from '../../types/commands';
import type { ZeroDatumConfigResult } from './ZeroDatumConfigDialog';
import type { DmpSection } from '../../types/commands';
import type { OverlapMode } from '../../types/config';
import { WizardMapPanel } from './WizardMapPanel';
// The preview-square cap comes straight from layoutConstants rather than
// through WizardMapPanel's re-export: two component tests mock that module, and
// a mocked module cannot supply a plain number the render arithmetic needs.
import { WIZARD_MAP_PANEL_MAX_WIDTH as MAP_PANEL_MAX_WIDTH } from '../SingleSystemView/layoutConstants';
import { WizardScrollBody } from './WizardScrollBody';
import SectionPreview, { type MergePreviewConfig, type DmpMergePreviewConfig, type ContextSectionGeometry, computeStationsFromDmpShots, computeStationsFromShots } from './SectionPreview';
import { Select } from '../common/Select';
import { DialogWrapper } from './DialogWrapper';
import { AlertDialog } from './AlertDialog';
import { SectionMetadataForm } from '../common/SectionMetadataForm';
import { SuggestionSectionSettings } from './SuggestionSectionSettings';
import { SegmentPlacementModes, type SegmentPlacementMode } from './SegmentPlacementModes';
import { buildZeroDatumSectionConfig, DMP_AZIMUTH_REFERENCE } from '../../utils/importSectionConfig';
import { ShotTableEditor, type EditableShot } from '../common/ShotTableEditor';
import { useProjectStore } from '../../store/projectStore';
import { convertToEditableShots, editableShotToShotData, editableShotsToDmpSection } from '../../utils/shotConversion';
import {
  computeMergeOptions,
  defaultMergeOffset,
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
  type VirtualConnection,
  type ExistingSectionGeoEntry,
  computeDmpBfsContext,
  stationPositionFromShotLines,
  discoverBridgedDmpSections,
  computeUnreachableSegments,
  computeSegmentLayout,
} from '../../utils/segmentContext';
import { azimuthReferenceFor } from '../../utils/stationWalk';
import { buildFromExistingContext } from './dmpWizard/fromExistingContext';
import { sectionColorPalette } from '../../utils/colors';
import { debugLog } from '../../utils/debugLog';
import { useUIStore, type PlacementResult } from '../../store/uiStore';
import { setSource, trackDialogComplete } from '../../utils/telemetry';
import {
  buildPlacementSectionData,
  redirectDeletedTargets,
  type SectionEditState,
  type ConfirmedOverlapInfo,
} from '../../utils/batchImportHelpers';
import {
  collectExistingAnchorsForTemporalRerank,
  distanceMapFromField,
  rerankSuggestionsByTemporalPlan,
} from '../../utils/dmpTemporalRerank';
import {
  fromEmittedStationIndex,
  isEmittedShot,
  toEmittedStationIndex,
  visibleBefore,
  visibleShotCount,
} from '../common/emittedShots';
import { applyAllOverlapTreatments } from '../../utils/overlapTreatment';
import { findIncompleteSections } from '../../utils/importPayloadGuard';
import { reanchorAfterRunDelete, reanchorStation } from '../../utils/stationReanchor';
import { blankEditableShot } from '../common/editableShot';
import type { ImportReceipt } from '../../types/ipc/ImportReceipt';
import { TOAST_KEYS } from '../../utils/toastKeys';
import { useDmpImportRun } from './dmpWizard/useDmpImportRun';
import { buildBatchImport } from './dmpWizard/buildBatchImport';
import { adjustConnectionsForEdits, buildEffectiveDmpSection } from './dmpWizard/effectiveSections';
import {
  normalizeSkippedSuggestionEntry,
  type DirectPlacement,
  type SavedManualPlacingState,
  type SkippedSuggestionPlacement,
} from './dmpWizard/wizardTypes';

interface DmpNewImportDialogProps {
  dmpFile: DmpFile;
  selectionConfig: DmpSelectionConfig;
  project: Project | null;
  stations: Station[];
  zeroDatumConfig?: ZeroDatumConfigResult | undefined;
  onCancel: () => void;
  onBack: () => void;
  onComplete: (newSectionIds?: number[], receipt?: ImportReceipt) => void;
  /** Saved state to restore after returning from manual map placement. */
  savedManualPlacingState?: SavedManualPlacingState | undefined;
  /** If true, immediately start map placement when the dialog opens in manual placing phase. */
  autoStartManualPlacement?: boolean;
}

// Moved to dmpWizard/ (#576 D4) and re-exported here, where App.tsx, the
// placement modes and the tests have always imported them from.
export type { DirectPlacement, SkippedSuggestionPlacement, SavedManualPlacingState };
export { buildBatchImport };

/**
 * Connection Wizard - pre-calculates all placements at startup, presents
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

  // Responsive preview - fills the available column so it never overflows the
  // fullscreen dialog on short windows (#93 review) and never leaves the column
  // half empty on wide ones (#567). One per flow.
  // The map column's width, dragged by the divider between it and the settings.
  // One value for both side-by-side blocks (suggestion and manual placing), so
  // the wizard does not change shape as it steps between them - and store-owned
  // since #404, so it also survives the dialog closing and the session ending
  // (WizardMapPanel persists it on divider release).
  const mapPanelWidth = useUIStore((s) => s.wizardMapPanelWidth);
  const setMapPanelWidth = useUIStore((s) => s.setWizardMapPanelWidth);
  const suggestionBodyRef = useRef<HTMLDivElement | null>(null);
  const manualBodyRef = useRef<HTMLDivElement | null>(null);
  const [suggestionPreviewRef, suggestionPreviewSize] = usePreviewSize(MAP_PANEL_MAX_WIDTH);
  const [manualPreviewRef, manualPreviewSize] = usePreviewSize(MAP_PANEL_MAX_WIDTH);

  // Store selectors
  const config = useProjectStore((s) => s.config);
  const patchConfig = useProjectStore((s) => s.patchConfig);
  const resolvedTheme = useUIStore((s) => s.resolvedTheme);
  // #357 item 9: seed new sections from the palette legible on this theme's
  // MAP CANVAS, not its chrome - a section keeps whatever color it was
  // created with, so this only ever affects colors handed to NEW sections.
  const sectionPalette = useMemo(() => sectionColorPalette(resolvedTheme), [resolvedTheme]);

  // Shorthand for restoring state
  const saved = savedManualPlacingState;

  // The run: its imports, what they banked, the withdrawal, and the failure of
  // whichever step failed last (#576 D4).
  const {
    isImporting,
    failure,
    fail,
    clearFailure,
    importAnchor,
    importBatch,
    importSegment,
    withdrawImportedSections,
    withdrawInFlight,
    withdrawalFailure,
    clearWithdrawalFailure,
    importedCount,
    completion,
    carry,
    earlyImported,
  } = useDmpImportRun({ dmpFile, selectionConfig, carried: saved, importsOnMount: saved?.placedSegment != null });

  // Core state - virtual connections instead of imported indices
  const [connections, setConnections] = useState<VirtualConnection[]>(saved?.connections ?? []);
  const [skippedIndices, setSkippedIndices] = useState<Set<number>>(
    saved ? new Set(saved.skippedIndices) : new Set()
  );
  const [currentSuggestion, setCurrentSuggestion] = useState<CrossSectionSuggestion | null>(null);
  const [alternatives, setAlternatives] = useState<CrossSectionSuggestion[]>([]);
  const [showAlternatives, setShowAlternatives] = useState(true);
  const [isCalculating, setIsCalculating] = useState(false);
  const [phase, setPhase] = useState<'init' | 'suggesting' | 'manual_placing' | 'placing' | 'done'>(
    saved ? 'manual_placing' : 'init'
  );
  const [autoStartManualPlacementPending, setAutoStartManualPlacementPending] = useState(
    autoStartManualPlacement
  );
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showBackConfirm, setShowBackConfirm] = useState(false);
  const error = failure?.message ?? null;
  // F8: registers this dialog's footer height with the toast stack for as long
  // as the footer is mounted, so a lingering toast (e.g. the manual-placement
  // hint, which fires just before this dialog closes and can still be on
  // screen when it reopens) is raised above the footer instead of covering
  // the Cancel/Back row.
  const footerRef = useRef<HTMLDivElement | null>(null);
  const registerToastBottomOffset = useUIStore((s) => s.registerToastBottomOffset);
  const unregisterToastBottomOffset = useUIStore((s) => s.unregisterToastBottomOffset);
  useEffect(() => {
    const el = footerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const owner = 'dmp-import-new-footer';
    const report = () => registerToastBottomOffset(owner, el.getBoundingClientRect().height);
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();
    return () => {
      ro.disconnect();
      unregisterToastBottomOffset(owner);
    };
  }, [registerToastBottomOffset, unregisterToastBottomOffset]);
  const [placingRetry, setPlacingRetry] = useState(0);

  // Merge station selection
  const [selectedMergeOffset, setSelectedMergeOffset] = useState(0);

  // Overlap handling mode (persisted to config)
  const [overlapMode, setOverlapMode] = useState<OverlapMode>(
    config?.import?.overlap_mode ?? 'import_data'
  );

  // Section editing state
  const [editState, setEditState] = useState<SectionEditState | null>(null);
  /** The live edit state and rows, for actions that must not read a captured
   *  copy - see refuseIncompleteShots and applyShotEdit. */
  const { editStateRef, currentShots, stageShots } = useLiveShots(editState);
  // Tracks which import section index the current editState was loaded for.
  // Used to prevent the sync effect from writing stale editState to the wrong section
  // when currentSuggestion changes before editState catches up.
  const [editStateForSection, setEditStateForSection] = useState<number | null>(null);
  /** Which section `editStateRef` currently holds, as a ref: the gate below has
   *  to pair the two, and a captured pairing is the stale-closure bug again. */
  const editStateForSectionRef = useLatest<number | null>(editStateForSection);
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
  const temporalDistanceCacheRef = useRef<Map<string, number>>(new Map());
  const temporalDistanceFetchedOriginsRef = useRef<Set<string>>(new Set());

  // ─── Manual placing phase state ────────────────────────────────────────────
  const [segmentQueue, setSegmentQueue] = useState<number[][]>(saved?.segmentQueue ?? []);
  const currentSegment = segmentQueue[0] ?? null;

  const [segmentPlacementMode, setSegmentPlacementMode] = useState<SegmentPlacementMode>('manual');
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

  // Same for station dropdown hover - reads current section from ref.
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

  // ─── The anchor's two station spaces ──────────────────────────────────────
  //
  // The pick is STORED in visible row space: that is what the station dropdowns
  // list, what the map preview's own click handler talks in once translated, and
  // the space the shot-table mutators re-anchor it in. Two surfaces speak
  // emitted space instead - the payloads, which carry only the rows the import
  // will create, and the previews, which draw those same rows - so each converts
  // at its edge rather than storing a second number that can drift.

  /** The anchor station as the BACKEND counts it. One derivation for every
   *  payload site: the two that shipped the raw pick merged a station
   *  downstream of the one clicked, and a pick past the emitted end made
   *  `merge_stations` refuse the whole batch. */
  const emittedAnchorStation = useCallback(
    (anchor: { sectionIndex: number; stationIndex: number }): number => {
      const edits = sectionEditsRef.current.get(anchor.sectionIndex);
      return edits ? toEmittedStationIndex(edits.shots, anchor.stationIndex) : anchor.stationIndex;
    },
    []
  );

  /** The other direction, for a station the PREVIEW drew: it renders the emitted
   *  rows, so a dot below a blank row is numbered one lower than the row the
   *  user is looking at in the grid. */
  const visibleAnchorStation = useCallback(
    (sectionIndex: number, emittedStationIndex: number): number => {
      const edits = sectionEditsRef.current.get(sectionIndex);
      return edits ? fromEmittedStationIndex(edits.shots, emittedStationIndex) : emittedStationIndex;
    },
    []
  );

  // Per-mode state for manual_placing
  const [fromExistingSectionId, setFromExistingSectionId] = useState<number | null>(null);
  const [fromExistingStationIdx, setFromExistingStationIdx] = useState<number>(0);

  // Track original suggestions for sections skipped during suggesting phase
  const skippedSuggestionsRef = useRef<Map<number, SkippedSuggestionPlacement>>(
    new Map((saved?.skippedSuggestions ?? []).map(([idx, entry]) => [idx, normalizeSkippedSuggestionEntry(entry)]))
  );

  // Accumulated direct placements for manual_placing phase
  const directPlacementsRef = useRef<DirectPlacement[]>(saved?.directPlacements ?? []);

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

  // Refs to avoid stale closures
  const connectionsRef = useLatest(connections);
  const skippedIndicesRef = useLatest(skippedIndices);

  const chooseSegmentAnchorSection = useCallback((segment: number[]): number => {
    return segment.find((idx) => skippedIndicesRef.current.has(idx)) ?? segment[0]!;
  }, [skippedIndicesRef]);

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

  // No effect resets the offset when the suggestion changes: the two places that
  // set a suggestion (`pickFromPool`, `handleAlternativeClick`) set its default
  // offset in the same batch (`computeDefaultMergeOffset`). An effect here used to
  // run after them and overwrite the backend's preferred offset with the deepest
  // one (#576 D12).

  // Check if the current suggestion targets an existing section that is doubly-anchored
  // (modified overlap shots sit between two positional constraints). When true, only
  // 'existing_data' and 'keep_both' are valid - interpolation / import_data would break
  // a closure or zero-datum constraint.
  //
  // A merge/closure is only an anchor if the partner can independently reach a zero datum
  // without going through this section.  A merge to a free-floating section is NOT a
  // positional constraint - the partner can follow via cascading offset adjustments.
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

  // Unified segment context - BFS through DMP connections + fetch existing segment geometry
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
          const result = await invokeIpc('get_segment_geometry', { sectionId: currentSuggestion.existingSectionId }, { purpose: 'fetch segment geometry for target section' });
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
            const result = await invokeIpc('get_segment_geometry', { sectionId: anchor.existingSectionId }, { purpose: 'fetch segment geometry for anchor section' });
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
          const result = await invokeIpc('get_segment_geometry', { sectionId: anchor.existingSectionId }, { purpose: 'fetch segment geometry for import-side anchor' });
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
      // Re-wrapped in the DEV guard (unlike the trivial-argument sites nearby):
      // `debugLog` itself no-ops in production, but JS evaluates a function's
      // arguments before the call, so the `.filter(...).length` scan below ran
      // on every restore in production regardless - the guard is what actually
      // skips the work, not the no-op.
      if (import.meta.env.DEV) {
        debugLog(
          `[init-effect] RESTORE section=${idx} from sectionEditsRef`,
          `shots.length=${existing.shots.length}`,
          `deleted=${existing.shots.filter(s => s.isDeleted).length}`,
        );
      }
      // The counter is per section, and only the initialize branch below used to
      // seed it: coming back to a section after editing a SHORTER one handed out
      // temp ids this section had already used, so two rows shared a key and the
      // grid painted one row's marks on the other.
      nextTempIdRef.current =
        existing.shots.reduce((max, s) => Math.max(max, s.tempId ?? 0), existing.shots.length) + 1;
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

    const shots = convertToEditableShots(section.shots, section.version);
    nextTempIdRef.current = shots.length + 1;
    debugLog(
      `[init-effect] INITIALIZE section=${idx} "${section.name}"`,
      `dmpShots=${section.shots.length} standardShots=${shots.length}`,
    );

    // Color based on position in selection order (matches zero datum dialog)
    const selectedPos = selectedIndices.indexOf(idx);
    const newState: SectionEditState = {
      name: section.name,
      surveyor: selectionConfig.defaultSurveyor || '',
      date: selectionConfig.defaultDate ?? section.date?.split(/[T ]/)[0] ?? '',
      color: sectionPalette[(selectedPos >= 0 ? selectedPos : 0) % sectionPalette.length] ?? '#4ecdc4',
      direction: section.direction === 'out' ? 'out' : 'in',
      quality: 1.0,
      reverse: false,
      shots,
    };

    sectionEditsRef.current.set(idx, newState);
    setEditStateForSection(idx);
    setEditState(newState);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- (re)initialise only when the active section changes; the other inputs are read at that moment
  }, [activeEditableSectionIndex]);

  // Keep sectionEditsRef in sync with editState changes (user edits to shots/metadata).
  // Guard: only write when editState actually belongs to the active edit section.
  // Without this guard, when the active section changes, this effect can briefly fire
  // with stale editState from the previous section before setEditState takes effect.
  useEffect(() => {
    if (!editState || activeEditableSectionIndex == null) return;
    if (editStateForSection !== activeEditableSectionIndex) {
      debugLog(
        `[sync-effect] SKIPPED stale write: editStateFor=${editStateForSection} !== active=${activeEditableSectionIndex}`,
      );
      return;
    }
    debugLog(
      `[sync-effect] WRITING sectionEditsRef[${activeEditableSectionIndex}]`,
      `editState.shots.length=${editState.shots.length}`,
    );
    sectionEditsRef.current.set(activeEditableSectionIndex, editState);
  }, [editState, activeEditableSectionIndex, editStateForSection]);

  // Compute frozen shot indices - matched overlap shots that must not be deleted
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
  // Raw editState is never mutated by overlap settings - effectiveShots is computed.
  const effectiveShots = useMemo(() => {
    if (!editState || !currentSuggestion || currentSuggestion.matchedShots === 0) {
      return editState?.shots ?? [];
    }

    const { importStationIndex, matchedShots, existingMatchedShots, direction } = currentSuggestion;
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
          // Station space - see the note on the other target-shot build.
          targetShots = targetEdits.shots.filter(isEmittedShot);
        } else {
          const targetDmpSection = dmpFile.sections[targetImportIndex];
          if (targetDmpSection) {
            targetShots = convertToEditableShots(targetDmpSection.shots, targetDmpSection.version);
          }
        }
      }

      // Build a mapping: import overlap shot ID → target shot.
      // The mapping is anchored by existingStationIndex (the suggestion's base),
      // NOT the merge-adjusted station - the merge picker only controls which
      // shots are actionable, not the overlap-to-target correspondence.
      if (targetShots) {
        const shouldReverse = needsDirectionReversal(importStationIndex, direction);
        const overlapParams = { importStationIndex, matchedShots, existingMatchedShots, existingStationIndex, direction };
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
        return { ...shot, kind: 'Reference' as const };
      }
      if (!isActionable) {
        // Past merge station: leave unchanged to keep geometry continuous in preview.
        return shot;
      }
      // import_data: keep import values as-is
      return shot;
    });
  }, [editState, currentSuggestion, selectedMergePair, overlapMode, dmpFile.sections]);

  /**
   * Rows the keep-both view DERIVES as Reference.
   *
   * Their glyph is computed, not read back from `editState`, so the kind cell on
   * these rows never showed what a click on it wrote: the display stayed
   * Reference while the write destroyed the Jump the user had set underneath,
   * and the import forces Reference on them again regardless. Nothing to edit,
   * so nothing pretends to be editable.
   */
  const derivedKindIndices = useMemo(() => {
    if (
      overlapMode !== 'keep_both' ||
      !editState ||
      !currentSuggestion ||
      currentSuggestion.matchedShots === 0
    ) {
      return new Set<number>();
    }
    const overlapIds = computeOverlapIds(
      currentSuggestion.importStationIndex,
      currentSuggestion.matchedShots,
    );
    const indices = new Set<number>();
    editState.shots.forEach((shot, idx) => {
      if (!shot.isNew && !shot.isDeleted && overlapIds.has(shot.id)) indices.add(idx);
    });
    return indices;
  }, [overlapMode, editState, currentSuggestion]);

  // Section edit callbacks
  const handleMetadataChange = useCallback((field: keyof SectionEditState, value: string | number | boolean) => {
    setEditState((prev) => prev ? { ...prev, [field]: value } : prev);
  }, []);

  const handleShotChange = useCallback(
    (index: number, field: keyof EditableShot, value: number | string | boolean | null) => {
      if (field === 'kind' && derivedKindIndices.has(index)) return;
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
    [derivedKindIndices]
  );

  /**
   * The one path a row-count change takes.
   *
   * `arrayIndex` is where the change lands in the FULL array and `delta` how
   * many VISIBLE rows it adds (positive) or removes (negative) there. The
   * segment anchor is a station index in that same visible space, so it is
   * renumbered here, in the same step as the rows: a mutator that wrote only the
   * rows left the pick addressing a station its own dropdown no longer offered.
   *
   * The transition is read from the rows as they stand now and committed OUTSIDE
   * the state updater, which stays pure - StrictMode invokes updaters twice on
   * purpose, and a commit in there re-anchored the pick twice for one edit.
   */
  const applyShotEdit = useCallback(
    (arrayIndex: number, delta: number, mutate: (shots: EditableShot[]) => EditableShot[]) => {
      const before = currentShots();
      stageShots(mutate(before));
      setEditState((prev) => (prev ? { ...prev, shots: mutate(prev.shots) } : prev));

      const anchor = segmentAnchorRef.current;
      if (delta === 0 || !anchor || anchor.sectionIndex !== activeEditableSectionIndex) return;
      const at = visibleBefore(before, arrayIndex);
      const survivorsAfter = visibleShotCount(before) + delta;
      const stationIndex =
        delta < 0
          ? reanchorAfterRunDelete(anchor.stationIndex, at, -delta, survivorsAfter)
          : reanchorStation(anchor.stationIndex, at, delta, survivorsAfter);
      if (stationIndex !== anchor.stationIndex) {
        commitSegmentAnchor({ sectionIndex: anchor.sectionIndex, stationIndex });
      }
    },
    [activeEditableSectionIndex, commitSegmentAnchor, currentShots, stageShots]
  );

  /** Blank rows to insert, each with its own temp id. */
  const blankRows = useCallback(
    (count: number): EditableShot[] =>
      Array.from({ length: count }, () => {
        const tempId = nextTempIdRef.current++;
        return { ...blankEditableShot(-tempId), tempId };
      }),
    []
  );

  /** Append `count` blank shots in ONE update, each with its own temp id. */
  const handleAddShots = useCallback((count: number) => {
    const rows = blankRows(Math.max(1, count));
    // Past every row: an append cannot renumber a station that already exists.
    applyShotEdit(Number.POSITIVE_INFINITY, rows.length, (shots) => [...shots, ...rows]);
  }, [applyShotEdit, blankRows]);

  const handleAddShot = useCallback(() => handleAddShots(1), [handleAddShots]);

  /** Insert `count` blank shots at `index`, in ONE update with an id per row. */
  const handleInsertShots = useCallback(
    (index: number, count: number, position: 'before' | 'after') => {
      const at = position === 'after' ? index + 1 : index;
      const rows = blankRows(Math.max(1, count));
      applyShotEdit(at, rows.length, (shots) => {
        const next = [...shots];
        next.splice(at, 0, ...rows);
        return next;
      });
    },
    [applyShotEdit, blankRows]
  );

  /** Say so when a row cannot go: the wizard freezes the matched overlap rows,
   *  and refusing them in silence left them on screen while the grid cleared the
   *  selection as though they had been deleted. Same wording as the edit-section
   *  grid, which refuses for the same reason. */
  const refuseFrozenDelete = useCallback((count: number) => {
    useUIStore
      .getState()
      .showToast(t('editSection.frozenNotDeleted', { count }), TOAST_KEYS.DMP_WIZARD_FROZEN_DELETE, 'warning');
  }, [t]);

  const handleDeleteShot = useCallback((index: number) => {
    const shot = currentShots()[index];
    if (!shot || shot.isDeleted === true) return;
    if (frozenShotIndices.has(index)) {
      refuseFrozenDelete(1);
      return;
    }
    applyShotEdit(index, -1, (shots) => {
      const next = [...shots];
      const row = next[index];
      if (row) next[index] = { ...row, isDeleted: true };
      return next;
    });
  }, [applyShotEdit, currentShots, frozenShotIndices, refuseFrozenDelete]);

  /** Delete a selection as ONE decision. Asked one row at a time, the frozen
   *  rows were dropped without a word and the grid collapsed the selection as
   *  though the whole range had gone; the anchor was also re-anchored once per
   *  row, each time against a count that no longer held. */
  const handleDeleteShots = useCallback((indices: number[]): boolean => {
    const shots = currentShots();
    const requested = indices.filter((i) => shots[i] !== undefined && shots[i]!.isDeleted !== true);
    if (requested.length === 0) return false;
    const targets = requested.filter((i) => !frozenShotIndices.has(i));
    if (targets.length < requested.length) refuseFrozenDelete(requested.length - targets.length);
    if (targets.length === 0) return false;

    const doomed = new Set(targets);
    applyShotEdit(Math.min(...targets), -targets.length, (rows) =>
      rows.map((row, i) => (doomed.has(i) ? { ...row, isDeleted: true } : row)),
    );
    return true;
  }, [applyShotEdit, currentShots, frozenShotIndices, refuseFrozenDelete]);

  // Persist the overlap mode on change: this one setting, sent as chosen (#576
  // RV6b-1). Handing `updateConfig` the whole config sent only what differed
  // from the store's copy, which is re-read only once a save has landed - so
  // switching the mode and straight back found nothing to send, and the first
  // choice was the one saved. Config writes run one at a time in the order they
  // were made (`chainSettingWrite`), so the last choice is the last write.
  const configLoaded = config != null;
  const handleOverlapModeChange = useCallback((value: OverlapMode) => {
    setOverlapMode(value);
    if (configLoaded) void patchConfig([{ path: ['import', 'overlap_mode'], value }]);
  }, [configLoaded, patchConfig]);

  // Auto-switch to 'existing_data' when a doubly-anchored target disables the current mode
  useEffect(() => {
    if (isTargetDoublyAnchored && (overlapMode === 'interpolate' || overlapMode === 'import_data')) {
      handleOverlapModeChange('existing_data');
    }
  }, [isTargetDoublyAnchored, overlapMode, handleOverlapModeChange]);

  // Pick the next suggestion from the cached pool, filtering out connected/skipped sections.
  const computeDefaultMergeOffset = useCallback((suggestion: CrossSectionSuggestion): number => {
    const section = dmpFile.sections[suggestion.importSectionIndex];
    const importShotCount = section
      ? section.shots.filter((s) => s.shot_type === 'Standard').length
      : 0;
    const options = computeMergeOptions(suggestion, importShotCount);
    return defaultMergeOffset(options, suggestion.preferredMergeOffset) ?? 0;
  }, [dmpFile.sections]);

  const ensureTemporalDistances = useCallback(async (pool: CrossSectionSuggestion[]) => {
    const anchors = collectExistingAnchorsForTemporalRerank(pool, connectionsRef.current, dmpFile.sections);
    const missing = anchors.filter((ref) => {
      const key = `${ref.section_id}:${ref.station_index}`;
      return !temporalDistanceFetchedOriginsRef.current.has(key);
    });

    await Promise.all(missing.map(async (origin) => {
      const key = `${origin.section_id}:${origin.station_index}`;
      try {
        const field = await invokeIpc(
          'get_station_distances_from',
          { from: origin },
          { purpose: 'temporal DMP placement rerank', fields: { origin: key } },
        );
        // null only when no project is open (#576 C3): no distances, not a crash.
        const distances = distanceMapFromField(origin, field);
        for (const [distanceKey, distance] of distances) {
          temporalDistanceCacheRef.current.set(distanceKey, distance);
        }
        temporalDistanceFetchedOriginsRef.current.add(key);
      } catch (e) {
        debugLog('[dmp-temporal-rerank] distance fetch failed', origin, e);
      }
    }));
  }, [connectionsRef]);

  const pickFromPool = useCallback(async () => {
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

    await ensureTemporalDistances(pool);
    const reranked = rerankSuggestionsByTemporalPlan(
      pool,
      dmpFile.sections,
      connectionsRef.current,
      temporalDistanceCacheRef.current,
    );
    suggestionPoolRef.current = reranked.suggestions;
    if (reranked.rejectedCount > 0) {
      debugLog(`[dmp-temporal-rerank] rejected ${reranked.rejectedCount} impossible candidate(s)`);
    }
    if (reranked.suggestions.length === 0) return false;

    const top = reranked.suggestions[0]!;
    // Set default merge option immediately to avoid a one-render race where
    // confirm can read the previous suggestion's offset.
    setSelectedMergeOffset(computeDefaultMergeOffset(top));
    setCurrentSuggestion(top);
    setAlternatives(
      reranked.suggestions
        .filter((s) => s !== top && s.importSectionIndex === top.importSectionIndex)
        .slice(0, 4)
    );
    return true;
  }, [computeDefaultMergeOffset, dmpFile.sections, ensureTemporalDistances, connectionsRef, skippedIndicesRef]);

  /** A section that reached the emit loop and produced nothing would otherwise
   *  disappear between the wizard and the map: it is not in the `unreachable`
   *  report either, which lists only what was never placed. */
  const reportEmptySections = useCallback((indices: number[]) => {
    if (indices.length === 0) return;
    const names = indices.map(
      (i) => sectionEditsRef.current.get(i)?.name ?? dmpFile.sections[i]?.name ?? t('dialogs.dmpNewImport.sectionFallbackName', { id: i }),
    );
    useUIStore.getState().showToast(
      t('dmpWizard.toasts.emptySections', { names: names.join(', ') }),
      TOAST_KEYS.DMP_WIZARD_EMPTY_SECTIONS,
      'warning',
    );
  }, [dmpFile.sections, t]);

  // Transition from suggesting phase: import reachable sections immediately (early import),
  // then enter manual_placing for unreachable segments, or complete if none.
  const transitionToPlacingOrManual = useCallback(async () => {
    if (transitionToPlacingInFlightRef.current) return;
    transitionToPlacingInFlightRef.current = true;

    try {
      // Import every reachable section now (the early import).
      const plan = await importBatch('early', () => {
        // 1. Overlap treatments (single source of truth): they replace the run's
        //    pending updates to existing shots.
        const existingShotUpdates = fullPoolRef.current.length > 0
          ? applyAllOverlapTreatments(
              fullPoolRef.current,
              confirmedOverlapsRef.current,
              sectionEditsRef.current,
              dmpFile,
              overlapMode,
            )
          : undefined;

        // 2. Redirect connections targeting deleted overlap zones
        redirectDeletedTargets(
          connectionsRef.current,
          sectionEditsRef.current,
          confirmedOverlapsRef.current,
          fullPoolRef.current,
        );

        // 3. Build batch import configs for reachable sections
        const batch = buildBatchImport(
          connectionsRef.current,
          zeroDatumConfig?.sectionIndex ?? null,
          dmpFile,
          selectionConfig,
          sectionEditsRef.current,
          fullPoolRef.current,
          directPlacementsRef.current,
          undefined,
          skippedIndicesRef.current,
          resolvedTheme,
          discardedIndicesRef.current,
        );
        reportEmptySections(batch.emptySections);
        return { ...batch, ...(existingShotUpdates ? { existingShotUpdates } : {}) };
      });
      if (!plan) return;
      const { unreachable } = plan;

      // 5. Check for unreachable sections
      if (unreachable.length > 0) {
        const segments = computeUnreachableSegments(unreachable, connectionsRef.current);
        if (segments.length > 0) {
          setSegmentQueue(segments);
          segmentSkipCountRef.current = new Map();

          // Initialize anchor to first section's station 0
          const firstSegment = segments[0]!;
          commitSegmentAnchor({ sectionIndex: chooseSegmentAnchorSection(firstSegment), stationIndex: 0 });
          setSegmentPlacementMode('manual');
          setAutoStartManualPlacementPending(true);
          // The shot table follows the suggestion first and nothing ever cleared
          // it, so entering manual placing with an exhausted pool left the grid
          // editing the last SUGGESTED section while the anchor named another.
          setCurrentSuggestion(null);

          setPhase('manual_placing');
          return;
        }
      }

      // No unreachable - all done
      trackDialogComplete('dmp-import-new');
      onComplete(...completion());
    } finally {
      transitionToPlacingInFlightRef.current = false;
      suggestionActionInFlightRef.current = false;
    }
  }, [zeroDatumConfig, dmpFile, selectionConfig, overlapMode, onComplete, importBatch, completion, reportEmptySections, resolvedTheme, connectionsRef, skippedIndicesRef]);

  /**
   * Ask the backend where every remaining section might connect, then present
   * the best match - or, with nothing to suggest, move on to placing.
   *
   * A failed call STOPS here (#576 D24, decided "Stop and offer Retry"). It used
   * to be swallowed as "nothing matched", so the wizard hid itself and started
   * map placement of every section by hand: a broken matcher looked exactly
   * like a survey with no overlaps. The user now sees why, and chooses between
   * Retry (this again) and Place manually (that old path, on purpose).
   */
  const computeSuggestions = useCallback(async () => {
    clearFailure();
    setIsCalculating(true);
    const zeroDatumIdx = zeroDatumConfig?.sectionIndex ?? null;

    const remainingSections: ImportSectionForSuggestion[] = [];
    for (const idx of selectedIndices) {
      if (idx === zeroDatumIdx) continue;
      const section = dmpFile.sections[idx];
      if (!section) continue;

      const editableShots = convertToEditableShots(section.shots, section.version);
      const shotData: ShotData[] = editableShots.map(editableShotToShotData);
      if (shotData.length === 0) continue;

      remainingSections.push({
        index: idx,
        name: section.name,
        shots: shotData,
        // Scored in the frame these readings are actually in (#438). Without
        // it the backend falls back to the project default, and a DMP section
        // would be matched against an existing Compass section across a
        // declination - a real overlap scoring as a mismatch.
        // camelCase here, snake_case on `ImportSectionConfig`: the two IPC
        // structs differ in their serde rename, and the generated types are
        // the authority.
        azimuthReference: DMP_AZIMUTH_REFERENCE,
      });
    }

    if (remainingSections.length === 0) {
      setIsCalculating(false);
      setPhase('done');
      return;
    }

    try {
      const suggestions = await invokeIpc(
        'suggest_all_import_placements',
        { importSections: remainingSections },
        { purpose: 'suggest import placements for remaining sections' },
      );

      suggestionPoolRef.current = suggestions;
      fullPoolRef.current = suggestions;
    } catch (e) {
      const reason = getErrorMessage(e);
      console.warn('[dmpImport] placement suggestions could not be computed:', reason);
      setIsCalculating(false);
      fail('suggestions', t('dialogs.dmpNewImport.suggestionsFailed', { reason }));
      return;
    }

    setIsCalculating(false);

    if (!(await pickFromPool())) {
      // No suggestions at all - check for unreachable sections
      transitionToPlacingOrManual();
      return;
    }

    setPhase('suggesting');
  }, [clearFailure, dmpFile.sections, fail, pickFromPool, selectedIndices, t, transitionToPlacingOrManual, zeroDatumConfig?.sectionIndex]);

  // On mount: import zero datum section and fire suggest_all_import_placements
  useEffect(() => {
    if (importStartedRef.current) return;
    importStartedRef.current = true;

    const init = async () => {
      // 1. Import zero datum section if provided (this is the anchor)
      if (zeroDatumConfig) {
        const { sectionIndex } = zeroDatumConfig;
        if (!(await importAnchor(() => buildZeroDatumSectionConfig(zeroDatumConfig)))) return;

        // Snap-fit to the newly placed zero datum section
        useUIStore.getState().triggerFitToBounds({ snap: true });

        // Check if only 1 section was selected - we're done
        if (selectedIndices.length === 1 && selectedIndices[0] === sectionIndex) {
          setPhase('done');
          return;
        }
      } else {
        // No zero datum - check if we can suggest
        const existingProject = useProjectStore.getState().project;
        const hasExistingSections = (existingProject?.sections.length ?? 0) > 0;

        if (!hasExistingSections && selectedIndices.length <= 1) {
          setPhase('done');
          return;
        }
      }

      // 2. Fire suggest_all_import_placements with all remaining sections
      await computeSuggestions();
    };

    init();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: the zero-datum import starts once (importStartedRef also guards a StrictMode re-run)
  }, []);

  // When restored from manual placement with an empty segment queue, transition to placing.
  useEffect(() => {
    if (phase === 'manual_placing' && segmentQueue.length === 0) {
      setPhase('placing');
    }
  }, [phase, segmentQueue.length]);

  // Handle 'placing' phase - late import of remaining sections after manual_placing.
  // Overlap treatment and connection redirect already happened during early import.
  useEffect(() => {
    if (phase !== 'placing') return;
    if (isImporting) return;

    const doLateImport = async () => {
      const plan = await importBatch('late', () => {
        const batch = buildBatchImport(
          connectionsRef.current,
          zeroDatumConfig?.sectionIndex ?? null,
          dmpFile,
          selectionConfig,
          sectionEditsRef.current,
          fullPoolRef.current,
          directPlacementsRef.current,
          earlyImported,
          undefined,
          resolvedTheme,
          discardedIndicesRef.current,
        );
        reportEmptySections(batch.emptySections);
        return batch;
      });
      if (!plan) return;
      const { unreachable } = plan;

      // Filter out discarded segments - they should not be placed later.
      const remaining = unreachable.filter(idx => !discardedIndicesRef.current.has(idx));
      if (remaining.length > 0) {
        const segments = computeUnreachableSegments(remaining, connectionsRef.current);
        if (segments.length > 0) {
          setSegmentQueue(segments);
          segmentSkipCountRef.current = new Map();

          const firstSegment = segments[0]!;
          commitSegmentAnchor({ sectionIndex: chooseSegmentAnchorSection(firstSegment), stationIndex: 0 });
          const hasSuggestion = firstSegment.some(idx => skippedSuggestionsRef.current.has(idx));
          setSegmentPlacementMode(hasSuggestion ? 'suggestion' : 'manual');
          setFromExistingSectionId(null);
          setFromExistingStationIdx(0);
          setAutoStartManualPlacementPending(true);
          clearFailure();
          setCurrentSuggestion(null);
          setPhase('manual_placing');
          return;
        }
      }

      trackDialogComplete('dmp-import-new');
      onComplete(...completion());
    };

    doLateImport();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- phase machine: runs on entering 'placing' (or a retry), not whenever a callback it calls is re-created
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
        commitSegmentAnchor({ sectionIndex: chooseSegmentAnchorSection(firstSegment), stationIndex: 0 });
        const hasSuggestion = firstSegment.some(idx => skippedSuggestionsRef.current.has(idx));
        setSegmentPlacementMode(hasSuggestion ? 'suggestion' : 'manual');
        setFromExistingSectionId(null);
        setFromExistingStationIdx(0);
        setAutoStartManualPlacementPending(true);
        clearFailure();
        setCurrentSuggestion(null);
        setPhase('manual_placing');
        return;
      }
    }

    trackDialogComplete('dmp-import-new');
    // With the receipt, like the other three completion sites (#487). This one
    // is reached after the zero-datum import has already banked one - a
    // single-selected-section file, or a selection with nothing left to
    // suggest - so dropping it silenced the receipt for those imports too.
    onComplete(...completion());
  // eslint-disable-next-line react-hooks/exhaustive-deps -- phase machine: runs on entering 'done' and when the import or calculation settles
  }, [phase, isImporting, isCalculating]);

  // Build preview section for import side from original shots (no mode modifications).
  // Both import and target sections display their original geometry so the user can
  // visually compare the overlap regardless of the selected overlap mode.
  const importPreviewSection = useMemo<DmpSection | null>(() => {
    if (!currentSuggestion) return null;
    const section = dmpFile.sections[currentSuggestion.importSectionIndex];
    if (!section) return null;
    if (!editState) return section;

    return {
      ...editableShotsToDmpSection(section, editState.shots),
      name: editState.name,
      direction: editState.direction,
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
      // The reference the backend walks the target with (#576 D15); the context
      // offset below walks it with the same one.
      targetAzimuthReference: azimuthReferenceFor(targetSection.azimuth_reference, currentProject.default_azimuth_reference),
    };
  }, [currentSuggestion, selectedMergePair]);

  // Build DMP merge preview config for import-to-import targets
  const dmpMergePreviewConfig = useMemo((): DmpMergePreviewConfig | null => {
    if (!currentSuggestion || currentSuggestion.targetType !== 'importing') return null;
    if (currentSuggestion.targetImportIndex == null) return null;

    const targetSection = dmpFile.sections[currentSuggestion.targetImportIndex];
    if (!targetSection) return null;

    const targetColorIdx = (currentSuggestion.targetImportIndex ?? 0) % sectionPalette.length;

    return {
      targetDmpSection: targetSection,
      targetColor: sectionPalette[targetColorIdx] ?? '#95a5a6',
      importStationIndex: selectedMergePair?.importStation ?? currentSuggestion.importStationIndex,
      targetStationIndex: selectedMergePair?.existingStation ?? currentSuggestion.existingStationIndex,
    };
  }, [currentSuggestion, selectedMergePair, dmpFile.sections, sectionPalette]);

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
            mergePreviewConfig.targetSection.shots, mergePreviewConfig.targetAzimuthReference
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
    return sectionPalette[(pos >= 0 ? pos : 0) % sectionPalette.length] ?? '#4ecdc4';
  }, [editState?.color, currentSuggestion?.importSectionIndex, selectedIndices, sectionPalette]);

  // Target section name for display
  const targetSectionName = useMemo(() => {
    if (!currentSuggestion) return '';
    return currentSuggestion.existingSectionName;
  }, [currentSuggestion]);

  // Confirm handler - records a virtual connection + overlap info (instant, no backend call).
  // Overlap treatment is deferred to applyAllOverlapTreatments which runs before batch import.
  /**
   * Refuse while ANY section that will be sent holds a half-filled row.
   *
   * Every selected section's edits are serialized, not just the one on screen,
   * so a gate on the active section alone let a cleared cell in section B walk
   * past it (switching the active section asks nothing) and die at Rust's
   * deserializer with an error that named nothing. The section is named here for
   * the same reason.
   *
   * Read FRESH from the refs: the wizard's actions suppress exhaustive-deps, so
   * a captured count is stale exactly when it matters - clear a cell, click
   * Confirm without touching anything else, and the old callback still remembers
   * zero.
   */
  const refuseIncompleteShots = useCallback(() => {
    const live = new Map(sectionEditsRef.current);
    // The active section's newest rows reach `sectionEditsRef` an effect later.
    const active = editStateForSectionRef.current;
    if (active != null && editStateRef.current) live.set(active, editStateRef.current);
    const blocking = findIncompleteSections(selectedIndices, live)[0];
    if (!blocking) return false;
    useUIStore.getState().showToast(
      t('dmpWizard.toasts.sectionIncomplete', { name: blocking.name, count: blocking.count }),
      TOAST_KEYS.DMP_WIZARD_INCOMPLETE,
      'warning',
    );
    return true;
  }, [selectedIndices, t, editStateForSectionRef, editStateRef]);

  const handleConfirm = useCallback(async () => {
    if (!currentSuggestion) return;
    if (refuseIncompleteShots()) return;
    if (suggestionActionInFlightRef.current || transitionToPlacingInFlightRef.current) return;
    suggestionActionInFlightRef.current = true;
    try {
      debugLog(
        `[handleConfirm] import=${currentSuggestion.importSectionIndex} "${currentSuggestion.importSectionName}"`,
        `→ target=${currentSuggestion.targetType === 'importing' ? currentSuggestion.targetImportIndex : currentSuggestion.existingSectionId}`,
        `"${currentSuggestion.existingSectionName}"`,
        `type=${currentSuggestion.targetType}`,
        `impStn=${currentSuggestion.importStationIndex} exStn=${currentSuggestion.existingStationIndex}`,
        `matched=${currentSuggestion.matchedShots} dir=${currentSuggestion.direction}`,
      );
      clearFailure();

      // Read fresh edit state from the ref (synchronously up-to-date) instead of
      // the editState React state which may be one render behind when the user
      // confirms quickly after a suggestion change.
      const importIdx = currentSuggestion.importSectionIndex;
      const freshEditState = sectionEditsRef.current.get(importIdx);
      if (!freshEditState) return; // shouldn't happen - init-effect always populates

      // Save raw user edits unchanged - NO overlap treatment here.
      // applyAllOverlapTreatments will handle all overlap mutation before batch import.
      sectionEditsRef.current.set(importIdx, freshEditState);

      // Record confirmed overlap info so applyAllOverlapTreatments knows the merge station
      const mergeImportStation = selectedMergePair?.importStation ?? currentSuggestion.importStationIndex;
      confirmedOverlapsRef.current.set(importIdx, {
        importStationIndex: currentSuggestion.importStationIndex,
        matchedShots: currentSuggestion.matchedShots,
        existingMatchedShots: currentSuggestion.existingMatchedShots,
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
        // All handled - transition to placing (or manual_placing if unreachable)
        transitionToPlacingOrManual();
        return;
      }

      // Pick next from pool
      if (!(await pickFromPool())) {
        // Pool exhausted - check for unreachable sections
        transitionToPlacingOrManual();
        return;
      }
    } finally {
      if (!transitionToPlacingInFlightRef.current) {
        suggestionActionInFlightRef.current = false;
      }
    }
  }, [currentSuggestion, selectedMergePair, zeroDatumConfig, selectedIndices, pickFromPool, transitionToPlacingOrManual, clearFailure, refuseIncompleteShots, connectionsRef, skippedIndicesRef]);

  // Skip handler (suggesting phase)
  const handleSkip = useCallback(async () => {
    if (refuseIncompleteShots()) return;
    if (!currentSuggestion) return;
    if (suggestionActionInFlightRef.current || transitionToPlacingInFlightRef.current) return;
    suggestionActionInFlightRef.current = true;
    try {
      const skippedIdx = currentSuggestion.importSectionIndex;
      const mergeImportStation = selectedMergePair?.importStation ?? currentSuggestion.importStationIndex;
      const mergeExistingStation = selectedMergePair?.existingStation ?? currentSuggestion.existingStationIndex;

      // Record the suggestion so it can be re-shown in manual_placing
      skippedSuggestionsRef.current.set(skippedIdx, {
        suggestion: currentSuggestion,
        mergeImportStation,
        mergeExistingStation,
      });

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

      if (!(await pickFromPool())) {
        transitionToPlacingOrManual();
        return;
      }
    } finally {
      if (!transitionToPlacingInFlightRef.current) {
        suggestionActionInFlightRef.current = false;
      }
    }
  }, [currentSuggestion, selectedMergePair, zeroDatumConfig, selectedIndices, pickFromPool, transitionToPlacingOrManual, connectionsRef, skippedIndicesRef]);

  // Alternative click handler
  const handleAlternativeClick = useCallback((alt: CrossSectionSuggestion) => {
    setSelectedMergeOffset(computeDefaultMergeOffset(alt));
    setCurrentSuggestion(alt);
    setAlternatives((prev) => {
      const newAlts = prev.filter((a) => a !== alt);
      if (currentSuggestion) {
        newAlts.push(currentSuggestion);
        newAlts.sort((a, b) => b.score - a.score);
      }
      return newAlts.slice(0, 4);
    });
  }, [currentSuggestion, computeDefaultMergeOffset]);

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
  const projectDefault = useProjectStore((s) => s.project?.default_azimuth_reference);

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
  // shots and interpolated values - matching what will be imported.
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
      const sectionColor = (edits?.color || null) ?? sectionPalette[(selectedPos >= 0 ? selectedPos : entry.sectionIndex) % sectionPalette.length] ?? '#95a5a6';
      return {
        section,
        color: sectionColor,
        sectionIndex: entry.sectionIndex,
        offsetX: entry.offsetX,
        offsetY: entry.offsetY,
      };
    }).filter((x): x is NonNullable<typeof x> => x !== null);
  }, [currentSegment, connections, dmpFile.sections, sectionPalette]);

  // Compute target segment context for "From Existing" preview (shows the target section's
  // connected segment as dimmed lines behind the import segment preview)
  const fromExistingContextSections = useMemo((): ContextSectionGeometry[] | null => {
    if (segmentPlacementMode !== 'fromExisting' || fromExistingSectionId == null) return null;
    if (!segmentAnchor || !segmentPreviewSections || segmentPreviewSections.length === 0) return null;
    return buildFromExistingContext({
      fromExistingSectionId, fromExistingStationIdx, projectSections, projectMerges, projectDefault,
      anchorSectionIndex: segmentAnchor.sectionIndex, emittedAnchorStation: emittedAnchorStation(segmentAnchor), segmentPreviewSections,
    });
  }, [segmentPlacementMode, fromExistingSectionId, fromExistingStationIdx, projectSections, projectMerges, projectDefault, segmentAnchor, segmentPreviewSections, emittedAnchorStation]);

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
        // Queue empty - transition to placing
        setPhase('placing');
        return [];
      }
      // Initialize anchor for next segment
      const firstSegment = next[0]!;
      commitSegmentAnchor({ sectionIndex: chooseSegmentAnchorSection(firstSegment), stationIndex: 0 });
      const hasSuggestion = firstSegment.some(idx => skippedSuggestionsRef.current.has(idx));
      setSegmentPlacementMode(hasSuggestion ? 'suggestion' : 'manual');
      setFromExistingSectionId(null);
      setFromExistingStationIdx(0);
      return next;
    });
  }, [chooseSegmentAnchorSection, commitSegmentAnchor]);

  // Place segment handler
  const handleSegmentPlace = useCallback(() => {
    if (refuseIncompleteShots()) return;
    if (!currentSegment || !segmentAnchor) return;
    const anchorStation = emittedAnchorStation(segmentAnchor);

    let placement: ImportPlacement;
    if (segmentPlacementMode === 'suggestion' && segmentSkippedSuggestion) {
      // Use the skipped suggestion as a from_existing connection
      const suggestion = segmentSkippedSuggestion.suggestion;
      if (suggestion.targetType === 'existing' && suggestion.existingSectionId != null) {
        // Add as a virtual connection instead
        const newConn: VirtualConnection = {
          importSectionIndex: suggestion.importSectionIndex,
          importStationIndex: segmentSkippedSuggestion.mergeImportStation,
          targetType: 'existing',
          existingSectionId: suggestion.existingSectionId,
          existingStationIndex: segmentSkippedSuggestion.mergeExistingStation,
        };
        setConnections((prev) => [...prev, newConn]);
        connectionsRef.current = [...connectionsRef.current, newConn];
        advanceSegmentQueue();
        return;
      } else if (suggestion.targetType === 'importing' && suggestion.targetImportIndex != null) {
        const newConn: VirtualConnection = {
          importSectionIndex: suggestion.importSectionIndex,
          importStationIndex: segmentSkippedSuggestion.mergeImportStation,
          targetType: 'importing',
          targetImportIndex: suggestion.targetImportIndex,
          targetImportStationIndex: segmentSkippedSuggestion.mergeExistingStation,
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
        import_station: anchorStation,
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
      anchorStationIndex: anchorStation,
      placement,
    };
    directPlacementsRef.current = [...directPlacementsRef.current, dp];
    advanceSegmentQueue();
  }, [currentSegment, segmentAnchor, segmentPlacementMode, segmentSkippedSuggestion, fromExistingSectionId, fromExistingStationIdx, advanceSegmentQueue, emittedAnchorStation, refuseIncompleteShots, connectionsRef]);

  // Skip segment handler - appends to end of queue
  const handleSegmentSkip = useCallback(() => {
    if (!currentSegment) return;
    const key = currentSegment.join(',');
    const count = (segmentSkipCountRef.current.get(key) ?? 0) + 1;
    segmentSkipCountRef.current.set(key, count);

    setSegmentQueue((prev) => {
      if (prev.length <= 1) {
        // Only one segment left - can't skip, it stays
        return prev;
      }
      const [first, ...rest] = prev;
      const next = [...rest, first!];
      // Initialize anchor for next segment
      const nextSeg = next[0]!;
      commitSegmentAnchor({ sectionIndex: chooseSegmentAnchorSection(nextSeg), stationIndex: 0 });
      const hasSuggestion = nextSeg.some(idx => skippedSuggestionsRef.current.has(idx));
      // 'manual' like every other way into a segment: the radio group has no
      // 'origin' option, so it used to come up with nothing selected (#576 NF-AN4-N3).
      setSegmentPlacementMode(hasSuggestion ? 'suggestion' : 'manual');
      setFromExistingSectionId(null);
      setFromExistingStationIdx(0);
      return next;
    });
  }, [currentSegment, chooseSegmentAnchorSection, commitSegmentAnchor]);

  // Station click handler for segment preview. The index arrives in the
  // preview's own (emitted) numbering - see the note on the two spaces.
  const handleSegmentStationClick = useCallback((stationIndex: number, sectionIndex?: number) => {
    const idx = sectionIndex ?? (currentSegment && currentSegment.length > 0 ? currentSegment[0]! : null);
    if (idx == null) return;
    commitSegmentAnchor({ sectionIndex: idx, stationIndex: visibleAnchorStation(idx, stationIndex) });
  }, [currentSegment, commitSegmentAnchor, visibleAnchorStation]);

  const buildSegmentPlacementPayload = useCallback(
    (segment: number[], anchor: { sectionIndex: number; stationIndex: number }) => {
      const anchorDmpSection = dmpFile.sections[anchor.sectionIndex];
      if (!anchorDmpSection) {
        return null;
      }

      const edits = sectionEditsRef.current.get(anchor.sectionIndex);
      const shots: ShotData[] = edits
        ? edits.shots.filter(isEmittedShot).map(editableShotToShotData)
        : convertToEditableShots(anchorDmpSection.shots, anchorDmpSection.version).map(editableShotToShotData);
      const emittedStationIndex = emittedAnchorStation(anchor);

      const sectionData = buildPlacementSectionData({
        dmpSection: anchorDmpSection,
        edits,
        defaultSurveyor: selectionConfig.defaultSurveyor,
        defaultDate: selectionConfig.defaultDate,
        palette: sectionPalette,
        paletteIndex: selectedIndices.indexOf(anchor.sectionIndex),
        shots,
      });

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
            sectionPalette[(secSelectedPos >= 0 ? secSelectedPos : entry.sectionIndex) % sectionPalette.length] ??
            '#95a5a6';
          const secShots = secEdits
            ? secEdits.shots.filter(isEmittedShot).map(editableShotToShotData)
            : convertToEditableShots(sec.shots, sec.version).map(editableShotToShotData);
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

      return { sectionData, additionalSections, emittedStationIndex };
    },
    [dmpFile.sections, emittedAnchorStation, selectionConfig.defaultDate, selectionConfig.defaultSurveyor, selectedIndices, sectionPalette, connectionsRef],
  );

  /** Import the segment just placed on the map: the whole batch as it stands
   *  with that placement added, narrowed by the run to the segment's sections. */
  const importPlacedSegmentNow = useCallback(
    (segmentIndices: number[], directPlacements: DirectPlacement[]) =>
      importSegment(segmentIndices, () => {
        const batch = buildBatchImport(
          connectionsRef.current,
          zeroDatumConfig?.sectionIndex ?? null,
          dmpFile,
          selectionConfig,
          sectionEditsRef.current,
          fullPoolRef.current,
          directPlacements,
          earlyImported,
          undefined,
          resolvedTheme,
          discardedIndicesRef.current,
        );
        reportEmptySections(batch.emptySections);
        return batch;
      }),
    [dmpFile, earlyImported, importSegment, reportEmptySections, selectionConfig, zeroDatumConfig?.sectionIndex, resolvedTheme, connectionsRef],
  );

  /**
   * Hand this segment off to map placement.
   *
   * Carries NO payload guard, deliberately (#476). `refuseIncompleteShots`
   * exists to protect an IPC payload, and this hands off nothing: the payload
   * leaves later, from `importPlacedSegmentNow`, once the user has dropped the
   * section. Gating the handoff on the completeness of the WHOLE selection is
   * what turned one zero-length row in the file into a dead end - the auto-start
   * effect below runs this while the dialog is hidden, so a refusal here was
   * invisible AND unrecoverable. The guard stays where a payload is actually at
   * stake: `handlePlaceOnMapClick` (the user-initiated button), the segment
   * submit, and `handleConfirm`/`handleSkip`.
   *
   * It also no longer clears `autoStartManualPlacementPending`. That window is
   * owned by the effect that opened it - see there.
   */
  const handleStartSegmentPlacement = useCallback(() => {
    // The payload is still guarded: importPlacedSegmentNow -> buildBatchImport -> assertSendableShots.
    if (!currentSegment || !segmentAnchor) return;

    // Reopen data (same as what App.tsx passes)
    const reopenData = {
      dmpFile,
      filePath: (useUIStore.getState().dialogData as Record<string, unknown>).filePath,
      selectionConfig,
      zeroDatumConfig,
    };

    const savedState = (
      directPlacements: DirectPlacement[],
      placedSegment?: SavedManualPlacingState['placedSegment'],
    ): SavedManualPlacingState => ({
      connections: [...connectionsRef.current],
      skippedIndices: Array.from(skippedIndicesRef.current),
      segmentQueue,
      segmentAnchor,
      directPlacements,
      skippedSuggestions: Array.from(skippedSuggestionsRef.current.entries()),
      segmentSkipCounts: Array.from(segmentSkipCountRef.current.entries()),
      sectionEdits: Array.from(sectionEditsRef.current.entries()),
      confirmedOverlaps: Array.from(confirmedOverlapsRef.current.entries()),
      discardedIndices: Array.from(discardedIndicesRef.current),
      ...carry(),
      ...(placedSegment ? { placedSegment } : {}),
    });

    const directPlacements = [...directPlacementsRef.current];
    const reopen = (autoStart: boolean, placedSegment?: SavedManualPlacingState['placedSegment']) => {
      setSource('dialog');
      openDialog('dmp-import-new', {
        ...reopenData,
        autoStartManualPlacement: autoStart,
        savedManualPlacingState: savedState(directPlacements, placedSegment),
      });
    };

    const payload = buildSegmentPlacementPayload(currentSegment, segmentAnchor);
    if (!payload) {
      reopen(false);
    } else {
      const anchor = segmentAnchor;
      startPlacementMode(
        payload.sectionData,
        payload.emittedStationIndex,
        (result: PlacementResult) => {
          // The SAME station the overlay was aligned to. Storing the visible
          // index here while placing against the emitted one meant the preview
          // and the import disagreed, and the segment landed a station too far
          // downstream whenever a blank row preceded the anchor.
          const alignStation = payload.emittedStationIndex;
          const placement: ImportPlacement = result.snappedToStation
            ? { type: 'manual_snap', align_station_index: alignStation, snapped_to_station: result.snappedToStation }
            : { type: 'manual', align_station_index: alignStation, offset: result.position };
          // The drop only RECORDS the placement (#576 D13): the reopened wizard
          // imports it, hidden like any auto-started handoff, so a failure shows
          // on this segment's screen and a success hands off the next segment.
          reopen(true, {
            segment: currentSegment,
            placement: { anchorSectionIndex: anchor.sectionIndex, anchorStationIndex: alignStation, placement },
          });
        },
        () => reopen(false),
        payload.additionalSections.length > 0 ? payload.additionalSections : undefined,
        DMP_AZIMUTH_REFERENCE,
      );

      showToast(
        t('dmpWizard.toasts.placementHint'),
        TOAST_KEYS.DMP_MANUAL_PLACEMENT_HINT,
        'info'
      );
    }

    // Close dialog so user can interact with the map
    trackDialogComplete('dmp-import-new');
    closeDialog();
  }, [
    currentSegment,
    segmentAnchor,
    segmentQueue,
    buildSegmentPlacementPayload,
    dmpFile,
    selectionConfig,
    zeroDatumConfig,
    carry,
    startPlacementMode,
    closeDialog,
    openDialog,
    showToast,
    connectionsRef,
    skippedIndicesRef,
  ]);

  /**
   * #576 D13: import the segment the user just dropped on the map, in THIS
   * instance - the drop reopened the wizard with it pending
   * (`SavedManualPlacingState.placedSegment`). The run starts busy, so the exits
   * and the auto-start handoff wait for the answer. Imported: the placement is
   * recorded and the queue advances, and the auto-start effect hands off the
   * next segment (or the late import runs). Refused: the segment stays queued,
   * its placement is not kept, and the wizard shows the failure on its screen.
   */
  const placedSegmentStartedRef = useRef(false);
  useEffect(() => {
    const placed = saved?.placedSegment;
    if (!placed || placedSegmentStartedRef.current) return;
    placedSegmentStartedRef.current = true;
    const placements = [...directPlacementsRef.current, placed.placement];
    void importPlacedSegmentNow(placed.segment, placements).then((imported) => {
      if (!imported) {
        setAutoStartManualPlacementPending(false);
        return;
      }
      directPlacementsRef.current = placements;
      advanceSegmentQueue();
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only: `saved` is this instance's restore data
  }, []);

  /**
   * "Place on Map", clicked by the user. This is where the payload guard
   * belongs: the click is a deliberate step toward an import, the dialog is
   * VISIBLE, and the refusal toast names a section the user can then go and fix
   * (#476 moved it off the auto-start path, where none of that was true).
   */
  const handlePlaceOnMapClick = useCallback(() => {
    if (refuseIncompleteShots()) return;
    handleStartSegmentPlacement();
  }, [refuseIncompleteShots, handleStartSegmentPlacement]);

  /**
   * The auto-start handoff, and the sole owner of `autoStartManualPlacementPending`.
   *
   * That flag hides the whole dialog (`hidden` -> `display:none` on
   * DialogWrapper's container), so the window it opens MUST be closed by
   * whatever happens next. Its honest meaning is "the handoff has not been
   * ATTEMPTED yet" - a state that any single attempt leaves, whatever the
   * attempt decides.
   *
   * It used to be cleared inside `handleStartSegmentPlacement`, after two early
   * returns, so a callee that declined left the dialog mounted, `display:none`,
   * with `activeDialog` still set - an invisible modal that made the whole app
   * `inert` with no mouse affordance and no retry, because nothing in this
   * effect's dependencies changes on a refusal (#476). Keeping ownership here
   * makes the window unstrandable by any future early return, which is the
   * actual invariant; clearing above each individual `return` would be correct
   * today and re-breakable tomorrow.
   *
   * `isImporting` is the ONLY guard that is transient - it flips false and
   * re-runs this effect. Every other reason not to attempt is terminal, so it
   * ends the hidden window instead of waiting forever.
   */
  useEffect(() => {
    if (!autoStartManualPlacementPending) {
      return;
    }
    if (isImporting) {
      return;
    }
    if (phase !== 'manual_placing' || !currentSegment || !segmentAnchor) {
      setAutoStartManualPlacementPending(false);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      // Attempted, so the window is over either way. In the success case the
      // handoff closes the dialog in this same commit, so nothing flashes; in
      // any other case the wizard becomes VISIBLE on the manual-placing screen,
      // which is where the user can act.
      try {
        handleStartSegmentPlacement();
      } finally {
        setAutoStartManualPlacementPending(false);
      }
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

  // ─── Cancel / Back ────────────────────────────────────────────────────────
  //
  // This wizard imports EAGERLY - the zero-datum anchor lands in the project on
  // mount, and each reachable segment as it is placed, because the map has to
  // render what it is placing. So by the time either exit is reached the project
  // may already hold sections the user never agreed to keep, and neither exit
  // used to say so: the gate asked only about `connections` (client-side records
  // that have imported nothing), so cancelling right after the zero-datum import
  // closed silently and left the section behind (#394 F2).
  //
  // Both exits therefore offer to WITHDRAW what was imported
  // (`withdrawImportedSections`, the run's one batched `delete_section` - one
  // undo entry for one user action).

  /** How many sections the pending confirmation is talking about. Snapshotted
   *  into state when the confirmation opens: the live count lives in a ref, and
   *  a ref does not re-render the copy that quotes it. */
  const [pendingWithdrawCount, setPendingWithdrawCount] = useState(0);

  /**
   * Neither exit may be OPENED while an import is in flight.
   *
   * An import banks its section ids only when it resolves, so a withdrawal
   * decided now would snapshot a list that is about to grow, and the late
   * arrival would survive in the project with nothing tracking it - the exact
   * shape F2 exists to prevent. The footer buttons are disabled for the same
   * reason; this also covers the routes that bypass them (the dialog's own
   * close button and Escape, both of which land on `handleCancel`).
   */
  const exitBlocked = isImporting;

  /** Leaving a confirmation also drops the reason its last removal failed: it
   *  belongs to that dialog, and the next one asks afresh. */
  const closeCancelConfirm = useCallback(() => {
    setShowCancelConfirm(false);
    clearWithdrawalFailure();
  }, [clearWithdrawalFailure]);
  const closeBackConfirm = useCallback(() => {
    setShowBackConfirm(false);
    clearWithdrawalFailure();
  }, [clearWithdrawalFailure]);

  const handleCancel = useCallback(() => {
    if (isImporting) return;
    const count = importedCount();
    if (connections.length > 0 || count > 0) {
      setPendingWithdrawCount(count);
      clearWithdrawalFailure();
      setShowCancelConfirm(true);
    } else {
      onCancel();
    }
  }, [connections.length, onCancel, isImporting, importedCount, clearWithdrawalFailure]);

  /** Close the wizard, first removing what it imported. */
  const handleCancelWithRemoval = useCallback(async () => {
    if (!(await withdrawImportedSections())) return;
    setShowCancelConfirm(false);
    onCancel();
  }, [withdrawImportedSections, onCancel]);

  const handleBack = useCallback(() => {
    if (isImporting) return;
    const count = importedCount();
    if (connections.length > 0 || count > 0) {
      setPendingWithdrawCount(count);
      clearWithdrawalFailure();
      setShowBackConfirm(true);
    } else {
      onBack();
    }
  }, [connections.length, onBack, isImporting, importedCount, clearWithdrawalFailure]);

  /**
   * Back re-enters the flow at a step BEFORE anything was imported (zero-datum
   * config, or the section selection), and the forward pass re-imports from
   * scratch - the anchor on mount, then the whole suggest/early-import pipeline.
   * So Back has to withdraw first, or the second pass duplicates every section
   * the first one created (#394 F1). Carrying "already imported, don't redo it"
   * across instead cannot work: the mount effect that imports the anchor is the
   * same one that fires `suggest_all_import_placements`, so suppressing it
   * strands the reopened wizard in `init` with nothing to do - and it would also
   * pin the anchor to the GPS/name/shot edits of the FIRST pass, which is
   * exactly what the user pressed Back to change.
   */
  const handleBackWithRemoval = useCallback(async () => {
    if (!(await withdrawImportedSections())) return;
    setShowBackConfirm(false);
    onBack();
  }, [withdrawImportedSections, onBack]);

  // Confidence helpers
  const confidenceColors: Record<string, string> = {
    high: 'bg-success-10 text-success border-success-30',
    medium: 'bg-warning-10 text-warning border-warning-30',
    low: 'bg-background-50 text-text-secondary border-border',
  };

  const directionLabel = (direction: string) =>
    direction === 'forward' ? '\u2192' : '\u2190';

  // Progress - during manual_placing, compute from queue (which has ALL unplaced sections).
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
    return currentSegment.map(idx => dmpFile.sections[idx]?.name ?? t('dialogs.dmpNewImport.sectionFallbackName', { id: idx }));
  }, [currentSegment, dmpFile.sections, t]);

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
      size="fullscreen"
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
          <WizardScrollBody
            bodyRef={suggestionBodyRef}
            table={
              editState ? (
                <ShotTableEditor
                  shots={effectiveShots}
                  onShotChange={handleShotChange}
                  onAddShot={handleAddShot}
                  onAddShots={handleAddShots}
                  onInsertShots={handleInsertShots}
                  onDeleteShot={handleDeleteShot}
                  onDeleteShots={handleDeleteShots}
                  frozenShotIndices={frozenShotIndices}
                />
              ) : null
            }
          >
            {(bandHeight) => (
            <div className="flex" style={{ minHeight: bandHeight }}>
            <WizardMapPanel
              width={mapPanelWidth}
              onWidthChange={setMapPanelWidth}
              bodyRef={suggestionBodyRef} panelRef={suggestionPreviewRef} height={bandHeight}
            >
              <SectionPreview
                section={importPreviewSection}
                color={importColor}
                size={suggestionPreviewSize.width}
                height={suggestionPreviewSize.height}
                mergePreview={mergePreviewConfig}
                dmpMergePreview={dmpMergePreviewConfig}
                focusStationIndex={selectedMergePair?.importStation ?? currentSuggestion!.importStationIndex}
                contextSections={mergedContextSections}
              />
            </WizardMapPanel>

            {/* Right column: connection details */}
            <div className="flex-1 min-w-0 p-5 space-y-4" data-testid="wizard-suggestion">
              {/* Suggested connection - prominent card */}
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
                      <span className="ml-1 text-xs text-text-secondary">{t('dialogs.dmpNewImport.importingTag')}</span>
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
                    <Select
                      value={String(selectedMergeOffset)}
                      onChange={(v) => setSelectedMergeOffset(Number(v))}
                      options={mergeOptions.map((opt) => ({
                        value: String(opt.offset),
                        label: t('dialogs.dmpNewImport.mergeOption', { importStation: opt.importStation, target: targetSectionName, existingStation: opt.existingStation }),
                      }))}
                      size="sm"
                      data-testid="merge-station-select"
                    />
                  ) : (
                    <span className="text-xs text-text-secondary">
                      {t('dialogs.dmpNewImport.mergeOption', {
                        importStation: selectedMergePair?.importStation ?? currentSuggestion!.importStationIndex, target: targetSectionName,
                        existingStation: selectedMergePair?.existingStation ?? currentSuggestion!.existingStationIndex,
                      })}
                    </span>
                  )}
                </div>

                {/* Overlap control */}
                <div className="flex items-center gap-2" data-testid="wizard-overlap-control">
                  <label className="text-xs text-text-secondary whitespace-nowrap">
                    {t('dialogs.dmpNewImport.overlapMode')}
                  </label>
                  {currentSuggestion && currentSuggestion.matchedShots > 0 ? (
                    <Select
                      value={overlapMode}
                      onChange={(v) => handleOverlapModeChange(v as OverlapMode)}
                      options={[
                        { value: 'interpolate', label: t('dialogs.dmpNewImport.overlapMode_interpolate'), disabled: isTargetDoublyAnchored },
                        { value: 'import_data', label: t('dialogs.dmpNewImport.overlapMode_importData'), disabled: isTargetDoublyAnchored },
                        { value: 'existing_data', label: t('dialogs.dmpNewImport.overlapMode_existingData') },
                        { value: 'keep_both', label: t('dialogs.dmpNewImport.overlapMode_keepBoth') },
                      ]}
                      size="sm"
                      data-testid="overlap-mode-select"
                    />
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
                            <span className="text-text-secondary">{t('dialogs.dmpNewImport.stn', { index: alt.importStationIndex })}</span>
                            <span className="text-text-secondary"> → </span>
                            <span className="font-medium">{alt.existingSectionName}</span>
                            <span className="text-text-secondary"> {t('dialogs.dmpNewImport.stn', { index: alt.existingStationIndex })}</span>
                            {alt.targetType === 'importing' && (
                              <span className="text-text-secondary text-[10px] ml-0.5">{t('dialogs.dmpNewImport.importingShort')}</span>
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
              {/* #61 embedding slot: section-name + SectionMetadataForm + ShotTableEditor.
                  Consumed as-is here; the reusable focus-mode section-edit surface
                  (fields-right / table-bottom) drops in here later. Do not refactor.
                  #567 item 2: wrapped in a collapsed-by-default disclosure so it
                  stops competing with the connection card/confidence badge above -
                  the wrapped content itself is unchanged. */}
              {editState && (
                <div className="border-t border-border pt-3">
                  <SuggestionSectionSettings editState={editState} onMetadataChange={handleMetadataChange} />
                </div>
              )}
            </div>
            </div>
            )}
          </WizardScrollBody>
        ) : showManualPlacing ? (
          <WizardScrollBody
            bodyRef={manualBodyRef}
            table={
              editState ? (
                <ShotTableEditor
                  shots={effectiveShots}
                  onShotChange={handleShotChange}
                  onAddShot={handleAddShot}
                  onAddShots={handleAddShots}
                  onInsertShots={handleInsertShots}
                  onDeleteShot={handleDeleteShot}
                  onDeleteShots={handleDeleteShots}
                  frozenShotIndices={frozenShotIndices}
                />
              ) : null
            }
          >
            {(bandHeight) => (
            <div className="flex" style={{ minHeight: bandHeight }}>
            <WizardMapPanel
              width={mapPanelWidth}
              onWidthChange={setMapPanelWidth}
              bodyRef={manualBodyRef} panelRef={manualPreviewRef} height={bandHeight}
            >
              <SectionPreview
                segmentSections={segmentPreviewSections}
                contextSections={fromExistingContextSections}
                size={manualPreviewSize.width}
                height={manualPreviewSize.height}
                onStationClick={handleSegmentStationClick}
                selectedStationIndex={previewAnchor ? emittedAnchorStation(previewAnchor) : null}
                selectedSectionIndex={previewAnchor?.sectionIndex ?? null}
              />
            </WizardMapPanel>

            {/* Right column: Placement configuration */}
            <div className="flex-1 min-w-0 p-5 space-y-4" data-testid="wizard-manual-placing">
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

              {/* Error - at the top, where the screen opens: a segment import that
                  failed after a drop on the map lands here (#576 D13), and below
                  the section settings it was out of view. */}
              {error && (
                <div className="text-sm text-error" role="alert" data-testid="wizard-error">
                  {error}
                </div>
              )}

              {/* Placement mode radio group */}
              <SegmentPlacementModes
                segmentSkippedSuggestion={segmentSkippedSuggestion}
                placementMode={segmentPlacementMode}
                onPlacementModeChange={setSegmentPlacementMode}
                currentSegment={currentSegment}
                segmentAnchor={segmentAnchor}
                onCommitSegmentAnchor={commitSegmentAnchor}
                sectionEdits={sectionEditsRef.current}
                dmpSections={dmpFile.sections}
                onAnchorSectionHover={handleAnchorSectionHover}
                onAnchorStationHover={handleAnchorStationHover}
                projectSections={projectSections}
                fromExistingSectionId={fromExistingSectionId}
                onFromExistingSectionChange={setFromExistingSectionId}
                fromExistingStationIdx={fromExistingStationIdx}
                onFromExistingStationChange={setFromExistingStationIdx}
                fromExistingStationCount={fromExistingStationCount}
                onPlaceOnMap={handlePlaceOnMapClick}
              />

              {/* Section settings (same editing surface as section connection / zero datum flows) */}
              {/* #61 embedding slot: section-edit surface goes here later. Do not refactor. */}
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
                      reverse={editState.reverse}
                      onReverseChange={(v) => handleMetadataChange('reverse', v)}
                      showName={false}
                      showDirection
                      showReverse
                    />
                  </div>
                </>
              )}
            </div>
            </div>
            )}
          </WizardScrollBody>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-6 min-h-0 overflow-auto">
            {/* Init/Importing zero datum */}
            {phase === 'init' && isImporting && (
              <div className="text-center" data-testid="wizard-importing-zero-datum">
                <div className="text-lg mb-2">{t('dialogs.dmpNewImport.importingZeroDatum')}</div>
                <div className="animate-pulse text-text-secondary">...</div>
              </div>
            )}

            {/* A failed step with no panel of its own - the anchor import in
                `init` above all, which used to leave this body blank (#576
                NF-AN4-N1). `placing` shows its failure below, with its Retry. */}
            {phase !== 'placing' && error && !isImporting && !isCalculating && (
              <div
                className="text-center"
                data-testid={failure?.kind === 'suggestions' ? 'wizard-suggestions-failed' : 'wizard-status-failed'}
              >
                <div className="text-lg mb-2 text-error" data-testid="wizard-error">{error}</div>
              </div>
            )}

            {/* Calculating suggestions */}
            {(phase === 'init' || phase === 'suggesting') && isCalculating && (
              <div className="text-center" data-testid="wizard-calculating">
                <div className="text-lg mb-2">{t('dialogs.dmpNewImport.calculating')}</div>
                <div className="animate-pulse text-text-secondary">...</div>
              </div>
            )}

            {/* Placing - batch import in progress or failed */}
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

            {/* No suggestions - show status while transitioning to manual placement */}
            {phase === 'suggesting' && !isCalculating && !currentSuggestion && !isImporting && (
              <div className="text-center" data-testid="wizard-no-suggestions">
                <div className="text-lg mb-2">{t('dialogs.dmpNewImport.noSuggestions')}</div>
              </div>
            )}

            {/* Done - all placed */}
            {phase === 'done' && placedCount === totalSelected && (
              <div className="text-center" data-testid="wizard-all-placed">
                <CheckCircleIcon size={32} className="text-success mx-auto mb-2" />
                <div className="text-lg">{t('dialogs.dmpNewImport.allPlaced')}</div>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div
          ref={footerRef}
          data-testid="dmp-import-dialog-footer"
          className="px-4 py-3 border-t border-border flex justify-between items-center"
        >
          <div className="flex gap-2">
            <Button
              onClick={handleCancel}
              disabled={exitBlocked}
              className={importSecondaryButtonClass}
              data-testid="cancel-button"
            >
              {t('common.actions.cancel')}
            </Button>
            <Button
              onClick={handleBack}
              disabled={exitBlocked}
              className={importSecondaryButtonClass}
              data-testid="back-button"
            >
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
            {/* #576 D24: the suggestions failed - ask again, or place by hand. */}
            {failure?.kind === 'suggestions' && !isCalculating && !isImporting && (
              <>
                <Button
                  onClick={() => { void transitionToPlacingOrManual(); }}
                  className={importSecondaryButtonClass}
                  data-testid="suggestions-place-manually-button"
                >
                  {t('dialogs.dmpNewImport.placeManually')}
                </Button>
                <Button
                  variant="primary"
                  onClick={() => { void computeSuggestions(); }}
                  data-testid="suggestions-retry-button"
                >
                  {t('common.actions.retry')}
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

      {/* Cancel confirmation. Three actions once anything has been imported -
          the exit is no longer just "close a dialog", it decides what happens to
          sections that are already in the project. `confirm-cancel-button` keeps
          its id and its meaning (close, change nothing on disk); the removal is
          the new, additional action. */}
      <AlertDialog
        open={showCancelConfirm}
        title={t('dialogs.dmpNewImport.cancelWizard')}
        // A delete is on the wire; every route out of this confirmation is shut
        // until it lands, including Escape and the backdrop. "Keep and close"
        // above all: it would close the wizard over a removal that still
        // completes, leaving the user looking at a project they chose to keep
        // sections in while those sections disappear behind them.
        onClose={() => { if (!withdrawInFlight) closeCancelConfirm(); }}
        data-testid="cancel-confirm-dialog"
        actions={
          <>
            <Button
              onClick={closeCancelConfirm}
              disabled={withdrawInFlight}
              className={importSecondaryButtonClass}
              data-testid="cancel-confirm-continue"
            >
              {pendingWithdrawCount > 0
                ? t('dialogs.dmpNewImport.cancelContinueEditing')
                : t('common.actions.continue')}
            </Button>
            <Button
              onClick={onCancel}
              disabled={withdrawInFlight}
              className={importSecondaryButtonClass}
              data-testid="confirm-cancel-button"
            >
              {pendingWithdrawCount > 0
                ? t('dialogs.dmpNewImport.cancelKeepAndClose')
                : t('common.actions.cancel')}
            </Button>
            {pendingWithdrawCount > 0 && (
              <Button
                variant="danger"
                disabled={withdrawInFlight}
                onClick={() => { void handleCancelWithRemoval(); }}
                data-testid="cancel-remove-button"
              >
                {t('dialogs.dmpNewImport.cancelRemoveAndClose')}
              </Button>
            )}
          </>
        }
      >
        <p data-testid="cancel-confirm-message">
          {pendingWithdrawCount > 0
            ? t('dialogs.dmpNewImport.cancelWizardMessage', { count: pendingWithdrawCount })
            : t('dialogs.dmpNewImport.cancelWizardNoImports')}
        </p>
        {/* Why the removal did not happen, where the user asked for it (#576
            NF-AN4-N2) - not in the panel behind this dialog. */}
        {withdrawalFailure && (
          <p className="mt-3 text-sm text-error" role="alert" data-testid="cancel-confirm-error">
            {withdrawalFailure.message}
          </p>
        )}
      </AlertDialog>

      {/* Back confirmation. No "keep" here: the step Back returns to re-imports
          from scratch on the way forward, so keeping would duplicate. */}
      <AlertDialog
        open={showBackConfirm}
        title={t('dialogs.dmpNewImport.backWizard')}
        onClose={() => { if (!withdrawInFlight) closeBackConfirm(); }}
        data-testid="back-confirm-dialog"
        actions={
          <>
            <Button
              onClick={closeBackConfirm}
              disabled={withdrawInFlight}
              className={importSecondaryButtonClass}
              data-testid="back-confirm-continue"
            >
              {t('common.actions.continue')}
            </Button>
            <Button
              variant="danger"
              disabled={withdrawInFlight}
              onClick={() => { void handleBackWithRemoval(); }}
              data-testid="confirm-back-button"
            >
              {pendingWithdrawCount > 0
                ? t('dialogs.dmpNewImport.backRemoveAndGo')
                : t('common.actions.back')}
            </Button>
          </>
        }
      >
        <p data-testid="back-confirm-message">
          {pendingWithdrawCount > 0
            ? t('dialogs.dmpNewImport.backWizardMessage', { count: pendingWithdrawCount })
            : t('dialogs.dmpNewImport.backWizardNoImports')}
        </p>
        {withdrawalFailure && (
          <p className="mt-3 text-sm text-error" role="alert" data-testid="back-confirm-error">
            {withdrawalFailure.message}
          </p>
        )}
      </AlertDialog>
    </DialogWrapper>
  );
}
