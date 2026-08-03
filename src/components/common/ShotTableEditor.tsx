import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { formatFixed, getNumberFormatLocale } from '../../i18n/format';
import { defaultConfig } from '../../types/config';
import { useProjectStore } from '../../store/projectStore';
import { useDecimalPrecision } from '../../hooks/useDecimalPrecision';
import { useGridLabels } from '../../hooks/useGridLabels';
import {
  hasAzimuthDiscrepancy,
  hasPitchDiscrepancy,
  validateEditableShot,
} from '../../utils/validation';
import { applyAzimuthEdit } from '../../utils/shotTable';
import { SpreadsheetGrid } from './SpreadsheetGrid';
import type { CellEdit } from './SpreadsheetGrid/types';
import {
  buildEditableShotColumns,
  EDITABLE_AZIMUTH_AVG_KEY,
} from './editableShotColumns';
import type { EditableShot } from './editableShot';

export type { EditableShot };

/**
 * The shared editable shot table, on the app's spreadsheet grid.
 *
 * Rendered by EditSectionDialog, ZeroDatumConfigDialog and (twice) the mNemo
 * import wizard. It used to be a hand-rolled `<table>` of `<input>`s with its
 * own draft/blur/Escape bookkeeping; that predated `SpreadsheetGrid` and carried
 * the defects that came with it - locale-naive `parseFloat` (a comma decimal
 * truncated), a controlled value re-formatted at display precision on every
 * keystroke, no clipboard, no keyboard cell navigation, no virtualization.
 *
 * The props are UNCHANGED, so its hosts did not have to move: it still takes
 * `shots`, hands `onShotChange` an index into the FULL array (soft-deleted rows
 * included), and keeps the add/insert/delete callbacks. Only the internals and
 * the per-cell test IDs differ.
 */
interface ValidationConfig {
  azimuth_diff_threshold: number;
  pitch_diff_threshold: number;
}

export interface ShotTableEditorProps {
  /** Array of editable shots to display */
  shots: EditableShot[];
  /** Callback when a shot field changes */
  onShotChange: (
    index: number,
    field: keyof EditableShot,
    value: number | string | boolean | null
  ) => void;
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
  /** Currently selected row index (into the FULL shots array) */
  selectedRowIndex?: number | null;
  /** Callback when a row is selected (index into the FULL shots array) */
  onRowSelect?: (index: number) => void;
  /** Set of shot indices whose geometry fields should be disabled (frozen shots) */
  frozenShotIndices?: Set<number>;
}

const DEFAULT_VALIDATION_CONFIG: ValidationConfig = {
  azimuth_diff_threshold: defaultConfig.validation.azimuth_diff_threshold,
  pitch_diff_threshold: defaultConfig.validation.pitch_diff_threshold,
};

/** Fallback grid height when the host gives no `maxHeight`. */
const DEFAULT_GRID_HEIGHT = 260;

/** Parse a CSS length like "16rem" / "320px" into px for the grid, which needs
 *  a number (virtualization cannot work from an indefinite height). */
function cssHeightToPx(value: string | undefined): number {
  if (!value) return DEFAULT_GRID_HEIGHT;
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return DEFAULT_GRID_HEIGHT;
  if (value.endsWith('rem')) return Math.round(n * 16);
  return Math.round(n);
}

function warningsFor(shot: EditableShot, config: ValidationConfig, t: TFunction): string[] {
  const out: string[] = [];
  if (hasAzimuthDiscrepancy(shot.azimuth_in, shot.azimuth_out, config.azimuth_diff_threshold)) {
    out.push(
      t('shotTable.warnings.azimuthDiff', {
        threshold: `${formatFixed(config.azimuth_diff_threshold, undefined, 0)}°`,
      })
    );
  }
  if (hasPitchDiscrepancy(shot.pitch_in, shot.pitch_out, config.pitch_diff_threshold)) {
    out.push(
      t('shotTable.warnings.pitchDiff', {
        threshold: `${formatFixed(config.pitch_diff_threshold, undefined, 0)}°`,
      })
    );
  }
  return out;
}

export function ShotTableEditor({
  shots,
  onShotChange,
  onAddShot,
  onDeleteShot,
  onInsertBefore,
  onInsertAfter,
  validationConfig,
  readOnly = false,
  showAddButton = true,
  maxHeight,
  selectedRowIndex,
  onRowSelect,
  frozenShotIndices,
}: ShotTableEditorProps) {
  const { t } = useTranslation();
  const precision = useDecimalPrecision();
  const gridLabels = useGridLabels('dataTable.shotNoun');
  const configValidation = useProjectStore((s) => s.config?.validation);

  const effectiveValidation: ValidationConfig = {
    azimuth_diff_threshold:
      validationConfig?.azimuth_diff_threshold ??
      configValidation?.azimuth_diff_threshold ??
      DEFAULT_VALIDATION_CONFIG.azimuth_diff_threshold,
    pitch_diff_threshold:
      validationConfig?.pitch_diff_threshold ??
      configValidation?.pitch_diff_threshold ??
      DEFAULT_VALIDATION_CONFIG.pitch_diff_threshold,
  };

  // Soft-deleted rows stay in `shots` so the host's indices never shift, but are
  // not shown. Everything below works in VISIBLE indices and translates on the
  // way out, because the callbacks are documented in full-array indices.
  const { visibleShots, actualIndexes } = useMemo(() => {
    const rows: EditableShot[] = [];
    const map: number[] = [];
    shots.forEach((shot, i) => {
      if (shot.isDeleted) return;
      rows.push(shot);
      map.push(i);
    });
    return { visibleShots: rows, actualIndexes: map };
  }, [shots]);

  const actualIndex = useCallback(
    (visibleIndex: number): number => actualIndexes[visibleIndex] ?? -1,
    [actualIndexes]
  );

  const errorsAt = useCallback(
    (visibleIndex: number): string[] => {
      const shot = visibleShots[visibleIndex];
      if (!shot) return [];
      return validateEditableShot(
        {
          length: shot.length,
          azimuth_in: shot.azimuth_in,
          azimuth_out: shot.azimuth_out,
          isDeleted: shot.isDeleted ?? false,
        },
        actualIndex(visibleIndex),
        0
      ).map((e) => e.message);
    },
    [visibleShots, actualIndex]
  );

  const warningsAt = useCallback(
    (visibleIndex: number): string[] => {
      const shot = visibleShots[visibleIndex];
      return shot ? warningsFor(shot, effectiveValidation, t) : [];
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- thresholds are primitives
    [visibleShots, effectiveValidation.azimuth_diff_threshold, effectiveValidation.pitch_diff_threshold, t]
  );

  const isFrozenAt = useCallback(
    (visibleIndex: number): boolean => frozenShotIndices?.has(actualIndex(visibleIndex)) ?? false,
    [frozenShotIndices, actualIndex]
  );

  const onDeleteAt = useCallback(
    (visibleIndex: number) => {
      const index = actualIndex(visibleIndex);
      if (index >= 0) onDeleteShot(index);
    },
    [actualIndex, onDeleteShot]
  );

  const columns = useMemo(
    () =>
      buildEditableShotColumns({
        t,
        precision,
        readOnly,
        errorsAt,
        warningsAt,
        isFrozenAt,
        onDeleteAt,
      }),
    [t, precision, readOnly, errorsAt, warningsAt, isFrozenAt, onDeleteAt]
  );

  /** One coerced cell value -> the host's field callback(s). */
  const applyEdit = useCallback(
    (visibleRow: number, colKey: string, value: unknown) => {
      if (readOnly) return;
      const index = actualIndex(visibleRow);
      if (index < 0) return;
      if (colKey === EDITABLE_AZIMUTH_AVG_KEY) {
        // One displayed azimuth fans back out to both legs, unnormalized -
        // exactly what the hand-rolled editor committed.
        const typed = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(typed)) return;
        const { azimuth_in, azimuth_out } = applyAzimuthEdit(typed, { normalize: false });
        onShotChange(index, 'azimuth_in', azimuth_in);
        onShotChange(index, 'azimuth_out', azimuth_out);
        return;
      }
      onShotChange(index, colKey as keyof EditableShot, value as number | string | null);
    },
    [readOnly, actualIndex, onShotChange]
  );

  const onEdit = useCallback(
    (rowIndex: number, colKey: string, value: unknown) => applyEdit(rowIndex, colKey, value),
    [applyEdit]
  );

  const onBatchEdit = useCallback(
    (edits: CellEdit[]) => {
      for (const e of edits) applyEdit(e.row, e.colKey, e.value);
    },
    [applyEdit]
  );

  // Insert: the grid reports an insertion BOUNDARY, which is "after the last
  // row" at the end and "before this row" everywhere else.
  const onInsertRows = useCallback(
    (beforeIndex: number) => {
      if (readOnly) return;
      if (beforeIndex >= visibleShots.length) {
        const last = visibleShots.length - 1;
        if (last >= 0 && onInsertAfter) onInsertAfter(actualIndex(last));
        else onAddShot();
        return;
      }
      onInsertBefore?.(actualIndex(beforeIndex));
    },
    [readOnly, visibleShots.length, onInsertAfter, onInsertBefore, onAddShot, actualIndex]
  );

  // Delete high-to-low so each removal cannot shift the indices still to come.
  const onDeleteRows = useCallback(
    (fromRow: number, toRow: number) => {
      if (readOnly) return;
      const indices: number[] = [];
      for (let r = fromRow; r <= toRow; r++) {
        const i = actualIndex(r);
        if (i >= 0) indices.push(i);
      }
      for (const i of indices.sort((a, b) => b - a)) onDeleteShot(i);
    },
    [readOnly, actualIndex, onDeleteShot]
  );

  const rowClassName = useCallback(
    (shot: EditableShot, rowIndex: number): string | undefined => {
      const classes: string[] = [];
      if (errorsAt(rowIndex).length > 0) classes.push('bg-error-5');
      else if (shot.isNew) classes.push('bg-success-5');
      // Virtual shots (jumps/references) read as secondary, same as before.
      if (shot.kind && shot.kind !== 'Normal') classes.push('opacity-50');
      return classes.length > 0 ? classes.join(' ') : undefined;
    },
    [errorsAt]
  );

  // The host tracks selection in FULL-array indices; the grid works in visible
  // ones, so translate in both directions.
  const selectedVisibleRow = useMemo(() => {
    if (selectedRowIndex === null || selectedRowIndex === undefined) return null;
    const found = actualIndexes.indexOf(selectedRowIndex);
    return found === -1 ? null : found;
  }, [selectedRowIndex, actualIndexes]);

  const onActiveCellChange = useCallback(
    (rowIndex: number) => {
      const index = actualIndex(rowIndex);
      if (index >= 0) onRowSelect?.(index);
    },
    [actualIndex, onRowSelect]
  );

  return (
    <div data-testid="shot-table-container" className="flex flex-col gap-2">
      {showAddButton && !readOnly && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onAddShot}
            className="text-accent text-sm"
            data-testid="add-shot-button"
          >
            {t('shotTable.add')}
          </button>
        </div>
      )}
      <div className="overflow-hidden rounded border border-border" data-testid="shot-table">
        <SpreadsheetGrid<EditableShot>
          columns={columns}
          rows={visibleShots}
          rowKey={(s, i) => s.tempId ?? s.id ?? i}
          rowTestId={(_s, i) => `shot-row-${i}`}
          cellTestId={(_s, i, colKey) => `shot-cell-${i}-${colKey}`}
          testIdPrefix="shot-editor"
          locale={getNumberFormatLocale()}
          height={cssHeightToPx(maxHeight)}
          onEdit={onEdit}
          onBatchEdit={onBatchEdit}
          rowClassName={rowClassName}
          labels={gridLabels}
          showToolbar={false}
          selectedRow={selectedVisibleRow}
          onActiveCellChange={onActiveCellChange}
          {...(readOnly ? {} : { onInsertRows, onDeleteRows })}
        />
      </div>
    </div>
  );
}
