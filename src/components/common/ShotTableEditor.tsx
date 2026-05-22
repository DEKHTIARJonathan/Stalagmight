import { useState, useRef, useCallback, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { formatFixed, formatNumber } from '../../i18n/format';
import type { Shot } from '../../types/project';
import { defaultConfig } from '../../types/config';
import { useDecimalPrecision } from '../../hooks/useDecimalPrecision';
import { hasAzimuthDiscrepancy, hasPitchDiscrepancy, validateEditableShot } from '../../utils/validation';
import { applyAzimuthEdit, getAzimuthAverage } from '../../utils/shotTable';
import { HelpTooltip } from './HelpTooltip';
import { useLongPress } from '../../hooks';

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
  /** Set of shot indices whose geometry fields should be disabled (frozen shots) */
  frozenShotIndices?: Set<number>;
}

/**
 * Default validation thresholds from config.
 */
const DEFAULT_VALIDATION_CONFIG: ValidationConfig = {
  azimuth_diff_threshold: defaultConfig.validation.azimuth_diff_threshold,
  pitch_diff_threshold: defaultConfig.validation.pitch_diff_threshold,
};

/**
 * Check for azimuth warning using the shared validation function.
 * Returns true if the difference between azimuth_in and azimuth_out exceeds the threshold.
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
function getShotWarnings(
  shot: EditableShot,
  config: ValidationConfig,
  t: TFunction
): ShotWarning[] {
  const warnings: ShotWarning[] = [];

  if (hasAzimuthWarning(shot, config.azimuth_diff_threshold)) {
    warnings.push({
      type: 'azimuth',
      message: t('shotTable.warnings.azimuthDiff', {
        threshold: `${formatFixed(config.azimuth_diff_threshold, undefined, 0)}°`,
      }),
    });
  }

  if (hasPitchWarning(shot, config.pitch_diff_threshold)) {
    warnings.push({
      type: 'pitch',
      message: t('shotTable.warnings.pitchDiff', {
        threshold: `${formatFixed(config.pitch_diff_threshold, undefined, 0)}°`,
      }),
    });
  }

  return warnings;
}

/**
 * Get blocking errors for a shot (length/azimuth validity).
 */
function getShotErrors(shot: EditableShot, shotIndex: number): string[] {
  return validateEditableShot(
    {
      length: shot.length,
      azimuth_in: shot.azimuth_in,
      azimuth_out: shot.azimuth_out,
      isDeleted: shot.isDeleted ?? false,
    },
    shotIndex,
    0
  ).map((e) => e.message);
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
  frozenShotIndices,
}: ShotTableEditorProps) {
  const { t } = useTranslation();
  const precision = useDecimalPrecision();
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    rowIndex: -1,
  });

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const skipBlurCommitRef = useRef<Set<string>>(new Set());

  const tableRef = useRef<HTMLTableElement>(null);

  // Filter out deleted shots for display
  const visibleShots = shots.filter((s) => !s.isDeleted);

  const getRowKey = useCallback((shot: EditableShot): string => {
    if (shot.tempId !== undefined) return `t:${shot.tempId}`;
    return `i:${shot.id}`;
  }, []);

  const getDraftKey = useCallback((shot: EditableShot, field: string): string => {
    return `${getRowKey(shot)}:${field}`;
  }, [getRowKey]);

  const startDraft = useCallback((draftKey: string, value: string) => {
    setDrafts((prev) => (draftKey in prev ? prev : { ...prev, [draftKey]: value }));
  }, []);

  const updateDraft = useCallback((draftKey: string, value: string) => {
    setDrafts((prev) => ({ ...prev, [draftKey]: value }));
  }, []);

  const clearDraft = useCallback((draftKey: string) => {
    setDrafts((prev) => {
      if (!(draftKey in prev)) return prev;
      const next = { ...prev };
      delete next[draftKey];
      return next;
    });
  }, []);

  const shouldSkipBlurCommit = useCallback((draftKey: string) => {
    if (skipBlurCommitRef.current.has(draftKey)) {
      skipBlurCommitRef.current.delete(draftKey);
      return true;
    }
    return false;
  }, []);

  const handleDraftKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>, onCommit: () => void, draftKey: string) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        skipBlurCommitRef.current.add(draftKey);
        onCommit();
        clearDraft(draftKey);
        (e.currentTarget as HTMLInputElement).blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        skipBlurCommitRef.current.add(draftKey);
        clearDraft(draftKey);
        (e.currentTarget as HTMLInputElement).blur();
      }
    },
    [clearDraft]
  );

  const commitNumberValue = useCallback(
    (
      index: number,
      field: keyof EditableShot,
      rawValue: string,
      emptyValue: number | null
    ) => {
      const trimmed = rawValue.trim();
      if (trimmed === '') {
        onShotChange(index, field, emptyValue);
        return;
      }
      const parsed = parseFloat(trimmed);
      if (!Number.isFinite(parsed)) {
        return;
      }
      onShotChange(index, field, parsed);
    },
    [onShotChange]
  );

  const commitAzimuthValue = useCallback(
    (index: number, rawValue: string) => {
      const trimmed = rawValue.trim();
      const parsed = trimmed === '' ? 0 : parseFloat(trimmed);
      if (!Number.isFinite(parsed)) {
        return;
      }
      const { azimuth_in, azimuth_out } = applyAzimuthEdit(parsed, { normalize: false });
      onShotChange(index, 'azimuth_in', azimuth_in);
      onShotChange(index, 'azimuth_out', azimuth_out);
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
   * Long-press handler for touch context menu on tbody.
   */
  const handleLongPress = useCallback(
    (pos: { x: number; y: number }, target: HTMLElement) => {
      if (readOnly) return;
      const row = target.closest('tr');
      const rowIndexStr = row?.dataset.rowIndex;
      if (rowIndexStr === undefined) return;
      const rowIndex = parseInt(rowIndexStr, 10);
      if (Number.isNaN(rowIndex)) return;
      setContextMenu({
        visible: true,
        x: pos.x,
        y: pos.y,
        rowIndex,
      });
    },
    [readOnly],
  );

  const longPressHandlers = useLongPress(handleLongPress, { enabled: !readOnly });

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
          {t('shotTable.header', {
            count: visibleShots.length,
            countFormatted: formatNumber(visibleShots.length),
          })}
        </span>
        {showAddButton && !readOnly && (
          <button
            type="button"
            onClick={onAddShot}
            className="text-sm px-2 py-1 bg-accent text-accent-on rounded hover:bg-accent-80 transition-colors"
            data-testid="add-shot-button"
          >
            {t('shotTable.add')}
          </button>
        )}
      </div>

      {/* Table container with scrolling */}
      <div
        className="overflow-auto pb-1"
        style={{ maxHeight }}
        data-testid="shot-table-container"
      >
        <table ref={tableRef} className="w-full" data-testid="shot-table">
          <thead>
            <tr>
              <th className="text-center" style={{ width: '40px' }}>{t('shotTable.columns.idShort')}</th>
              <th className="text-right" style={{ width: '100px' }}>{t('shotTable.columns.length')}</th>
              <th className="text-right" style={{ width: '70px' }}>{t('shotTable.columns.azimuth')}</th>
              <th className="text-right" style={{ width: '80px' }}>{t('shotTable.columns.depthIn')}</th>
              <th className="text-right" style={{ width: '95px' }}>{t('shotTable.columns.depthOut')}</th>
              <th className="text-right" style={{ width: '50px' }}>{t('shotTable.columns.leftShort')}</th>
              <th className="text-right" style={{ width: '50px' }}>{t('shotTable.columns.rightShort')}</th>
              <th className="text-right" style={{ width: '50px' }}>{t('shotTable.columns.upShort')}</th>
              <th className="text-right" style={{ width: '50px' }}>{t('shotTable.columns.downShort')}</th>
              <th className="text-left" style={{ width: '100px' }}>{t('shotTable.columns.comment')}</th>
              <th className="text-center" style={{ width: '30px' }} title={t('shotTable.columns.warnings')}></th>
              <th style={{ width: '30px' }}></th>
            </tr>
          </thead>
          <tbody {...longPressHandlers}>
            {visibleShots.map((shot, visibleIdx) => {
              const actualIndex = getActualIndex(visibleIdx);
              const warnings = getShotWarnings(shot, validationConfig, t);
              const errors = getShotErrors(shot, actualIndex);
              const hasErrors = errors.length > 0;
              const warningMessages = warnings.map((w) => w.message);
              const tooltipText = [...errors, ...warningMessages].join('\n');
              const isSelected = selectedRowIndex === actualIndex;
              const avgAzimuth = getAzimuthAverage(shot.azimuth_in, shot.azimuth_out);
              const geoDisabled = readOnly || (frozenShotIndices?.has(actualIndex) ?? false);
              const rowClassName = `hover:bg-background-50 ${
                isSelected ? 'bg-accent-10' : hasErrors ? 'bg-error-5' : ''
              } ${shot.isNew && !hasErrors ? 'bg-success-5' : ''} ${shot.is_reference ? 'opacity-50' : ''}`;

              return (
                <tr
                  key={shot.tempId ?? shot.id}
                  className={rowClassName}
                  onClick={() => handleRowClick(visibleIdx)}
                  onContextMenu={(e) => handleContextMenu(e, visibleIdx)}
                  onKeyDown={(e) => handleKeyDown(e, visibleIdx)}
                  data-row-index={visibleIdx}
                  data-testid={`shot-row-${visibleIdx}`}
                >
                  {/* Row number */}
                  <td className="p-0 text-center">
                    <span className="px-2 py-1 inline-block text-text-secondary">{visibleIdx + 1}</span>
                  </td>

                  {/* Length */}
                  <td className="p-0 text-right">
                    {(() => {
                      const draftKey = getDraftKey(shot, 'length');
                      const draftValue = drafts[draftKey];
                      const rawValue = Number.isFinite(shot.length) ? String(shot.length) : '';
                      const displayValue = draftValue ?? (Number.isFinite(shot.length) ? shot.length.toFixed(precision.length) : '');
                      const isInvalid = draftValue !== undefined && draftValue.trim() !== '' && !Number.isFinite(parseFloat(draftValue));
                      return (
                    <input
                      type="number" inputMode="decimal"
                      value={displayValue}
                      onFocus={() => startDraft(draftKey, rawValue)}
                      onChange={(e) =>
                        updateDraft(draftKey, e.target.value)
                      }
                      onBlur={(e) => {
                        if (shouldSkipBlurCommit(draftKey)) return;
                        commitNumberValue(actualIndex, 'length', e.target.value, 0);
                        clearDraft(draftKey);
                      }}
                      onKeyDown={(e) => handleDraftKeyDown(
                        e,
                        () => commitNumberValue(actualIndex, 'length', e.currentTarget.value, 0),
                        draftKey
                      )}
                      className={`w-full px-2 py-1 bg-transparent border-none focus:bg-panel text-right tabular-nums ${isInvalid ? 'ring-2 ring-error' : ''}`}
                      step="0.1"
                      disabled={geoDisabled}
                      data-testid={`shot-length-${visibleIdx}`}
                    />
                      );
                    })()}
                  </td>

                  {/* Azimuth (average of in/out, editing sets both) */}
                  <td className="p-0 text-right">
                    {(() => {
                      const draftKey = getDraftKey(shot, 'azimuth');
                      const draftValue = drafts[draftKey];
                      const rawValue = String(avgAzimuth);
                      const displayValue = draftValue ?? avgAzimuth.toFixed(precision.azimuth);
                      const parsed = draftValue !== undefined && draftValue.trim() !== ''
                        ? parseFloat(draftValue)
                        : null;
                      const isInvalid =
                        draftValue !== undefined &&
                        draftValue.trim() !== '' &&
                        (!Number.isFinite(parsed) || (parsed !== null && (parsed < 0 || parsed >= 360)));
                      return (
                    <input
                      type="number" inputMode="decimal"
                      value={displayValue}
                      onFocus={() => startDraft(draftKey, rawValue)}
                      onChange={(e) => updateDraft(draftKey, e.target.value)}
                      onBlur={(e) => {
                        if (shouldSkipBlurCommit(draftKey)) return;
                        commitAzimuthValue(actualIndex, e.target.value);
                        clearDraft(draftKey);
                      }}
                      onKeyDown={(e) => handleDraftKeyDown(
                        e,
                        () => commitAzimuthValue(actualIndex, e.currentTarget.value),
                        draftKey
                      )}
                      className={`w-full px-2 py-1 bg-transparent border-none focus:bg-panel text-right tabular-nums ${isInvalid ? 'ring-2 ring-error' : ''}`}
                      step="0.1"
                      min="0"
                      max="360"
                      disabled={geoDisabled}
                      data-testid={`shot-azimuth-${visibleIdx}`}
                      title={t('shotTable.azimuthTitle', {
                        inValue: `${formatFixed(shot.azimuth_in, undefined, precision.azimuth)}°`,
                        outValue: `${formatFixed(shot.azimuth_out, undefined, precision.azimuth)}°`,
                      })}
                    />
                      );
                    })()}
                  </td>

                  {/* Depth In */}
                  <td className="p-0 text-right">
                    {(() => {
                      const draftKey = getDraftKey(shot, 'depth_in');
                      const draftValue = drafts[draftKey];
                      const rawValue = Number.isFinite(shot.depth_in) ? String(shot.depth_in) : '';
                      const displayValue = draftValue ?? (Number.isFinite(shot.depth_in) ? shot.depth_in.toFixed(precision.depth) : '');
                      const isInvalid = draftValue !== undefined && draftValue.trim() !== '' && !Number.isFinite(parseFloat(draftValue));
                      return (
                    <input
                      type="number" inputMode="decimal"
                      value={displayValue}
                      onFocus={() => startDraft(draftKey, rawValue)}
                      onChange={(e) =>
                        updateDraft(draftKey, e.target.value)
                      }
                      onBlur={(e) => {
                        if (shouldSkipBlurCommit(draftKey)) return;
                        commitNumberValue(actualIndex, 'depth_in', e.target.value, 0);
                        clearDraft(draftKey);
                      }}
                      onKeyDown={(e) => handleDraftKeyDown(
                        e,
                        () => commitNumberValue(actualIndex, 'depth_in', e.currentTarget.value, 0),
                        draftKey
                      )}
                      className={`w-full px-2 py-1 bg-transparent border-none focus:bg-panel text-right tabular-nums ${isInvalid ? 'ring-2 ring-error' : ''}`}
                      step="0.1"
                      disabled={geoDisabled}
                      data-testid={`shot-depth-in-${visibleIdx}`}
                    />
                      );
                    })()}
                  </td>

                  {/* Depth Out */}
                  <td className="p-0 text-right">
                    {(() => {
                      const draftKey = getDraftKey(shot, 'depth_out');
                      const draftValue = drafts[draftKey];
                      const rawValue = Number.isFinite(shot.depth_out) ? String(shot.depth_out) : '';
                      const displayValue = draftValue ?? (Number.isFinite(shot.depth_out) ? shot.depth_out.toFixed(precision.depth) : '');
                      const isInvalid = draftValue !== undefined && draftValue.trim() !== '' && !Number.isFinite(parseFloat(draftValue));
                      return (
                    <input
                      type="number" inputMode="decimal"
                      value={displayValue}
                      onFocus={() => startDraft(draftKey, rawValue)}
                      onChange={(e) =>
                        updateDraft(draftKey, e.target.value)
                      }
                      onBlur={(e) => {
                        if (shouldSkipBlurCommit(draftKey)) return;
                        commitNumberValue(actualIndex, 'depth_out', e.target.value, 0);
                        clearDraft(draftKey);
                      }}
                      onKeyDown={(e) => handleDraftKeyDown(
                        e,
                        () => commitNumberValue(actualIndex, 'depth_out', e.currentTarget.value, 0),
                        draftKey
                      )}
                      className={`w-full px-2 py-1 bg-transparent border-none focus:bg-panel text-right tabular-nums ${isInvalid ? 'ring-2 ring-error' : ''}`}
                      step="0.1"
                      disabled={geoDisabled}
                      data-testid={`shot-depth-out-${visibleIdx}`}
                    />
                      );
                    })()}
                  </td>

                  {/* LRUD: Left */}
                  <td className="p-0 text-right">
                    {(() => {
                      const draftKey = getDraftKey(shot, 'left');
                      const draftValue = drafts[draftKey];
                      const rawValue = formatValue(shot.left);
                      const displayValue = draftValue ?? (shot.left !== null && shot.left !== undefined ? shot.left.toFixed(precision.length) : '');
                      const isInvalid = draftValue !== undefined && draftValue.trim() !== '' && !Number.isFinite(parseFloat(draftValue));
                      return (
                    <input
                      type="number" inputMode="decimal"
                      value={displayValue}
                      onFocus={() => startDraft(draftKey, rawValue)}
                      onChange={(e) =>
                        updateDraft(draftKey, e.target.value)
                      }
                      onBlur={(e) => {
                        if (shouldSkipBlurCommit(draftKey)) return;
                        commitNumberValue(actualIndex, 'left', e.target.value, null);
                        clearDraft(draftKey);
                      }}
                      onKeyDown={(e) => handleDraftKeyDown(
                        e,
                        () => commitNumberValue(actualIndex, 'left', e.currentTarget.value, null),
                        draftKey
                      )}
                      className={`w-full px-2 py-1 bg-transparent border-none focus:bg-panel text-right tabular-nums ${isInvalid ? 'ring-2 ring-error' : ''}`}
                      step="0.1"
                      placeholder="—"
                      disabled={readOnly}
                      data-testid={`shot-left-${visibleIdx}`}
                    />
                      );
                    })()}
                  </td>

                  {/* LRUD: Right */}
                  <td className="p-0 text-right">
                    {(() => {
                      const draftKey = getDraftKey(shot, 'right');
                      const draftValue = drafts[draftKey];
                      const rawValue = formatValue(shot.right);
                      const displayValue = draftValue ?? (shot.right !== null && shot.right !== undefined ? shot.right.toFixed(precision.length) : '');
                      const isInvalid = draftValue !== undefined && draftValue.trim() !== '' && !Number.isFinite(parseFloat(draftValue));
                      return (
                    <input
                      type="number" inputMode="decimal"
                      value={displayValue}
                      onFocus={() => startDraft(draftKey, rawValue)}
                      onChange={(e) =>
                        updateDraft(draftKey, e.target.value)
                      }
                      onBlur={(e) => {
                        if (shouldSkipBlurCommit(draftKey)) return;
                        commitNumberValue(actualIndex, 'right', e.target.value, null);
                        clearDraft(draftKey);
                      }}
                      onKeyDown={(e) => handleDraftKeyDown(
                        e,
                        () => commitNumberValue(actualIndex, 'right', e.currentTarget.value, null),
                        draftKey
                      )}
                      className={`w-full px-2 py-1 bg-transparent border-none focus:bg-panel text-right tabular-nums ${isInvalid ? 'ring-2 ring-error' : ''}`}
                      step="0.1"
                      placeholder="—"
                      disabled={readOnly}
                      data-testid={`shot-right-${visibleIdx}`}
                    />
                      );
                    })()}
                  </td>

                  {/* LRUD: Up */}
                  <td className="p-0 text-right">
                    {(() => {
                      const draftKey = getDraftKey(shot, 'up');
                      const draftValue = drafts[draftKey];
                      const rawValue = formatValue(shot.up);
                      const displayValue = draftValue ?? (shot.up !== null && shot.up !== undefined ? shot.up.toFixed(precision.length) : '');
                      const isInvalid = draftValue !== undefined && draftValue.trim() !== '' && !Number.isFinite(parseFloat(draftValue));
                      return (
                    <input
                      type="number" inputMode="decimal"
                      value={displayValue}
                      onFocus={() => startDraft(draftKey, rawValue)}
                      onChange={(e) =>
                        updateDraft(draftKey, e.target.value)
                      }
                      onBlur={(e) => {
                        if (shouldSkipBlurCommit(draftKey)) return;
                        commitNumberValue(actualIndex, 'up', e.target.value, null);
                        clearDraft(draftKey);
                      }}
                      onKeyDown={(e) => handleDraftKeyDown(
                        e,
                        () => commitNumberValue(actualIndex, 'up', e.currentTarget.value, null),
                        draftKey
                      )}
                      className={`w-full px-2 py-1 bg-transparent border-none focus:bg-panel text-right tabular-nums ${isInvalid ? 'ring-2 ring-error' : ''}`}
                      step="0.1"
                      placeholder="—"
                      disabled={readOnly}
                      data-testid={`shot-up-${visibleIdx}`}
                    />
                      );
                    })()}
                  </td>

                  {/* LRUD: Down */}
                  <td className="p-0 text-right">
                    {(() => {
                      const draftKey = getDraftKey(shot, 'down');
                      const draftValue = drafts[draftKey];
                      const rawValue = formatValue(shot.down);
                      const displayValue = draftValue ?? (shot.down !== null && shot.down !== undefined ? shot.down.toFixed(precision.length) : '');
                      const isInvalid = draftValue !== undefined && draftValue.trim() !== '' && !Number.isFinite(parseFloat(draftValue));
                      return (
                    <input
                      type="number" inputMode="decimal"
                      value={displayValue}
                      onFocus={() => startDraft(draftKey, rawValue)}
                      onChange={(e) =>
                        updateDraft(draftKey, e.target.value)
                      }
                      onBlur={(e) => {
                        if (shouldSkipBlurCommit(draftKey)) return;
                        commitNumberValue(actualIndex, 'down', e.target.value, null);
                        clearDraft(draftKey);
                      }}
                      onKeyDown={(e) => handleDraftKeyDown(
                        e,
                        () => commitNumberValue(actualIndex, 'down', e.currentTarget.value, null),
                        draftKey
                      )}
                      className={`w-full px-2 py-1 bg-transparent border-none focus:bg-panel text-right tabular-nums ${isInvalid ? 'ring-2 ring-error' : ''}`}
                      step="0.1"
                      placeholder="—"
                      disabled={readOnly}
                      data-testid={`shot-down-${visibleIdx}`}
                    />
                      );
                    })()}
                  </td>

                  {/* Comment */}
                  <td className="p-0">
                    <input
                      type="text"
                      value={shot.comment ?? ''}
                      onChange={(e) =>
                        onShotChange(actualIndex, 'comment', e.target.value || null)
                      }
                      className="w-full px-2 py-1 bg-transparent border-none focus:bg-panel"
                      placeholder="—"
                      disabled={readOnly}
                      data-testid={`shot-comment-${visibleIdx}`}
                    />
                  </td>

                  {/* Warnings */}
                  <td className="p-0 text-center">
                    {(hasErrors || warnings.length > 0) && (
                      <HelpTooltip
                        text={tooltipText}
                        icon="!"
                        ariaLabel={hasErrors ? t('shotTable.warnings.error') : t('shotTable.warnings.warning')}
                        className="justify-center"
                        iconClassName={`w-5 h-5 text-xs border-transparent ${
                          hasErrors ? 'bg-error-20 text-error' : 'bg-warning-20 text-warning'
                        }`}
                        iconTestId={`shot-warning-${visibleIdx}`}
                        tooltipTestId={`shot-warning-tooltip-${visibleIdx}`}
                      />
                    )}
                  </td>

                  {/* Actions (delete) */}
                  <td className="p-0 text-center">
                    {!readOnly && !frozenShotIndices?.has(actualIndex) && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteShot(actualIndex);
                        }}
                        className="text-error hover:text-error-80 text-xs px-1"
                        title={t('shotTable.actions.delete')}
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
                <td colSpan={12} className="p-0 text-center text-text-secondary">
                  <span className="px-2 py-4 inline-block">
                    {readOnly ? t('shotTable.empty') : t('shotTable.emptyWithAction')}
                  </span>
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
                className="w-full px-3 py-2 text-left text-sm hover:bg-accent-10"
                data-testid="context-menu-insert-before"
              >
                {t('shotTable.contextMenu.insertBefore')}
              </button>
            )}
            {onInsertAfter && (
              <button
                type="button"
                onClick={() => handleContextMenuAction('insert-after')}
                className="w-full px-3 py-2 text-left text-sm hover:bg-accent-10"
                data-testid="context-menu-insert-after"
              >
                {t('shotTable.contextMenu.insertAfter')}
              </button>
            )}
            {(onInsertBefore || onInsertAfter) && (
              <div className="border-t border-border my-1" />
            )}
            {(() => {
              const ctxShot = visibleShots[contextMenu.rowIndex];
              const ctxActualIndex = ctxShot ? shots.findIndex(
                (s) => s === ctxShot || (s.id === ctxShot.id && s.tempId === ctxShot.tempId)
              ) : -1;
              const isFrozen = frozenShotIndices?.has(ctxActualIndex) ?? false;
              return (
                <button
                  type="button"
                  onClick={() => !isFrozen && handleContextMenuAction('delete')}
                  className={`w-full px-3 py-2 text-left text-sm ${
                    isFrozen
                      ? 'text-text-secondary opacity-50 cursor-not-allowed'
                      : 'text-error hover:bg-error-10'
                  }`}
                  disabled={isFrozen}
                  data-testid="context-menu-delete"
                >
                  {t('shotTable.contextMenu.delete')}
                </button>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

export default ShotTableEditor;
