import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { invokeIpc } from '../../utils/ipc';
import {
  completeImportToSingleView,
  finalizeDeferredSaveWarnings,
  importFailureMessage,
  surfaceImportFailure,
  type ImportFailure,
} from '../../utils/saveFeedback';
import { formatPhaseLabel } from '../../utils/loadingPhaseLabel';
import { extractFilename } from '../../utils/path';
import { clamp } from '../../utils/clamp';
import { formatNumber } from '../../i18n/format';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import type { TmlFile, TmlSection, TmlShot, OrphanPlacementSuggestion } from '../../types/commands';
import { setSource } from '../../utils/telemetry';
import type { VirtualShotMode } from '../../types/project';

interface TmlImportDialogProps {
  tmlFile: TmlFile;
  filePath: string;
}

/** Why the dialog is asking what to do with the just-created empty project. */
type Residue = { kind: 'cancel' } | { kind: 'failed'; message: string };

/**
 * True when the open project was created FOR this import (`importContext ===
 * 'new-project'`, set by the unified picker route) and still holds nothing.
 * Cancelling or failing out of here would otherwise strand the user inside an
 * empty project they never asked for (#411 C2).
 */
function isEmptyImportProject(): boolean {
  return (
    useUIStore.getState().importContext === 'new-project' &&
    (useProjectStore.getState().project?.sections.length ?? 0) === 0
  );
}

/**
 * The shots the backend will actually import under the current toggles: CLOSURE
 * rows are never imported (they are loop markers, not measurements) and excluded
 * rows only when the user opts in - mirrors `convert_shots_to_shot_data`
 * (src-tauri/src/parsers/tml.rs).
 */
function importableShots(section: TmlSection, includeExcluded: boolean): TmlShot[] {
  return section.shots.filter(
    (shot) => shot.shot_type !== 'Closure' && (includeExcluded || !shot.excluded)
  );
}

export default function TmlImportDialog({ tmlFile, filePath }: TmlImportDialogProps) {
  const { t } = useTranslation();
  const { executeTmlImport, calculateFileHash, startLoading, setLoadingProgress, resetLoading } = useProjectStore();
  const loading = useProjectStore((state) => state.loading);
  const { closeDialog, openDialog, setView, triggerFitToBounds, setImportContext } = useUIStore();

  const [isImporting, setIsImporting] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [fileHash, setFileHash] = useState<string | null>(null);
  const [residue, setResidue] = useState<Residue | null>(null);
  const [includeExcluded, setIncludeExcluded] = useState(false);
  const [commentsOnStations, setCommentsOnStations] = useState(true);
  // #27: Ariane has one VIRTUAL category, so the chain rule decides Jump vs
  // Reference by default. A user who knows the file can override it here.
  const [virtualShotMode, setVirtualShotMode] = useState<VirtualShotMode>('Auto');

  // The hash is import PROVENANCE (it rides along to execute_tml_import), never
  // a gate: this dialog only ever opens on a brand-new project, so a duplicate
  // import is unreachable here and nothing waits on the round-trip.
  useEffect(() => {
    (async () => {
      try {
        setFileHash(await calculateFileHash(filePath));
      } catch {
        // Non-fatal: import without provenance rather than blocking on it.
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fileName = useMemo(() => {
    return extractFilename(filePath);
  }, [filePath]);

  const stats = useMemo(() => {
    let totalShots = 0;
    let totalLength = 0;
    let minDepth = Infinity;
    let maxDepth = -Infinity;
    let excludedCount = 0;
    let commentCount = 0;
    let virtualCount = 0;

    for (const section of tmlFile.sections) {
      for (const shot of section.shots) {
        if (shot.shot_type === 'Closure') continue;
        if (shot.excluded) excludedCount++;
        if (!includeExcluded && shot.excluded) continue;
        totalShots++;
        totalLength += shot.length;
        if (shot.depth < minDepth) minDepth = shot.depth;
        if (shot.depth > maxDepth) maxDepth = shot.depth;
        if (shot.comment) commentCount++;
        if (shot.shot_type === 'Virtual') virtualCount++;
      }
    }

    return {
      totalShots,
      virtualCount,
      totalLength: Math.round(totalLength * 10) / 10,
      depthRange:
        minDepth === Infinity
          ? null
          : `${Math.round(minDepth * 10) / 10} - ${Math.round(maxDepth * 10) / 10}`,
      excludedCount,
      commentCount,
    };
  }, [tmlFile, includeExcluded]);

  const isEmptyImport = stats.totalShots === 0;

  // Escape / backdrop must not silently drop the option choices the user made.
  const optionsChanged = includeExcluded || !commentsOnStations || virtualShotMode !== 'Auto';

  const handleImport = useCallback(async () => {
    setIsImporting(true);
    // Drive the in-dialog progress line: Reading -> Converting -> Applying ->
    // Finalizing phase ticks from the backend ProgressEmitter.
    startLoading(tmlFile.cave_name || fileName, filePath);
    setLoadingProgress({ phase: 'import_parsing' });
    const importUi = { closeDialog, setView, triggerFitToBounds, openDialog };
    /**
     * Terminal failure. The shared router owns the wording and the exit rules
     * (docs/notifications.md); the one thing it cannot do is ask about the empty
     * project this import created, so when there is one the residue prompt below
     * carries the message instead - only one dialog fits on screen (#411 C2).
     */
    const reportFailure = (failure: ImportFailure) => {
      setIsImporting(false);
      if (isEmptyImportProject()) {
        setResidue({ kind: 'failed', message: importFailureMessage(failure) });
        return;
      }
      surfaceImportFailure('tml-import', importUi, failure);
    };
    try {
      const result = await executeTmlImport(filePath, fileHash, includeExcluded, commentsOnStations, virtualShotMode);
      resetLoading();

      if (!result.success) {
        reportFailure({ phase: 'command', error: result.error });
        return;
      }

      // A partial-success import (new-project deferred save failed) returns
      // success WITH a "SYSTEM" save-failure warning. Surface ONLY that, before
      // the optional orphan step, so "unsaved - save manually" isn't buried.
      // Routine per-shot validation warnings (LONG_SHOT, …) also ride along on a
      // successful import but are surfaced via the data-table UI - they must not
      // modal here or skip orphan placement (#110).
      if (finalizeDeferredSaveWarnings(result.warnings, 'tml-import', importUi, result.import_receipt)) {
        return;
      }

      // `section_ids` is `skip_serializing_if = "Vec::is_empty"` in Rust, so an
      // import that created NO section omits the key entirely - the generated
      // type says `Array<number>` but the wire says `undefined`. A bare
      // `.length` here threw, the catch below reported it as a transport
      // failure, and the receipt explaining the empty import was thrown away
      // (#411). Same guard as WallsImportDialog.
      const sectionIds = result.section_ids ?? [];

      // Check for orphan placement opportunities
      if (sectionIds.length > 0) {
        try {
          const suggestions = await invokeIpc<OrphanPlacementSuggestion[]>(
            'suggest_orphan_placements',
            { newlyImportedSectionIds: sectionIds },
            { purpose: 'suggest orphan placements after TML import' }
          );
          if (suggestions.length > 0) {
            setSource('dialog');
            openDialog('orphan-placement', { suggestions, receipt: result.import_receipt });
            return;
          }
        } catch {
          // Non-fatal: proceed without orphan detection
        }
      }

      completeImportToSingleView('tml-import', importUi, result.import_receipt);
    } catch (e) {
      resetLoading();
      reportFailure({ phase: 'transport', error: e, format: 'TML' });
    }
  }, [executeTmlImport, filePath, fileHash, includeExcluded, commentsOnStations, virtualShotMode, tmlFile.cave_name, fileName, closeDialog, openDialog, setView, triggerFitToBounds, startLoading, setLoadingProgress, resetLoading]);

  const handleCancel = useCallback(() => {
    if (isImporting) return;
    if (isEmptyImportProject()) {
      setResidue({ kind: 'cancel' });
      return;
    }
    closeDialog();
  }, [isImporting, closeDialog]);

  const handleKeepProject = useCallback(() => {
    closeDialog();
  }, [closeDialog]);

  const handleDiscardProject = useCallback(async () => {
    setIsDiscarding(true);
    const { project, databaseOpen, closeProject, deleteProject } = useProjectStore.getState();
    const path = project?.file_path;
    // A new-project import defers the initial save, so there is usually no
    // `.stalx` yet (databaseOpen === false) and closing the project IS the
    // discard. One created with an explicit save path was written to disk, so it
    // goes through the same delete path the Delete Project dialog uses.
    if (databaseOpen && path) {
      await deleteProject(path);
    } else {
      await closeProject();
    }
    setImportContext(null);
    setView('global');
    closeDialog();
  }, [closeDialog, setImportContext, setView]);

  if (residue) {
    return (
      <DialogWrapper
        title={t('dialogs.tmlImport.residue.title')}
        onClose={handleKeepProject}
        size="md"
        data-testid="tml-import-residue-dialog"
      >
        <div className="space-y-4">
          {residue.kind === 'failed' && (
            <div
              className="p-3 bg-error-10 border border-error-20 rounded text-error text-sm whitespace-pre-wrap"
              data-testid="tml-import-residue-error"
            >
              {residue.message}
            </div>
          )}
          <p className="text-text-secondary">{t('dialogs.tmlImport.residue.body')}</p>

          <div className="flex justify-end gap-2 pt-4 border-t border-border">
            <Button
              variant="danger"
              onClick={handleDiscardProject}
              disabled={isDiscarding}
              data-testid="tml-import-residue-discard"
            >
              {t('dialogs.tmlImport.residue.discard')}
            </Button>
            <Button
              data-primary-action=""
              onClick={handleKeepProject}
              disabled={isDiscarding}
              data-testid="tml-import-residue-keep"
            >
              {t('dialogs.tmlImport.residue.keep')}
            </Button>
          </div>
        </div>
      </DialogWrapper>
    );
  }

  return (
    <DialogWrapper
      title={t('dialogs.tmlImport.title')}
      onClose={handleCancel}
      size="lg"
      isDirty={optionsChanged}
      data-testid="tml-import-dialog"
    >
      <div className="space-y-4">
        {/* Header info */}
        <div className="space-y-1">
          <div className="text-sm text-text-secondary">{fileName}</div>
          {tmlFile.cave_name && (
            <div className="text-lg font-medium">{tmlFile.cave_name}</div>
          )}
          {tmlFile.unit === 'Imperial' && (
            <div className="text-xs text-text-tertiary">
              {t('dialogs.tmlImport.unitConversion')}
            </div>
          )}
        </div>

        {/* Summary stats - what actually imports under the current toggles */}
        <div className="grid grid-cols-4 gap-3 p-3 bg-surface-alt rounded">
          <div>
            <div className="text-xs text-text-tertiary">{t('dialogs.tmlImport.stats.sections')}</div>
            <div className="text-sm font-medium" data-testid="tml-section-count">{tmlFile.sections.length}</div>
          </div>
          <div>
            <div className="text-xs text-text-tertiary">{t('dialogs.tmlImport.stats.shots')}</div>
            <div className="text-sm font-medium" data-testid="tml-shot-count">{stats.totalShots}</div>
          </div>
          <div>
            <div className="text-xs text-text-tertiary">{t('dialogs.tmlImport.stats.totalLength')}</div>
            <div className="text-sm font-medium">
              {t('dialogs.tmlImport.stats.lengthValue', { length: stats.totalLength })}
            </div>
          </div>
          <div>
            <div className="text-xs text-text-tertiary">{t('dialogs.tmlImport.stats.depthRange')}</div>
            <div className="text-sm font-medium">{stats.depthRange ?? t('dialogs.tmlImport.stats.none')}</div>
          </div>
        </div>

        {/* Nothing survives the current options - there is no import to run */}
        {isEmptyImport && (
          <div
            className="p-3 bg-warning-10 border border-warning-20 rounded text-sm"
            data-testid="tml-import-empty"
          >
            {t('dialogs.tmlImport.empty')}
          </div>
        )}

        {/* Section list */}
        <div className="max-h-64 overflow-y-auto border border-border rounded">
          <table className="w-full text-sm">
            <thead className="bg-surface-alt sticky top-0">
              <tr className="text-left text-text-tertiary text-xs">
                <th className="px-3 py-1.5">{t('dialogs.tmlImport.table.section')}</th>
                <th className="px-3 py-1.5">{t('dialogs.tmlImport.table.shots')}</th>
                <th className="px-3 py-1.5">{t('dialogs.tmlImport.table.surveyor')}</th>
                <th className="px-3 py-1.5">{t('dialogs.tmlImport.table.date')}</th>
                <th className="px-3 py-1.5 w-6">{t('dialogs.tmlImport.table.color')}</th>
              </tr>
            </thead>
            <tbody>
              {tmlFile.sections.map((section, i) => (
                <tr
                  key={i}
                  className="border-t border-border"
                  data-testid={`tml-section-row-${i}`}
                >
                  <td className="px-3 py-1.5">
                    {section.name}
                    {section.is_branch_split && (
                      <span className="ml-1 text-xs text-text-tertiary">
                        {t('dialogs.tmlImport.table.branch')}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">{importableShots(section, includeExcluded).length}</td>
                  <td className="px-3 py-1.5 text-text-secondary">
                    {section.surveyor ?? t('dialogs.tmlImport.stats.none')}
                  </td>
                  <td className="px-3 py-1.5 text-text-secondary">
                    {section.date ?? t('dialogs.tmlImport.stats.none')}
                  </td>
                  <td className="px-3 py-1.5">
                    <div
                      className="w-4 h-4 rounded"
                      style={{ backgroundColor: section.color }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Closures info */}
        {tmlFile.closures.length > 0 && (
          <div className="text-xs text-text-secondary" data-testid="tml-closure-count">
            {t('dialogs.tmlImport.closures', { count: tmlFile.closures.length })}
          </div>
        )}

        {/* Excluded shots toggle */}
        {stats.excludedCount > 0 && (
          <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={includeExcluded}
              onChange={(e) => setIncludeExcluded(e.target.checked)}
              data-testid="tml-include-excluded"
            />
            {t('dialogs.tmlImport.includeExcluded', { count: stats.excludedCount })}
          </label>
        )}

        {/* Comments placement toggle */}
        {stats.commentCount > 0 && (
          <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={!commentsOnStations}
              onChange={(e) => setCommentsOnStations(!e.target.checked)}
              data-testid="tml-comments-on-shots"
            />
            {t('dialogs.tmlImport.keepCommentsOnShots')}
          </label>
        )}

        {/* Virtual-shot classification (#27). One control for the whole file,
            rather than the per-shot picker the issue first proposed: the chain
            rule gets it right in the common case, and the data table's J/R cell
            handles the exceptions with the map visible alongside. */}
        {stats.virtualCount > 0 && (
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <span>{t('dialogs.tmlImport.virtualShots', { count: stats.virtualCount })}</span>
            <select
              className="bg-surface border border-border rounded px-2 py-1"
              value={virtualShotMode}
              onChange={(e) => setVirtualShotMode(e.target.value as VirtualShotMode)}
              data-testid="tml-virtual-shot-mode"
            >
              <option value="Auto">{t('dialogs.tmlImport.virtualMode.auto')}</option>
              <option value="AllJumps">{t('dialogs.tmlImport.virtualMode.allJumps')}</option>
              <option value="AllReferences">{t('dialogs.tmlImport.virtualMode.allReferences')}</option>
            </select>
          </label>
        )}

        {/* In-dialog progress: by import time the view is 'single', so the
            GlobalView overlay that renders these phases is not mounted and a
            large file would otherwise show only a busy button (#411 C3). */}
        {isImporting && (
          <div className="space-y-1" data-testid="tml-import-progress">
            <div className="flex justify-between text-xs text-text-secondary">
              <span data-testid="tml-import-progress-phase">
                {formatPhaseLabel(t, loading.phase, loading.phaseIndex, loading.phaseCount)}
              </span>
              <span>{formatNumber(Math.round(clamp(loading.overallProgress, 0, 100)))}%</span>
            </div>
            <div className="h-1.5 bg-border rounded-full overflow-hidden">
              <div
                className="h-full bg-accent transition-all duration-300"
                style={{ width: `${clamp(loading.overallProgress, 0, 100)}%` }}
                role="progressbar"
                aria-label={t('loading.overall.aria')}
                aria-valuenow={Math.round(clamp(loading.overallProgress, 0, 100))}
                aria-valuemin={0}
                aria-valuemax={100}
              />
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={handleCancel} disabled={isImporting} data-testid="tml-import-cancel">
            {t('dialogs.tmlImport.cancel')}
          </Button>
          <Button
            data-primary-action=""
            data-testid="tml-import-confirm"
            onClick={handleImport}
            disabled={isImporting || isEmptyImport}
          >
            {isImporting ? t('dialogs.tmlImport.importing') : t('dialogs.tmlImport.import')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
