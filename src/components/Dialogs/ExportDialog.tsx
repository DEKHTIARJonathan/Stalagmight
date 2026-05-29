import { useState, useEffect, useRef, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { saveDialog } from '../../utils/fileDialogs';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { Select } from '../common/Select';
import { DialogWrapper } from './DialogWrapper';
import { AlertDialog } from './AlertDialog';
import { LoadingProgress } from '../LoadingProgress/LoadingProgress';
import ExportPreview from './ExportPreview';
import type { ExportImageOptions, ImageFormat } from '../../types/commands';
import type { LoadingProgressPayload } from '../../types/loading';
import { ensureExtension, exportSaveFilters } from '../../utils/fileDialogs';
import { trackDialogComplete } from '../../utils/telemetry';

/** Phase label mapping for export phases (matches backend LoadingPhase) */
const EXPORT_PHASE_LABELS: Record<string, string> = {
  export_preparing: 'Preparing export...',
  export_generating: 'Generating...',
  export_writing: 'Writing file...',
  export_complete: 'Export complete',
};

/** Branching-threshold slider bounds. Matches backend's u32 field. */
const THRESHOLD_MIN = 0;
const THRESHOLD_MAX = 10;
const THRESHOLD_DEFAULT = 2;

export default function ExportDialog() {
  const { closeDialog } = useUIStore();
  const { project, exportCsv, exportJson, exportTml, exportImage, getAnchoredSectionIds } = useProjectStore();

  const [exportType, setExportType] = useState<'data' | 'image'>('data');
  const [dataFormat, setDataFormat] = useState<'csv' | 'json' | 'tml'>('csv');
  const [imageOptions, setImageOptions] = useState<ExportImageOptions>({
    format: 'png',
    dpi: 300,
    branching_threshold: THRESHOLD_DEFAULT,
  });

  // Export progress state - uses shared LoadingProgressPayload from loading infrastructure
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<LoadingProgressPayload | null>(null);
  const [showTmlUnanchoredWarning, setShowTmlUnanchoredWarning] = useState(false);
  const [tmlDiscardedSections, setTmlDiscardedSections] = useState<Array<{ id: number; name: string | null }>>([]);
  // Track the loadingId we're expecting (to filter out events from other operations)
  const exportLoadingIdRef = useRef<bigint | null>(null);

  // Track if component is mounted to prevent setState on unmounted component
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Guarded close handler - no-op while exporting to prevent closing mid-export
  const handleClose = useCallback(() => {
    if (!isExporting) {
      closeDialog();
    }
  }, [isExporting, closeDialog]);

  const formatSectionLabel = useCallback((section: { id: number; name: string | null }): string => {
    const trimmedName = section.name?.trim();
    return trimmedName && trimmedName.length > 0
      ? `${trimmedName} (#${section.id})`
      : `Section ${section.id}`;
  }, []);

  const handleExport = async (options?: { skipTmlAnchorCheck?: boolean }) => {
    try {
      if (exportType === 'data') {
        const isTml = dataFormat === 'tml';
        if (isTml && !options?.skipTmlAnchorCheck) {
          try {
            if (project && project.sections.length > 0) {
              const anchoredSectionIds = new Set(await getAnchoredSectionIds());
              const unanchoredSections = project.sections
                .filter((section) => !anchoredSectionIds.has(section.id))
                .map((section) => ({ id: section.id, name: section.name }));
              if (unanchoredSections.length > 0) {
                setTmlDiscardedSections(unanchoredSections);
                setShowTmlUnanchoredWarning(true);
                return;
              }
            }
          } catch (error) {
            console.error('Failed to check zero-datum coverage before TML export:', error);
          }
        }

        const filters = isTml
          ? [
              { name: 'TML (ZIP)', extensions: ['tml'] },
              { name: 'TMLU (XML)', extensions: ['tmlu'] },
            ]
          : exportSaveFilters(dataFormat.toUpperCase(), dataFormat);
        const selected = await saveDialog({ filters });

        if (selected) {
          // For TML, preserve the extension the OS dialog appended.
          // If the path already has .tmlu or .tml, keep it as-is;
          // otherwise default to .tml.
          let finalPath: string;
          if (isTml) {
            const lower = selected.toLowerCase();
            if (lower.endsWith('.tmlu')) {
              finalPath = selected;
            } else if (lower.endsWith('.tml')) {
              finalPath = selected;
            } else {
              finalPath = ensureExtension(selected, 'tml');
            }
          } else {
            finalPath = ensureExtension(selected, dataFormat);
          }
          // Disable button during data export (no progress events for CSV/JSON/TML)
          setIsExporting(true);
          try {
            if (dataFormat === 'csv') {
              await exportCsv(finalPath);
            } else if (dataFormat === 'json') {
              await exportJson(finalPath);
            } else {
              await exportTml(finalPath);
            }
          } finally {
            if (isMountedRef.current) {
              setIsExporting(false);
            }
          }
        }
      } else {
        const extension = imageOptions.format;
        const selected = await saveDialog({
          filters: exportSaveFilters(imageOptions.format.toUpperCase(), extension),
        });

        if (selected) {
          const finalPath = ensureExtension(selected, extension);
          // Register listener BEFORE starting export to avoid race condition with early events
          // Uses shared loading-progress events for consistency with LoadingProgress infrastructure
          const unlisten = await listen<LoadingProgressPayload>('loading-progress', (event) => {
            if (isMountedRef.current) {
              // Only process export-related events (filter by loadingId once we know it,
              // or accept all export_* phase events if loadingId not yet known)
              const phase = event.payload.phase;
              const isExportPhase = phase.startsWith('export_');

              if (isExportPhase) {
                const eventLoadingId = event.payload.loadingId;
                // Accept this event and track its loadingId for future filtering
                if (exportLoadingIdRef.current === null) {
                  exportLoadingIdRef.current = eventLoadingId;
                }

                // Only process events matching our export's loadingId
                if (eventLoadingId === exportLoadingIdRef.current) {
                  setExportProgress(event.payload);
                }
              }
            }
          });

          setIsExporting(true);
          setExportProgress(null);
          exportLoadingIdRef.current = null;

          try {
            await exportImage(finalPath, imageOptions);
          } finally {
            // Clean up listener and reset state only if still mounted
            unlisten();
            exportLoadingIdRef.current = null;
            if (isMountedRef.current) {
              setIsExporting(false);
              setExportProgress(null);
            }
          }
        }
      }

      if (isMountedRef.current) {
        trackDialogComplete('export');
        closeDialog();
      }
    } catch (e) {
      console.error('Export failed:', e);
      if (isMountedRef.current) {
        setIsExporting(false);
        setExportProgress(null);
      }
    }
  };

  return (
    <DialogWrapper title="Export" onClose={handleClose} size="lg" data-testid="export-dialog">
      <div className="flex gap-6">
        {/* Left column: Options */}
        <div className="flex-1 space-y-4">
          {/* Export type */}
          <div>
            <label className="block text-sm text-text-secondary mb-2">Export Type</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={exportType === 'data'}
                  onChange={() => setExportType('data')}
                  data-testid="export-type-data"
                />
                <span>Survey Data</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={exportType === 'image'}
                  onChange={() => setExportType('image')}
                  data-testid="export-type-image"
                />
                <span>Map Image</span>
              </label>
            </div>
          </div>

          {/* Data format options */}
          {exportType === 'data' && (
            <div>
              <label className="block text-sm text-text-secondary mb-2">Format</label>
              <Select
                value={dataFormat}
                onChange={(v) => setDataFormat(v as 'csv' | 'json' | 'tml')}
                options={[
                  { value: 'csv', label: 'CSV' },
                  { value: 'json', label: 'JSON' },
                  { value: 'tml', label: 'TML (Ariane)' },
                ]}
                data-testid="data-format-select"
              />
            </div>
          )}

          {/* Image format options */}
          {exportType === 'image' && (
            <>
              <div>
                <label className="block text-sm text-text-secondary mb-2">Format</label>
                <Select
                  value={imageOptions.format}
                  onChange={(v) => setImageOptions({ ...imageOptions, format: v as ImageFormat })}
                  options={[
                    { value: 'png', label: 'PNG' },
                    { value: 'svg', label: 'SVG' },
                    { value: 'pdf', label: 'PDF' },
                  ]}
                  data-testid="image-format-select"
                />
              </div>

              {imageOptions.format === 'png' && (
                <div>
                  <label className="block text-sm text-text-secondary mb-2">Resolution</label>
                  <Select
                    value={String(imageOptions.dpi)}
                    onChange={(v) => setImageOptions({ ...imageOptions, dpi: parseInt(v) })}
                    options={[
                      { value: '72', label: 'Low (72 DPI)' },
                      { value: '150', label: 'Medium (150 DPI)' },
                      { value: '300', label: 'High (300 DPI)' },
                      { value: '600', label: 'Print (600 DPI)' },
                    ]}
                    data-testid="resolution-select"
                  />
                </div>
              )}

              {/* Branching threshold slider: segments whose branching factor is
                  >= threshold are drawn thick; the rest are drawn thin. */}
              <div>
                <label
                  htmlFor="branching-threshold"
                  className="block text-sm text-text-secondary mb-2"
                >
                  Line-weight threshold
                </label>
                <div className="flex items-center gap-3">
                  <input
                    id="branching-threshold"
                    type="range"
                    min={THRESHOLD_MIN}
                    max={THRESHOLD_MAX}
                    step={1}
                    value={imageOptions.branching_threshold}
                    onChange={(e) =>
                      setImageOptions({
                        ...imageOptions,
                        branching_threshold: parseInt(e.target.value, 10),
                      })
                    }
                    className="flex-1"
                    data-testid="branching-threshold-slider"
                    aria-valuemin={THRESHOLD_MIN}
                    aria-valuemax={THRESHOLD_MAX}
                    aria-valuenow={imageOptions.branching_threshold}
                  />
                  <span
                    className="w-8 text-right text-sm tabular-nums"
                    data-testid="branching-threshold-value"
                  >
                    {imageOptions.branching_threshold}
                  </span>
                </div>
                <p className="mt-1 text-xs text-text-secondary">
                  Segments connected to ≥ this many other segments via reference shots are drawn thick.
                </p>
              </div>
            </>
          )}
        </div>

        {/* Right column: Preview (only for image export) */}
        {exportType === 'image' && (
          <div className="flex flex-col gap-2">
            <span className="text-sm text-text-secondary">Preview</span>
            <ExportPreview options={imageOptions} />
          </div>
        )}
      </div>

      {/* Export Progress - uses shared LoadingProgress component for consistent UI */}
      {isExporting && (() => {
        const phase = EXPORT_PHASE_LABELS[exportProgress?.phase ?? ''] ?? 'Preparing...';
        const overall = exportProgress?.overallPercent ?? 0;
        const isIndeterminate = exportProgress?.isIndeterminate ?? true;
        // Compute phase progress from current/total (not overallPercent)
        const current = exportProgress?.current;
        const total = exportProgress?.total;
        const phasePercent = (current != null && total != null && total > 0)
          ? Math.round((current / total) * 100)
          : undefined;
        return (
          <div className="mt-4 flex justify-center" data-testid="export-progress-container">
            {isIndeterminate || phasePercent === undefined ? (
              <LoadingProgress
                title="Exporting..."
                phase={phase}
                overallProgress={overall}
              />
            ) : (
              <LoadingProgress
                title="Exporting..."
                phase={phase}
                phaseProgress={phasePercent}
                overallProgress={overall}
              />
            )}
          </div>
        );
      })()}

      {/* Actions */}
      <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-border">
        <Button onClick={handleClose} disabled={isExporting}>Cancel</Button>
        <Button
          variant="primary"
          onClick={() => {
            void handleExport();
          }}
          disabled={isExporting}
          data-testid="export-button"
        >
          {isExporting ? 'Exporting...' : 'Export'}
        </Button>
      </div>

      <AlertDialog
        open={showTmlUnanchoredWarning}
        title="Some sections will be discarded"
        onClose={() => setShowTmlUnanchoredWarning(false)}
        data-testid="tml-unanchored-warning-dialog"
        actions={
          <>
            <Button onClick={() => setShowTmlUnanchoredWarning(false)} data-testid="tml-unanchored-warning-cancel">
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setShowTmlUnanchoredWarning(false);
                void handleExport({ skipTmlAnchorCheck: true });
              }}
              data-testid="tml-unanchored-warning-continue"
            >
              Continue anyway
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p>
            Ariane TML/TMLU exports only include sections connected to a zero datum.
            The sections below are not connected and may be discarded.
          </p>
          <div className="rounded border border-border bg-panel p-3">
            <p className="text-xs font-medium text-text-secondary mb-2">Potentially discarded sections</p>
            <ul className="list-disc pl-5 space-y-1 text-sm max-h-40 overflow-y-auto">
              {tmlDiscardedSections.map((section) => (
                <li key={section.id} data-testid="tml-unanchored-section-item">
                  {formatSectionLabel(section)}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </AlertDialog>
    </DialogWrapper>
  );
}
