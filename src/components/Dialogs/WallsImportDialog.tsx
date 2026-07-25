import { useState, useEffect, useCallback, useMemo } from 'react';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { invokeIpc, getErrorMessage } from '../../utils/ipc';
import { extractFilename } from '../../utils/path';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import type { WallsFile, OrphanPlacementSuggestion } from '../../types/commands';
import { setSource, trackDialogComplete } from '../../utils/telemetry';
import { completeImportToSingleView, finalizeDeferredSaveWarnings } from '../../utils/saveFeedback';

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

  // Indices (into `wallsFile.surveys`, 1:1 with the backend's survey order) the
  // user has chosen to import. Only resolved surveys are selectable (an
  // unresolved one has no .SRV on disk). Default: everything resolved, so the
  // import matches prior behavior until the user deselects (e.g. a huge surface
  // terrain mesh). Reset whenever the previewed file changes.
  const resolvedIndices = useMemo(
    () => wallsFile.surveys.flatMap((s, i) => (s.resolved ? [i] : [])),
    [wallsFile.surveys]
  );
  const [selectedSurveys, setSelectedSurveys] = useState<Set<number>>(
    () => new Set(resolvedIndices)
  );
  useEffect(() => {
    setSelectedSurveys(new Set(resolvedIndices));
  }, [resolvedIndices]);

  const allSelected =
    resolvedIndices.length > 0 && resolvedIndices.every((i) => selectedSurveys.has(i));
  const toggleSurvey = useCallback((i: number) => {
    setSelectedSurveys((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }, []);
  const toggleAll = useCallback(() => {
    setSelectedSurveys((prev) => {
      const allOn = resolvedIndices.length > 0 && resolvedIndices.every((i) => prev.has(i));
      return allOn ? new Set() : new Set(resolvedIndices);
    });
  }, [resolvedIndices]);

  // Importable shots in the CURRENTLY SELECTED surveys (each summary's
  // shot_count already excludes splays, same filter as the project total), so
  // the Shots stat and the Import gate track the selection rather than the
  // whole file - deselecting every shot-bearing survey disables Import.
  const selectedShotCount = useMemo(
    () =>
      wallsFile.surveys.reduce(
        (sum, s, i) => (selectedSurveys.has(i) ? sum + s.shot_count : sum),
        0
      ),
    [wallsFile.surveys, selectedSurveys]
  );

  // Splays / fixed stations in the SELECTED surveys, computed the same way as
  // `selectedShotCount`. The Import gate's splay branch and the Fixed-stations
  // stat/warning key off these so they track the selection rather than the whole
  // file - deselecting a splay-only or fix-heavy survey no longer leaves the gate
  // enabled or the anchor stat/warning stale.
  const selectedSplayCount = useMemo(
    () =>
      wallsFile.surveys.reduce(
        (sum, s, i) => (selectedSurveys.has(i) ? sum + s.splay_count : sum),
        0
      ),
    [wallsFile.surveys, selectedSurveys]
  );
  const selectedFixedStationCount = useMemo(
    () =>
      wallsFile.surveys.reduce(
        (sum, s, i) => (selectedSurveys.has(i) ? sum + s.fixed_station_count : sum),
        0
      ),
    [wallsFile.surveys, selectedSurveys]
  );

  // Re-check for a duplicate whenever the target file changes (the dialog may be
  // reused for a different import); reset the gate so Import stays disabled until
  // the new hash is verified, and ignore a stale in-flight result.
  useEffect(() => {
    let cancelled = false;
    setHashChecked(false);
    (async () => {
      try {
        const hash = await calculateFileHash(filePath);
        if (cancelled) return;
        setFileHash(hash);
        const dup = await checkDuplicateImport(hash);
        if (cancelled) return;
        setIsDuplicate(dup);
      } catch {
        // Non-fatal: proceed without duplicate detection
      }
      if (!cancelled) setHashChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [filePath, calculateFileHash, checkDuplicateImport]);

  const fileName = useMemo(() => extractFilename(filePath), [filePath]);

  // Walls stores a negative .REF zone for the southern hemisphere; render it as
  // "UTM 16 S" rather than the raw "UTM -16".
  const projectionLabel = useMemo(() => {
    if (!wallsFile.has_georeference) return '-';
    const z = wallsFile.utm_zone;
    const zoneLabel = z != null ? `${Math.abs(z)} ${z < 0 ? 'S' : 'N'}` : '';
    return `UTM ${zoneLabel}${wallsFile.datum ? ` · ${wallsFile.datum}` : ''}`.trim();
  }, [wallsFile.has_georeference, wallsFile.utm_zone, wallsFile.datum]);

  const handleImport = useCallback(async () => {
    setIsImporting(true);
    startLoading(wallsFile.project_name || fileName, filePath);
    setLoadingProgress({ phase: 'import_parsing' });
    const importUi = { closeDialog, setView, triggerFitToBounds, openDialog };
    try {
      // Pass the selection as the original survey indices; omit (null) when
      // everything resolved is selected so a full import stays unfiltered.
      const surveySelection = allSelected
        ? null
        : [...selectedSurveys].sort((a, b) => a - b);
      const result = await executeWallsImport(
        filePath,
        fileHash,
        commentsOnStations,
        includeSplays,
        surveySelection
      );
      resetLoading();

      if (!result.success) {
        completeImportToSingleView('walls-import', importUi);
        openDialog('error', {
          title: 'Import Errors',
          message: result.error ?? 'Unknown error during import',
        });
        return;
      }

      // A partial-success import (new-project deferred save failed) returns
      // success WITH a "SYSTEM" save-failure warning. Surface ONLY that - before
      // the optional orphan step - so "unsaved - save manually" isn't swallowed.
      if (finalizeDeferredSaveWarnings(result.warnings, 'walls-import', importUi)) {
        return;
      }

      // `section_ids` is omitted from the IPC payload when empty, so default it.
      const sectionIds = result.section_ids ?? [];

      // Nothing was imported - most commonly a `.wpj` whose `.srv` files aren't
      // next to it on disk. Tell the user why instead of silently "succeeding".
      if (sectionIds.length === 0) {
        trackDialogComplete('walls-import');
        closeDialog();
        openDialog('error', {
          title: 'Nothing imported',
          message:
            wallsFile.missing_file_count > 0
              ? `No surveys were imported: ${wallsFile.missing_file_count} referenced .SRV file(s) were not found next to the project. Put the survey files in the same folder as the .wpj, or import a .srv file directly.`
              : 'No survey shots were found to import.',
        });
        return;
      }

      // Check for orphan placement opportunities
      try {
        const suggestions = await invokeIpc<OrphanPlacementSuggestion[]>(
          'suggest_orphan_placements',
          { newlyImportedSectionIds: sectionIds },
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

      completeImportToSingleView('walls-import', importUi);
    } catch (e) {
      resetLoading();
      setIsImporting(false);
      openDialog('error', {
        title: 'Import Failed',
        message: getErrorMessage(e, 'Failed to import Walls file'),
      });
    }
  }, [executeWallsImport, filePath, fileHash, commentsOnStations, includeSplays, selectedSurveys, allSelected, wallsFile.project_name, fileName, closeDialog, openDialog, setView, triggerFitToBounds, startLoading, setLoadingProgress, resetLoading]);

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
            <div className="text-sm font-medium">
              {selectedShotCount}
              {!allSelected ? ` / ${wallsFile.shot_count}` : ''}
            </div>
          </div>
          <div>
            <div className="text-xs text-text-tertiary" title="#Fix stations - each becomes a GPS zero datum on its connected component">
              Fixed stations
            </div>
            <div className="text-sm font-medium">
              {selectedFixedStationCount}
              {!allSelected ? ` / ${wallsFile.fixed_station_count}` : ''}
            </div>
          </div>
          <div>
            <div className="text-xs text-text-tertiary" title="Projection reference from the .wpj .REF directive - the coordinate system, not a station anchor">
              Projection
            </div>
            <div className="text-sm font-medium">{projectionLabel}</div>
          </div>
        </div>
        {wallsFile.has_georeference && selectedFixedStationCount === 0 && (
          <div className="text-xs text-text-secondary">
            This project has a coordinate reference (.REF) but no <code>#Fix</code> stations in the
            resolved surveys, so nothing is GPS-anchored. Walls keeps fixed points in separate
            survey files - include those to georeference the cave.
          </div>
        )}

        {/* Nothing-to-import warning: a .wpj resolves its .srv files by name from
            the same folder; if none are present there is nothing to import. */}
        {wallsFile.shot_count === 0 && (
          <div className="p-3 bg-warning-10 border border-warning-20 rounded text-sm">
            {wallsFile.missing_file_count > 0
              ? `None of the ${wallsFile.missing_file_count} referenced .SRV survey file(s) were found next to "${fileName}", so there is nothing to import. A .wpj references its survey files by name - put the .SRV files in the same folder as the .wpj, or import a single .srv file directly.`
              : wallsFile.splay_count > 0
                ? `This file has no regular survey shots, but ${wallsFile.splay_count} anonymous wall / splay shot(s). Enable "Include anonymous wall / splay shots" below to import them.`
                : 'This file contains no survey shots to import.'}
          </div>
        )}

        {/* Missing-file / attachment notice (when there is still something to import) */}
        {wallsFile.shot_count > 0 &&
          (wallsFile.missing_file_count > 0 || wallsFile.skipped_attachment_count > 0) && (
            <div className="text-xs text-text-secondary">
              {wallsFile.missing_file_count > 0 && (
                <span>{wallsFile.missing_file_count} referenced survey file(s) not found on disk. </span>
              )}
              {wallsFile.skipped_attachment_count > 0 && (
                <span>{wallsFile.skipped_attachment_count} non-survey attachment(s) skipped.</span>
              )}
            </div>
          )}

        {/* Survey list - choose which surveys to import */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-text-tertiary">
            <span>Surveys to import</span>
            <span data-testid="walls-selected-count">
              {selectedSurveys.size} of {resolvedIndices.length} selected
            </span>
          </div>
          <div className="max-h-64 overflow-y-auto border border-border rounded">
            <table className="w-full text-sm">
              <thead className="bg-surface-alt sticky top-0">
                <tr className="text-left text-text-tertiary text-xs">
                  <th className="px-3 py-1.5 w-8">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      aria-label="Select all surveys"
                      data-testid="walls-select-all"
                    />
                  </th>
                  <th className="px-3 py-1.5">Survey</th>
                  <th className="px-3 py-1.5">Shots</th>
                  <th className="px-3 py-1.5">Segment</th>
                  <th className="px-3 py-1.5">Date</th>
                </tr>
              </thead>
              <tbody>
                {wallsFile.surveys.map((survey, i) =>
                  survey.resolved ? (
                    <tr key={i} className="border-t border-border">
                      <td className="px-3 py-1.5">
                        <input
                          type="checkbox"
                          checked={selectedSurveys.has(i)}
                          onChange={() => toggleSurvey(i)}
                          aria-label={`Import ${survey.title || survey.name}`}
                          data-testid={`walls-survey-${i}`}
                        />
                      </td>
                      <td className="px-3 py-1.5">{survey.title || survey.name}</td>
                      <td className="px-3 py-1.5">{survey.shot_count}</td>
                      <td className="px-3 py-1.5 text-text-secondary">{survey.segment || '-'}</td>
                      <td className="px-3 py-1.5 text-text-secondary">{survey.date || '-'}</td>
                    </tr>
                  ) : null
                )}
              </tbody>
            </table>
          </div>
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
            disabled={
              isImporting ||
              !hashChecked ||
              selectedSurveys.size === 0 ||
              (selectedShotCount === 0 && !(includeSplays && selectedSplayCount > 0))
            }
          >
            {isImporting ? 'Importing...' : 'Import'}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
