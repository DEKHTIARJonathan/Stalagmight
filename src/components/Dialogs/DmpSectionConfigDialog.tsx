import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Button } from '../common/Button';
import { Panel } from '../common/Panel';
import type { DmpFile, DmpShot } from '../../types/commands';
import type { DmpSelectionConfig } from './DmpSelectionDialog';
import type { Project, Station, StationRef, GpsCoordinates } from '../../types/project';
import { SectionMetadataForm } from '../common/SectionMetadataForm';
import { ShotTableEditor, type EditableShot } from '../common/ShotTableEditor';
import SectionPreview, { type MergePreviewConfig } from './SectionPreview';
import { parseGps, detectFormat, type GpsFormat } from '../../utils/gps';

/**
 * Placement configuration for a section.
 */
export type PlacementConfig =
  | { type: 'origin' }
  | { type: 'zeroDatum'; coordinates: GpsCoordinates; stationIndex: number }
  | { type: 'fromExisting'; importStation: number; existingStation: StationRef }
  | { type: 'manual'; alignStation: 'first' | 'last' };

/**
 * Configuration for a single imported section.
 */
export interface ImportedSectionConfig {
  sectionIndex: number;
  name: string;
  surveyor: string | null;
  date: string | null;
  color: string;
  direction: 'in' | 'out';
  shots: EditableShot[];
  placement: PlacementConfig;
}

/**
 * Section status for the left panel.
 */
type SectionStatus = 'placed' | 'not_placed' | 'errors';

interface DmpSectionConfigDialogProps {
  /** Parsed DMP file data */
  dmpFile: DmpFile;
  /** Configuration from Step 1 (section selection) */
  selectionConfig: DmpSelectionConfig;
  /** Called when user cancels the dialog */
  onCancel: () => void;
  /** Called when user goes back to Step 1 */
  onBack: () => void;
  /** Called when user completes import */
  onImport: (sections: ImportedSectionConfig[]) => void;
  /** Current project (null if new project) */
  project: Project | null;
  /** Computed stations from the project */
  stations: Station[];
}

/**
 * Default section colors for import.
 */
const SECTION_COLORS = [
  '#4ecdc4',
  '#ff6b6b',
  '#95a5a6',
  '#3498db',
  '#9b59b6',
  '#1abc9c',
  '#e67e22',
  '#f39c12',
];

/**
 * Convert DMP shots to EditableShots.
 */
function convertToEditableShots(shots: DmpShot[]): EditableShot[] {
  return shots
    .filter((shot) => shot.shot_type === 'Standard')
    .map((shot, index) => ({
      id: index,
      azimuth_in: shot.heading_in,
      azimuth_out: shot.heading_out,
      length: shot.length,
      depth_in: shot.depth_in,
      depth_out: shot.depth_out,
      pitch_in: shot.pitch_in,
      pitch_out: shot.pitch_out,
      left: shot.left || null,
      right: shot.right || null,
      up: shot.up || null,
      down: shot.down || null,
      comment: shot.comment || null,
      is_virtual: false,
    }));
}

/**
 * Step 2 of DMP Import: Configure each selected section.
 *
 * This dialog displays:
 * - Left panel: Collapsible section list with status icons
 * - Main panel: Section preview, parameters, placement options, shot table
 * - Footer: Navigation buttons
 *
 * Features:
 * - Click section in list to navigate directly
 * - Auto-save current section configuration on navigation
 * - Keyboard shortcuts: Ctrl+Enter (proceed), Ctrl+Arrow (navigate), Escape (cancel)
 */
export default function DmpSectionConfigDialog({
  dmpFile,
  selectionConfig,
  onCancel,
  onBack,
  onImport,
  project,
  stations: _stations,
}: DmpSectionConfigDialogProps) {
  // Get selected section indices in order
  const selectedIndices = useMemo(() => {
    return Array.from(selectionConfig.selectedIndices).sort((a, b) => a - b);
  }, [selectionConfig.selectedIndices]);

  // Current section index (within selectedIndices array)
  const [currentIndex, setCurrentIndex] = useState(0);

  // Left panel collapsed state
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(false);

  // Cancel confirmation dialog state
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  // Back confirmation dialog state
  const [showBackConfirm, setShowBackConfirm] = useState(false);

  // Delete shot confirmation state
  const [deleteConfirmState, setDeleteConfirmState] = useState<{
    visible: boolean;
    shotIndex: number;
    isMidSection: boolean;
  }>({ visible: false, shotIndex: -1, isMidSection: false });

  // Selected shot row index (syncs with preview)
  const [selectedShotIndex, setSelectedShotIndex] = useState<number | null>(null);

  // Undo/redo history for the current section
  type HistoryEntry = { shots: EditableShot[] };
  const historyRef = useRef<Map<number, { past: HistoryEntry[]; future: HistoryEntry[] }>>(new Map());

  // Get or initialize history for current section
  const getHistory = useCallback((sectionIndex: number) => {
    if (!historyRef.current.has(sectionIndex)) {
      historyRef.current.set(sectionIndex, { past: [], future: [] });
    }
    return historyRef.current.get(sectionIndex)!;
  }, []);

  /**
   * Store original DMP values for reset functionality.
   * These values remain constant throughout the dialog lifecycle.
   */
  const originalSectionValues = useMemo(() => {
    const originals = new Map<number, ImportedSectionConfig>();
    selectedIndices.forEach((sectionIdx, arrayIdx) => {
      const section = dmpFile.sections[sectionIdx];
      if (!section) return;

      // Get original direction from DMP
      const direction = section.direction;

      // Date from DMP only (not Step 1 override - that's for initial state)
      const dateStr = section.date?.split(/[T ]/)[0] ?? null;

      originals.set(sectionIdx, {
        sectionIndex: sectionIdx,
        name: section.name,
        surveyor: section.name || null, // Original surveyor from DMP (section name by default)
        date: dateStr,
        color: SECTION_COLORS[arrayIdx % SECTION_COLORS.length] ?? '#4ecdc4',
        direction,
        shots: convertToEditableShots(section.shots),
        placement: { type: 'origin' },
      });
    });
    return originals;
  }, [selectedIndices, dmpFile.sections]);

  // Initialize section configs for all selected sections
  const [sectionConfigs, setSectionConfigs] = useState<Map<number, ImportedSectionConfig>>(() => {
    const configs = new Map<number, ImportedSectionConfig>();
    selectedIndices.forEach((sectionIdx, arrayIdx) => {
      const section = dmpFile.sections[sectionIdx];
      if (!section) return;

      // Get effective direction (from Step 1 override or original)
      const direction = selectionConfig.sectionDirections.get(sectionIdx) ?? section.direction;

      // Get surveyor (from Step 1 default or section)
      const surveyor = selectionConfig.defaultSurveyor || section.name || null;

      // Get date (from Step 1 override, section, or null)
      const dateStr = selectionConfig.defaultDate ?? section.date?.split(/[T ]/)[0] ?? null;

      configs.set(sectionIdx, {
        sectionIndex: sectionIdx,
        name: section.name,
        surveyor,
        date: dateStr,
        color: SECTION_COLORS[arrayIdx % SECTION_COLORS.length] ?? '#4ecdc4',
        direction,
        shots: convertToEditableShots(section.shots),
        placement: { type: 'origin' },
      });
    });
    return configs;
  });

  // Track which sections have been "placed" (user has explicitly set placement)
  const [placedSections, setPlacedSections] = useState<Set<number>>(() => {
    // First section defaults to placed at origin
    const placed = new Set<number>();
    if (selectedIndices.length > 0 && selectedIndices[0] !== undefined) {
      placed.add(selectedIndices[0]);
    }
    return placed;
  });

  // ===== Placement Mode State =====
  // Zero Datum fields
  const [gpsInput, setGpsInput] = useState('');
  const [gpsCoords, setGpsCoords] = useState<GpsCoordinates | null>(null);
  const [gpsFormat, setGpsFormat] = useState<GpsFormat | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [gpsStationIndex, setGpsStationIndex] = useState(0);

  // From Existing fields
  const [importStationIndex, setImportStationIndex] = useState(0); // 0=first, -1=last
  const [targetSectionId, setTargetSectionId] = useState<number | null>(null);
  const [targetStationIndex, setTargetStationIndex] = useState(0);

  // Manual Placement fields
  const [manualAlignStation, setManualAlignStation] = useState<'first' | 'last'>('first');
  // Note: isPlacingOnMap will be used by fn-51-ctu.10 (Manual Placement Mode)
  const [_isPlacingOnMap, setIsPlacingOnMap] = useState(false);

  // Get current section data
  const currentSectionIndex = selectedIndices[currentIndex];
  const currentConfig = currentSectionIndex !== undefined
    ? sectionConfigs.get(currentSectionIndex)
    : undefined;
  const currentDmpSection = currentSectionIndex !== undefined
    ? dmpFile.sections[currentSectionIndex]
    : undefined;

  // Compute station count for the current section
  const currentShotCount = useMemo(() => {
    if (!currentConfig) return 0;
    return currentConfig.shots.filter((s) => !s.isDeleted).length;
  }, [currentConfig]);

  // Generate station options (0 to shotCount, since station N is after shot N-1)
  const stationOptions = useMemo(() => {
    const options: Array<{ value: number; label: string }> = [];
    for (let i = 0; i <= currentShotCount; i++) {
      options.push({ value: i, label: `Station ${i}` });
    }
    return options;
  }, [currentShotCount]);

  // Get existing sections from project (for "From Existing" mode)
  const existingSections = useMemo(() => {
    if (!project) return [];
    return project.sections;
  }, [project]);

  // Get stations for a selected existing section
  const getStationsForSection = useCallback(
    (sectionId: number): Array<{ value: number; label: string }> => {
      const section = existingSections.find((s) => s.id === sectionId);
      if (!section) return [];
      // Station count = shot count + 1
      const count = section.shots.length + 1;
      const options: Array<{ value: number; label: string }> = [];
      for (let i = 0; i < count; i++) {
        options.push({ value: i, label: `Station ${i}` });
      }
      return options;
    },
    [existingSections]
  );

  // Existing section options
  const existingSectionOptions = useMemo(() => {
    return existingSections.map((s) => ({
      value: s.id,
      label: s.name || `Section ${s.id}`,
    }));
  }, [existingSections]);

  // Target section stations (when a target section is selected)
  const targetSectionStations = useMemo(() => {
    if (targetSectionId === null) return [];
    return getStationsForSection(targetSectionId);
  }, [targetSectionId, getStationsForSection]);

  // Compute merge preview config for SectionPreview when "From Existing" is selected
  const mergePreviewConfig = useMemo((): MergePreviewConfig | null => {
    if (!currentConfig || currentConfig.placement.type !== 'fromExisting') {
      return null;
    }

    const placement = currentConfig.placement;
    const targetSection = existingSections.find((s) => s.id === placement.existingStation.section_id);

    if (!targetSection) {
      return null;
    }

    return {
      targetSection,
      importStationIndex: placement.importStation,
      targetStationIndex: placement.existingStation.station_index,
    };
  }, [currentConfig, existingSections]);

  /**
   * Handle GPS input change with auto-detection.
   */
  const handleGpsInputChange = useCallback((value: string) => {
    setGpsInput(value);

    if (!value.trim()) {
      setGpsCoords(null);
      setGpsFormat(null);
      setGpsError(null);
      return;
    }

    // Detect format for indicator
    const detected = detectFormat(value);
    setGpsFormat(detected || null);

    // Try to parse
    const result = parseGps(value);
    if ('coordinates' in result) {
      setGpsCoords(result.coordinates);
      setGpsError(null);
    } else {
      setGpsCoords(null);
      setGpsError(result.message);
    }
  }, []);

  /**
   * Update a field in the current section config.
   */
  const updateCurrentConfig = useCallback(
    (updates: Partial<ImportedSectionConfig>) => {
      if (currentSectionIndex === undefined) return;
      setSectionConfigs((prev) => {
        const next = new Map(prev);
        const current = next.get(currentSectionIndex);
        if (current) {
          next.set(currentSectionIndex, { ...current, ...updates });
        }
        return next;
      });
    },
    [currentSectionIndex]
  );

  /**
   * Save current state to undo history before making changes.
   */
  const saveToHistory = useCallback(() => {
    if (currentSectionIndex === undefined || !currentConfig) return;
    const history = getHistory(currentSectionIndex);
    // Deep copy current shots
    const snapshot = { shots: currentConfig.shots.map(s => ({ ...s })) };
    history.past.push(snapshot);
    // Clear future when new action is taken
    history.future = [];
    // Limit history size to 50 entries
    if (history.past.length > 50) {
      history.past.shift();
    }
  }, [currentSectionIndex, currentConfig, getHistory]);

  // Track if we've saved for the current editing session (for debouncing field edits)
  const lastSavedFieldRef = useRef<{ index: number; field: string } | null>(null);

  /**
   * Handle shot field change.
   * Saves to history on first change per field, debouncing subsequent edits.
   */
  const handleShotChange = useCallback(
    (shotIndex: number, field: keyof EditableShot, value: number | string | boolean | null) => {
      if (!currentConfig) return;

      // Save to history if this is a different field/row than last time
      const lastSaved = lastSavedFieldRef.current;
      if (!lastSaved || lastSaved.index !== shotIndex || lastSaved.field !== field) {
        saveToHistory();
        lastSavedFieldRef.current = { index: shotIndex, field: field as string };
      }

      const newShots = [...currentConfig.shots];
      const shot = newShots[shotIndex];
      if (shot) {
        newShots[shotIndex] = { ...shot, [field]: value };
        updateCurrentConfig({ shots: newShots });
      }
    },
    [currentConfig, updateCurrentConfig, saveToHistory]
  );

  /**
   * Add a new shot at the end.
   */
  const handleAddShot = useCallback(() => {
    if (!currentConfig) return;
    saveToHistory();
    const newShot: EditableShot = {
      id: -(currentConfig.shots.length + 1),
      azimuth_in: 0,
      azimuth_out: 180,
      length: 1,
      depth_in: 0,
      depth_out: 0,
      pitch_in: null,
      pitch_out: null,
      left: null,
      right: null,
      up: null,
      down: null,
      comment: null,
      is_virtual: false,
      isNew: true,
      tempId: Date.now(),
    };
    updateCurrentConfig({ shots: [...currentConfig.shots, newShot] });
  }, [currentConfig, updateCurrentConfig, saveToHistory]);

  /**
   * Undo the last shot table change.
   */
  const handleUndo = useCallback(() => {
    if (currentSectionIndex === undefined || !currentConfig) return;
    const history = getHistory(currentSectionIndex);
    if (history.past.length === 0) return;

    // Save current state to future
    const currentSnapshot = { shots: currentConfig.shots.map(s => ({ ...s })) };
    history.future.push(currentSnapshot);

    // Restore previous state
    const previousState = history.past.pop()!;
    updateCurrentConfig({ shots: previousState.shots });
  }, [currentSectionIndex, currentConfig, getHistory, updateCurrentConfig]);

  /**
   * Redo the last undone shot table change.
   */
  const handleRedo = useCallback(() => {
    if (currentSectionIndex === undefined || !currentConfig) return;
    const history = getHistory(currentSectionIndex);
    if (history.future.length === 0) return;

    // Save current state to past
    const currentSnapshot = { shots: currentConfig.shots.map(s => ({ ...s })) };
    history.past.push(currentSnapshot);

    // Restore future state
    const futureState = history.future.pop()!;
    updateCurrentConfig({ shots: futureState.shots });
  }, [currentSectionIndex, currentConfig, getHistory, updateCurrentConfig]);

  /**
   * Check if a shot is mid-section (not first or last visible shot).
   */
  const isMidSectionShot = useCallback((shotIndex: number) => {
    if (!currentConfig) return false;
    const visibleShots = currentConfig.shots
      .map((s, i) => ({ shot: s, index: i }))
      .filter(({ shot }) => !shot.isDeleted);
    if (visibleShots.length <= 2) return false;
    const visibleIdx = visibleShots.findIndex(({ index }) => index === shotIndex);
    return visibleIdx > 0 && visibleIdx < visibleShots.length - 1;
  }, [currentConfig]);

  /**
   * Request to delete a shot at the given index.
   * Shows confirmation for mid-section shots.
   */
  const handleDeleteShotRequest = useCallback(
    (shotIndex: number) => {
      if (!currentConfig) return;
      const midSection = isMidSectionShot(shotIndex);
      if (midSection) {
        setDeleteConfirmState({ visible: true, shotIndex, isMidSection: true });
      } else {
        // Delete directly for first/last shots
        saveToHistory();
        const newShots = [...currentConfig.shots];
        if (newShots[shotIndex]) {
          newShots[shotIndex] = { ...newShots[shotIndex]!, isDeleted: true };
          updateCurrentConfig({ shots: newShots });
        }
      }
    },
    [currentConfig, isMidSectionShot, saveToHistory, updateCurrentConfig]
  );

  /**
   * Confirm deletion of a mid-section shot.
   */
  const handleConfirmDelete = useCallback(() => {
    if (!currentConfig || deleteConfirmState.shotIndex < 0) return;
    saveToHistory();
    const newShots = [...currentConfig.shots];
    const idx = deleteConfirmState.shotIndex;
    if (newShots[idx]) {
      newShots[idx] = { ...newShots[idx]!, isDeleted: true };
      updateCurrentConfig({ shots: newShots });
    }
    setDeleteConfirmState({ visible: false, shotIndex: -1, isMidSection: false });
  }, [currentConfig, deleteConfirmState.shotIndex, saveToHistory, updateCurrentConfig]);

  /**
   * Insert a new shot before the given index.
   */
  const handleInsertBefore = useCallback(
    (shotIndex: number) => {
      if (!currentConfig) return;
      saveToHistory();
      const newShots = [...currentConfig.shots];
      const newShot: EditableShot = {
        id: -(Date.now()),
        azimuth_in: 0,
        azimuth_out: 180,
        length: 1,
        depth_in: 0,
        depth_out: 0,
        pitch_in: null,
        pitch_out: null,
        left: null,
        right: null,
        up: null,
        down: null,
        comment: null,
        is_virtual: false,
        isNew: true,
        tempId: Date.now(),
      };
      newShots.splice(shotIndex, 0, newShot);
      updateCurrentConfig({ shots: newShots });
    },
    [currentConfig, saveToHistory, updateCurrentConfig]
  );

  /**
   * Insert a new shot after the given index.
   */
  const handleInsertAfter = useCallback(
    (shotIndex: number) => {
      if (!currentConfig) return;
      saveToHistory();
      const newShots = [...currentConfig.shots];
      const newShot: EditableShot = {
        id: -(Date.now()),
        azimuth_in: 0,
        azimuth_out: 180,
        length: 1,
        depth_in: 0,
        depth_out: 0,
        pitch_in: null,
        pitch_out: null,
        left: null,
        right: null,
        up: null,
        down: null,
        comment: null,
        is_virtual: false,
        isNew: true,
        tempId: Date.now(),
      };
      newShots.splice(shotIndex + 1, 0, newShot);
      updateCurrentConfig({ shots: newShots });
    },
    [currentConfig, saveToHistory, updateCurrentConfig]
  );

  /**
   * Handle placement change.
   */
  const handlePlacementChange = useCallback(
    (placement: PlacementConfig) => {
      updateCurrentConfig({ placement });
      // Mark section as placed
      if (currentSectionIndex !== undefined) {
        setPlacedSections((prev) => new Set(prev).add(currentSectionIndex));
      }
    },
    [updateCurrentConfig, currentSectionIndex]
  );

  /**
   * Handle "Place" button for Place at 0,0 mode.
   */
  const handlePlaceAtOrigin = useCallback(() => {
    handlePlacementChange({ type: 'origin' });
  }, [handlePlacementChange]);

  /**
   * Handle "Place" button for Zero Datum mode.
   */
  const handlePlaceZeroDatum = useCallback(() => {
    if (!gpsCoords) return;
    handlePlacementChange({
      type: 'zeroDatum',
      coordinates: gpsCoords,
      stationIndex: gpsStationIndex,
    });
  }, [handlePlacementChange, gpsCoords, gpsStationIndex]);

  /**
   * Handle "Place" button for From Existing mode.
   */
  const handlePlaceFromExisting = useCallback(() => {
    if (targetSectionId === null) return;
    // Convert importStationIndex: 0=first, -1=last (actual index)
    const actualImportStation =
      importStationIndex === -1 ? currentShotCount : importStationIndex;
    handlePlacementChange({
      type: 'fromExisting',
      importStation: actualImportStation,
      existingStation: { section_id: targetSectionId, station_index: targetStationIndex },
    });
  }, [
    handlePlacementChange,
    importStationIndex,
    currentShotCount,
    targetSectionId,
    targetStationIndex,
  ]);

  /**
   * Handle "Start Placement" button for Manual mode.
   */
  const handleStartManualPlacement = useCallback(() => {
    handlePlacementChange({ type: 'manual', alignStation: manualAlignStation });
    setIsPlacingOnMap(true);
    // Note: In a full implementation, this would hide the dialog and
    // show a ghost outline on the map. For now, we just set the state.
  }, [handlePlacementChange, manualAlignStation]);

  /**
   * Handle station selection from preview click.
   * Used for Zero Datum mode station selection.
   * Note: This will be wired to SectionPreview's onStationClick prop in a future task.
   */
  // @ts-expect-error - Will be used by SectionPreview onStationClick in future task
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handlePreviewStationClick = useCallback(
    (stationIndex: number) => {
      if (currentConfig?.placement.type === 'zeroDatum') {
        setGpsStationIndex(stationIndex);
      }
    },
    [currentConfig?.placement.type]
  );

  /**
   * Reset current section to original DMP values.
   * Resets: name, surveyor, date, color, direction, shots, placement
   */
  const handleResetSection = useCallback(() => {
    if (currentSectionIndex === undefined) return;

    const original = originalSectionValues.get(currentSectionIndex);
    if (!original) return;

    // Reset to original values (deep copy shots array)
    setSectionConfigs((prev) => {
      const next = new Map(prev);
      next.set(currentSectionIndex, {
        ...original,
        shots: original.shots.map((shot) => ({ ...shot })),
        placement: { type: 'origin' },
      });
      return next;
    });

    // Remove from placed sections (clear placement)
    setPlacedSections((prev) => {
      const next = new Set(prev);
      next.delete(currentSectionIndex);
      return next;
    });
  }, [currentSectionIndex, originalSectionValues]);

  /**
   * Get section status for display in the left panel.
   */
  const getSectionStatus = useCallback(
    (sectionIndex: number): SectionStatus => {
      const config = sectionConfigs.get(sectionIndex);
      if (!config) return 'not_placed';

      // Check for errors (e.g., empty shots)
      const validShots = config.shots.filter((s) => !s.isDeleted);
      if (validShots.length === 0) return 'errors';

      // Check if placed
      if (placedSections.has(sectionIndex)) return 'placed';

      return 'not_placed';
    },
    [sectionConfigs, placedSections]
  );

  /**
   * Navigate to a specific section.
   */
  const navigateToSection = useCallback(
    (arrayIndex: number) => {
      if (arrayIndex >= 0 && arrayIndex < selectedIndices.length) {
        setCurrentIndex(arrayIndex);
      }
    },
    [selectedIndices.length]
  );

  /**
   * Navigate to previous section.
   */
  const handlePrevious = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    }
  }, [currentIndex]);

  /**
   * Navigate to next section or trigger import.
   */
  const handleNext = useCallback(() => {
    if (currentIndex < selectedIndices.length - 1) {
      // Mark current section as placed if not already
      if (currentSectionIndex !== undefined) {
        setPlacedSections((prev) => new Set(prev).add(currentSectionIndex));
      }
      setCurrentIndex(currentIndex + 1);
    } else {
      // Last section - trigger import
      const sections = Array.from(sectionConfigs.values()).map((config) => ({
        ...config,
        shots: config.shots.filter((s) => !s.isDeleted),
      }));
      onImport(sections);
    }
  }, [currentIndex, selectedIndices.length, currentSectionIndex, sectionConfigs, onImport]);

  /**
   * Handle cancel with confirmation.
   */
  const handleCancel = useCallback(() => {
    setShowCancelConfirm(true);
  }, []);

  /**
   * Handle back to Step 1 with confirmation.
   */
  const handleBack = useCallback(() => {
    setShowBackConfirm(true);
  }, []);

  /**
   * Keyboard shortcuts handler.
   */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape - cancel (with confirmation)
      if (e.key === 'Escape' && !e.repeat) {
        e.preventDefault();
        if (showCancelConfirm || showBackConfirm) {
          setShowCancelConfirm(false);
          setShowBackConfirm(false);
        } else {
          handleCancel();
        }
        return;
      }

      // Ctrl+Enter - proceed (Next or Import)
      if (e.key === 'Enter' && e.ctrlKey && !e.repeat) {
        e.preventDefault();
        handleNext();
        return;
      }

      // Ctrl+ArrowLeft - previous section
      if (e.key === 'ArrowLeft' && e.ctrlKey && !e.repeat) {
        e.preventDefault();
        handlePrevious();
        return;
      }

      // Ctrl+ArrowRight - next section
      if (e.key === 'ArrowRight' && e.ctrlKey && !e.repeat) {
        e.preventDefault();
        if (currentIndex < selectedIndices.length - 1) {
          navigateToSection(currentIndex + 1);
        }
        return;
      }

      // Ctrl+Z - undo (shot table changes)
      if (e.key === 'z' && e.ctrlKey && !e.shiftKey && !e.repeat) {
        e.preventDefault();
        handleUndo();
        return;
      }

      // Ctrl+Shift+Z or Ctrl+Y - redo (shot table changes)
      if (((e.key === 'z' || e.key === 'Z') && e.ctrlKey && e.shiftKey) ||
          (e.key === 'y' && e.ctrlKey && !e.repeat)) {
        e.preventDefault();
        handleRedo();
        return;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [
    currentIndex,
    selectedIndices.length,
    handleCancel,
    handleNext,
    handlePrevious,
    navigateToSection,
    showCancelConfirm,
    showBackConfirm,
    handleUndo,
    handleRedo,
  ]);

  // Count sections with errors
  const errorCount = useMemo(() => {
    return selectedIndices.filter((idx) => getSectionStatus(idx) === 'errors').length;
  }, [selectedIndices, getSectionStatus]);

  // Is this the last section?
  const isLastSection = currentIndex === selectedIndices.length - 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={handleCancel}
      />

      {/* Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="dmp-section-config-dialog-title"
        data-testid="dmp-section-config-dialog"
        className="relative bg-panel border border-border rounded-lg shadow-xl flex flex-col"
        style={{ width: 900, height: 700 }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 id="dmp-section-config-dialog-title" className="text-lg font-medium">
            Import DMP File (Step 2)
          </h2>
          <button
            type="button"
            onClick={handleCancel}
            className="text-text-secondary hover:text-text-primary text-xl"
            aria-label="Close dialog"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left Panel - Section List */}
          <div
            className={`border-r border-border flex flex-col transition-all ${
              leftPanelCollapsed ? 'w-10' : 'w-48'
            }`}
            data-testid="section-list-panel"
          >
            {/* Collapse/Expand button */}
            <button
              type="button"
              onClick={() => setLeftPanelCollapsed(!leftPanelCollapsed)}
              className="px-2 py-2 text-sm text-text-secondary hover:text-text-primary border-b border-border"
              aria-label={leftPanelCollapsed ? 'Expand section list' : 'Collapse section list'}
              data-testid="collapse-section-list-button"
            >
              {leftPanelCollapsed ? '▶' : '◀ Sections'}
            </button>

            {/* Section list */}
            {!leftPanelCollapsed && (
              <div className="flex-1 overflow-auto">
                {selectedIndices.map((sectionIdx, arrayIdx) => {
                  const section = dmpFile.sections[sectionIdx];
                  const status = getSectionStatus(sectionIdx);
                  const isActive = arrayIdx === currentIndex;

                  // Status icon
                  let statusIcon: string;
                  let statusColor: string;
                  if (status === 'placed') {
                    statusIcon = '✓';
                    statusColor = 'text-success';
                  } else if (status === 'errors') {
                    statusIcon = '!';
                    statusColor = 'text-error';
                  } else {
                    statusIcon = '○';
                    statusColor = 'text-text-secondary';
                  }

                  return (
                    <button
                      key={sectionIdx}
                      type="button"
                      onClick={() => navigateToSection(arrayIdx)}
                      className={`w-full px-3 py-2 text-left text-sm flex items-center gap-2 hover:bg-background/50 ${
                        isActive ? 'bg-accent/10 border-l-2 border-accent' : ''
                      }`}
                      data-testid={`section-list-item-${arrayIdx}`}
                    >
                      <span className={statusColor} data-testid={`section-status-${arrayIdx}`}>
                        {statusIcon}
                      </span>
                      <span className="truncate flex-1">{section?.name ?? `Section ${arrayIdx + 1}`}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Error count indicator */}
            {!leftPanelCollapsed && errorCount > 0 && (
              <div className="px-3 py-2 text-xs text-error border-t border-border">
                {errorCount} section{errorCount > 1 ? 's' : ''} with errors
              </div>
            )}
          </div>

          {/* Main Panel */}
          <div className="flex-1 flex flex-col overflow-hidden p-4" data-testid="main-config-panel">
            {currentConfig && currentDmpSection ? (
              <>
                {/* Section header */}
                <div className="flex items-center gap-4 mb-4">
                  <h3 className="font-medium text-lg">
                    Section: {currentConfig.name}
                  </h3>
                  <span className="text-sm text-text-secondary">
                    ({currentIndex + 1} of {selectedIndices.length})
                  </span>
                </div>

                {/* Top row: Preview + Parameters */}
                <div className="flex gap-4 mb-4">
                  {/* Preview */}
                  <div className="flex-shrink-0">
                    <SectionPreview
                      section={currentDmpSection}
                      color={currentConfig.color}
                      size={200}
                      selectedStationIndex={
                        selectedShotIndex !== null ? selectedShotIndex + 1 : null
                      }
                      mergePreview={mergePreviewConfig}
                      onStationClick={(stationIndex) => {
                        // Station N corresponds to shot N-1 (station 0 has no corresponding shot)
                        if (stationIndex > 0) {
                          setSelectedShotIndex(stationIndex - 1);
                        } else {
                          setSelectedShotIndex(null);
                        }
                      }}
                    />
                  </div>

                  {/* Parameters */}
                  <Panel title="Parameters" className="flex-1">
                    <div className="space-y-3">
                      <SectionMetadataForm
                        name={currentConfig.name}
                        surveyor={currentConfig.surveyor ?? ''}
                        date={currentConfig.date ?? ''}
                        color={currentConfig.color}
                        direction={currentConfig.direction}
                        onNameChange={(value) => updateCurrentConfig({ name: value })}
                        onSurveyorChange={(value) => updateCurrentConfig({ surveyor: value || null })}
                        onDateChange={(value) => updateCurrentConfig({ date: value || null })}
                        onColorChange={(value) => updateCurrentConfig({ color: value })}
                        onDirectionChange={(value) => updateCurrentConfig({ direction: value })}
                        showDirection
                      />
                      <div className="flex justify-end">
                        <Button
                          size="sm"
                          onClick={handleResetSection}
                          data-testid="reset-section-button"
                          title="Reset all fields and placement to original DMP values"
                        >
                          Reset Section
                        </Button>
                      </div>
                    </div>
                  </Panel>
                </div>

                {/* Placement options */}
                <Panel title="Placement" className="mb-4" data-testid="placement-panel">
                  <div className="space-y-3">
                    {/* Place at 0,0 */}
                    <div
                      className={`p-3 rounded border ${
                        currentConfig.placement.type === 'origin'
                          ? 'border-accent bg-accent/5'
                          : 'border-border'
                      }`}
                      data-testid="placement-mode-origin"
                    >
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="placement"
                          checked={currentConfig.placement.type === 'origin'}
                          onChange={() => handlePlacementChange({ type: 'origin' })}
                          data-testid="placement-origin"
                        />
                        <span className="font-medium">Place at 0,0</span>
                      </label>
                      {currentConfig.placement.type === 'origin' && (
                        <div className="mt-2 ml-6 flex items-center justify-between">
                          <span className="text-sm text-text-secondary">
                            First station at origin
                          </span>
                          <Button
                            size="sm"
                            onClick={handlePlaceAtOrigin}
                            data-testid="place-origin-button"
                          >
                            Place
                          </Button>
                        </div>
                      )}
                    </div>

                    {/* Zero Datum (GPS) */}
                    <div
                      className={`p-3 rounded border ${
                        currentConfig.placement.type === 'zeroDatum'
                          ? 'border-accent bg-accent/5'
                          : 'border-border'
                      }`}
                      data-testid="placement-mode-zero-datum"
                    >
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="placement"
                          checked={currentConfig.placement.type === 'zeroDatum'}
                          onChange={() =>
                            handlePlacementChange({
                              type: 'zeroDatum',
                              coordinates: gpsCoords || { latitude: 0, longitude: 0, depth_reference: 0 },
                              stationIndex: gpsStationIndex,
                            })
                          }
                          data-testid="placement-zero-datum"
                        />
                        <span className="font-medium">Zero Datum (GPS)</span>
                      </label>
                      {currentConfig.placement.type === 'zeroDatum' && (
                        <div className="mt-3 ml-6 space-y-3">
                          {/* GPS Input */}
                          <div className="flex items-center gap-2">
                            <label className="text-sm text-text-secondary w-12">GPS:</label>
                            <input
                              type="text"
                              value={gpsInput}
                              onChange={(e) => handleGpsInputChange(e.target.value)}
                              placeholder="48.8584, 2.2945"
                              className="flex-1 px-2 py-1 bg-background border border-border rounded text-sm"
                              data-testid="gps-input"
                            />
                            {gpsFormat && (
                              <span
                                className="text-xs px-2 py-1 bg-accent/10 text-accent rounded"
                                data-testid="gps-format-indicator"
                              >
                                {gpsFormat}
                              </span>
                            )}
                          </div>
                          {gpsError && (
                            <div className="text-xs text-error ml-14" data-testid="gps-error">
                              {gpsError}
                            </div>
                          )}
                          {gpsCoords && (
                            <div className="text-xs text-success ml-14" data-testid="gps-parsed">
                              Lat: {gpsCoords.latitude.toFixed(6)}, Lon: {gpsCoords.longitude.toFixed(6)}
                            </div>
                          )}

                          {/* Station Selection */}
                          <div className="flex items-center gap-2">
                            <label className="text-sm text-text-secondary w-12">Station:</label>
                            <select
                              value={gpsStationIndex}
                              onChange={(e) => setGpsStationIndex(parseInt(e.target.value, 10))}
                              className="px-2 py-1 bg-background border border-border rounded text-sm"
                              data-testid="gps-station-select"
                            >
                              {stationOptions.map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                            <Button
                              size="sm"
                              onClick={handlePlaceZeroDatum}
                              disabled={!gpsCoords}
                              data-testid="place-zero-datum-button"
                            >
                              Place
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* From Existing */}
                    <div
                      className={`p-3 rounded border ${
                        currentConfig.placement.type === 'fromExisting'
                          ? 'border-accent bg-accent/5'
                          : 'border-border'
                      } ${!project || existingSections.length === 0 ? 'opacity-50' : ''}`}
                      data-testid="placement-mode-existing"
                    >
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="placement"
                          checked={currentConfig.placement.type === 'fromExisting'}
                          onChange={() =>
                            handlePlacementChange({
                              type: 'fromExisting',
                              importStation: importStationIndex === -1 ? currentShotCount : importStationIndex,
                              existingStation: {
                                section_id: targetSectionId || 0,
                                station_index: targetStationIndex,
                              },
                            })
                          }
                          disabled={!project || existingSections.length === 0}
                          data-testid="placement-from-existing"
                        />
                        <span className="font-medium">From Existing Station</span>
                        {(!project || existingSections.length === 0) && (
                          <span className="text-xs text-text-secondary">(no existing sections)</span>
                        )}
                      </label>
                      {currentConfig.placement.type === 'fromExisting' && (
                        <div className="mt-3 ml-6 space-y-3">
                          {/* This section station */}
                          <div className="flex items-center gap-2 flex-wrap">
                            <label className="text-sm text-text-secondary">Connect:</label>
                            <select
                              value={importStationIndex}
                              onChange={(e) => setImportStationIndex(parseInt(e.target.value, 10))}
                              className="px-2 py-1 bg-background border border-border rounded text-sm"
                              data-testid="import-station-select"
                            >
                              <option value={0}>First station (0)</option>
                              <option value={-1}>Last station ({currentShotCount})</option>
                            </select>
                            <span className="text-sm text-text-secondary">to</span>
                          </div>

                          {/* Target section and station */}
                          <div className="flex items-center gap-2 flex-wrap">
                            <select
                              value={targetSectionId ?? ''}
                              onChange={(e) => {
                                const val = e.target.value;
                                setTargetSectionId(val ? parseInt(val, 10) : null);
                                setTargetStationIndex(0);
                              }}
                              className="px-2 py-1 bg-background border border-border rounded text-sm"
                              data-testid="target-section-select"
                            >
                              <option value="">Select section...</option>
                              {existingSectionOptions.map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                            <select
                              value={targetStationIndex}
                              onChange={(e) => setTargetStationIndex(parseInt(e.target.value, 10))}
                              className="px-2 py-1 bg-background border border-border rounded text-sm"
                              disabled={targetSectionId === null}
                              data-testid="target-station-select"
                            >
                              {targetSectionStations.length === 0 ? (
                                <option value={0}>Select station...</option>
                              ) : (
                                targetSectionStations.map((opt) => (
                                  <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </option>
                                ))
                              )}
                            </select>
                            <Button
                              size="sm"
                              onClick={handlePlaceFromExisting}
                              disabled={targetSectionId === null}
                              data-testid="place-from-existing-button"
                            >
                              Place
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Manual Placement */}
                    <div
                      className={`p-3 rounded border ${
                        currentConfig.placement.type === 'manual'
                          ? 'border-accent bg-accent/5'
                          : 'border-border'
                      }`}
                      data-testid="placement-mode-manual"
                    >
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="placement"
                          checked={currentConfig.placement.type === 'manual'}
                          onChange={() => handlePlacementChange({ type: 'manual', alignStation: manualAlignStation })}
                          data-testid="placement-manual"
                        />
                        <span className="font-medium">Manual Placement</span>
                      </label>
                      {currentConfig.placement.type === 'manual' && (
                        <div className="mt-3 ml-6 space-y-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            <label className="text-sm text-text-secondary">Align:</label>
                            <select
                              value={manualAlignStation}
                              onChange={(e) => setManualAlignStation(e.target.value as 'first' | 'last')}
                              className="px-2 py-1 bg-background border border-border rounded text-sm"
                              data-testid="manual-align-select"
                            >
                              <option value="first">First station</option>
                              <option value="last">Last station</option>
                            </select>
                            <span className="text-sm text-text-secondary">with cursor</span>
                            <Button
                              size="sm"
                              onClick={handleStartManualPlacement}
                              data-testid="start-placement-button"
                            >
                              Place on Map
                            </Button>
                          </div>
                          <p className="text-xs text-text-secondary">
                            Click on the map to position the section. Press Esc or right-click to cancel.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </Panel>

                {/* Shot table */}
                <Panel title="Shot Table" className="flex-1 min-h-0 flex flex-col">
                  <div className="flex-1 overflow-auto">
                    <ShotTableEditor
                      shots={currentConfig.shots}
                      onShotChange={handleShotChange}
                      onAddShot={handleAddShot}
                      onDeleteShot={handleDeleteShotRequest}
                      onInsertBefore={handleInsertBefore}
                      onInsertAfter={handleInsertAfter}
                      selectedRowIndex={selectedShotIndex}
                      onRowSelect={setSelectedShotIndex}
                      maxHeight="calc(100% - 2rem)"
                    />
                  </div>
                </Panel>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-text-secondary">
                No section selected
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border flex justify-between items-center">
          <div className="flex gap-2">
            <Button onClick={handleCancel} data-testid="cancel-button">
              Cancel
            </Button>
            <Button onClick={handleBack} data-testid="back-to-selection-button">
              ← Back to Selection
            </Button>
          </div>
          <div className="flex gap-2">
            <Button
              onClick={handlePrevious}
              disabled={currentIndex === 0}
              data-testid="previous-section-button"
            >
              Previous
            </Button>
            <Button
              variant="primary"
              onClick={handleNext}
              data-testid={isLastSection ? 'import-button' : 'next-section-button'}
            >
              {isLastSection ? `Import ${selectedIndices.length} Section${selectedIndices.length > 1 ? 's' : ''}` : 'Next'}
            </Button>
          </div>
        </div>
      </div>

      {/* Cancel confirmation dialog */}
      {showCancelConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowCancelConfirm(false)} />
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="cancel-confirm-title"
            className="relative bg-panel border border-border rounded-lg shadow-xl max-w-sm w-full mx-4"
            data-testid="cancel-confirm-dialog"
          >
            <div className="px-4 py-3 border-b border-border">
              <h2 id="cancel-confirm-title" className="text-lg font-medium">Cancel Import?</h2>
            </div>
            <div className="p-4 space-y-4">
              <p>Are you sure you want to cancel the import?</p>
              <p className="text-text-secondary text-sm">All section configurations will be lost.</p>
              <div className="flex justify-end gap-2 pt-4 border-t border-border">
                <Button onClick={() => setShowCancelConfirm(false)}>Continue Editing</Button>
                <Button variant="danger" onClick={onCancel} data-testid="confirm-cancel-button">
                  Cancel Import
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Back confirmation dialog */}
      {showBackConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowBackConfirm(false)} />
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="back-confirm-title"
            className="relative bg-panel border border-border rounded-lg shadow-xl max-w-sm w-full mx-4"
            data-testid="back-confirm-dialog"
          >
            <div className="px-4 py-3 border-b border-border">
              <h2 id="back-confirm-title" className="text-lg font-medium">Go Back?</h2>
            </div>
            <div className="p-4 space-y-4">
              <p>Go back to section selection?</p>
              <p className="text-text-secondary text-sm">All section configurations will be lost.</p>
              <div className="flex justify-end gap-2 pt-4 border-t border-border">
                <Button onClick={() => setShowBackConfirm(false)}>Continue Editing</Button>
                <Button variant="danger" onClick={onBack} data-testid="confirm-back-button">
                  Go Back
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete shot confirmation dialog (for mid-section shots) */}
      {deleteConfirmState.visible && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setDeleteConfirmState({ visible: false, shotIndex: -1, isMidSection: false })}
          />
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-shot-confirm-title"
            className="relative bg-panel border border-border rounded-lg shadow-xl max-w-sm w-full mx-4"
            data-testid="delete-shot-confirm-dialog"
          >
            <div className="px-4 py-3 border-b border-border">
              <h2 id="delete-shot-confirm-title" className="text-lg font-medium">Delete Shot?</h2>
            </div>
            <div className="p-4 space-y-4">
              <p>Are you sure you want to delete this shot?</p>
              <p className="text-text-secondary text-sm">
                This is a mid-section shot. Deleting it will affect the survey chain.
              </p>
              <div className="flex justify-end gap-2 pt-4 border-t border-border">
                <Button
                  onClick={() => setDeleteConfirmState({ visible: false, shotIndex: -1, isMidSection: false })}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  onClick={handleConfirmDelete}
                  data-testid="confirm-delete-shot-button"
                >
                  Delete Shot
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
