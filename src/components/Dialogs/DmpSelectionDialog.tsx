import { useState, useMemo, useCallback, useEffect } from 'react';
import { DialogWrapper } from './DialogWrapper';
import { Button } from '../common/Button';
import { Panel } from '../common/Panel';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { extractFilename } from '../../utils/path';
import { defaultConfig } from '../../types/config';
import { formatLength, formatDepthRange } from '../../utils/formatStats';
import type { DmpFile } from '../../types/commands';

/**
 * Configuration produced by DmpSelectionDialog (Step 1)
 * and passed to DmpSectionConfigDialog (Step 2).
 */
export interface DmpSelectionConfig {
  /** Indices of selected sections from the DMP file */
  selectedIndices: Set<number>;
  /** Default surveyor name to apply to all sections */
  defaultSurveyor: string;
  /** Optional date override to apply to all sections */
  defaultDate: string | null;
  /** SHA256 hash of the source DMP file, null if computation failed */
  fileHash: string | null;
  /** Content hashes of selected sections (for section-level duplicate detection) */
  sectionHashes: string[];
}

interface DmpSelectionDialogProps {
  /** Parsed DMP file data */
  dmpFile: DmpFile;
  /** Path to the DMP file */
  filePath: string;
  /** Called when user cancels the dialog */
  onCancel: () => void;
  /** Called when user clicks Continue to proceed to Step 2 */
  onContinue: (config: DmpSelectionConfig) => void;
}

/**
 * Calculate DMP file metadata for header display based on selected sections.
 */
function calculateMetadata(dmpFile: DmpFile, selectedIndices: Set<number>) {
  const sections = dmpFile.sections;
  const sectionCount = sections.length;

  // Count only standard shots from selected sections
  let totalShots = 0;
  let totalLength = 0;
  let minDepth: number | null = null;
  let maxDepth: number | null = null;

  for (let i = 0; i < sections.length; i++) {
    if (!selectedIndices.has(i)) continue;

    const section = sections[i];
    if (!section) continue;

    const standardShots = section.shots.filter(s => s.shot_type === 'Standard');
    totalShots += standardShots.length;

    for (const shot of standardShots) {
      // Exclude negative lengths from total (data corruption guard)
      if (Number.isFinite(shot.length) && shot.length >= 0) {
        totalLength += shot.length;
      }

      // Calculate depth range from depth_in and depth_out
      for (const depth of [shot.depth_in, shot.depth_out]) {
        if (Number.isFinite(depth)) {
          if (minDepth === null || depth < minDepth) minDepth = depth;
          if (maxDepth === null || depth > maxDepth) maxDepth = depth;
        }
      }
    }
  }

  return {
    sectionCount,
    totalShots,
    totalLength,
    minDepth,
    maxDepth,
  };
}

/**
 * Step 1 of DMP Import: Select sections and set default values.
 *
 * This dialog displays:
 * - DMP file metadata header (version, sections, shots, length, date range)
 * - Default values section (surveyor, date override)
 * - Bulk selection controls (All, None, Invert)
 * - Section table with checkboxes
 *
 * Empty sections (0 standard shots) are displayed but grayed out and disabled.
 */
export default function DmpSelectionDialog({
  dmpFile,
  filePath,
  onCancel,
  onContinue,
}: DmpSelectionDialogProps) {
  const importSecondaryButtonClass = 'ring-1 ring-inset ring-border hover:bg-background-50';

  // Extract filename from path
  const fileName = useMemo(() => {
    return extractFilename(filePath);
  }, [filePath]);

  // Get config for unit conversion (fallback to defaults)
  const config = useProjectStore((state) => state.config);
  const lengthUnit = config?.units?.length ?? defaultConfig.units.length;
  const depthUnit = config?.units?.depth ?? defaultConfig.units.depth;

  // Get hash functions from project store
  const calculateFileHash = useProjectStore((state) => state.calculateFileHash);
  const checkDuplicateImport = useProjectStore((state) => state.checkDuplicateImport);
  const checkSectionHashes = useProjectStore((state) => state.checkSectionHashes);

  // File hash and duplicate detection state
  const [fileHash, setFileHash] = useState<string | null>(null);
  const [isDuplicate, setIsDuplicate] = useState(false);

  // Track whether hash computation has settled (resolved or failed)
  const [hashSettled, setHashSettled] = useState(false);

  // Section-level duplicate detection state
  const [duplicateSectionIndices, setDuplicateSectionIndices] = useState<Set<number>>(new Set());
  const [sectionHashesSettled, setSectionHashesSettled] = useState(false);

  // Check section content hashes for duplicates on mount
  useEffect(() => {
    let cancelled = false;
    setSectionHashesSettled(false);
    setDuplicateSectionIndices(new Set());
    (async () => {
      try {
        const hashes = dmpFile.sections.map(s => s.content_hash);
        const results = await checkSectionHashes(hashes);
        if (cancelled) return;
        const dupes = new Set<number>();
        results.forEach((isDup, idx) => {
          if (isDup) dupes.add(idx);
        });
        setDuplicateSectionIndices(dupes);
        // Auto-deselect duplicate sections
        if (dupes.size > 0) {
          setSelectedIndices(prev => {
            const next = new Set(prev);
            for (const idx of dupes) {
              next.delete(idx);
            }
            return next;
          });
        }
      } catch {
        // Graceful degradation
      } finally {
        if (!cancelled) {
          setSectionHashesSettled(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [dmpFile.sections, checkSectionHashes]);

  // Compute file hash and check for duplicates on mount / filePath change
  useEffect(() => {
    let cancelled = false;
    // Reset state when filePath changes to avoid stale values
    setFileHash(null);
    setIsDuplicate(false);
    setHashSettled(false);
    (async () => {
      try {
        const hash = await calculateFileHash(filePath);
        if (cancelled) return;
        setFileHash(hash);
        if (cancelled) return;
        const isDup = await checkDuplicateImport(hash);
        if (cancelled) return;
        setIsDuplicate(isDup);
      } catch {
        // Graceful degradation: proceed without warning
      } finally {
        if (!cancelled) {
          setHashSettled(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [filePath, calculateFileHash, checkDuplicateImport]);

  // Get last used surveyor from session memory
  const lastUsedSurveyor = useUIStore((state) => state.lastUsedSurveyor);
  const setLastUsedSurveyor = useUIStore((state) => state.setLastUsedSurveyor);

  // Default values state - initialize surveyor with last used value from session
  const [defaultSurveyor, setDefaultSurveyor] = useState(lastUsedSurveyor);
  const [defaultDate, setDefaultDate] = useState('');

  // Track initial state for isDirty calculation
  const [initialSurveyor] = useState(lastUsedSurveyor);
  const [initialDate] = useState('');

  // Section selection state - default to all non-empty sections
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(() => {
    const indices = new Set<number>();
    dmpFile.sections.forEach((section, index) => {
      const standardShots = section.shots.filter(s => s.shot_type === 'Standard');
      if (standardShots.length > 0) {
        indices.add(index);
      }
    });
    return indices;
  });

  // Track initial selection for isDirty calculation
  const [initialSelection] = useState(() => {
    const indices = new Set<number>();
    dmpFile.sections.forEach((section, index) => {
      const standardShots = section.shots.filter(s => s.shot_type === 'Standard');
      if (standardShots.length > 0) {
        indices.add(index);
      }
    });
    return indices;
  });

  // Check if form has changes
  const isDirty = useMemo(() => {
    // Check surveyor/date changes
    if (defaultSurveyor !== initialSurveyor) return true;
    if (defaultDate !== initialDate) return true;

    // Check selection changes
    if (selectedIndices.size !== initialSelection.size) return true;
    for (const idx of selectedIndices) {
      if (!initialSelection.has(idx)) return true;
    }

    return false;
  }, [defaultSurveyor, initialSurveyor, defaultDate, initialDate, selectedIndices, initialSelection]);

  // Calculate metadata for header based on selected sections (updates in real-time)
  const metadata = useMemo(
    () => calculateMetadata(dmpFile, selectedIndices),
    [dmpFile, selectedIndices]
  );

  // Bulk selection handlers
  const handleSelectAll = useCallback(() => {
    const indices = new Set<number>();
    dmpFile.sections.forEach((section, index) => {
      const standardShots = section.shots.filter(s => s.shot_type === 'Standard');
      if (standardShots.length > 0) {
        indices.add(index);
      }
    });
    setSelectedIndices(indices);
  }, [dmpFile.sections]);

  const handleSelectNone = useCallback(() => {
    setSelectedIndices(new Set());
  }, []);

  const handleInvertSelection = useCallback(() => {
    const inverted = new Set<number>();
    dmpFile.sections.forEach((section, index) => {
      const standardShots = section.shots.filter(s => s.shot_type === 'Standard');
      if (standardShots.length > 0 && !selectedIndices.has(index)) {
        inverted.add(index);
      }
    });
    setSelectedIndices(inverted);
  }, [dmpFile.sections, selectedIndices]);

  // Toggle individual section
  const handleToggleSection = useCallback((index: number) => {
    setSelectedIndices(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  // Handle Continue button click
  const handleContinue = useCallback(() => {
    // Save surveyor to session memory for next import
    if (defaultSurveyor.trim()) {
      setLastUsedSurveyor(defaultSurveyor.trim());
    }

    const sectionHashes: string[] = [];
    for (const idx of selectedIndices) {
      const section = dmpFile.sections[idx];
      if (section) {
        sectionHashes.push(section.content_hash);
      }
    }

    const config: DmpSelectionConfig = {
      selectedIndices,
      defaultSurveyor,
      defaultDate: defaultDate.trim() || null,
      fileHash,
      sectionHashes,
    };
    onContinue(config);
  }, [selectedIndices, defaultSurveyor, defaultDate, fileHash, dmpFile.sections, onContinue, setLastUsedSurveyor]);

  // Calculate section counts for display
  const nonEmptySectionCount = useMemo(() => {
    return dmpFile.sections.filter(
      section => section.shots.filter(s => s.shot_type === 'Standard').length > 0
    ).length;
  }, [dmpFile.sections]);

  return (
    <DialogWrapper
      title="Import DMP File (Step 1)"
      onClose={onCancel}
      size="2xl"
      isDirty={isDirty}
      data-testid="dmp-selection-dialog"
    >
      <div className="space-y-4">
        {/* File metadata header */}
        <div className="bg-background-50 rounded p-3 text-sm">
          <div className="font-medium text-text-primary mb-1" data-testid="dmp-filename">
            File: {fileName} (v{dmpFile.version})
          </div>
          <div
            className="text-text-secondary"
            data-testid="selection-stats"
            aria-label={`Selection statistics: ${metadata.totalShots} shots, ${formatLength(metadata.totalLength, lengthUnit)} total length, depth range ${formatDepthRange(metadata.minDepth, metadata.maxDepth, depthUnit)}`}
          >
            <span data-testid="stats-shot-count">{metadata.totalShots} shots</span>
            <span className="mx-2">|</span>
            <span data-testid="stats-total-length">{formatLength(metadata.totalLength, lengthUnit)}</span>
            <span className="mx-2">|</span>
            <span data-testid="stats-depth-range">Depth: {formatDepthRange(metadata.minDepth, metadata.maxDepth, depthUnit)}</span>
          </div>
        </div>

        {/* Duplicate hash warning banner */}
        {isDuplicate && hashSettled && (
          <div
            className="p-3 bg-warning-10 border border-warning-20 rounded text-warning text-sm"
            data-testid="duplicate-hash-warning"
          >
            {'\u26A0'} File may have been imported before (same hash detected)
          </div>
        )}

        {/* Section-level duplicate banner */}
        {sectionHashesSettled && duplicateSectionIndices.size > 0 && (
          <div
            className="p-3 bg-warning-10 border border-warning-20 rounded text-warning text-sm"
            data-testid="duplicate-sections-warning"
          >
            {'\u26A0'} {duplicateSectionIndices.size} of {dmpFile.sections.length} sections already imported (auto-deselected)
          </div>
        )}

        {/* Default values section */}
        <Panel title="Default Values (apply to all sections)">
          <div className="flex gap-4">
            <div className="flex-1">
              <label className="block text-sm text-text-secondary mb-1">
                Surveyor
              </label>
              <input
                type="text"
                value={defaultSurveyor}
                onChange={(e) => setDefaultSurveyor(e.target.value)}
                placeholder="Enter surveyor name..."
                className="w-full"
                data-testid="default-surveyor-input"
              />
            </div>
            <div className="flex-1">
              <label className="block text-sm text-text-secondary mb-1">
                Date Override
              </label>
              <input
                type="date"
                value={defaultDate}
                onChange={(e) => setDefaultDate(e.target.value)}
                className="w-full"
                data-testid="default-date-input"
              />
            </div>
          </div>
        </Panel>

        {/* Bulk selection controls */}
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={handleSelectAll}
            className={importSecondaryButtonClass}
            data-testid="select-all-button"
          >
            Select All
          </Button>
          <Button
            size="sm"
            onClick={handleSelectNone}
            className={importSecondaryButtonClass}
            data-testid="select-none-button"
          >
            Select None
          </Button>
          <Button
            size="sm"
            onClick={handleInvertSelection}
            className={importSecondaryButtonClass}
            data-testid="invert-selection-button"
          >
            Invert
          </Button>
          <span className="ml-auto text-sm text-text-secondary self-center">
            {selectedIndices.size} of {nonEmptySectionCount} sections selected
          </span>
        </div>

        {/* Section table */}
        <div className="border border-border rounded overflow-hidden">
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-background-50 sticky top-0">
                <tr>
                  <th className="w-10 px-3 py-2 text-left"></th>
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Direction</th>
                  <th className="px-3 py-2 text-right">Shots</th>
                </tr>
              </thead>
              <tbody>
                {dmpFile.sections.map((section, index) => {
                  const standardShots = section.shots.filter(s => s.shot_type === 'Standard');
                  const shotCount = standardShots.length;
                  const isEmpty = shotCount === 0;
                  const isSelected = selectedIndices.has(index);
                  const isDupeSection = duplicateSectionIndices.has(index);
                  const dateStr = section.date?.split(/[T ]/)[0] ?? '-';

                  return (
                    <tr
                      key={index}
                      className={`
                        border-t border-border
                        ${isEmpty ? 'opacity-50 bg-background-30' : ''}
                        ${isSelected && !isEmpty ? 'bg-accent-10' : ''}
                      `}
                      data-testid={`section-row-${index}`}
                    >
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={isEmpty}
                          onChange={() => handleToggleSection(index)}
                          data-testid={`section-checkbox-${index}`}
                          aria-label={`Select section ${section.name}`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        {section.name}
                        {isDupeSection && (
                          <span className="ml-2 text-xs text-warning" data-testid={`section-duplicate-${index}`}>
                            (already imported)
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">{dateStr}</td>
                      <td className="px-3 py-2 capitalize">{section.direction}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {isEmpty ? (
                          <span className="text-text-secondary">(empty)</span>
                        ) : (
                          shotCount
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={onCancel} className={importSecondaryButtonClass} data-testid="cancel-button">
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleContinue}
            disabled={selectedIndices.size === 0 || !hashSettled || !sectionHashesSettled}
            data-testid="continue-button"
          >
            {!hashSettled || !sectionHashesSettled ? 'Checking for duplicates...' : 'Continue to Section Setup'}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
