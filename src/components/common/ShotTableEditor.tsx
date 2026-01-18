import { useState, useRef, useCallback } from 'react';
import type { Shot } from '../../types/project';
import { defaultConfig } from '../../types/config';
import { hasAzimuthDiscrepancy, hasPitchDiscrepancy } from '../../utils/validation';

/**
 * Editable shot type - extends Shot with editing state flags.
 */
export interface EditableShot extends Omit<Shot, 'marker_index' | 'temperature'> {
  isNew?: boolean;
  isDeleted?: boolean;
  tempId?: number;
}

/**
 * Validation configuration for shot data.
 * Uses the same field names as the main config for consistency.
 */
export interface ValidationConfig {
  /** Threshold for azimuth in/out difference warning (degrees). Default: 10 */
  azimuth_diff_threshold: number;
  /** Threshold for pitch in/out difference warning (degrees). Default: 5 */
  pitch_diff_threshold: number;
}

/**
 * Warning type for shot validation issues.
 */
interface ShotWarning {
  type: 'azimuth' | 'pitch';
  message: string;
}

/**
 * Props for the ShotTableEditor component.
 */
export interface ShotTableEditorProps {
  /** Array of editable shots to display */
  shots: EditableShot[];
  /** Callback when a shot field changes */
  onShotChange: (index: number, field: keyof EditableShot, value: number | string | boolean | null) => void;
  /** Callback to add a new shot at the end */
  onAddShot: () => void;
  /** Callback to delete a shot at the given index */
  onDeleteShot: (index: number) => void;
  /** Optional callback to insert a shot before the given index */
  onInsertBefore?: (index: number) => void;
  /** Optional callback to insert a shot after the given index */
  onInsertAfter?: (index: number) => void;
  /** Validation configuration for warnings */
  validationConfig?: ValidationConfig;
  /** Whether the table is read-only */
  readOnly?: boolean;
  /** Whether to show the Add Shot button */
  showAddButton?: boolean;
  /** Maximum height for the table container (CSS value) */
  maxHeight?: string;
  /** Currently selected row index */
  selectedRowIndex?: number | null;
  /** Callback when a row is selected */
  onRowSelect?: (index: number) => void;
}

/**
 * Default validation thresholds from config.
 */
const DEFAULT_VALIDATION_CONFIG: ValidationConfig = {
  azimuth_diff_threshold: defaultConfig.validation.azimuth_diff_threshold,
  pitch_diff_threshold: defaultConfig.validation.pitch_diff_threshold,
};

/**
 * Calculate the average of two values, handling null/undefined.
 */
function calculateAverage(a: number | null | undefined, b: number | null | undefined): number {
  const aVal = a ?? 0;
  const bVal = b ?? 0;
  return (aVal + bVal) / 2;
}

/**
 * Check for azimuth warning using the shared validation function.
 * Returns true if the difference from 180 exceeds the threshold.
 */
function hasAzimuthWarning(shot: EditableShot, threshold: number): boolean {
  return hasAzimuthDiscrepancy(shot.azimuth_in, shot.azimuth_out, threshold);
}

/**
 * Check for pitch warning using the shared validation function.
 * Returns true if the absolute difference exceeds the threshold.
 */
function hasPitchWarning(shot: EditableShot, threshold: number): boolean {
  return hasPitchDiscrepancy(shot.pitch_in, shot.pitch_out, threshold);
}

/**
 * Get warnings for a shot based on validation config.
 */
function getShotWarnings(shot: EditableShot, config: ValidationConfig): ShotWarning[] {
  const warnings: ShotWarning[] = [];

  if (hasAzimuthWarning(shot, config.azimuth_diff_threshold)) {
    warnings.push({
      type: 'azimuth',
      message: `Azimuth in/out differ by more than ${config.azimuth_diff_threshold}° from 180°`,
    });
  }

  if (hasPitchWarning(shot, config.pitch_diff_threshold)) {
    warnings.push({
      type: 'pitch',
      message: `Pitch in/out differ by more than ${config.pitch_diff_threshold}°`,
    });
  }

  return warnings;
}

/**
 * Format a number for display, showing '-' for null/undefined.
 */
function formatValue(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return value.toString();
}

/**
 * Context menu state.
 */
interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  rowIndex: number;
}

/**
 * ShotTableEditor - A reusable component for editing shot data in a table format.
 *
 * Features:
 * - Azimuth column shows average of in/out, editing sets both values
 * - Warnings column shows icons for azimuth/pitch discrepancies
 * - Right-click context menu for insert before/after/delete
 * - Keyboard navigation (Tab between cells, Enter to confirm, Escape to cancel)
 */
export function ShotTableEditor({
  shots,
  onShotChange,
  onAddShot,
  onDeleteShot,
  onInsertBefore,
  onInsertAfter,
  validationConfig = DEFAULT_VALIDATION_CONFIG,
  readOnly = false,
  showAddButton = true,
  maxHeight = '16rem',
  selectedRowIndex,
  onRowSelect,
}: ShotTableEditorProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    rowIndex: -1,
  });

  const tableRef = useRef<HTMLTableElement>(null);

  // Filter out deleted shots for display
  const visibleShots = shots.filter((s) => !s.isDeleted);

  /**
   * Handle azimuth change - sets both azimuth_in and azimuth_out to the same value.
   */
  const handleAzimuthChange = useCallback(
    (index: number, value: string) => {
      const numValue = parseFloat(value) || 0;
      // Set both azimuth_in and azimuth_out to maintain consistency
      onShotChange(index, 'azimuth_in', numValue);
      onShotChange(index, 'azimuth_out', (numValue + 180) % 360);
    },
    [onShotChange]
  );

  /**
   * Handle context menu right-click.
   */
  const handleContextMenu = useCallback(
    (e: React.MouseEvent, rowIndex: number) => {
      if (readOnly) return;
      e.preventDefault();
      setContextMenu({
        visible: true,
        x: e.clientX,
        y: e.clientY,
        rowIndex,
      });
    },
    [readOnly]
  );

  /**
   * Close context menu.
   */
  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  /**
   * Handle context menu action.
   */
  const handleContextMenuAction = useCallback(
    (action: 'insert-before' | 'insert-after' | 'delete') => {
      const actualIndex = shots.findIndex(
        (s) => s === visibleShots[contextMenu.rowIndex] ||
               (s.id === visibleShots[contextMenu.rowIndex]?.id &&
                s.tempId === visibleShots[contextMenu.rowIndex]?.tempId)
      );

      switch (action) {
        case 'insert-before':
          if (onInsertBefore) {
            onInsertBefore(actualIndex);
          }
          break;
        case 'insert-after':
          if (onInsertAfter) {
            onInsertAfter(actualIndex);
          }
          break;
        case 'delete':
          onDeleteShot(actualIndex);
          break;
      }
      closeContextMenu();
    },
    [shots, visibleShots, contextMenu.rowIndex, onInsertBefore, onInsertAfter, onDeleteShot, closeContextMenu]
  );

  /**
   * Handle row click for selection.
   */
  const handleRowClick = useCallback(
    (index: number) => {
      if (onRowSelect) {
        const actualIndex = shots.findIndex(
          (s) => s === visibleShots[index] ||
                 (s.id === visibleShots[index]?.id &&
                  s.tempId === visibleShots[index]?.tempId)
        );
        onRowSelect(actualIndex);
      }
    },
    [shots, visibleShots, onRowSelect]
  );

  /**
   * Handle keyboard navigation.
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, rowIndex: number) => {
      if (e.key === 'Enter') {
        // Move to next row
        const nextInput = tableRef.current?.querySelector(
          `tr:nth-child(${rowIndex + 2}) input`
        ) as HTMLInputElement | null;
        nextInput?.focus();
      }
    },
    []
  );

  /**
   * Get the actual index in the shots array for a visible row.
   */
  const getActualIndex = (visibleIndex: number): number => {
    const shot = visibleShots[visibleIndex];
    return shots.findIndex(
      (s) => s === shot || (s.id === shot?.id && s.tempId === shot?.tempId)
    );
  };

  return (
    <div className="relative">
      {/* Header with count and add button */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-text-secondary">
          Shots ({visibleShots.length})
        </span>
        {showAddButton && !readOnly && (
          <button
            type="button"
            onClick={onAddShot}
            className="text-sm px-2 py-1 bg-accent text-white rounded hover:bg-accent/80 transition-colors"
            data-testid="add-shot-button"
          >
            + Add Shot
          </button>
        )}
      </div>

      {/* Table container with scrolling */}
      <div
        className="overflow-auto border border-border rounded"
        style={{ maxHeight }}
        data-testid="shot-table-container"
      >
        <table ref={tableRef} className="w-full text-sm" data-testid="shot-table">
          <thead className="bg-background sticky top-0 z-10">
            <tr className="border-b border-border">
              <th className="px-2 py-1 text-left w-12">#</th>
              <th className="px-2 py-1 text-left">Length</th>
              <th className="px-2 py-1 text-left">Azimuth</th>
              <th className="px-2 py-1 text-left">Depth In</th>
              <th className="px-2 py-1 text-left">Depth Out</th>
              <th className="px-2 py-1 text-left w-12">L</th>
              <th className="px-2 py-1 text-left w-12">R</th>
              <th className="px-2 py-1 text-left w-12">U</th>
              <th className="px-2 py-1 text-left w-12">D</th>
              <th className="px-2 py-1 text-left">Comment</th>
              <th className="px-2 py-1 text-center w-8" title="Warnings"></th>
              <th className="px-2 py-1 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {visibleShots.map((shot, visibleIdx) => {
              const actualIndex = getActualIndex(visibleIdx);
              const warnings = getShotWarnings(shot, validationConfig);
              const isSelected = selectedRowIndex === actualIndex;
              const avgAzimuth = calculateAverage(shot.azimuth_in, shot.azimuth_out);

              return (
                <tr
                  key={shot.tempId ?? shot.id}
                  className={`border-b border-border last:border-0 hover:bg-background/50 ${
                    isSelected ? 'bg-accent/10' : ''
                  } ${shot.isNew ? 'bg-success/5' : ''}`}
                  onClick={() => handleRowClick(visibleIdx)}
                  onContextMenu={(e) => handleContextMenu(e, visibleIdx)}
                  onKeyDown={(e) => handleKeyDown(e, visibleIdx)}
                  data-testid={`shot-row-${visibleIdx}`}
                >
                  {/* Row number */}
                  <td className="px-2 py-1 text-text-secondary">{visibleIdx + 1}</td>

                  {/* Length */}
                  <td className="px-1 py-1">
                    <input
                      type="number"
                      value={shot.length}
                      onChange={(e) =>
                        onShotChange(actualIndex, 'length', parseFloat(e.target.value) || 0)
                      }
                      className="w-16 text-xs px-1 py-0.5"
                      step="0.1"
                      disabled={readOnly}
                      data-testid={`shot-length-${visibleIdx}`}
                    />
                  </td>

                  {/* Azimuth (average of in/out, editing sets both) */}
                  <td className="px-1 py-1">
                    <input
                      type="number"
                      value={avgAzimuth.toFixed(1)}
                      onChange={(e) => handleAzimuthChange(actualIndex, e.target.value)}
                      className="w-16 text-xs px-1 py-0.5"
                      step="0.1"
                      min="0"
                      max="360"
                      disabled={readOnly}
                      data-testid={`shot-azimuth-${visibleIdx}`}
                      title={`In: ${shot.azimuth_in.toFixed(1)}°, Out: ${shot.azimuth_out.toFixed(1)}°`}
                    />
                  </td>

                  {/* Depth In */}
                  <td className="px-1 py-1">
                    <input
                      type="number"
                      value={shot.depth_in}
                      onChange={(e) =>
                        onShotChange(actualIndex, 'depth_in', parseFloat(e.target.value) || 0)
                      }
                      className="w-16 text-xs px-1 py-0.5"
                      step="0.1"
                      disabled={readOnly}
                      data-testid={`shot-depth-in-${visibleIdx}`}
                    />
                  </td>

                  {/* Depth Out */}
                  <td className="px-1 py-1">
                    <input
                      type="number"
                      value={shot.depth_out}
                      onChange={(e) =>
                        onShotChange(actualIndex, 'depth_out', parseFloat(e.target.value) || 0)
                      }
                      className="w-16 text-xs px-1 py-0.5"
                      step="0.1"
                      disabled={readOnly}
                      data-testid={`shot-depth-out-${visibleIdx}`}
                    />
                  </td>

                  {/* LRUD: Left */}
                  <td className="px-1 py-1">
                    <input
                      type="number"
                      value={formatValue(shot.left)}
                      onChange={(e) =>
                        onShotChange(
                          actualIndex,
                          'left',
                          e.target.value === '' ? null : parseFloat(e.target.value)
                        )
                      }
                      className="w-10 text-xs px-1 py-0.5"
                      step="0.1"
                      placeholder="-"
                      disabled={readOnly}
                      data-testid={`shot-left-${visibleIdx}`}
                    />
                  </td>

                  {/* LRUD: Right */}
                  <td className="px-1 py-1">
                    <input
                      type="number"
                      value={formatValue(shot.right)}
                      onChange={(e) =>
                        onShotChange(
                          actualIndex,
                          'right',
                          e.target.value === '' ? null : parseFloat(e.target.value)
                        )
                      }
                      className="w-10 text-xs px-1 py-0.5"
                      step="0.1"
                      placeholder="-"
                      disabled={readOnly}
                      data-testid={`shot-right-${visibleIdx}`}
                    />
                  </td>

                  {/* LRUD: Up */}
                  <td className="px-1 py-1">
                    <input
                      type="number"
                      value={formatValue(shot.up)}
                      onChange={(e) =>
                        onShotChange(
                          actualIndex,
                          'up',
                          e.target.value === '' ? null : parseFloat(e.target.value)
                        )
                      }
                      className="w-10 text-xs px-1 py-0.5"
                      step="0.1"
                      placeholder="-"
                      disabled={readOnly}
                      data-testid={`shot-up-${visibleIdx}`}
                    />
                  </td>

                  {/* LRUD: Down */}
                  <td className="px-1 py-1">
                    <input
                      type="number"
                      value={formatValue(shot.down)}
                      onChange={(e) =>
                        onShotChange(
                          actualIndex,
                          'down',
                          e.target.value === '' ? null : parseFloat(e.target.value)
                        )
                      }
                      className="w-10 text-xs px-1 py-0.5"
                      step="0.1"
                      placeholder="-"
                      disabled={readOnly}
                      data-testid={`shot-down-${visibleIdx}`}
                    />
                  </td>

                  {/* Comment */}
                  <td className="px-1 py-1">
                    <input
                      type="text"
                      value={shot.comment ?? ''}
                      onChange={(e) =>
                        onShotChange(actualIndex, 'comment', e.target.value || null)
                      }
                      className="w-24 text-xs px-1 py-0.5"
                      placeholder="-"
                      disabled={readOnly}
                      data-testid={`shot-comment-${visibleIdx}`}
                    />
                  </td>

                  {/* Warnings */}
                  <td className="px-1 py-1 text-center">
                    {warnings.length > 0 && (
                      <span
                        className="inline-flex items-center justify-center w-5 h-5 text-xs font-bold rounded-full bg-warning text-black cursor-help"
                        title={warnings.map((w) => w.message).join('\n')}
                        data-testid={`shot-warning-${visibleIdx}`}
                        role="img"
                        aria-label="Warning"
                      >
                        !
                      </span>
                    )}
                  </td>

                  {/* Actions (delete) */}
                  <td className="px-1 py-1 text-center">
                    {!readOnly && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteShot(actualIndex);
                        }}
                        className="text-error hover:text-error/80 text-xs px-1"
                        title="Delete shot"
                        data-testid={`shot-delete-${visibleIdx}`}
                      >
                        x
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {visibleShots.length === 0 && (
              <tr>
                <td colSpan={12} className="px-2 py-4 text-center text-text-secondary">
                  No shots. {!readOnly && 'Click "Add Shot" to create one.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Context Menu */}
      {contextMenu.visible && (
        <div
          className="fixed inset-0 z-50"
          onClick={closeContextMenu}
          onContextMenu={(e) => {
            e.preventDefault();
            closeContextMenu();
          }}
        >
          <div
            className="absolute bg-panel border border-border rounded-lg shadow-xl py-1 min-w-[160px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
            data-testid="shot-context-menu"
          >
            {onInsertBefore && (
              <button
                type="button"
                onClick={() => handleContextMenuAction('insert-before')}
                className="w-full px-3 py-2 text-left text-sm hover:bg-accent/10"
                data-testid="context-menu-insert-before"
              >
                Insert row before
              </button>
            )}
            {onInsertAfter && (
              <button
                type="button"
                onClick={() => handleContextMenuAction('insert-after')}
                className="w-full px-3 py-2 text-left text-sm hover:bg-accent/10"
                data-testid="context-menu-insert-after"
              >
                Insert row after
              </button>
            )}
            {(onInsertBefore || onInsertAfter) && (
              <div className="border-t border-border my-1" />
            )}
            <button
              type="button"
              onClick={() => handleContextMenuAction('delete')}
              className="w-full px-3 py-2 text-left text-sm text-error hover:bg-error/10"
              data-testid="context-menu-delete"
            >
              Delete row
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default ShotTableEditor;
