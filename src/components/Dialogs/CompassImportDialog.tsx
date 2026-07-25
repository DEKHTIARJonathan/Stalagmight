import { useState, useEffect, useCallback, useMemo } from 'react';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { invokeIpc, getErrorMessage } from '../../utils/ipc';
import { completeImportToSingleView, finalizeDeferredSaveWarnings } from '../../utils/saveFeedback';
import { extractFilename } from '../../utils/path';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import type { CompassFile, OrphanPlacementSuggestion } from '../../types/commands';
import { setSource } from '../../utils/telemetry';

interface CompassImportDialogProps {
  compassFile: CompassFile;
  filePath: string;
}

export default function CompassImportDialog({ compassFile, filePath }: CompassImportDialogProps) {
  const { executeCompassImport, calculateFileHash, checkDuplicateImport, startLoading, setLoadingProgress, resetLoading } = useProjectStore();
  const { closeDialog, openDialog, setView, triggerFitToBounds } = useUIStore();

  const [isImporting, setIsImporting] = useState(false);
  const [fileHash, setFileHash] = useState<string | null>(null);
  const [isDuplicate, setIsDuplicate] = useState(false);
  const [hashChecked, setHashChecked] = useState(false);
  const [includeExcluded, setIncludeExcluded] = useState(false);
  const [applyCorrections, setApplyCorrections] = useState(true);
  const [commentsOnStations, setCommentsOnStations] = useState(true);

  // Check for duplicate import on mount
  useEffect(() => {
    (async () => {
      try {
        const hash = await calculateFileHash(filePath);
        setFileHash(hash);
        const dup = await checkDuplicateImport(hash);
        setIsDuplicate(dup);
      } catch {
        // Non-fatal: proceed without duplicate detection
      }
      setHashChecked(true);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fileName = useMemo(() => extractFilename(filePath), [filePath]);

  const handleImport = useCallback(async () => {
    setIsImporting(true);
    // Show the loading overlay so the user sees Reading -> Converting ->
    // Applying -> Finalizing phase ticks from the backend ProgressEmitter.
    startLoading(compassFile.cave_name || fileName, filePath);
    setLoadingProgress({ phase: 'import_parsing' });
    const importUi = { closeDialog, setView, triggerFitToBounds, openDialog };
    try {
      const result = await executeCompassImport(filePath, fileHash, includeExcluded, applyCorrections, commentsOnStations);
      resetLoading();

      if (!result.success) {
        completeImportToSingleView('compass-import', importUi);
        openDialog('error', {
          title: 'Import Errors',
          message: result.error ?? 'Unknown error during import',
        });
        return;
      }

      // A partial-success import (new-project deferred save failed) returns
      // success WITH a "SYSTEM" save-failure warning. Surface ONLY that, before
      // the optional orphan step, so "unsaved - save manually" isn't buried.
      // Routine per-shot validation warnings (LONG_SHOT, …) also ride along on a
      // successful import but are surfaced via the data-table UI - they must not
      // modal here or skip orphan placement (#110).
      if (finalizeDeferredSaveWarnings(result.warnings, 'compass-import', importUi)) {
        return;
      }

      // Check for orphan placement opportunities
      if (result.section_ids.length > 0) {
        try {
          const suggestions = await invokeIpc<OrphanPlacementSuggestion[]>(
            'suggest_orphan_placements',
            { newlyImportedSectionIds: result.section_ids },
            { purpose: 'suggest orphan placements after Compass import' }
          );
          if (suggestions.length > 0) {
            setSource('dialog');
            openDialog('orphan-placement', { suggestions });
            return;
          }
        } catch {
          // Non-fatal: proceed without orphan detection
        }
      }

      completeImportToSingleView('compass-import', importUi);
    } catch (e) {
      resetLoading();
      setIsImporting(false);
      openDialog('error', {
        title: 'Import Failed',
        message: getErrorMessage(e, 'Failed to import Compass file'),
      });
    }
  }, [executeCompassImport, filePath, fileHash, includeExcluded, applyCorrections, commentsOnStations, compassFile.cave_name, fileName, closeDialog, openDialog, setView, triggerFitToBounds, startLoading, setLoadingProgress, resetLoading]);

  return (
    <DialogWrapper title="Import Compass Survey" onClose={closeDialog} size="lg" data-testid="compass-import-dialog">
      <div className="space-y-4">
        {/* Header info */}
        <div className="space-y-1">
          <div className="text-sm text-text-secondary">{fileName}</div>
          {compassFile.cave_name && (
            <div className="text-lg font-medium">{compassFile.cave_name}</div>
          )}
          <div className="text-xs text-text-tertiary">
            {compassFile.length_unit === 'meters'
              ? 'Lengths kept as-is (survey is in meters)'
              : compassFile.length_unit === 'mixed'
                ? 'Surveys declare mixed length units; each is converted to meters per its own declaration'
                : 'Lengths converted from feet to meters'}
          </div>
        </div>

        {/* Summary stats */}
        <div className="grid grid-cols-4 gap-3 p-3 bg-surface-alt rounded">
          <div>
            <div className="text-xs text-text-tertiary">Surveys</div>
            <div className="text-sm font-medium">{compassFile.survey_count}</div>
          </div>
          <div>
            <div className="text-xs text-text-tertiary">Shots</div>
            <div className="text-sm font-medium">{compassFile.shot_count}</div>
          </div>
          <div>
            <div className="text-xs text-text-tertiary">Datum</div>
            <div className="text-sm font-medium">{compassFile.datum ?? '-'}</div>
          </div>
          <div>
            <div className="text-xs text-text-tertiary">Georeference</div>
            <div className="text-sm font-medium">
              {compassFile.has_georeference
                ? `UTM ${compassFile.utm_zone ?? ''}`.trim()
                : 'None'}
            </div>
          </div>
        </div>

        {/* Survey list */}
        <div className="max-h-64 overflow-y-auto border border-border rounded">
          <table className="w-full text-sm">
            <thead className="bg-surface-alt sticky top-0">
              <tr className="text-left text-text-tertiary text-xs">
                <th className="px-3 py-1.5">Survey</th>
                <th className="px-3 py-1.5">Shots</th>
                <th className="px-3 py-1.5">Team</th>
                <th className="px-3 py-1.5">Date</th>
                <th className="px-3 py-1.5">Decl.</th>
              </tr>
            </thead>
            <tbody>
              {compassFile.surveys.map((survey, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="px-3 py-1.5">{survey.name}</td>
                  <td className="px-3 py-1.5">{survey.shot_count}</td>
                  <td className="px-3 py-1.5 text-text-secondary">{survey.team ?? '-'}</td>
                  <td className="px-3 py-1.5 text-text-secondary">{survey.date}</td>
                  <td className="px-3 py-1.5 text-text-secondary">{survey.declination}°</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Declination mode info */}
        <div className="text-xs text-text-secondary">
          Declination mode: {compassFile.declination_mode}
          {compassFile.has_backsights && ' · backsights present'}
        </div>

        {/* Parser warnings */}
        {compassFile.warnings.length > 0 && (
          <div className="p-3 bg-warning-10 border border-warning-20 rounded text-sm space-y-1">
            {compassFile.warnings.map((w, i) => (
              <div key={i}>{w}</div>
            ))}
          </div>
        )}

        {/* Duplicate warning */}
        {isDuplicate && hashChecked && (
          <div className="p-3 bg-warning-10 border border-warning-20 rounded text-sm">
            This file has already been imported to this project. Importing again will create duplicate sections.
          </div>
        )}

        {/* Options */}
        <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={applyCorrections}
            onChange={(e) => setApplyCorrections(e.target.checked)}
            data-testid="compass-apply-corrections"
          />
          Apply per-survey instrument corrections (CORRECTIONS / CORRECTIONS2 lines)
        </label>
        <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={commentsOnStations}
            onChange={(e) => setCommentsOnStations(e.target.checked)}
            data-testid="compass-comments-on-stations"
          />
          Promote shot comments to the FROM station (Compass convention)
        </label>
        <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={includeExcluded}
            onChange={(e) => setIncludeExcluded(e.target.checked)}
            data-testid="compass-include-excluded"
          />
          Include shots flagged for exclusion (as reference shots)
        </label>

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={closeDialog}>Cancel</Button>
          <Button
            data-primary-action=""
            data-testid="compass-import-confirm"
            onClick={handleImport}
            disabled={isImporting || !hashChecked}
          >
            {isImporting ? 'Importing...' : 'Import'}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
