import { useState, useEffect, useCallback, useMemo } from 'react';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { invokeIpc, getErrorMessage } from '../../utils/ipc';
import { extractFilename } from '../../utils/path';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import type { WallsFile, OrphanPlacementSuggestion } from '../../types/commands';
import { setSource, trackDialogComplete } from '../../utils/telemetry';

interface WallsImportDialogProps {
  wallsFile: WallsFile;
  filePath: string;
}

export default function WallsImportDialog({ wallsFile, filePath }: WallsImportDialogProps) {
  const { executeWallsImport, calculateFileHash, checkDuplicateImport, startLoading, setLoadingProgress, resetLoading } = useProjectStore();
  const { closeDialog, openDialog, setView, triggerFitToBounds } = useUIStore();

  const [isImporting, setIsImporting] = useState(false);
  const [fileHash, setFileHash] = useState<string | null>(null);
  const [isDuplicate, setIsDuplicate] = useState(false);
  const [hashChecked, setHashChecked] = useState(false);
  const [commentsOnStations, setCommentsOnStations] = useState(true);
  const [includeSplays, setIncludeSplays] = useState(false);

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
    startLoading(wallsFile.project_name || fileName, filePath);
    setLoadingProgress({ phase: 'import_parsing' });
    try {
      const result = await executeWallsImport(filePath, fileHash, commentsOnStations, includeSplays);
      resetLoading();

      if (!result.success) {
        trackDialogComplete('walls-import');
        closeDialog();
        setView('single');
        triggerFitToBounds();
        openDialog('error', {
          title: 'Import Errors',
          message: result.error ?? 'Unknown error during import',
        });
        return;
      }

      // Check for orphan placement opportunities
      if (result.section_ids.length > 0) {
        try {
          const suggestions = await invokeIpc<OrphanPlacementSuggestion[]>(
            'suggest_orphan_placements',
            { newlyImportedSectionIds: result.section_ids },
            { purpose: 'suggest orphan placements after Walls import' }
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

      trackDialogComplete('walls-import');
      closeDialog();
      setView('single');
      triggerFitToBounds();
    } catch (e) {
      resetLoading();
      setIsImporting(false);
      openDialog('error', {
        title: 'Import Failed',
        message: getErrorMessage(e, 'Failed to import Walls file'),
      });
    }
  }, [executeWallsImport, filePath, fileHash, commentsOnStations, includeSplays, wallsFile.project_name, fileName, closeDialog, openDialog, setView, triggerFitToBounds, startLoading, setLoadingProgress, resetLoading]);

  return (
    <DialogWrapper title="Import Walls Survey" onClose={closeDialog} size="lg" data-testid="walls-import-dialog">
      <div className="space-y-4">
        {/* Header info */}
        <div className="space-y-1">
          <div className="text-sm text-text-secondary">{fileName}</div>
          {wallsFile.project_name && (
            <div className="text-lg font-medium">{wallsFile.project_name}</div>
          )}
        </div>

        {/* Summary stats */}
        <div className="grid grid-cols-4 gap-3 p-3 bg-surface-alt rounded">
          <div>
            <div className="text-xs text-text-tertiary">Surveys</div>
            <div className="text-sm font-medium">
              {wallsFile.resolved_survey_count}
              {wallsFile.survey_count !== wallsFile.resolved_survey_count
                ? ` / ${wallsFile.survey_count}`
                : ''}
            </div>
          </div>
          <div>
            <div className="text-xs text-text-tertiary">Shots</div>
            <div className="text-sm font-medium">{wallsFile.shot_count}</div>
          </div>
          <div>
            <div className="text-xs text-text-tertiary">Datum</div>
            <div className="text-sm font-medium">{wallsFile.datum ?? '-'}</div>
          </div>
          <div>
            <div className="text-xs text-text-tertiary">Georeference</div>
            <div className="text-sm font-medium">
              {wallsFile.has_georeference
                ? `UTM ${wallsFile.utm_zone ?? ''}`.trim()
                : 'None'}
            </div>
          </div>
        </div>

        {/* Missing-file / attachment notice */}
        {(wallsFile.missing_file_count > 0 || wallsFile.skipped_attachment_count > 0) && (
          <div className="text-xs text-text-secondary">
            {wallsFile.missing_file_count > 0 && (
              <span>{wallsFile.missing_file_count} referenced survey file(s) not found on disk. </span>
            )}
            {wallsFile.skipped_attachment_count > 0 && (
              <span>{wallsFile.skipped_attachment_count} non-survey attachment(s) skipped.</span>
            )}
          </div>
        )}

        {/* Survey list */}
        <div className="max-h-64 overflow-y-auto border border-border rounded">
          <table className="w-full text-sm">
            <thead className="bg-surface-alt sticky top-0">
              <tr className="text-left text-text-tertiary text-xs">
                <th className="px-3 py-1.5">Survey</th>
                <th className="px-3 py-1.5">Shots</th>
                <th className="px-3 py-1.5">Segment</th>
                <th className="px-3 py-1.5">Date</th>
              </tr>
            </thead>
            <tbody>
              {wallsFile.surveys.filter((s) => s.resolved).map((survey, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="px-3 py-1.5">{survey.title || survey.name}</td>
                  <td className="px-3 py-1.5">{survey.shot_count}</td>
                  <td className="px-3 py-1.5 text-text-secondary">{survey.segment || '-'}</td>
                  <td className="px-3 py-1.5 text-text-secondary">{survey.date || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Parser warnings */}
        {wallsFile.warnings.length > 0 && (
          <div className="p-3 bg-warning-10 border border-warning-20 rounded text-sm space-y-1 max-h-32 overflow-y-auto">
            {wallsFile.warnings.map((w, i) => (
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
            checked={commentsOnStations}
            onChange={(e) => setCommentsOnStations(e.target.checked)}
            data-testid="walls-comments-on-stations"
          />
          Promote shot comments to the FROM station
        </label>
        <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={includeSplays}
            onChange={(e) => setIncludeSplays(e.target.checked)}
            data-testid="walls-include-splays"
          />
          Include anonymous wall / splay shots (as reference shots)
        </label>

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={closeDialog}>Cancel</Button>
          <Button
            data-primary-action=""
            data-testid="walls-import-confirm"
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
