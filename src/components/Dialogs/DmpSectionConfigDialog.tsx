import { useState, useEffect, useMemo, useCallback } from 'react';
import { Button } from '../common/Button';
import { Panel } from '../common/Panel';
import type { DmpFile } from '../../types/commands';
import type { DmpSelectionConfig } from './DmpSelectionDialog';
import type { Project, Station } from '../../types/project';
import { SectionMetadataForm } from '../common/SectionMetadataForm';
import { ShotTableEditor, type EditableShot } from '../common/ShotTableEditor';
import { Select, type SelectOptionGroup } from '../common/Select';
import SectionPreview, { type MergePreviewConfig } from './SectionPreview';
import { parseGps, detectFormat, type GpsFormat } from '../../utils/gps';
import { useUIStore, type PlacementResult } from '../../store/uiStore';
import {
  useImportState,
  type PlacementConfig,
  type SectionConfig,
} from '../../hooks/useImportState';

// Re-export types from the hook for backwards compatibility
export type { PlacementConfig } from '../../hooks/useImportState';

/**
 * Configuration for a single imported section.
 * Alias to SectionConfig from useImportState for backwards compatibility.
 */
export type ImportedSectionConfig = SectionConfig;

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
  // Get placement mode controls from UI store
  const { startPlacementMode, closeDialog, openDialog, dialogData, getMapViewportCenter } = useUIStore();

  // Check for saved state from dialogData (for restoring after placement mode)
  const savedSectionConfigs = dialogData.savedSectionConfigs as Array<[number, SectionConfig]> | undefined;
  const savedPlacedSections = dialogData.savedPlacedSections as number[] | undefined;
  const savedExcludedSections = dialogData.savedExcludedSections as number[] | undefined;
  const savedCurrentIndex = dialogData.savedCurrentIndex as number | undefined;

  // Use the import state hook for all state management
  const importState = useImportState(
    dmpFile,
    selectionConfig,
    savedSectionConfigs && savedPlacedSections && savedCurrentIndex !== undefined
      ? {
          sectionConfigs: savedSectionConfigs,
          placedSections: savedPlacedSections,
          excludedSections: savedExcludedSections ?? [],
          currentSectionIndex: savedCurrentIndex,
        }
      : undefined
  );

  const {
    currentConfig,
    currentSectionIndex,
    currentArrayIndex,
    selectedIndices,
    // canUndo and canRedo are available for UI indicators when needed
    canUndo: _canUndo,
    canRedo: _canRedo,
    navigateToArrayIndex,
    navigateToSection: navigateToSectionIndex,  // Takes section index
    updateSectionField,
    updateShot,
    addShot,
    deleteShot: deleteImportShot,
    insertShotBefore,
    insertShotAfter,
    setPlacement,
    markPlaced,
    excludeSection,
    includeSection,
    undo,
    redo,
    resetSection,
    serializeSectionConfigs,
    serializePlacedSections,
    serializeExcludedSections,
    getSectionStatus,
    getAllConfigs,
    getPlacedSectionConfigs,
    getSectionDataErrorCount,
    getTotalDataErrorCount,
    getNextUnplacedSection,
    allSectionsExcluded,
  } = importState;

  // Access sectionConfigs and placedSections via importState.state for manual placement callbacks
  const { sectionConfigs: _sectionConfigs, placedSections: _placedSections } = importState.state;
  void _sectionConfigs; // Used in manual placement serialization via hook functions
  void _placedSections; // Used in manual placement serialization via hook functions

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

  // ===== Placement Mode State =====
  // Zero Datum fields
  const [gpsInput, setGpsInput] = useState('');
  const [gpsCoords, setGpsCoords] = useState<{ latitude: number; longitude: number; depth_reference: number } | null>(null);
  const [gpsFormat, setGpsFormat] = useState<GpsFormat | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [gpsStationIndex, setGpsStationIndex] = useState(0);

  // From Existing fields
  const [importStationIndex, setImportStationIndex] = useState(0); // 0=first, -1=last
  // Target can be existing section ID (number as string) or importing section ("import-X")
  const [targetSectionRef, setTargetSectionRef] = useState<string>('');
  const [targetStationIndex, setTargetStationIndex] = useState(0);

  // Manual Placement fields
  const [manualAlignStation, setManualAlignStation] = useState<'first' | 'last'>('first');

  // Get current DMP section data
  const currentDmpSection = currentSectionIndex !== undefined
    ? dmpFile.sections[currentSectionIndex]
    : undefined;

  // Alias for backward compatibility with currentIndex
  const currentIndex = currentArrayIndex;

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

  // Placed sections from current import (for "From existing" dropdown)
  // Exclude the current section being configured
  const importingSectionOptions = useMemo(() => {
    const placedConfigs = getPlacedSectionConfigs();
    return placedConfigs
      .filter((config) => config.sectionIndex !== currentSectionIndex)
      .map((config) => ({
        value: `import-${config.sectionIndex}`,
        label: `${config.name} (importing)`,
        stationCount: config.stationCount,
      }));
  }, [getPlacedSectionConfigs, currentSectionIndex]);

  // Get stations for an importing section
  const getStationsForImportingSection = useCallback(
    (sectionIndex: number): Array<{ value: number; label: string }> => {
      const config = getPlacedSectionConfigs().find((c) => c.sectionIndex === sectionIndex);
      if (!config) return [];
      // stationCount is already shots + 1, don't add +1 again
      const count = config.stationCount;
      const options: Array<{ value: number; label: string }> = [];
      for (let i = 0; i < count; i++) {
        options.push({ value: i, label: `Station ${i}` });
      }
      return options;
    },
    [getPlacedSectionConfigs]
  );

  // Target section stations (when a target section is selected)
  const targetSectionStations = useMemo(() => {
    if (!targetSectionRef) return [];

    // Check if it's an importing section
    if (targetSectionRef.startsWith('import-')) {
      const sectionIndex = parseInt(targetSectionRef.replace('import-', ''), 10);
      return getStationsForImportingSection(sectionIndex);
    }

    // Otherwise it's an existing section ID
    const sectionId = parseInt(targetSectionRef, 10);
    return getStationsForSection(sectionId);
  }, [targetSectionRef, getStationsForSection, getStationsForImportingSection]);

  // Compute merge preview config for SectionPreview when "From Existing" is selected
  // Uses local dropdown state for real-time preview updates
  const mergePreviewConfig = useMemo((): MergePreviewConfig | null => {
    if (!currentConfig) return null;

    const placementType = currentConfig.placement.type;
    if (placementType !== 'fromExisting' && placementType !== 'fromImporting') {
      return null;
    }

    // Use local dropdown state for preview (updates in real-time)
    if (!targetSectionRef) return null;

    // Calculate actual import station index
    const actualImportStation = importStationIndex === -1 ? currentShotCount : importStationIndex;

    // Handle existing sections
    if (!targetSectionRef.startsWith('import-')) {
      const sectionId = parseInt(targetSectionRef, 10);
      const targetSection = existingSections.find((s) => s.id === sectionId);
      if (!targetSection) return null;

      return {
        targetSection,
        importStationIndex: actualImportStation,
        targetStationIndex,
      };
    }

    // Handle importing sections (from current import)
    const targetIdx = parseInt(targetSectionRef.replace('import-', ''), 10);
    const targetConfig = getPlacedSectionConfigs().find((c) => c.sectionIndex === targetIdx);
    if (!targetConfig) return null;

    // Get DMP shots and convert to Shot-like format for preview
    const dmpShots = dmpFile.sections[targetIdx]?.shots.filter(s => s.shot_type === 'Standard') || [];
    const convertedShots = dmpShots.map((shot, idx) => ({
      id: idx,
      azimuth_in: shot.heading_in,
      azimuth_out: shot.heading_out,
      length: shot.length,
      depth_in: shot.depth_in,
      depth_out: shot.depth_out,
      pitch_in: shot.pitch_in ?? null,
      pitch_out: shot.pitch_out ?? null,
      left: shot.left ?? null,
      right: shot.right ?? null,
      up: shot.up ?? null,
      down: shot.down ?? null,
      comment: shot.comment ?? null,
      is_virtual: false,
      marker_index: null,
      temperature: null,
    }));

    // Create a pseudo-section for the importing section preview
    const importingSection = {
      id: -targetIdx - 1, // Negative ID to distinguish from real sections
      name: targetConfig.name,
      shots: convertedShots,
    };

    return {
      targetSection: importingSection as any,
      importStationIndex: actualImportStation,
      targetStationIndex,
    };
  }, [currentConfig, existingSections, targetSectionRef, targetStationIndex, importStationIndex, currentShotCount, getPlacedSectionConfigs, dmpFile.sections]);

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
   * Handle shot field change.
   * Uses the hook's updateShot action.
   */
  const handleShotChange = useCallback(
    (shotIndex: number, field: keyof EditableShot, value: number | string | boolean | null) => {
      updateShot(shotIndex, field, value);
    },
    [updateShot]
  );

  /**
   * Add a new shot at the end.
   * Uses the hook's addShot action.
   */
  const handleAddShot = useCallback(() => {
    addShot();
  }, [addShot]);

  /**
   * Undo the last change.
   * Uses the hook's undo action.
   */
  const handleUndo = useCallback(() => {
    undo();
  }, [undo]);

  /**
   * Redo the last undone change.
   * Uses the hook's redo action.
   */
  const handleRedo = useCallback(() => {
    redo();
  }, [redo]);

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
        deleteImportShot(shotIndex);
      }
    },
    [currentConfig, isMidSectionShot, deleteImportShot]
  );

  /**
   * Confirm deletion of a mid-section shot.
   */
  const handleConfirmDelete = useCallback(() => {
    if (!currentConfig || deleteConfirmState.shotIndex < 0) return;
    deleteImportShot(deleteConfirmState.shotIndex);
    setDeleteConfirmState({ visible: false, shotIndex: -1, isMidSection: false });
  }, [currentConfig, deleteConfirmState.shotIndex, deleteImportShot]);

  /**
   * Insert a new shot before the given index.
   * Uses the hook's insertShotBefore action.
   */
  const handleInsertBefore = useCallback(
    (shotIndex: number) => {
      insertShotBefore(shotIndex);
    },
    [insertShotBefore]
  );

  /**
   * Insert a new shot after the given index.
   * Uses the hook's insertShotAfter action.
   */
  const handleInsertAfter = useCallback(
    (shotIndex: number) => {
      insertShotAfter(shotIndex);
    },
    [insertShotAfter]
  );

  /**
   * Handle placement change.
   * Uses the hook's setPlacement action.
   */
  const handlePlacementChange = useCallback(
    (placement: PlacementConfig) => {
      setPlacement(placement);
    },
    [setPlacement]
  );

  /**
   * Handle placement at viewport center (used for "Place at center of screen" option).
   * Gets the current map viewport center and sets that as the section position.
   */
  const handlePlaceAtViewportCenter = useCallback(() => {
    const center = getMapViewportCenter();
    handlePlacementChange({
      type: 'manual',
      alignStation: 'first',
      position: { x: center.x, y: center.y, z: 0 },
    });
  }, [handlePlacementChange, getMapViewportCenter]);

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
   * Supports both existing sections (in project) and importing sections (from current import).
   */
  const handlePlaceFromExisting = useCallback(() => {
    if (!targetSectionRef) return;

    // Convert importStationIndex: 0=first, -1=last (actual index)
    const actualImportStation =
      importStationIndex === -1 ? currentShotCount : importStationIndex;

    // Check if it's an importing section
    if (targetSectionRef.startsWith('import-')) {
      const targetSectionIndex = parseInt(targetSectionRef.replace('import-', ''), 10);
      handlePlacementChange({
        type: 'fromImporting',
        importStation: actualImportStation,
        targetSectionIndex,
        targetStationIndex,
      });
    } else {
      // It's an existing section
      const sectionId = parseInt(targetSectionRef, 10);
      handlePlacementChange({
        type: 'fromExisting',
        importStation: actualImportStation,
        existingStation: { section_id: sectionId, station_index: targetStationIndex },
      });
    }
  }, [
    handlePlacementChange,
    importStationIndex,
    currentShotCount,
    targetSectionRef,
    targetStationIndex,
  ]);

  /**
   * Handle "Place on Map" button for Manual mode.
   * Hides dialog and starts placement mode on the map.
   */
  const handleStartManualPlacement = useCallback(() => {
    if (!currentConfig || currentSectionIndex === undefined) return;

    // Build SectionData from current config for the ghost outline
    const sectionData = {
      name: currentConfig.name,
      surveyor: currentConfig.surveyor,
      date: currentConfig.date,
      color: currentConfig.color,
      direction: currentConfig.direction,
      shots: currentConfig.shots
        .filter((s) => !s.isDeleted)
        .map((s) => ({
          azimuth_in: s.azimuth_in,
          azimuth_out: s.azimuth_out,
          length: s.length,
          depth_in: s.depth_in,
          depth_out: s.depth_out,
          pitch_in: s.pitch_in,
          pitch_out: s.pitch_out,
          left: s.left,
          right: s.right,
          up: s.up,
          down: s.down,
          comment: s.comment,
          is_virtual: s.is_virtual,
        })),
    };

    // Store current state for restoration after placement
    const savedState = {
      sectionConfigs: serializeSectionConfigs(),
      placedSections: serializePlacedSections(),
      excludedSections: serializeExcludedSections(),
      currentIndex,
      currentSectionIndex,
      manualAlignStation,
    };

    // Start placement mode on the map with callbacks
    startPlacementMode(
      sectionData,
      manualAlignStation,
      // onComplete callback
      (result: PlacementResult) => {
        // Update the saved state with the placement result
        const updatedConfigs = new Map<number, ImportedSectionConfig>(savedState.sectionConfigs);
        const current = updatedConfigs.get(savedState.currentSectionIndex);
        if (current) {
          updatedConfigs.set(savedState.currentSectionIndex, {
            ...current,
            placement: {
              type: 'manual',
              alignStation: savedState.manualAlignStation,
              position: result.position,
              snappedToStation: result.snappedToStation,
            },
          });
        }

        // Do NOT auto-mark as placed - user must click "Place section" button
        // Keep the same placed sections as before
        const updatedPlaced = new Set<number>(savedState.placedSections);

        // Reopen dialog with updated state
        openDialog('dmp-section-config', {
          dmpFile,
          filePath: dialogData.filePath,
          selectionConfig,
          // Pass saved state to restore (use currentSectionIndex, not array index)
          savedSectionConfigs: Array.from(updatedConfigs.entries()),
          savedPlacedSections: Array.from(updatedPlaced),
          savedExcludedSections: savedState.excludedSections,
          savedCurrentIndex: savedState.currentSectionIndex,
        });
      },
      // onCancel callback
      () => {
        // Reopen dialog with original state (no changes)
        openDialog('dmp-section-config', {
          dmpFile,
          filePath: dialogData.filePath,
          selectionConfig,
          // Pass saved state to restore (use currentSectionIndex, not array index)
          savedSectionConfigs: savedState.sectionConfigs,
          savedPlacedSections: savedState.placedSections,
          savedExcludedSections: savedState.excludedSections,
          savedCurrentIndex: savedState.currentSectionIndex,
        });
      }
    );

    // Hide the dialog
    closeDialog();
  }, [
    currentConfig,
    currentSectionIndex,
    currentIndex,
    manualAlignStation,
    serializeSectionConfigs,
    serializePlacedSections,
    serializeExcludedSections,
    startPlacementMode,
    openDialog,
    closeDialog,
    dmpFile,
    dialogData.filePath,
    selectionConfig,
  ]);

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
   * Uses the hook's resetSection action.
   */
  const handleResetSection = useCallback(() => {
    resetSection();
  }, [resetSection]);

  /**
   * Navigate to a specific section (by array index).
   * Uses the hook's navigateToArrayIndex action.
   */
  const navigateToSection = useCallback(
    (arrayIndex: number) => {
      navigateToArrayIndex(arrayIndex);
    },
    [navigateToArrayIndex]
  );

  /**
   * Navigate to previous section.
   */
  const handlePrevious = useCallback(() => {
    if (currentIndex > 0) {
      navigateToArrayIndex(currentIndex - 1);
    }
  }, [currentIndex, navigateToArrayIndex]);

  /**
   * Handle "Place section" button click.
   * Applies the placement config based on current field values,
   * marks the current section as placed, and advances to the next unplaced section.
   * If all sections are now handled, triggers the import.
   */
  const handlePlaceSection = useCallback(() => {
    if (currentSectionIndex === undefined || !currentConfig) return;

    // Apply placement config based on current type and field values
    if (currentConfig.placement.type === 'origin') {
      // Convert 'origin' to viewport center position
      handlePlaceAtViewportCenter();
    } else if (currentConfig.placement.type === 'zeroDatum') {
      // Update with current GPS values
      handlePlaceZeroDatum();
    } else if (currentConfig.placement.type === 'fromExisting' || currentConfig.placement.type === 'fromImporting') {
      // Validate that a target section is selected
      if (!targetSectionRef) {
        // Don't place - user needs to select a target section first
        return;
      }
      // Update with current target section/station values
      handlePlaceFromExisting();
    }
    // Note: 'manual' type is already set via handleStartManualPlacement

    // Mark current section as placed
    markPlaced(currentSectionIndex);

    // Check if there's a next unplaced section
    // Pass currentSectionIndex as excludeSection since state hasn't updated yet
    // Note: getNextUnplacedSection returns a section index, not array index
    const nextUnplaced = getNextUnplacedSection(currentSectionIndex, currentSectionIndex);
    if (nextUnplaced !== undefined) {
      // Navigate to the next unplaced section (by section index)
      navigateToSectionIndex(nextUnplaced);
    } else {
      // All sections are now handled - trigger import
      const sections = getAllConfigs();
      onImport(sections);
    }
  }, [currentSectionIndex, currentConfig, markPlaced, handlePlaceAtViewportCenter, handlePlaceZeroDatum, handlePlaceFromExisting, getNextUnplacedSection, navigateToSectionIndex, getAllConfigs, onImport, targetSectionRef]);

  /**
   * Handle Exclude/Include toggle for current section.
   */
  const handleExcludeToggle = useCallback(() => {
    if (currentSectionIndex === undefined) return;

    const status = getSectionStatus(currentSectionIndex);
    if (status === 'excluded') {
      // Include the section
      includeSection(currentSectionIndex);
    } else {
      // Exclude the section and advance to next unplaced
      excludeSection(currentSectionIndex);

      // Navigate to next unplaced section
      // Pass currentSectionIndex as excludeSection since state hasn't updated yet
      // Note: getNextUnplacedSection returns a section index, not array index
      const nextUnplaced = getNextUnplacedSection(currentSectionIndex, currentSectionIndex);
      if (nextUnplaced !== undefined) {
        navigateToSectionIndex(nextUnplaced);
      }
    }
  }, [currentSectionIndex, getSectionStatus, includeSection, excludeSection, getNextUnplacedSection, navigateToSectionIndex]);

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

  // Total error count across all sections (DATA errors only, not placement errors)
  const totalErrorCount = useMemo(() => {
    return getTotalDataErrorCount(existingSections);
  }, [getTotalDataErrorCount, existingSections]);

  // Count sections with DATA errors (for display)
  const sectionsWithErrorsCount = useMemo(() => {
    return selectedIndices.filter((idx) => getSectionDataErrorCount(idx, existingSections) > 0).length;
  }, [selectedIndices, getSectionDataErrorCount, existingSections]);


  // Current section status
  const currentSectionStatus = useMemo(() => {
    if (currentSectionIndex === undefined) return 'not_placed';
    return getSectionStatus(currentSectionIndex);
  }, [currentSectionIndex, getSectionStatus]);

  // Is current section placed?
  const isCurrentPlaced = currentSectionStatus === 'placed';

  // Is current section excluded?
  const isCurrentExcluded = currentSectionStatus === 'excluded';

  // Does current section have data errors? (excluding placement errors)
  // This is used to determine if the Place button should be enabled
  const currentSectionHasErrors = useMemo(() => {
    if (currentSectionIndex === undefined) return false;
    // Use getSectionDataErrorCount to exclude placement errors - those are expected before placing
    return getSectionDataErrorCount(currentSectionIndex, existingSections) > 0;
  }, [currentSectionIndex, getSectionDataErrorCount, existingSections]);

  // Is this the last unplaced section (all others are placed or excluded)?
  const isLastUnplacedSection = useMemo(() => {
    // Count sections that are not placed and not excluded (excluding current)
    const unplacedCount = selectedIndices.filter((idx) => {
      if (idx === currentSectionIndex) return false; // Don't count current
      const status = getSectionStatus(idx);
      return status !== 'placed' && status !== 'excluded';
    }).length;
    return unplacedCount === 0;
  }, [selectedIndices, currentSectionIndex, getSectionStatus]);

  // Should show "Place and finish" instead of "Place section"?
  const showPlaceAndFinish = isLastUnplacedSection && !isCurrentPlaced && !isCurrentExcluded;

  // Find the next unplaced section index (for "Next section" button)
  const nextUnplacedSectionIndex = useMemo(() => {
    // Look for the next unplaced section after current
    for (let i = currentIndex + 1; i < selectedIndices.length; i++) {
      const idx = selectedIndices[i];
      if (idx === undefined) continue;
      const status = getSectionStatus(idx);
      if (status !== 'placed' && status !== 'excluded') {
        return i;
      }
    }
    // Wrap around and look before current
    for (let i = 0; i < currentIndex; i++) {
      const idx = selectedIndices[i];
      if (idx === undefined) continue;
      const status = getSectionStatus(idx);
      if (status !== 'placed' && status !== 'excluded') {
        return i;
      }
    }
    return null;
  }, [selectedIndices, currentIndex, getSectionStatus]);

  // Should show "Next section" button (when current is placed/excluded and there are more unplaced sections)?
  const showNextSection = (isCurrentPlaced || isCurrentExcluded) && nextUnplacedSectionIndex !== null;

  // Handler for "Next section" button
  const handleNextSection = useCallback(() => {
    if (nextUnplacedSectionIndex !== null) {
      navigateToArrayIndex(nextUnplacedSectionIndex);
    }
  }, [nextUnplacedSectionIndex, navigateToArrayIndex]);

  // Can finish with current section excluded (all other sections are placed/excluded)?
  const canFinishWithExclusion = useMemo(() => {
    if (!isCurrentExcluded) return false;
    // Check if all OTHER sections are placed or excluded
    return selectedIndices.every((idx) => {
      if (idx === currentSectionIndex) return true; // Current is excluded, that's OK
      const status = getSectionStatus(idx);
      return status === 'placed' || status === 'excluded';
    });
  }, [isCurrentExcluded, selectedIndices, currentSectionIndex, getSectionStatus]);

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

      // Ctrl+Enter - place current section
      if (e.key === 'Enter' && e.ctrlKey && !e.repeat) {
        e.preventDefault();
        // Don't allow if current section is already placed or has errors
        if (currentSectionIndex !== undefined) {
          const status = getSectionStatus(currentSectionIndex);
          if (status === 'placed' || status === 'excluded' || status === 'errors') {
            return;
          }
        }
        handlePlaceSection();
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
    currentSectionIndex,
    handleCancel,
    handlePlaceSection,
    handlePrevious,
    navigateToSection,
    showCancelConfirm,
    showBackConfirm,
    handleUndo,
    handleRedo,
    getSectionStatus,
  ]);

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
        style={{ width: 'min(900px, 95vw)', height: 'min(700px, 90vh)' }}
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
              leftPanelCollapsed ? 'w-10' : 'w-56'
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
              <div className="flex-1 overflow-auto min-h-0">
                {selectedIndices.map((sectionIdx, arrayIdx) => {
                  const section = dmpFile.sections[sectionIdx];
                  const status = getSectionStatus(sectionIdx);
                  const isActive = arrayIdx === currentIndex;
                  // Use data error count (excluding placement errors) for status display
                  const sectionDataErrors = getSectionDataErrorCount(sectionIdx, existingSections);

                  // Status icon - based on data errors only, not placement errors
                  let statusIcon: string;
                  let statusColor: string;
                  if (status === 'excluded') {
                    statusIcon = '✕';
                    statusColor = 'text-error';
                  } else if (status === 'errors' || sectionDataErrors > 0) {
                    statusIcon = '!';
                    statusColor = 'text-error';
                  } else if (status === 'placed') {
                    statusIcon = '✓';
                    statusColor = 'text-success';
                  } else {
                    statusIcon = '○';
                    statusColor = 'text-text-secondary';
                  }

                  return (
                    <button
                      key={sectionIdx}
                      type="button"
                      onClick={() => navigateToArrayIndex(arrayIdx)}
                      className={`w-full px-3 py-2 text-left text-sm flex items-center gap-2 hover:bg-background/50 ${
                        isActive ? 'bg-accent/10 border-l-2 border-accent' : ''
                      }`}
                      data-testid={`section-list-item-${arrayIdx}`}
                    >
                      <span className={statusColor} data-testid={`section-status-${arrayIdx}`}>
                        {statusIcon}
                      </span>
                      <span className="truncate flex-1">{section?.name ?? `Section ${arrayIdx + 1}`}</span>
                      {/* Error count badge - data errors only */}
                      {sectionDataErrors > 0 && (
                        <span
                          className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 bg-error text-white rounded-full text-[10px] font-medium"
                          data-testid={`section-error-count-${arrayIdx}`}
                          title={`${sectionDataErrors} error${sectionDataErrors > 1 ? 's' : ''}`}
                        >
                          {sectionDataErrors}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Preview - anchored at bottom, only when expanded */}
            {!leftPanelCollapsed && currentConfig && currentDmpSection && (
              <div className="flex-shrink-0 p-2 border-t border-border" data-testid="section-preview-panel">
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
            )}

            {/* Error count indicator */}
            {!leftPanelCollapsed && sectionsWithErrorsCount > 0 && (
              <div className="px-3 py-2 text-xs text-error border-t border-border" data-testid="error-summary">
                {sectionsWithErrorsCount} section{sectionsWithErrorsCount > 1 ? 's' : ''} with errors ({totalErrorCount} total)
              </div>
            )}
          </div>

          {/* Main Panel */}
          <div className="flex-1 flex flex-col min-h-0 min-w-0 p-4" data-testid="main-config-panel">
            {currentConfig && currentDmpSection ? (
              <div className="flex-1 overflow-auto min-h-0 flex flex-col">
                {/* Section header */}
                <div className="flex items-center gap-4 mb-4">
                  <h3 className="font-medium text-lg">
                    Section: {currentConfig.name}
                  </h3>
                  <span className="text-sm text-text-secondary">
                    ({currentIndex + 1} of {selectedIndices.length})
                  </span>
                  {/* Status badges */}
                  {isCurrentPlaced && (
                    <span className="px-2 py-1 bg-success/10 text-success text-xs rounded" data-testid="placed-badge">
                      ✓ Placed
                    </span>
                  )}
                  {isCurrentExcluded && (
                    <span className="px-2 py-1 bg-error/10 text-error text-xs rounded" data-testid="excluded-badge">
                      ✕ Excluded
                    </span>
                  )}
                  {/* Reset Section button - pushed to the right */}
                  <div className="flex-1" />
                  <Button
                    size="sm"
                    onClick={handleResetSection}
                    disabled={isCurrentPlaced || isCurrentExcluded}
                    data-testid="reset-section-button"
                    title="Reset all fields and placement to original DMP values"
                  >
                    Reset Section
                  </Button>
                </div>

                {/* Read-only banner for placed sections */}
                {isCurrentPlaced && (
                  <div className="mb-4 p-3 bg-success/10 border border-success/30 rounded text-sm text-success" data-testid="placed-section-banner">
                    This section has been placed and cannot be edited. Navigate to an unplaced section to continue.
                  </div>
                )}

                {/* Excluded banner */}
                {isCurrentExcluded && (
                  <div className="mb-4 p-3 bg-error/10 border border-error/30 rounded text-sm text-error" data-testid="excluded-section-banner">
                    This section is excluded from import. Click "Include" to add it back.
                  </div>
                )}

                {/* Parameters */}
                <div className="mb-4">
                  <Panel title="Parameters">
                    <SectionMetadataForm
                      name={currentConfig.name}
                      surveyor={currentConfig.surveyor ?? ''}
                      date={currentConfig.date ?? ''}
                      color={currentConfig.color}
                      direction={currentConfig.direction}
                      onNameChange={(value) => updateSectionField('name', value)}
                      onSurveyorChange={(value) => updateSectionField('surveyor', value || null)}
                      onDateChange={(value) => updateSectionField('date', value || null)}
                      onColorChange={(value) => updateSectionField('color', value)}
                      onDirectionChange={(value) => updateSectionField('direction', value)}
                      showDirection
                      disabled={isCurrentPlaced || isCurrentExcluded}
                    />
                  </Panel>
                </div>

                {/* Placement options */}
                <Panel title="Placement" className="mb-4" data-testid="placement-panel">
                  <div className="space-y-3">
                    {/* Place at center of screen */}
                    <div
                      className={`p-3 rounded border ${
                        currentConfig.placement.type === 'origin'
                          ? 'border-accent bg-accent/5'
                          : 'border-border'
                      } ${isCurrentPlaced || isCurrentExcluded ? 'opacity-50' : ''}`}
                      data-testid="placement-mode-origin"
                    >
                      <label className={`flex items-center gap-2 ${isCurrentPlaced || isCurrentExcluded ? '' : 'cursor-pointer'}`}>
                        <input
                          type="radio"
                          name="placement"
                          checked={currentConfig.placement.type === 'origin'}
                          onChange={() => handlePlacementChange({ type: 'origin' })}
                          disabled={isCurrentPlaced || isCurrentExcluded}
                          data-testid="placement-origin"
                        />
                        <span className="font-medium">Place at center of screen</span>
                      </label>
                      {currentConfig.placement.type === 'origin' && (
                        <div className="mt-2 ml-6">
                          <span className="text-sm text-text-secondary">
                            First station at current map viewport center
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Zero Datum (GPS) */}
                    <div
                      className={`p-3 rounded border ${
                        currentConfig.placement.type === 'zeroDatum'
                          ? 'border-accent bg-accent/5'
                          : 'border-border'
                      } ${isCurrentPlaced || isCurrentExcluded ? 'opacity-50' : ''}`}
                      data-testid="placement-mode-zero-datum"
                    >
                      <label className={`flex items-center gap-2 ${isCurrentPlaced || isCurrentExcluded ? '' : 'cursor-pointer'}`}>
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
                          disabled={isCurrentPlaced || isCurrentExcluded}
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
                              className="flex-1 px-2 py-1 bg-background border border-border rounded text-sm disabled:opacity-50"
                              disabled={isCurrentPlaced || isCurrentExcluded}
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
                            <Select
                              value={String(gpsStationIndex)}
                              onChange={(v) => setGpsStationIndex(parseInt(v, 10))}
                              options={stationOptions.map((opt) => ({ value: String(opt.value), label: opt.label }))}
                              disabled={isCurrentPlaced || isCurrentExcluded}
                              className="flex-1"
                              data-testid="gps-station-select"
                            />
                          </div>
                        </div>
                      )}
                    </div>

                    {/* From Existing or Importing Section */}
                    <div
                      className={`p-3 rounded border ${
                        currentConfig.placement.type === 'fromExisting' || currentConfig.placement.type === 'fromImporting'
                          ? 'border-accent bg-accent/5'
                          : 'border-border'
                      } ${(existingSections.length === 0 && importingSectionOptions.length === 0) || isCurrentPlaced || isCurrentExcluded ? 'opacity-50' : ''}`}
                      data-testid="placement-mode-existing"
                    >
                      <label className={`flex items-center gap-2 ${(existingSections.length === 0 && importingSectionOptions.length === 0) || isCurrentPlaced || isCurrentExcluded ? '' : 'cursor-pointer'}`}>
                        <input
                          type="radio"
                          name="placement"
                          checked={currentConfig.placement.type === 'fromExisting' || currentConfig.placement.type === 'fromImporting'}
                          onChange={() => {
                            // Switch to this mode - use existing handler which checks the target ref
                            if (targetSectionRef) {
                              handlePlaceFromExisting();
                            } else {
                              // Default: set a placeholder placement that will be updated when target is selected
                              handlePlacementChange({
                                type: 'fromExisting',
                                importStation: importStationIndex === -1 ? currentShotCount : importStationIndex,
                                existingStation: { section_id: 0, station_index: 0 },
                              });
                            }
                          }}
                          disabled={(existingSections.length === 0 && importingSectionOptions.length === 0) || isCurrentPlaced || isCurrentExcluded}
                          data-testid="placement-from-existing"
                        />
                        <span className="font-medium">From Existing Station</span>
                        {existingSections.length === 0 && importingSectionOptions.length === 0 && (
                          <span className="text-xs text-text-secondary">(no available sections)</span>
                        )}
                      </label>
                      {(currentConfig.placement.type === 'fromExisting' || currentConfig.placement.type === 'fromImporting') && (
                        <div className="mt-3 ml-6 space-y-3">
                          {/* This section station */}
                          <div className="flex items-center gap-2 flex-wrap">
                            <label className="text-sm text-text-secondary">Connect:</label>
                            <Select
                              value={String(importStationIndex)}
                              onChange={(v) => {
                                const newImportStation = parseInt(v, 10);
                                setImportStationIndex(newImportStation);
                                // Update placement config with new import station
                                if (targetSectionRef) {
                                  const actualImportStation = newImportStation === -1 ? currentShotCount : newImportStation;
                                  if (targetSectionRef.startsWith('import-')) {
                                    const targetSectionIdx = parseInt(targetSectionRef.replace('import-', ''), 10);
                                    handlePlacementChange({
                                      type: 'fromImporting',
                                      importStation: actualImportStation,
                                      targetSectionIndex: targetSectionIdx,
                                      targetStationIndex,
                                    });
                                  } else {
                                    const sectionId = parseInt(targetSectionRef, 10);
                                    handlePlacementChange({
                                      type: 'fromExisting',
                                      importStation: actualImportStation,
                                      existingStation: { section_id: sectionId, station_index: targetStationIndex },
                                    });
                                  }
                                }
                              }}
                              options={stationOptions.map((opt) => ({
                                value: String(opt.value),
                                label: opt.label,
                              }))}
                              disabled={isCurrentPlaced || isCurrentExcluded}
                              data-testid="import-station-select"
                            />
                            <span className="text-sm text-text-secondary">to</span>
                          </div>

                          {/* Target section and station */}
                          <div className="flex items-center gap-2 flex-wrap">
                            <Select
                              value={targetSectionRef}
                              onChange={(v) => {
                                setTargetSectionRef(v);
                                setTargetStationIndex(0);
                                // Update placement config immediately when target is selected
                                if (v) {
                                  const actualImportStation = importStationIndex === -1 ? currentShotCount : importStationIndex;
                                  if (v.startsWith('import-')) {
                                    const targetSectionIndex = parseInt(v.replace('import-', ''), 10);
                                    handlePlacementChange({
                                      type: 'fromImporting',
                                      importStation: actualImportStation,
                                      targetSectionIndex,
                                      targetStationIndex: 0,
                                    });
                                  } else {
                                    const sectionId = parseInt(v, 10);
                                    handlePlacementChange({
                                      type: 'fromExisting',
                                      importStation: actualImportStation,
                                      existingStation: { section_id: sectionId, station_index: 0 },
                                    });
                                  }
                                }
                              }}
                              options={(() => {
                                const groups: SelectOptionGroup[] = [];

                                // Importing sections (placed) - grouped on top
                                if (importingSectionOptions.length > 0) {
                                  groups.push({
                                    label: 'Importing',
                                    options: importingSectionOptions.map((opt) => {
                                      const idx = parseInt(opt.value.replace('import-', ''), 10);
                                      const name = opt.label.replace(' (importing)', '');
                                      return {
                                        value: opt.value,
                                        label: `${idx}: ${name}`,
                                      };
                                    }),
                                  });
                                }

                                // Existing sections - use section ID
                                if (existingSectionOptions.length > 0) {
                                  groups.push({
                                    label: 'Existing',
                                    options: existingSectionOptions.map((opt) => ({
                                      value: String(opt.value),
                                      label: `${opt.value}: ${opt.label}`,
                                    })),
                                  });
                                }

                                return groups.length > 0 ? groups : [{ value: '', label: 'No sections available' }];
                              })()}
                              placeholder="Select section..."
                              disabled={isCurrentPlaced || isCurrentExcluded}
                              data-testid="target-section-select"
                            />
                            <Select
                              value={String(targetStationIndex)}
                              onChange={(v) => {
                                const newStationIndex = parseInt(v, 10);
                                setTargetStationIndex(newStationIndex);
                                // Update placement config with new station
                                if (targetSectionRef) {
                                  const actualImportStation = importStationIndex === -1 ? currentShotCount : importStationIndex;
                                  if (targetSectionRef.startsWith('import-')) {
                                    const targetSectionIdx = parseInt(targetSectionRef.replace('import-', ''), 10);
                                    handlePlacementChange({
                                      type: 'fromImporting',
                                      importStation: actualImportStation,
                                      targetSectionIndex: targetSectionIdx,
                                      targetStationIndex: newStationIndex,
                                    });
                                  } else {
                                    const sectionId = parseInt(targetSectionRef, 10);
                                    handlePlacementChange({
                                      type: 'fromExisting',
                                      importStation: actualImportStation,
                                      existingStation: { section_id: sectionId, station_index: newStationIndex },
                                    });
                                  }
                                }
                              }}
                              options={
                                targetSectionStations.length === 0
                                  ? [{ value: '0', label: 'Select station...' }]
                                  : targetSectionStations.map((opt) => ({
                                      value: String(opt.value),
                                      label: opt.label,
                                    }))
                              }
                              disabled={!targetSectionRef || isCurrentPlaced || isCurrentExcluded}
                              className="min-w-[140px]"
                              data-testid="target-station-select"
                            />
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
                      } ${isCurrentPlaced || isCurrentExcluded ? 'opacity-50' : ''}`}
                      data-testid="placement-mode-manual"
                    >
                      <label className={`flex items-center gap-2 ${isCurrentPlaced || isCurrentExcluded ? '' : 'cursor-pointer'}`}>
                        <input
                          type="radio"
                          name="placement"
                          checked={currentConfig.placement.type === 'manual'}
                          onChange={() => handlePlacementChange({ type: 'manual', alignStation: manualAlignStation })}
                          disabled={isCurrentPlaced || isCurrentExcluded}
                          data-testid="placement-manual"
                        />
                        <span className="font-medium">Manual Placement</span>
                      </label>
                      {currentConfig.placement.type === 'manual' && (
                        <div className="mt-3 ml-6 space-y-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            <label className="text-sm text-text-secondary">Align:</label>
                            <Select
                              value={manualAlignStation}
                              onChange={(v) => setManualAlignStation(v as 'first' | 'last')}
                              options={[
                                { value: 'first', label: 'First station' },
                                { value: 'last', label: 'Last station' },
                              ]}
                              disabled={isCurrentPlaced || isCurrentExcluded}
                              data-testid="manual-align-select"
                            />
                            <span className="text-sm text-text-secondary">with cursor</span>
                            <Button
                              size="sm"
                              onClick={handleStartManualPlacement}
                              disabled={isCurrentPlaced || isCurrentExcluded}
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
                      readOnly={isCurrentPlaced || isCurrentExcluded}
                    />
                  </div>
                </Panel>
              </div>
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
            {/* Exclude/Include toggle - always show so user can include sections back */}
            <Button
              onClick={handleExcludeToggle}
              disabled={isCurrentPlaced}
              data-testid={isCurrentExcluded ? 'include-button' : 'exclude-button'}
              title={isCurrentPlaced ? 'Cannot exclude a placed section' : undefined}
            >
              {isCurrentExcluded ? 'Include' : 'Exclude'}
            </Button>
          </div>
          <div className="flex gap-2">
            {/* Show Cancel when all sections are excluded */}
            {allSectionsExcluded ? (
              <Button onClick={handleCancel} data-testid="cancel-all-excluded-button">
                Cancel (all sections excluded)
              </Button>
            ) : canFinishWithExclusion ? (
              /* Show Finish Import when current is excluded but all others are placed/excluded */
              <Button
                variant="primary"
                onClick={() => onImport(getAllConfigs())}
                data-testid="finish-import-button"
              >
                Finish Import
              </Button>
            ) : showNextSection ? (
              /* Show Next section when current is placed/excluded but there are more unplaced sections */
              <Button
                variant="primary"
                onClick={handleNextSection}
                data-testid="next-section-button"
              >
                Next section →
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={handlePlaceSection}
                disabled={
                  currentSectionHasErrors ||
                  ((currentConfig?.placement.type === 'fromExisting' || currentConfig?.placement.type === 'fromImporting') && !targetSectionRef) ||
                  (currentConfig?.placement.type === 'manual' && !currentConfig.placement.position)
                }
                data-testid={showPlaceAndFinish ? 'place-and-finish-button' : 'place-section-button'}
                title={
                  currentSectionHasErrors
                    ? 'Fix errors before placing'
                    : (currentConfig?.placement.type === 'fromExisting' || currentConfig?.placement.type === 'fromImporting') && !targetSectionRef
                      ? 'Select a target section first'
                      : currentConfig?.placement.type === 'manual' && !currentConfig.placement.position
                        ? 'Click "Place on map" first'
                        : undefined
                }
              >
                {showPlaceAndFinish ? 'Place and finish' : 'Place section'}
              </Button>
            )}
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
