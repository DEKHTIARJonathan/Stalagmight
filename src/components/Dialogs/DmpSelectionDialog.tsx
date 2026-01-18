import { useState, useMemo, useCallback } from 'react';
import { DialogWrapper } from './DialogWrapper';
import { Button } from '../common/Button';
import { Panel } from '../common/Panel';
import { useUIStore } from '../../store/uiStore';
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
  /** Direction overrides per section (key: section index) */
  sectionDirections: Map<number, 'in' | 'out'>;
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
 * Calculate DMP file metadata for header display.
 */
function calculateMetadata(dmpFile: DmpFile) {
  const sections = dmpFile.sections;
  const sectionCount = sections.length;

  // Count only standard shots
  let totalShots = 0;
  let totalLength = 0;
  let minDate: string | null = null;
  let maxDate: string | null = null;

  for (const section of sections) {
    const standardShots = section.shots.filter(s => s.shot_type === 'Standard');
    totalShots += standardShots.length;
    totalLength += standardShots.reduce((sum, shot) => sum + shot.length, 0);

    // Track date range
    if (section.date) {
      const dateStr = section.date.split(/[T ]/)[0];
      if (dateStr) {
        if (!minDate || dateStr < minDate) minDate = dateStr;
        if (!maxDate || dateStr > maxDate) maxDate = dateStr;
      }
    }
  }

  return {
    sectionCount,
    totalShots,
    totalLength,
    dateRange: minDate && maxDate
      ? (minDate === maxDate ? minDate : `${minDate} to ${maxDate}`)
      : null,
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
  // Extract filename from path
  const fileName = useMemo(() => {
    const parts = filePath.split(/[/\\]/);
    return parts[parts.length - 1] ?? filePath;
  }, [filePath]);

  // Calculate metadata for header
  const metadata = useMemo(() => calculateMetadata(dmpFile), [dmpFile]);

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

  // Direction overrides per section
  const [sectionDirections, setSectionDirections] = useState<Map<number, 'in' | 'out'>>(
    new Map()
  );

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

    // Check direction changes
    if (sectionDirections.size > 0) return true;

    return false;
  }, [defaultSurveyor, initialSurveyor, defaultDate, initialDate, selectedIndices, initialSelection, sectionDirections]);

  // Get effective direction for a section (user override or original)
  const getEffectiveDirection = useCallback(
    (sectionIndex: number): 'in' | 'out' => {
      const override = sectionDirections.get(sectionIndex);
      if (override !== undefined) return override;
      return dmpFile.sections[sectionIndex]?.direction ?? 'in';
    },
    [dmpFile.sections, sectionDirections]
  );

  // Handle direction change
  const handleDirectionChange = useCallback((sectionIndex: number, direction: 'in' | 'out') => {
    setSectionDirections(prev => {
      const next = new Map(prev);
      // Only set override if different from original
      const original = dmpFile.sections[sectionIndex]?.direction ?? 'in';
      if (direction === original) {
        next.delete(sectionIndex);
      } else {
        next.set(sectionIndex, direction);
      }
      return next;
    });
  }, [dmpFile.sections]);

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

    const config: DmpSelectionConfig = {
      selectedIndices,
      defaultSurveyor,
      defaultDate: defaultDate.trim() || null,
      sectionDirections: new Map(sectionDirections),
    };
    onContinue(config);
  }, [selectedIndices, defaultSurveyor, defaultDate, sectionDirections, onContinue, setLastUsedSurveyor]);

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
        <div className="bg-background/50 rounded p-3 text-sm">
          <div className="font-medium text-text-primary mb-1" data-testid="dmp-filename">
            File: {fileName}
          </div>
          <div className="text-text-secondary space-x-3" data-testid="dmp-metadata">
            <span>Version: {dmpFile.version}</span>
            <span>|</span>
            <span>Sections: {metadata.sectionCount}</span>
            <span>|</span>
            <span>Shots: {metadata.totalShots}</span>
            <span>|</span>
            <span>Length: {metadata.totalLength.toFixed(1)}m</span>
            {metadata.dateRange && (
              <>
                <span>|</span>
                <span>Date: {metadata.dateRange}</span>
              </>
            )}
          </div>
        </div>

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
            data-testid="select-all-button"
          >
            Select All
          </Button>
          <Button
            size="sm"
            onClick={handleSelectNone}
            data-testid="select-none-button"
          >
            Select None
          </Button>
          <Button
            size="sm"
            onClick={handleInvertSelection}
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
              <thead className="bg-background/50 sticky top-0">
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
                  const dateStr = section.date?.split(/[T ]/)[0] ?? '-';
                  const direction = getEffectiveDirection(index);

                  return (
                    <tr
                      key={index}
                      className={`
                        border-t border-border
                        ${isEmpty ? 'opacity-50 bg-background/30' : ''}
                        ${isSelected && !isEmpty ? 'bg-accent/10' : ''}
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
                      <td className="px-3 py-2">{section.name}</td>
                      <td className="px-3 py-2">{dateStr}</td>
                      <td className="px-3 py-2">
                        <select
                          value={direction}
                          onChange={(e) => handleDirectionChange(index, e.target.value as 'in' | 'out')}
                          disabled={isEmpty}
                          className="bg-surface border border-border rounded px-2 py-0.5 text-xs"
                          data-testid={`section-direction-${index}`}
                          aria-label={`Direction for section ${section.name}`}
                        >
                          <option value="in">In</option>
                          <option value="out">Out</option>
                        </select>
                      </td>
                      <td className="px-3 py-2 text-right">
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
          <Button onClick={onCancel} data-testid="cancel-button">
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleContinue}
            disabled={selectedIndices.size === 0}
            data-testid="continue-button"
          >
            Continue to Section Setup
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
