import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '../common/Button';
import { CheckCircleIcon } from '../common/icons';
import type { DmpFile, PlacementSuggestion, CommandResult } from '../../types/commands';
import type { DmpSelectionConfig } from './DmpSelectionDialog';
import type { Project, Station, ShotData } from '../../types/project';
import type { ImportSectionConfig as BackendImportSectionConfig, ImportPlacement } from '../../types/commands';
import type { ZeroDatumConfigResult } from './ZeroDatumConfigDialog';
import type { DmpSection } from '../../types/commands';
import SectionPreview, { type MergePreviewConfig } from './SectionPreview';
import { DialogWrapper } from './DialogWrapper';
import { AlertDialog } from './AlertDialog';
import { useProjectStore } from '../../store/projectStore';
import { convertToEditableShots } from '../../hooks/useImportState';
import { editableShotToShotData } from '../../utils/shotConversion';

const SECTION_COLORS = [
  '#4ecdc4', '#ff6b6b', '#95a5a6', '#3498db',
  '#9b59b6', '#1abc9c', '#e67e22', '#f39c12',
];

type RankedSuggestion = PlacementSuggestion & {
  importSectionIndex: number;
  importSectionName: string;
};

interface DmpNewImportDialogProps {
  dmpFile: DmpFile;
  selectionConfig: DmpSelectionConfig;
  project: Project | null;
  stations: Station[];
  zeroDatumConfig?: ZeroDatumConfigResult | undefined;
  onCancel: () => void;
  onBack: () => void;
  onHandoffToLegacy: (remainingIndices: Set<number>) => void;
  onComplete: () => void;
}

/**
 * Connection Wizard — auto-detects connections between import sections and
 * existing project sections, imports one-at-a-time as user confirms.
 * Hands off remaining sections to the legacy DmpSectionConfigDialog.
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
  const suggestImportPlacement = useProjectStore((s) => s.suggestImportPlacement);

  // Core state
  const [importedIndices, setImportedIndices] = useState<Set<number>>(new Set());
  const [skippedIndices, setSkippedIndices] = useState<Set<number>>(new Set());
  const [currentSuggestion, setCurrentSuggestion] = useState<RankedSuggestion | null>(null);
  const [alternatives, setAlternatives] = useState<RankedSuggestion[]>([]);
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [isCalculating, setIsCalculating] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [phase, setPhase] = useState<'init' | 'suggesting' | 'done'>('init');
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showBackConfirm, setShowBackConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track suggestion recalculation trigger
  const [recalcTrigger, setRecalcTrigger] = useState(0);

  // Cache all ranked suggestions from the last full calculation.
  // After confirm/skip we filter this instead of recalculating.
  const suggestionPoolRef = useRef<RankedSuggestion[]>([]);

  // Ref-based guard against double-click — state alone is stale in the closure
  const isImportingRef = useRef(false);

  // Guard against React StrictMode double-firing the mount effect.
  // Refs survive the cleanup→re-run cycle, preventing duplicate IPC calls.
  const importStartedRef = useRef(false);

  // Refs to avoid stale closures
  const importedIndicesRef = useRef(importedIndices);
  importedIndicesRef.current = importedIndices;
  const skippedIndicesRef = useRef(skippedIndices);
  skippedIndicesRef.current = skippedIndices;

  const selectedIndices = useMemo(
    () => Array.from(selectionConfig.selectedIndices).sort((a, b) => a - b),
    [selectionConfig.selectedIndices]
  );

  const totalSelected = selectedIndices.length;

  // Pick the next suggestion from the cached pool, filtering out imported/skipped sections.
  // Returns true if a suggestion was found, false if pool is empty.
  const pickFromPool = useCallback(() => {
    const imported = importedIndicesRef.current;
    const skipped = skippedIndicesRef.current;

    // Filter pool to only remaining sections
    const pool = suggestionPoolRef.current.filter(
      (s) => !imported.has(s.importSectionIndex) && !skipped.has(s.importSectionIndex)
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
    setShowAlternatives(false);
    return true;
  }, []);

  // On mount: import zero datum section if provided
  useEffect(() => {
    if (importStartedRef.current) return;
    importStartedRef.current = true;

    const importZeroDatum = async () => {
      if (!zeroDatumConfig) {
        // No zero datum to import — check if we can suggest
        const existingProject = useProjectStore.getState().project;
        const hasExistingSections = (existingProject?.sections.length ?? 0) > 0;

        if (!hasExistingSections && selectedIndices.length <= 1) {
          // No existing sections, 0 or 1 selected — nothing to connect
          setPhase('done');
          return;
        }

        setPhase('suggesting');
        return;
      }

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

      setImportedIndices(new Set([sectionIndex]));

      // Check if only 1 section was selected — we're done
      if (selectedIndices.length === 1 && selectedIndices[0] === sectionIndex) {
        setPhase('done');
        return;
      }

      setPhase('suggesting');
    };

    importZeroDatum();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Calculate suggestions when phase is 'suggesting' and importedIndices/skippedIndices change
  useEffect(() => {
    if (phase !== 'suggesting') return;

    let cancelled = false;

    const calculate = async () => {
      setIsCalculating(true);
      setCurrentSuggestion(null);
      setAlternatives([]);
      setShowAlternatives(false);

      const currentImported = importedIndicesRef.current;
      const remaining = selectedIndices.filter(
        (idx) => !currentImported.has(idx) && !skippedIndices.has(idx)
      );

      if (remaining.length === 0) {
        setIsCalculating(false);
        setPhase('done');
        return;
      }

      // Check if there are any existing sections to match against
      const currentProject = useProjectStore.getState().project;
      const hasExistingSections = (currentProject?.sections.length ?? 0) > 0;

      if (!hasExistingSections) {
        // No existing sections — can't suggest placements
        setIsCalculating(false);
        setPhase('done');
        return;
      }

      // For each remaining section, get placement suggestions
      const allSuggestions: RankedSuggestion[] = [];

      const promises = remaining.map(async (sectionIdx) => {
        const section = dmpFile.sections[sectionIdx];
        if (!section) return;

        const editableShots = convertToEditableShots(section.shots);
        const shotData: ShotData[] = editableShots.map((s) => ({
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

        try {
          const suggestions = await suggestImportPlacement(shotData);
          for (const suggestion of suggestions) {
            allSuggestions.push({
              ...suggestion,
              importSectionIndex: sectionIdx,
              importSectionName: section.name,
            });
          }
        } catch {
          // Silently ignore — suggestions are non-critical
        }
      });

      await Promise.all(promises);

      if (cancelled) return;

      // Sort by score descending and cache the full pool
      allSuggestions.sort((a, b) => b.score - a.score);
      suggestionPoolRef.current = allSuggestions;

      if (!pickFromPool()) {
        setIsCalculating(false);
        setPhase('done');
        return;
      }

      setIsCalculating(false);
    };

    calculate();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, recalcTrigger]);

  // Handle 'done' phase
  useEffect(() => {
    if (phase !== 'done') return;
    // Don't act while still importing or calculating
    if (isImporting || isCalculating) return;

    const remaining = new Set(
      selectedIndices.filter((idx) => !importedIndices.has(idx))
    );

    if (remaining.size > 0) {
      onHandoffToLegacy(remaining);
    } else {
      onComplete();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, isImporting, isCalculating]);

  // Build preview section for import side
  const importPreviewSection = useMemo<DmpSection | null>(() => {
    if (!currentSuggestion) return null;
    const section = dmpFile.sections[currentSuggestion.importSectionIndex];
    if (!section) return null;
    return section;
  }, [currentSuggestion, dmpFile.sections]);

  // Build merge preview config for SectionPreview
  const mergePreviewConfig = useMemo((): MergePreviewConfig | null => {
    if (!currentSuggestion) return null;

    const currentProject = useProjectStore.getState().project;
    if (!currentProject) return null;

    const targetSection = currentProject.sections.find(
      (s) => s.id === currentSuggestion.existingSectionId
    );
    if (!targetSection) return null;

    return {
      targetSection,
      importStationIndex: currentSuggestion.importStationIndex,
      targetStationIndex: currentSuggestion.existingStationIndex,
    };
  }, [currentSuggestion]);

  // Import color for the current section
  const importColor = useMemo(() => {
    return SECTION_COLORS[importedIndices.size % SECTION_COLORS.length] ?? '#4ecdc4';
  }, [importedIndices.size]);

  // Confirm handler — fires backend import optimistically and advances the
  // wizard immediately. Only blocks when fresh backend state is needed
  // (last section or pool exhausted for recalculation).
  const handleConfirm = useCallback(async () => {
    if (!currentSuggestion || isImportingRef.current) return;

    isImportingRef.current = true;
    setIsImporting(true);
    setError(null);

    const section = dmpFile.sections[currentSuggestion.importSectionIndex];
    if (!section) {
      isImportingRef.current = false;
      setIsImporting(false);
      return;
    }

    const editableShots = convertToEditableShots(section.shots);
    const backendShots: ShotData[] = editableShots.map(editableShotToShotData);

    const placement: ImportPlacement = {
      type: 'from_existing',
      import_station: currentSuggestion.importStationIndex,
      existing_station: {
        section_id: currentSuggestion.existingSectionId,
        station_index: currentSuggestion.existingStationIndex,
      },
    };

    // Determine color based on how many already imported
    const colorIdx = importedIndices.size % SECTION_COLORS.length;

    // Use default date from DMP section or selectionConfig
    const dateStr = selectionConfig.defaultDate ?? section.date?.split(/[T ]/)[0] ?? null;

    const config: BackendImportSectionConfig = {
      section_index: currentSuggestion.importSectionIndex,
      name: section.name,
      surveyor: selectionConfig.defaultSurveyor || null,
      date: dateStr,
      color: SECTION_COLORS[colorIdx] ?? '#4ecdc4',
      direction: section.direction,
      quality: 1.0,
      shots: backendShots,
      placement,
      station_comments: [],
    };

    // Fire backend import — don't await yet. The backend does two full
    // project serializations (undo snapshots) + autosave, which takes ~1s.
    // We advance the wizard immediately and only block when we need
    // fresh backend state.
    const importPromise = invoke<CommandResult>('import_sections', {
      sections: [config],
      fileHash: selectionConfig.fileHash ?? null,
    }).then((result) => {
      if (!result.success) {
        setError(result.error ?? 'Import failed');
      }
      refreshProjectState();
      return result;
    }).catch((e) => {
      const result: CommandResult = { success: false, error: String(e), warnings: [], section_ids: [] };
      setError(result.error ?? 'Import failed');
      return result;
    });

    isImportingRef.current = false;
    setIsImporting(false);

    // Add to imported
    const importedIdx = currentSuggestion.importSectionIndex;
    setImportedIndices((prev) => {
      const next = new Set(prev);
      next.add(importedIdx);
      return next;
    });

    // Update ref eagerly so pickFromPool sees the just-imported section
    const newImported = new Set(importedIndicesRef.current);
    newImported.add(importedIdx);
    importedIndicesRef.current = newImported;

    const remaining = selectedIndices.filter(
      (idx) => !newImported.has(idx) && !skippedIndicesRef.current.has(idx)
    );

    if (remaining.length === 0) {
      // Last section — wait for backend before transitioning
      await importPromise;
      setPhase('done');
      return;
    }

    // Try to pick next suggestion from cached pool (instant)
    if (!pickFromPool()) {
      // Pool exhausted — wait for backend, then recalculate against
      // newly imported sections
      await importPromise;
      setRecalcTrigger((n) => n + 1);
    }
  }, [currentSuggestion, dmpFile.sections, refreshProjectState, selectionConfig, importedIndices.size, selectedIndices, pickFromPool]);

  // Skip handler
  const handleSkip = useCallback(() => {
    if (!currentSuggestion) return;

    const skippedIdx = currentSuggestion.importSectionIndex;
    setSkippedIndices((prev) => {
      const next = new Set(prev);
      next.add(skippedIdx);
      return next;
    });

    // Update ref eagerly so pickFromPool sees the just-skipped section
    const newSkipped = new Set(skippedIndicesRef.current);
    newSkipped.add(skippedIdx);
    skippedIndicesRef.current = newSkipped;

    const remaining = selectedIndices.filter(
      (idx) => !importedIndicesRef.current.has(idx) && !newSkipped.has(idx)
    );

    if (remaining.length === 0) {
      setPhase('done');
      return;
    }

    // Try to pick next from cached pool (instant)
    if (!pickFromPool()) {
      // Pool exhausted — full recalculation needed
      setRecalcTrigger((n) => n + 1);
    }
  }, [currentSuggestion, selectedIndices, pickFromPool]);

  // Alternative click handler
  const handleAlternativeClick = useCallback((alt: RankedSuggestion) => {
    setCurrentSuggestion(alt);
    setAlternatives((prev) => {
      const newAlts = prev.filter((a) => a !== alt);
      if (currentSuggestion) {
        newAlts.push(currentSuggestion);
        newAlts.sort((a, b) => b.score - a.score);
      }
      return newAlts.slice(0, 4);
    });
    setShowAlternatives(false);
  }, [currentSuggestion]);

  // Cancel/Back
  const handleCancel = useCallback(() => {
    if (importedIndices.size > 0) {
      setShowCancelConfirm(true);
    } else {
      onCancel();
    }
  }, [importedIndices.size, onCancel]);

  const handleBack = useCallback(() => {
    if (importedIndices.size > 0) {
      setShowBackConfirm(true);
    } else {
      onBack();
    }
  }, [importedIndices.size, onBack]);

  // Confidence helpers
  const confidenceColors: Record<string, string> = {
    high: 'bg-success-10 text-success border-success-30',
    medium: 'bg-warning-10 text-warning border-warning-30',
    low: 'bg-background-50 text-text-secondary border-border',
  };

  const directionLabel = (direction: string) =>
    direction === 'forward' ? '\u2192' : '\u2190';

  // Progress
  const placedCount = importedIndices.size;
  const skippedCount = skippedIndices.size;

  // Whether we're in the suggestion view with a current suggestion (side-by-side layout)
  const showSideBySide = phase === 'suggesting' && !isCalculating && currentSuggestion != null;

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
                focusStationIndex={currentSuggestion!.importStationIndex}
              />
            </div>

            {/* Right column: connection details */}
            <div className="flex-1 min-w-0 overflow-y-auto p-5 space-y-4" data-testid="wizard-suggestion">
              {/* Connection description */}
              <div data-testid="wizard-connection-description">
                <div className="text-sm">
                  <span className="font-medium">&ldquo;{currentSuggestion!.importSectionName}&rdquo;</span>
                  {' '}{t('dialogs.dmpNewImport.station', { index: currentSuggestion!.importStationIndex })}
                </div>
                <div className="text-text-secondary text-sm my-1">
                  {t('dialogs.dmpNewImport.connectsTo')}
                </div>
                <div className="text-sm">
                  <span className="font-medium">&ldquo;{currentSuggestion!.existingSectionName}&rdquo;</span>
                  {' '}{t('dialogs.dmpNewImport.station', { index: currentSuggestion!.existingStationIndex })}
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
                          key={`${alt.importSectionIndex}-${alt.existingSectionId}-${alt.existingStationIndex}-${alt.importStationIndex}-${alt.direction}`}
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
            </div>

            {/* Importing overlay */}
            {isImporting && (
              <div className="absolute inset-0 bg-background/50 flex items-center justify-center z-10">
                <div className="text-sm animate-pulse">Importing...</div>
              </div>
            )}
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
            {phase === 'suggesting' && isCalculating && (
              <div className="text-center" data-testid="wizard-calculating">
                <div className="text-lg mb-2">{t('dialogs.dmpNewImport.calculating')}</div>
                <div className="animate-pulse text-text-secondary">...</div>
              </div>
            )}

            {/* No suggestions — show done phase briefly before handoff */}
            {phase === 'suggesting' && !isCalculating && !currentSuggestion && (
              <div className="text-center" data-testid="wizard-no-suggestions">
                <div className="text-lg mb-2">{t('dialogs.dmpNewImport.noSuggestions')}</div>
                {selectedIndices.filter((idx) => !importedIndices.has(idx)).length > 0 && (
                  <div className="text-sm text-text-secondary">
                    {t('dialogs.dmpNewImport.handoffMessage', {
                      count: selectedIndices.filter((idx) => !importedIndices.has(idx)).length,
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Done — all placed */}
            {phase === 'done' && importedIndices.size === totalSelected && (
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
          {importedIndices.size > 0
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
