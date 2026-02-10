import { useState, useEffect, useMemo, useCallback, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../common/Button';
import { Panel } from '../common/Panel';
import { AlertCircleIcon, AlertTriangleIcon, CheckCircleIcon, ChevronLeftIcon, ChevronRightIcon, CircleIcon, XCircleIcon } from '../common/icons';
import type { DmpFile, DmpSection, PlacementSuggestion } from '../../types/commands';
import type { DmpSelectionConfig } from './DmpSelectionDialog';
import type { Project, Station, ShotData } from '../../types/project';
import type { ZeroDatumConfigResult } from './ZeroDatumConfigDialog';
import { SectionMetadataForm } from '../common/SectionMetadataForm';
import { ShotTableEditor, type EditableShot } from '../common/ShotTableEditor';
import { Select, type SelectOptionGroup } from '../common/Select';
import SectionPreview, { type MergePreviewConfig } from './SectionPreview';
import { DialogWrapper } from './DialogWrapper';
import { AlertDialog } from './AlertDialog';
import { parseGps, detectFormat, type GpsFormat } from '../../utils/gps';
import { formatFixed } from '../../i18n/format';
import { useDecimalPrecision } from '../../hooks/useDecimalPrecision';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { defaultConfig } from '../../types/config';
import { formatLength, formatDepthRange } from '../../utils/formatStats';
import {
  useImportState,
  type PlacementConfig,
  type SectionConfig,
} from '../../hooks/useImportState';

export type ImportedSectionConfig = SectionConfig;

interface DmpNewImportDialogProps {
  dmpFile: DmpFile;
  selectionConfig: DmpSelectionConfig;
  project: Project | null;
  stations: Station[];
  zeroDatumConfig?: ZeroDatumConfigResult | undefined;
  onCancel: () => void;
  onBack: () => void;
  onImport: (sections: ImportedSectionConfig[]) => void;
}

/**
 * New DMP import dialog — streamlined workflow with placement suggestions.
 * Shown when "Use legacy DMP import" is disabled in Advanced settings.
 */
export default function DmpNewImportDialog({
  dmpFile,
  selectionConfig,
  project,
  stations: _stations,
  zeroDatumConfig,
  onCancel,
  onBack,
  onImport,
}: DmpNewImportDialogProps) {
  const { t } = useTranslation();
  const { getMapViewportCenter } = useUIStore();

  // Store selectors
  const config = useProjectStore((state) => state.config);
  const suggestImportPlacement = useProjectStore((state) => state.suggestImportPlacement);
  const precision = useDecimalPrecision();
  const lengthUnit = config?.units?.length ?? defaultConfig.units.length;
  const depthUnit = config?.units?.depth ?? defaultConfig.units.depth;

  const validationConfig = useMemo(() => ({
    azimuth_diff_threshold: config?.validation?.azimuth_diff_threshold ?? defaultConfig.validation.azimuth_diff_threshold,
    pitch_diff_threshold: config?.validation?.pitch_diff_threshold ?? defaultConfig.validation.pitch_diff_threshold,
  }), [config?.validation?.azimuth_diff_threshold, config?.validation?.pitch_diff_threshold]);

  // Initialize import state
  const importState = useImportState(dmpFile, selectionConfig);

  const {
    currentConfig,
    currentSectionIndex,
    currentArrayIndex,
    selectedIndices,
    canUndo: _canUndo,
    canRedo: _canRedo,
    navigateToArrayIndex,
    navigateToSection: navigateToSectionIndex,
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
    getSectionStatus,
    getAllConfigs,
    getPlacedSectionConfigs,
    getSectionDataErrorCount,
    getSectionWarningCount,
    getTotalDataErrorCount,
    getNextUnplacedSection,
    allSectionsExcluded,
  } = importState;

  // UI state
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showBackConfirm, setShowBackConfirm] = useState(false);
  const [deleteConfirmState, setDeleteConfirmState] = useState<{
    visible: boolean;
    shotIndex: number;
    isMidSection: boolean;
  }>({ visible: false, shotIndex: -1, isMidSection: false });
  const [selectedShotKey, setSelectedShotKey] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<PlacementSuggestion[]>([]);

  // Placement mode state
  const [gpsInput, setGpsInput] = useState('');
  const [gpsCoords, setGpsCoords] = useState<{ latitude: number; longitude: number; depth_reference: number } | null>(null);
  const [gpsFormat, setGpsFormat] = useState<GpsFormat | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [gpsStationIndex, setGpsStationIndex] = useState(0);
  const [importStationIndex, setImportStationIndex] = useState(0);
  const [targetSectionRef, setTargetSectionRef] = useState<string>('');
  const [targetStationIndex, setTargetStationIndex] = useState(0);

  // Track whether zeroDatumConfig has been applied
  const [zeroDatumApplied, setZeroDatumApplied] = useState(false);

  // Pre-apply zeroDatumConfig on mount
  useEffect(() => {
    if (!zeroDatumConfig || zeroDatumApplied) return;

    const { sectionIndex, stationIndex, gps, metadata } = zeroDatumConfig;

    // Set placement to zeroDatum
    navigateToSectionIndex(sectionIndex);

    // Update metadata
    updateSectionField('name', metadata.name);
    updateSectionField('surveyor', metadata.surveyor);
    updateSectionField('date', metadata.date);
    updateSectionField('color', metadata.color);
    updateSectionField('direction', metadata.direction);
    updateSectionField('quality', metadata.quality);

    // Set placement
    setPlacement({
      type: 'zeroDatum',
      coordinates: gps,
      stationIndex,
    });

    // Mark as placed
    markPlaced(sectionIndex);

    // Navigate to the first unplaced section
    const nextUnplaced = getNextUnplacedSection(sectionIndex, sectionIndex);
    if (nextUnplaced !== undefined) {
      navigateToSectionIndex(nextUnplaced);
    }

    setZeroDatumApplied(true);
  // Only run once on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zeroDatumConfig]);

  // Derived data
  const currentDmpSection = currentSectionIndex !== undefined
    ? dmpFile.sections[currentSectionIndex]
    : undefined;

  const previewSection = useMemo<DmpSection | null>(() => {
    if (!currentConfig) return null;
    return {
      version: currentDmpSection?.version ?? dmpFile.version,
      name: currentConfig.name ?? currentDmpSection?.name ?? '',
      direction: currentConfig.direction ?? currentDmpSection?.direction ?? 'in',
      date: currentConfig.date ?? currentDmpSection?.date ?? '',
      shots: currentConfig.shots
        .filter((shot) => !shot.isDeleted)
        .map((shot) => {
          const comment = shot.comment ?? undefined;
          return {
            shot_type: 'Standard',
            heading_in: shot.azimuth_in,
            heading_out: shot.azimuth_out,
            length: shot.length,
            depth_in: shot.depth_in,
            depth_out: shot.depth_out,
            pitch_in: shot.pitch_in ?? 0,
            pitch_out: shot.pitch_out ?? 0,
            left: shot.left ?? 0,
            right: shot.right ?? 0,
            up: shot.up ?? 0,
            down: shot.down ?? 0,
            temperature: 0,
            hour: 0,
            minute: 0,
            second: 0,
            marker_index: 0,
            ...(comment !== undefined ? { comment } : {}),
          };
        }),
    };
  }, [currentConfig, currentDmpSection, dmpFile.version]);

  const currentIndex = currentArrayIndex;

  const visibleShots = useMemo(() => {
    return currentConfig?.shots.filter((s) => !s.isDeleted) ?? [];
  }, [currentConfig]);

  const getShotKey = useCallback((shot: EditableShot): string => {
    if (shot.tempId !== undefined) return `t:${shot.tempId}`;
    return `i:${shot.id}`;
  }, []);

  const selectedShotActualIndex = useMemo(() => {
    if (!currentConfig || !selectedShotKey) return null;
    const index = currentConfig.shots.findIndex((shot) => getShotKey(shot) === selectedShotKey);
    return index >= 0 ? index : null;
  }, [currentConfig, getShotKey, selectedShotKey]);

  const selectedShotVisibleIndex = useMemo(() => {
    if (!selectedShotKey) return null;
    const index = visibleShots.findIndex((shot) => getShotKey(shot) === selectedShotKey);
    return index >= 0 ? index : null;
  }, [getShotKey, selectedShotKey, visibleShots]);

  // Clear selection when switching sections
  useEffect(() => {
    setSelectedShotKey(null);
  }, [currentSectionIndex]);

  useEffect(() => {
    if (!selectedShotKey || !currentConfig) return;
    const selectedShot = currentConfig.shots.find((shot) => getShotKey(shot) === selectedShotKey);
    if (!selectedShot || selectedShot.isDeleted) {
      setSelectedShotKey(null);
    }
  }, [currentConfig, getShotKey, selectedShotKey]);

  const currentShotCount = useMemo(() => visibleShots.length, [visibleShots.length]);

  const sectionStats = useMemo(() => {
    if (!currentConfig) {
      return { shotCount: 0, totalLength: 0, minDepth: null as number | null, maxDepth: null as number | null };
    }
    let totalLength = 0;
    let minDepth: number | null = null;
    let maxDepth: number | null = null;
    for (const shot of visibleShots) {
      const hasValidLength = Number.isFinite(shot.length) && shot.length > 0;
      if (hasValidLength) {
        totalLength += shot.length;
      } else {
        continue;
      }
      for (const depth of [shot.depth_in, shot.depth_out]) {
        if (Number.isFinite(depth)) {
          if (minDepth === null || depth < minDepth) minDepth = depth;
          if (maxDepth === null || depth > maxDepth) maxDepth = depth;
        }
      }
    }
    return { shotCount: visibleShots.length, totalLength, minDepth, maxDepth };
  }, [currentConfig, visibleShots]);

  const stationOptions = useMemo(() => {
    const options: Array<{ value: number; label: string }> = [];
    for (let i = 0; i <= currentShotCount; i++) {
      options.push({ value: i, label: `Station ${i}` });
    }
    return options;
  }, [currentShotCount]);

  const existingSections = useMemo(() => {
    if (!project) return [];
    return project.sections;
  }, [project]);

  // Fetch placement suggestions when current section changes
  useEffect(() => {
    setSuggestions([]);

    if (!currentConfig || !project || existingSections.length === 0) return;

    const status = currentSectionIndex !== undefined ? getSectionStatus(currentSectionIndex) : undefined;
    if (status === 'placed' || status === 'excluded') return;

    const shotData: ShotData[] = currentConfig.shots
      .filter((s) => !s.isDeleted)
      .map((s) => ({
        azimuth_in: s.azimuth_in,
        azimuth_out: s.azimuth_out,
        length: s.length,
        depth_in: s.depth_in,
        depth_out: s.depth_out,
        pitch_in: s.pitch_in ?? null,
        pitch_out: s.pitch_out ?? null,
        left: s.left ?? null,
        right: s.right ?? null,
        up: s.up ?? null,
        down: s.down ?? null,
        comment: s.comment ?? null,
        is_reference: s.is_reference ?? false,
        marker_index: null,
        temperature: null,
      }));

    if (shotData.length === 0) return;

    let cancelled = false;
    suggestImportPlacement(shotData)
      .then((results) => {
        if (!cancelled) setSuggestions(results);
      })
      .catch(() => {
        // Silently ignore — suggestions are non-critical
      });

    return () => { cancelled = true; };
  // Only re-fetch when section changes, not on every shot edit
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSectionIndex, project, existingSections.length]);

  // Section/station helpers
  const getStationsForSection = useCallback(
    (sectionId: number): Array<{ value: number; label: string }> => {
      const section = existingSections.find((s) => s.id === sectionId);
      if (!section) return [];
      const count = section.shots.length + 1;
      const options: Array<{ value: number; label: string }> = [];
      for (let i = 0; i < count; i++) {
        options.push({ value: i, label: `Station ${i}` });
      }
      return options;
    },
    [existingSections]
  );

  const existingSectionOptions = useMemo(() => {
    return existingSections.map((s) => ({
      value: s.id,
      label: s.name || `Section ${s.id}`,
    }));
  }, [existingSections]);

  const importingSectionOptions = useMemo(() => {
    const placedConfigs = getPlacedSectionConfigs();
    return placedConfigs
      .filter((c) => c.sectionIndex !== currentSectionIndex)
      .map((c) => ({
        value: `import-${c.sectionIndex}`,
        label: `${c.name} (importing)`,
        stationCount: c.stationCount,
      }));
  }, [getPlacedSectionConfigs, currentSectionIndex]);

  const getStationsForImportingSection = useCallback(
    (sectionIndex: number): Array<{ value: number; label: string }> => {
      const c = getPlacedSectionConfigs().find((pc) => pc.sectionIndex === sectionIndex);
      if (!c) return [];
      const options: Array<{ value: number; label: string }> = [];
      for (let i = 0; i < c.stationCount; i++) {
        options.push({ value: i, label: `Station ${i}` });
      }
      return options;
    },
    [getPlacedSectionConfigs]
  );

  const targetSectionStations = useMemo(() => {
    if (!targetSectionRef) return [];
    if (targetSectionRef.startsWith('import-')) {
      const sectionIndex = parseInt(targetSectionRef.replace('import-', ''), 10);
      return getStationsForImportingSection(sectionIndex);
    }
    const sectionId = parseInt(targetSectionRef, 10);
    return getStationsForSection(sectionId);
  }, [targetSectionRef, getStationsForSection, getStationsForImportingSection]);

  // Merge preview config for SectionPreview
  const mergePreviewConfig = useMemo((): MergePreviewConfig | null => {
    if (!currentConfig) return null;
    const placementType = currentConfig.placement.type;
    if (placementType !== 'fromExisting' && placementType !== 'fromImporting') return null;
    if (!targetSectionRef) return null;

    const actualImportStation = importStationIndex === -1 ? currentShotCount : importStationIndex;

    if (!targetSectionRef.startsWith('import-')) {
      const sectionId = parseInt(targetSectionRef, 10);
      const targetSection = existingSections.find((s) => s.id === sectionId);
      if (!targetSection) return null;
      return { targetSection, importStationIndex: actualImportStation, targetStationIndex };
    }

    const targetIdx = parseInt(targetSectionRef.replace('import-', ''), 10);
    const targetConfig = getPlacedSectionConfigs().find((c) => c.sectionIndex === targetIdx);
    if (!targetConfig) return null;

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
      is_reference: false,
      marker_index: null,
      temperature: null,
    }));

    const importingSection = {
      id: -targetIdx - 1,
      name: targetConfig.name,
      shots: convertedShots,
    };

    return {
      targetSection: importingSection as any,
      importStationIndex: actualImportStation,
      targetStationIndex,
    };
  }, [currentConfig, existingSections, targetSectionRef, targetStationIndex, importStationIndex, currentShotCount, getPlacedSectionConfigs, dmpFile.sections]);

  // Handlers
  const handleGpsInputChange = useCallback((value: string) => {
    setGpsInput(value);
    if (!value.trim()) {
      setGpsCoords(null);
      setGpsFormat(null);
      setGpsError(null);
      return;
    }
    const detected = detectFormat(value);
    setGpsFormat(detected || null);
    const result = parseGps(value);
    if ('coordinates' in result) {
      setGpsCoords(result.coordinates);
      setGpsError(null);
    } else {
      setGpsCoords(null);
      setGpsError(result.message);
    }
  }, []);

  const handleShotChange = useCallback(
    (shotIndex: number, field: keyof EditableShot, value: number | string | boolean | null) => {
      updateShot(shotIndex, field, value);
    },
    [updateShot]
  );

  const handleAddShot = useCallback(() => { addShot(); }, [addShot]);
  const handleUndo = useCallback(() => { undo(); }, [undo]);
  const handleRedo = useCallback(() => { redo(); }, [redo]);

  const isMidSectionShot = useCallback((shotIndex: number) => {
    if (!currentConfig) return false;
    const visible = currentConfig.shots
      .map((s, i) => ({ shot: s, index: i }))
      .filter(({ shot }) => !shot.isDeleted);
    if (visible.length <= 2) return false;
    const visibleIdx = visible.findIndex(({ index }) => index === shotIndex);
    return visibleIdx > 0 && visibleIdx < visible.length - 1;
  }, [currentConfig]);

  const handleDeleteShotRequest = useCallback(
    (shotIndex: number) => {
      if (!currentConfig) return;
      if (isMidSectionShot(shotIndex)) {
        setDeleteConfirmState({ visible: true, shotIndex, isMidSection: true });
      } else {
        deleteImportShot(shotIndex);
      }
    },
    [currentConfig, isMidSectionShot, deleteImportShot]
  );

  const handleConfirmDelete = useCallback(() => {
    if (!currentConfig || deleteConfirmState.shotIndex < 0) return;
    deleteImportShot(deleteConfirmState.shotIndex);
    setDeleteConfirmState({ visible: false, shotIndex: -1, isMidSection: false });
  }, [currentConfig, deleteConfirmState.shotIndex, deleteImportShot]);

  const handleInsertBefore = useCallback(
    (shotIndex: number) => { insertShotBefore(shotIndex); },
    [insertShotBefore]
  );

  const handleInsertAfter = useCallback(
    (shotIndex: number) => { insertShotAfter(shotIndex); },
    [insertShotAfter]
  );

  const handlePlacementChange = useCallback(
    (placement: PlacementConfig) => { setPlacement(placement); },
    [setPlacement]
  );

  const handlePlaceAtViewportCenter = useCallback(() => {
    const center = getMapViewportCenter();
    handlePlacementChange({
      type: 'manual',
      alignStationIndex: 0,
      position: { x: center.x, y: center.y, z: 0 },
    });
  }, [handlePlacementChange, getMapViewportCenter]);

  const handlePlaceZeroDatum = useCallback(() => {
    if (!gpsCoords) return;
    handlePlacementChange({
      type: 'zeroDatum',
      coordinates: gpsCoords,
      stationIndex: gpsStationIndex,
    });
  }, [handlePlacementChange, gpsCoords, gpsStationIndex]);

  const handlePlaceFromExisting = useCallback(() => {
    if (!targetSectionRef) return;
    const actualImportStation = importStationIndex === -1 ? currentShotCount : importStationIndex;

    if (targetSectionRef.startsWith('import-')) {
      const targetSectionIndex = parseInt(targetSectionRef.replace('import-', ''), 10);
      handlePlacementChange({
        type: 'fromImporting',
        importStation: actualImportStation,
        targetSectionIndex,
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
  }, [handlePlacementChange, importStationIndex, currentShotCount, targetSectionRef, targetStationIndex]);

  const handleResetSection = useCallback(() => { resetSection(); }, [resetSection]);

  const handlePrevious = useCallback(() => {
    if (currentIndex > 0) {
      navigateToArrayIndex(currentIndex - 1);
    }
  }, [currentIndex, navigateToArrayIndex]);

  const handlePlaceSection = useCallback(() => {
    if (currentSectionIndex === undefined || !currentConfig) return;

    if (currentConfig.placement.type === 'origin') {
      handlePlaceAtViewportCenter();
    } else if (currentConfig.placement.type === 'zeroDatum') {
      handlePlaceZeroDatum();
    } else if (currentConfig.placement.type === 'fromExisting' || currentConfig.placement.type === 'fromImporting') {
      if (!targetSectionRef) return;
      handlePlaceFromExisting();
    }

    markPlaced(currentSectionIndex);

    const nextUnplaced = getNextUnplacedSection(currentSectionIndex, currentSectionIndex);
    if (nextUnplaced !== undefined) {
      navigateToSectionIndex(nextUnplaced);
    } else {
      const sections = getAllConfigs();
      onImport(sections);
    }
  }, [currentSectionIndex, currentConfig, markPlaced, handlePlaceAtViewportCenter, handlePlaceZeroDatum, handlePlaceFromExisting, getNextUnplacedSection, navigateToSectionIndex, getAllConfigs, onImport, targetSectionRef]);

  const handleExcludeToggle = useCallback(() => {
    if (currentSectionIndex === undefined) return;
    const status = getSectionStatus(currentSectionIndex);
    if (status === 'excluded') {
      includeSection(currentSectionIndex);
    } else {
      excludeSection(currentSectionIndex);
      const nextUnplaced = getNextUnplacedSection(currentSectionIndex, currentSectionIndex);
      if (nextUnplaced !== undefined) {
        navigateToSectionIndex(nextUnplaced);
      }
    }
  }, [currentSectionIndex, getSectionStatus, includeSection, excludeSection, getNextUnplacedSection, navigateToSectionIndex]);

  const handleCancel = useCallback(() => { setShowCancelConfirm(true); }, []);
  const handleBack = useCallback(() => { setShowBackConfirm(true); }, []);

  // Computed status
  const totalErrorCount = useMemo(() => getTotalDataErrorCount(existingSections), [getTotalDataErrorCount, existingSections]);

  const sectionsWithErrorsCount = useMemo(() => {
    return selectedIndices.filter((idx) => getSectionDataErrorCount(idx, existingSections) > 0).length;
  }, [selectedIndices, getSectionDataErrorCount, existingSections]);

  const currentSectionStatus = useMemo(() => {
    if (currentSectionIndex === undefined) return 'not_placed';
    return getSectionStatus(currentSectionIndex);
  }, [currentSectionIndex, getSectionStatus]);

  const isCurrentPlaced = currentSectionStatus === 'placed';
  const isCurrentExcluded = currentSectionStatus === 'excluded';

  const currentSectionHasErrors = useMemo(() => {
    if (currentSectionIndex === undefined) return false;
    return getSectionDataErrorCount(currentSectionIndex, existingSections) > 0;
  }, [currentSectionIndex, getSectionDataErrorCount, existingSections]);

  const isLastUnplacedSection = useMemo(() => {
    const unplacedCount = selectedIndices.filter((idx) => {
      if (idx === currentSectionIndex) return false;
      const status = getSectionStatus(idx);
      return status !== 'placed' && status !== 'excluded';
    }).length;
    return unplacedCount === 0;
  }, [selectedIndices, currentSectionIndex, getSectionStatus]);

  const showPlaceAndFinish = isLastUnplacedSection && !isCurrentPlaced && !isCurrentExcluded;

  const nextUnplacedSectionIndex = useMemo(() => {
    for (let i = currentIndex + 1; i < selectedIndices.length; i++) {
      const idx = selectedIndices[i];
      if (idx === undefined) continue;
      const status = getSectionStatus(idx);
      if (status !== 'placed' && status !== 'excluded') return i;
    }
    for (let i = 0; i < currentIndex; i++) {
      const idx = selectedIndices[i];
      if (idx === undefined) continue;
      const status = getSectionStatus(idx);
      if (status !== 'placed' && status !== 'excluded') return i;
    }
    return null;
  }, [selectedIndices, currentIndex, getSectionStatus]);

  const showNextSection = (isCurrentPlaced || isCurrentExcluded) && nextUnplacedSectionIndex !== null;

  const handleNextSection = useCallback(() => {
    if (nextUnplacedSectionIndex !== null) {
      navigateToArrayIndex(nextUnplacedSectionIndex);
    }
  }, [nextUnplacedSectionIndex, navigateToArrayIndex]);

  const canFinishWithExclusion = useMemo(() => {
    if (!isCurrentExcluded) return false;
    return selectedIndices.every((idx) => {
      if (idx === currentSectionIndex) return true;
      const status = getSectionStatus(idx);
      return status === 'placed' || status === 'excluded';
    });
  }, [isCurrentExcluded, selectedIndices, currentSectionIndex, getSectionStatus]);

  // Keyboard shortcuts
  const handleDialogKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' && e.ctrlKey && !e.repeat) {
        e.preventDefault();
        e.stopPropagation();
        if (currentSectionIndex !== undefined) {
          const status = getSectionStatus(currentSectionIndex);
          if (status === 'placed' || status === 'excluded' || status === 'errors') return;
        }
        handlePlaceSection();
        return;
      }
      if (e.key === 'ArrowLeft' && e.ctrlKey && !e.repeat) {
        e.preventDefault();
        e.stopPropagation();
        handlePrevious();
        return;
      }
      if (e.key === 'ArrowRight' && e.ctrlKey && !e.repeat) {
        e.preventDefault();
        e.stopPropagation();
        if (currentIndex < selectedIndices.length - 1) {
          navigateToArrayIndex(currentIndex + 1);
        }
        return;
      }
      if (e.key === 'z' && e.ctrlKey && !e.shiftKey && !e.repeat) {
        e.preventDefault();
        e.stopPropagation();
        handleUndo();
        return;
      }
      if (((e.key === 'z' || e.key === 'Z') && e.ctrlKey && e.shiftKey) ||
          (e.key === 'y' && e.ctrlKey && !e.repeat)) {
        e.preventDefault();
        e.stopPropagation();
        handleRedo();
      }
    },
    [currentIndex, selectedIndices.length, currentSectionIndex, handlePlaceSection, handlePrevious, navigateToArrayIndex, handleUndo, handleRedo, getSectionStatus],
  );

  return (
    <DialogWrapper
      title={t('dialogs.dmpNewImport.title')}
      onClose={handleCancel}
      fixedSize={{ width: 'min(900px, 95vw)', height: 'min(700px, 90vh)' }}
      overflow="hidden"
      bodyClassName="flex-1 flex flex-col p-0 min-h-0"
      data-testid="dmp-new-import-dialog"
      onKeyDown={handleDialogKeyDown}
    >
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 flex overflow-hidden min-h-0">
          {/* Left Panel - Section List */}
          <div
            className={`border-r border-border flex flex-col transition-all flex-shrink-0 min-h-0 ${
              leftPanelCollapsed ? 'w-10' : 'w-56'
            }`}
            data-testid="section-list-panel"
          >
            <button
              type="button"
              onClick={() => setLeftPanelCollapsed(!leftPanelCollapsed)}
              className="px-2 py-2 text-sm text-text-secondary hover:text-text-primary border-b border-border"
              aria-label={leftPanelCollapsed ? 'Expand section list' : 'Collapse section list'}
              data-testid="collapse-section-list-button"
            >
              {leftPanelCollapsed ? (
                <ChevronRightIcon size={14} />
              ) : (
                <span className="inline-flex items-center gap-2">
                  <ChevronLeftIcon size={14} />
                  <span>{t('dialogs.dmpNewImport.sections')}</span>
                </span>
              )}
            </button>

            {!leftPanelCollapsed && (
              <div className="flex-1 overflow-auto min-h-0">
                {selectedIndices.map((sectionIdx, arrayIdx) => {
                  const section = dmpFile.sections[sectionIdx];
                  const status = getSectionStatus(sectionIdx);
                  const isActive = arrayIdx === currentIndex;
                  const sectionDataErrors = getSectionDataErrorCount(sectionIdx, existingSections);
                  const canShowWarnings = sectionDataErrors === 0 && status === 'not_placed';
                  const sectionWarnings = canShowWarnings ? getSectionWarningCount(sectionIdx, validationConfig) : 0;
                  const showWarnings = sectionWarnings > 0;
                  const statusType =
                    status === 'excluded' ? 'excluded'
                      : status === 'errors' || sectionDataErrors > 0 ? 'errors'
                        : showWarnings ? 'warnings'
                          : status === 'placed' ? 'placed'
                            : 'not_placed';

                  let statusIcon: ReactNode;
                  let statusColor: string;
                  if (status === 'excluded') {
                    statusIcon = <XCircleIcon size={14} />;
                    statusColor = 'text-error';
                  } else if (status === 'errors' || sectionDataErrors > 0) {
                    statusIcon = <AlertCircleIcon size={14} />;
                    statusColor = 'text-error';
                  } else if (showWarnings) {
                    statusIcon = <AlertTriangleIcon size={14} />;
                    statusColor = 'text-warning';
                  } else if (status === 'placed') {
                    statusIcon = <CheckCircleIcon size={14} />;
                    statusColor = 'text-success';
                  } else {
                    statusIcon = <CircleIcon size={14} />;
                    statusColor = 'text-text-secondary';
                  }

                  return (
                    <button
                      key={sectionIdx}
                      type="button"
                      onClick={() => navigateToArrayIndex(arrayIdx)}
                      className={`w-full px-3 py-2 text-left text-sm flex items-center gap-2 hover:bg-background-50 ${
                        isActive ? 'bg-accent-10 border-l-2 border-accent' : ''
                      }`}
                      data-testid={`section-list-item-${arrayIdx}`}
                    >
                      <span className={statusColor} data-testid={`section-status-${arrayIdx}`} data-status={statusType}>
                        {statusIcon}
                      </span>
                      <span className="truncate flex-1">{section?.name ?? `Section ${arrayIdx + 1}`}</span>
                      {showWarnings && (
                        <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 bg-warning text-accent-on rounded-full text-[10px] font-medium" data-testid={`section-warning-count-${arrayIdx}`}>
                          {sectionWarnings}
                        </span>
                      )}
                      {sectionDataErrors > 0 && (
                        <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 bg-error text-accent-on rounded-full text-[10px] font-medium" data-testid={`section-error-count-${arrayIdx}`}>
                          {sectionDataErrors}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Preview - anchored at bottom */}
            {!leftPanelCollapsed && currentConfig && currentDmpSection && (
              <div className="flex-shrink-0 p-2 border-t border-border bg-panel" data-testid="section-preview-panel">
                <SectionPreview
                  section={previewSection}
                  color={currentConfig.color}
                  size={200}
                  selectedStationIndex={
                    selectedShotVisibleIndex !== null ? selectedShotVisibleIndex + 1 : null
                  }
                  mergePreview={mergePreviewConfig}
                  onStationClick={(stationIndex) => {
                    if (stationIndex > 0) {
                      const visibleIndex = stationIndex - 1;
                      const shot = visibleShots[visibleIndex];
                      if (shot) {
                        setSelectedShotKey(getShotKey(shot));
                      } else {
                        setSelectedShotKey(null);
                      }
                    } else {
                      setSelectedShotKey(null);
                    }
                  }}
                />
              </div>
            )}

            {!leftPanelCollapsed && sectionsWithErrorsCount > 0 && (
              <div className="px-3 py-2 text-xs text-error border-t border-border" data-testid="error-summary">
                {sectionsWithErrorsCount} section{sectionsWithErrorsCount > 1 ? 's' : ''} with errors ({totalErrorCount} total)
              </div>
            )}
          </div>

          {/* Main Panel */}
          <div className="flex-1 flex flex-col min-h-0 min-w-0 p-3" data-testid="main-config-panel">
            {currentConfig && currentDmpSection ? (
              <div className="flex-1 overflow-y-auto min-h-0 flex flex-col">
                {/* Section header */}
                <div className="flex items-center gap-4 mb-4">
                  <h3 className="font-medium text-lg">
                    {currentConfig.name}
                  </h3>
                  <span className="text-sm text-text-secondary">
                    ({t('dialogs.dmpNewImport.sectionOf', { current: currentIndex + 1, total: selectedIndices.length })})
                  </span>
                  {isCurrentPlaced && (
                    <span className="px-2 py-1 bg-success-10 text-success text-xs rounded inline-flex items-center gap-1" data-testid="placed-badge">
                      <CheckCircleIcon size={12} />
                      Placed
                    </span>
                  )}
                  {isCurrentExcluded && (
                    <span className="px-2 py-1 bg-error-10 text-error text-xs rounded inline-flex items-center gap-1" data-testid="excluded-badge">
                      <XCircleIcon size={12} />
                      Excluded
                    </span>
                  )}
                  <div className="flex-1" />
                  <Button
                    size="sm"
                    onClick={handleResetSection}
                    disabled={isCurrentPlaced || isCurrentExcluded}
                    data-testid="reset-section-button"
                    title="Reset all fields and placement to original DMP values"
                  >
                    {t('common.actions.reset')}
                  </Button>
                </div>

                {isCurrentPlaced && (
                  <div className="mb-4 p-3 bg-success-10 border border-success-30 rounded text-sm text-success" data-testid="placed-section-banner">
                    This section has been placed and cannot be edited. Navigate to an unplaced section to continue.
                  </div>
                )}

                {isCurrentExcluded && (
                  <div className="mb-4 p-3 bg-error-10 border border-error-30 rounded text-sm text-error" data-testid="excluded-section-banner">
                    This section is excluded from import. Click "Include" to add it back.
                  </div>
                )}

                {/* Parameters */}
                <div className="mb-4">
                  <Panel title="Parameters">
                    <div
                      className={`text-sm text-text-secondary border-b border-border pb-3 mb-3 ${isCurrentExcluded ? 'opacity-50' : ''}`}
                      data-testid="section-stats"
                    >
                      <span data-testid="section-stats-shot-count">{sectionStats.shotCount} shots</span>
                      <span className="mx-2">|</span>
                      <span data-testid="section-stats-total-length">{formatLength(sectionStats.totalLength, lengthUnit)}</span>
                      <span className="mx-2">|</span>
                      <span data-testid="section-stats-depth-range">Depth: {formatDepthRange(sectionStats.minDepth, sectionStats.maxDepth, depthUnit)}</span>
                    </div>
                    <SectionMetadataForm
                      name={currentConfig.name}
                      surveyor={currentConfig.surveyor ?? ''}
                      date={currentConfig.date ?? ''}
                      color={currentConfig.color}
                      direction={currentConfig.direction}
                      quality={currentConfig.quality}
                      onNameChange={(value) => updateSectionField('name', value)}
                      onSurveyorChange={(value) => updateSectionField('surveyor', value || null)}
                      onDateChange={(value) => updateSectionField('date', value || null)}
                      onColorChange={(value) => updateSectionField('color', value)}
                      onQualityChange={(value) => updateSectionField('quality', value)}
                      onDirectionChange={(value) => updateSectionField('direction', value)}
                      showDirection
                      showQuality
                      disabled={isCurrentPlaced || isCurrentExcluded}
                    />
                  </Panel>
                </div>

                {/* Placement options */}
                <Panel title="Placement" className="mb-4" data-testid="placement-panel">
                  {/* Suggested placements from reference shot overlap */}
                  {suggestions.length > 0 && !isCurrentPlaced && !isCurrentExcluded && (
                    <div className="mb-3 space-y-2" data-testid="placement-suggestions">
                      <div className="text-xs font-medium text-text-secondary uppercase tracking-wide">{t('dialogs.dmpNewImport.suggestedPlacements')}</div>
                      {suggestions.slice(0, 3).map((suggestion, idx) => {
                        const confidenceColors = {
                          high: 'bg-success-10 text-success border-success-30',
                          medium: 'bg-warning-10 text-warning border-warning-30',
                          low: 'bg-background-50 text-text-secondary border-border',
                        };
                        const confidenceLabel = { high: 'High', medium: 'Med', low: 'Low' };
                        const directionLabel = suggestion.direction === 'forward' ? '\u2192' : '\u2190';
                        return (
                          <button
                            key={`${suggestion.existingSectionId}-${suggestion.existingStationIndex}-${suggestion.importStationIndex}-${suggestion.direction}`}
                            type="button"
                            className={`w-full p-2 rounded border text-left text-sm flex items-center gap-2 hover:bg-accent-5 transition-colors ${
                              suggestion.confidence === 'low' ? 'opacity-70' : ''
                            } ${confidenceColors[suggestion.confidence]}`}
                            onClick={() => {
                              const actualImportStation = suggestion.importStationIndex;
                              setImportStationIndex(actualImportStation);
                              setTargetSectionRef(String(suggestion.existingSectionId));
                              setTargetStationIndex(suggestion.existingStationIndex);
                              handlePlacementChange({
                                type: 'fromExisting',
                                importStation: actualImportStation,
                                existingStation: {
                                  section_id: suggestion.existingSectionId,
                                  station_index: suggestion.existingStationIndex,
                                },
                              });
                            }}
                            data-testid={`placement-suggestion-${idx}`}
                          >
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${confidenceColors[suggestion.confidence]}`}>
                              {confidenceLabel[suggestion.confidence]}
                            </span>
                            <span className="flex-1 truncate">
                              <span className="font-medium">{suggestion.existingSectionName}</span>
                              <span className="text-text-secondary"> stn {suggestion.existingStationIndex}</span>
                            </span>
                            <span className="text-text-secondary text-xs" title={`${suggestion.matchedShots} shots matched ${suggestion.direction}${suggestion.isPartial ? ' (partial)' : ''}`}>
                              {suggestion.matchedShots} {directionLabel}
                              {suggestion.isPartial && <span className="ml-0.5 opacity-60">~</span>}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <div className="space-y-3">
                    {/* Place at center of screen */}
                    <div
                      className={`p-3 rounded border ${
                        currentConfig.placement.type === 'origin' ? 'border-accent bg-accent-5' : 'border-border'
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
                        currentConfig.placement.type === 'zeroDatum' ? 'border-accent bg-accent-5' : 'border-border'
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
                              <span className="text-xs px-2 py-1 bg-accent-10 text-accent rounded" data-testid="gps-format-indicator">
                                {gpsFormat}
                              </span>
                            )}
                          </div>
                          {gpsError && (
                            <div className="text-xs text-error ml-14" data-testid="gps-error">{gpsError}</div>
                          )}
                          {gpsCoords && (
                            <div className="text-xs text-success ml-14" data-testid="gps-parsed">
                              Lat: {formatFixed(gpsCoords.latitude, undefined, precision.gps)}, Lon: {formatFixed(gpsCoords.longitude, undefined, precision.gps)}
                            </div>
                          )}
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
                          ? 'border-accent bg-accent-5'
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
                            if (targetSectionRef) {
                              handlePlaceFromExisting();
                            } else {
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
                          <div className="flex items-center gap-2 flex-wrap">
                            <label className="text-sm text-text-secondary">Connect:</label>
                            <Select
                              value={String(importStationIndex)}
                              onChange={(v) => {
                                const newImportStation = parseInt(v, 10);
                                setImportStationIndex(newImportStation);
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

                          <div className="flex items-center gap-2 flex-wrap">
                            <Select
                              value={targetSectionRef}
                              onChange={(v) => {
                                setTargetSectionRef(v);
                                setTargetStationIndex(0);
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
                                if (importingSectionOptions.length > 0) {
                                  groups.push({
                                    label: 'Importing',
                                    options: importingSectionOptions.map((opt) => {
                                      const idx = parseInt(opt.value.replace('import-', ''), 10);
                                      const name = opt.label.replace(' (importing)', '');
                                      return { value: opt.value, label: `${idx}: ${name}` };
                                    }),
                                  });
                                }
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
                      selectedRowIndex={selectedShotActualIndex}
                      onRowSelect={(rowIndex) => {
                        if (!currentConfig) return;
                        const shot = currentConfig.shots[rowIndex];
                        if (!shot) {
                          setSelectedShotKey(null);
                          return;
                        }
                        setSelectedShotKey(getShotKey(shot));
                      }}
                      maxHeight="calc(100% - 2rem)"
                      readOnly={isCurrentPlaced || isCurrentExcluded}
                      validationConfig={validationConfig}
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
              {t('common.actions.cancel')}
            </Button>
            <Button onClick={handleBack} data-testid="back-to-selection-button">
              {t('common.actions.back')}
            </Button>
            <Button
              onClick={handleExcludeToggle}
              disabled={isCurrentPlaced}
              data-testid={isCurrentExcluded ? 'include-button' : 'exclude-button'}
              title={isCurrentPlaced ? 'Cannot exclude a placed section' : undefined}
            >
              {isCurrentExcluded ? t('dialogs.dmpNewImport.include') : t('dialogs.dmpNewImport.exclude')}
            </Button>
          </div>
          <div className="flex gap-2">
            {allSectionsExcluded ? (
              <Button onClick={handleCancel} data-testid="cancel-all-excluded-button">
                {t('dialogs.dmpNewImport.cancelAllExcluded')}
              </Button>
            ) : canFinishWithExclusion ? (
              <Button
                variant="primary"
                onClick={() => onImport(getAllConfigs())}
                data-testid="finish-import-button"
              >
                {t('dialogs.dmpNewImport.finishImport')}
              </Button>
            ) : showNextSection ? (
              <Button
                variant="primary"
                onClick={handleNextSection}
                data-testid="next-section-button"
              >
                {t('dialogs.dmpNewImport.nextSection')} →
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={handlePlaceSection}
                disabled={
                  currentSectionHasErrors ||
                  ((currentConfig?.placement.type === 'fromExisting' || currentConfig?.placement.type === 'fromImporting') && !targetSectionRef) ||
                  (currentConfig?.placement.type === 'zeroDatum' && !gpsCoords)
                }
                data-testid={showPlaceAndFinish ? 'place-and-finish-button' : 'place-section-button'}
                title={
                  currentSectionHasErrors
                    ? 'Fix errors before placing'
                    : (currentConfig?.placement.type === 'fromExisting' || currentConfig?.placement.type === 'fromImporting') && !targetSectionRef
                      ? 'Select a target section first'
                      : currentConfig?.placement.type === 'zeroDatum' && !gpsCoords
                        ? 'Enter GPS coordinates first'
                        : undefined
                }
              >
                {showPlaceAndFinish ? t('dialogs.dmpNewImport.placeAndFinish') : t('dialogs.dmpNewImport.placeSection')}
              </Button>
            )}
          </div>
        </div>
      </div>

      <AlertDialog
        open={showCancelConfirm}
        title="Cancel Import?"
        onClose={() => setShowCancelConfirm(false)}
        data-testid="cancel-confirm-dialog"
        actions={
          <>
            <Button onClick={() => setShowCancelConfirm(false)}>Continue Editing</Button>
            <Button variant="danger" onClick={onCancel} data-testid="confirm-cancel-button">
              Cancel Import
            </Button>
          </>
        }
      >
        <>
          <p>Are you sure you want to cancel the import?</p>
          <p className="text-text-secondary text-sm">All section configurations will be lost.</p>
        </>
      </AlertDialog>

      <AlertDialog
        open={showBackConfirm}
        title="Go Back?"
        onClose={() => setShowBackConfirm(false)}
        data-testid="back-confirm-dialog"
        actions={
          <>
            <Button onClick={() => setShowBackConfirm(false)}>Continue Editing</Button>
            <Button variant="danger" onClick={onBack} data-testid="confirm-back-button">
              Go Back
            </Button>
          </>
        }
      >
        <>
          <p>Go back to section selection?</p>
          <p className="text-text-secondary text-sm">All section configurations will be lost.</p>
        </>
      </AlertDialog>

      <AlertDialog
        open={deleteConfirmState.visible}
        title="Delete Shot?"
        onClose={() => setDeleteConfirmState({ visible: false, shotIndex: -1, isMidSection: false })}
        data-testid="delete-shot-confirm-dialog"
        actions={
          <>
            <Button onClick={() => setDeleteConfirmState({ visible: false, shotIndex: -1, isMidSection: false })}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={handleConfirmDelete}
              data-testid="confirm-delete-shot-button"
            >
              Delete Shot
            </Button>
          </>
        }
      >
        <>
          <p>Are you sure you want to delete this shot?</p>
          <p className="text-text-secondary text-sm">
            This is a mid-section shot. Deleting it will affect the survey chain.
          </p>
        </>
      </AlertDialog>
    </DialogWrapper>
  );
}
