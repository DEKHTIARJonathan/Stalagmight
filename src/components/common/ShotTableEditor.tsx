import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { nextShotKind } from '../../utils/shotKind';
import { SpreadsheetGrid } from './SpreadsheetGrid';
import { ExpandIcon, EyeIcon, ShrinkIcon } from './icons';
import { useDismissableLayer } from '../../hooks/useDismissableLayer';
import { useAnchoredFixedMenu } from '../../hooks/useAnchoredFixedMenu';
import { useEditSectionViewPersistence } from '../Dialogs/useEditSectionViewPersistence';
import type { CellEdit } from './SpreadsheetGrid/types';
import {
  buildEditableShotColumns,
  EDITABLE_AZIMUTH_AVG_KEY,
} from './editableShotColumns';
import type { EditableShot } from './editableShot';
import { missingRequiredCells } from './editableShotStatus';

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
  /** Maximum height for the table container (CSS value) */
  maxHeight?: string;
  /** Currently selected row index (into the FULL shots array) */
  selectedRowIndex?: number | null;
  /** Callback when a row is selected (index into the FULL shots array) */
  onRowSelect?: (index: number) => void;
  /** Set of shot indices whose geometry fields should be disabled (frozen shots) */
  frozenShotIndices?: Set<number>;
  /** Whether the host dialog is currently enlarged. Supply this together with
   *  {@link onToggleExpand} to get the Expand control; the HOST owns the size,
   *  because this editor is a child of three different dialogs and cannot
   *  resize any of them itself. */
  expanded?: boolean;
  onToggleExpand?: () => void;
}

const DEFAULT_VALIDATION_CONFIG: ValidationConfig = {
  azimuth_diff_threshold: defaultConfig.validation.azimuth_diff_threshold,
  pitch_diff_threshold: defaultConfig.validation.pitch_diff_threshold,
};

/** Fallback grid height before the first measurement, and under jsdom. */
const DEFAULT_GRID_HEIGHT = 260;
/** Never size the row area below this on a short window. */
const MIN_GRID_HEIGHT = 120;

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

/** The blank trailing row. Rendered, never stored: `onAddShot` turns it into a
 *  real shot the first time a value lands in it. */
const PHANTOM_ROW: EditableShot = {
  id: Number.NEGATIVE_INFINITY,
  azimuth_in: NaN,
  azimuth_out: NaN,
  length: NaN,
  depth_in: NaN,
  depth_out: NaN,
  pitch_in: null,
  pitch_out: null,
  left: null,
  right: null,
  up: null,
  down: null,
  comment: null,
  kind: 'Normal',
};

/** Nothing hidden by default: this grid edits a survey that already exists, so
 *  there is no "start simple" case the way there is for a brand-new section. */
const DEFAULT_EDIT_SECTION_HIDDEN_COLUMNS: readonly string[] = [];

export function ShotTableEditor({
  shots,
  onShotChange,
  onAddShot,
  onDeleteShot,
  onInsertBefore,
  onInsertAfter,
  validationConfig,
  readOnly = false,
  maxHeight,
  selectedRowIndex,
  onRowSelect,
  frozenShotIndices,
  expanded = false,
  onToggleExpand,
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

  /** The always-present empty row at the end. Typing in it is what adds a shot -
   *  the same affordance the data table and the new-section dialog use, instead
   *  of a separate Add button. It is a render-only phantom: it becomes real via
   *  `onAddShot` the moment a value lands in it. */
  const isPhantomAt = useCallback(
    (visibleIndex: number): boolean => visibleIndex === visibleShots.length,
    [visibleShots.length]
  );
  const gridRows = useMemo<EditableShot[]>(
    () => [...visibleShots, { ...PHANTOM_ROW }],
    [visibleShots]
  );

  const errorsAt = useCallback(
    (visibleIndex: number): string[] => {
      const shot = visibleShots[visibleIndex];
      if (!shot) return []; // the trailing blank is an invitation, not an error
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

  const onCycleKindAt = useCallback(
    (visibleIndex: number, direction: 1 | -1) => {
      if (readOnly) return;
      const index = actualIndex(visibleIndex);
      const shot = visibleShots[visibleIndex];
      if (index < 0 || !shot) return;
      onShotChange(index, 'kind', nextShotKind(shot.kind, direction));
    },
    [readOnly, actualIndex, visibleShots, onShotChange]
  );

  const onDeleteAt = useCallback(
    (visibleIndex: number) => {
      const index = actualIndex(visibleIndex);
      if (index >= 0) onDeleteShot(index);
    },
    [actualIndex, onDeleteShot]
  );

  // --- Column layout, persisted under the dialog's own `edit_section_*` keys --
  const [columnOrder, setColumnOrder] = useState<string[]>([]);
  const [hiddenColumns, setHiddenColumns] = useState<ReadonlySet<string>>(() => new Set());
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const viewSetters = useMemo(() => ({ setColumnOrder, setHiddenColumns, setColumnWidths }), []);
  useEditSectionViewPersistence(
    { columnOrder, hiddenColumns, columnWidths },
    viewSetters,
    DEFAULT_EDIT_SECTION_HIDDEN_COLUMNS
  );
  const hiddenColumnList = useMemo(() => [...hiddenColumns], [hiddenColumns]);

  const [colMenuOpen, setColMenuOpen] = useState(false);
  const colMenuWrapRef = useRef<HTMLDivElement | null>(null);
  const colMenuBtnRef = useRef<HTMLButtonElement | null>(null);
  const colMenuListRef = useRef<HTMLDivElement | null>(null);
  useDismissableLayer({
    open: colMenuOpen,
    onDismiss: () => setColMenuOpen(false),
    contains: [colMenuWrapRef],
  });
  const colMenuStyle = useAnchoredFixedMenu(colMenuOpen, colMenuBtnRef, colMenuListRef, {
    align: 'right',
    gap: 4,
    width: 224,
  });

  /** Show/hide a group of columns together (LRUD is one row, four keys). */
  const toggleCols = useCallback((keys: string[]) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      const allVisible = keys.every((k) => !next.has(k));
      for (const k of keys) {
        if (allVisible) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  }, []);

  const colCheckRow = (keys: string[], label: string, className = '') => (
    <label
      key={keys[0]}
      className={`flex cursor-pointer items-center gap-2 rounded px-2 py-0.5 hover:bg-accent-10 ${className}`}
    >
      <input
        type="checkbox"
        checked={keys.every((k) => !hiddenColumns.has(k))}
        onChange={() => toggleCols(keys)}
        data-testid={`shot-editor-col-vis-${keys[0]}`}
      />
      {label}
    </label>
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
        onCycleKindAt,
        isPhantomAt,
      }),
    [
      t,
      precision,
      readOnly,
      errorsAt,
      warningsAt,
      isFrozenAt,
      onDeleteAt,
      onCycleKindAt,
      isPhantomAt,
    ]
  );

  /** One coerced cell value -> the host's field callback(s), at a resolved
   *  full-array index. */
  const applyEditAt = useCallback(
    (index: number, colKey: string, value: unknown) => {
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
    [onShotChange]
  );

  /** Resolve a grid row to a full-array index, materializing the trailing blank
   *  on the way if that is where the edit landed. `onAddShot` appends, so the
   *  new shot's index is the pre-append length - both hosts update `shots`
   *  functionally, so the append and the edit apply in order within one tick. */
  const resolveRowForEdit = useCallback(
    (visibleRow: number): number => {
      if (!isPhantomAt(visibleRow)) return actualIndex(visibleRow);
      onAddShot();
      return shots.length;
    },
    [isPhantomAt, actualIndex, onAddShot, shots.length]
  );

  const onEdit = useCallback(
    (rowIndex: number, colKey: string, value: unknown) => {
      if (readOnly) return;
      const index = resolveRowForEdit(rowIndex);
      if (index >= 0) applyEditAt(index, colKey, value);
    },
    [readOnly, resolveRowForEdit, applyEditAt]
  );

  /**
   * A required cell cleared back to empty. The grid marks it missing and writes
   * NOTHING (it will never put a 0 in a survey), so without this the host's shot
   * keeps its old value and a row emptied by the user still looks filled - and
   * still blocks Save. Writing NaN is how "no measurement" is spelled here.
   */
  const onClearMissing = useCallback(
    (rowIndex: number, colKey: string) => {
      if (readOnly || isPhantomAt(rowIndex)) return;
      const index = actualIndex(rowIndex);
      if (index < 0) return;
      if (colKey === EDITABLE_AZIMUTH_AVG_KEY) {
        onShotChange(index, 'azimuth_in', NaN);
        onShotChange(index, 'azimuth_out', NaN);
        return;
      }
      onShotChange(index, colKey as keyof EditableShot, NaN);
    },
    [readOnly, isPhantomAt, actualIndex, onShotChange]
  );

  const onBatchEdit = useCallback(
    (edits: CellEdit[]) => {
      if (readOnly) return;
      // Group by row so the trailing blank is materialized ONCE however many of
      // its cells a paste fills.
      const byRow = new Map<number, CellEdit[]>();
      for (const e of edits) {
        const arr = byRow.get(e.row);
        if (arr) arr.push(e);
        else byRow.set(e.row, [e]);
      }
      for (const [row, rowEdits] of byRow) {
        const index = resolveRowForEdit(row);
        if (index < 0) continue;
        for (const e of rowEdits) applyEditAt(index, e.colKey, e.value);
      }
    },
    [readOnly, resolveRowForEdit, applyEditAt]
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
      for (let r = fromRow; r <= Math.min(toRow, visibleShots.length - 1); r++) {
        const i = actualIndex(r);
        if (i >= 0) indices.push(i);
      }
      for (const i of indices.sort((a, b) => b - a)) onDeleteShot(i);
    },
    [readOnly, actualIndex, onDeleteShot, visibleShots.length]
  );

  // Required-but-empty cells get the grid's red missing tint, so an incomplete
  // row points at the cells to fill rather than only naming the row.
  const cellClassName = useCallback(
    (shot: EditableShot, rowIndex: number, colKey: string): string | undefined => {
      if (isPhantomAt(rowIndex)) return undefined;
      return missingRequiredCells(shot, EDITABLE_AZIMUTH_AVG_KEY).has(colKey)
        ? 'sg-cell-missing'
        : undefined;
    },
    [isPhantomAt]
  );

  const rowClassName = useCallback(
    (shot: EditableShot, rowIndex: number): string | undefined => {
      // A virtual shot (jump/reference) is indicated by the J/R column, exactly
      // as in the data table and the new-section dialog. It is deliberately NOT
      // dimmed: the old table faded the whole row, which read as "disabled" on
      // a row that is perfectly editable.
      if (isPhantomAt(rowIndex)) return 'sg-row-draft';
      if (errorsAt(rowIndex).length > 0) return 'bg-error-5';
      // The data table's amber frozen tint, so a row whose geometry cells are
      // locked says WHY rather than just looking greyed out.
      if (isFrozenAt(rowIndex)) return 'sg-row-frozen';
      // Not-yet-saved rows borrow the grid's own uncommitted-row tint rather
      // than inventing a second one.
      if (shot.isNew) return 'sg-row-draft';
      return undefined;
    },
    [errorsAt, isPhantomAt, isFrozenAt]
  );

  // The host tracks selection in FULL-array indices; the grid works in visible
  // ones, so translate in both directions.
  const selectedVisibleRow = useMemo(() => {
    if (selectedRowIndex === null || selectedRowIndex === undefined) return null;
    const found = actualIndexes.indexOf(selectedRowIndex);
    return found === -1 ? null : found;
  }, [selectedRowIndex, actualIndexes]);

  // With an explicit `maxHeight` the host is dictating the size. Without one
  // (the expanded case) the box grows with the dialog, so it has to be measured
  // - virtualization needs a number, not an indefinite height. Guarded for
  // jsdom, which has no ResizeObserver, per the convention in ProfileChart/Dock.
  const gridBoxRef = useRef<HTMLDivElement | null>(null);
  const [measuredHeight, setMeasuredHeight] = useState(DEFAULT_GRID_HEIGHT);
  useEffect(() => {
    const el = gridBoxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const h = Math.max(MIN_GRID_HEIGHT, el.clientHeight);
      setMeasuredHeight((prev) => (Math.abs(prev - h) > 1 ? h : prev));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  const onActiveCellChange = useCallback(
    (rowIndex: number) => {
      const index = actualIndex(rowIndex);
      if (index >= 0) onRowSelect?.(index);
    },
    [actualIndex, onRowSelect]
  );

  return (
    <div data-testid="shot-table-container" className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex shrink-0 items-center justify-end gap-3">
        <div ref={colMenuWrapRef} className="relative" onMouseDown={(e) => e.stopPropagation()}>
          <button
            ref={colMenuBtnRef}
            type="button"
            onClick={() => setColMenuOpen((v) => !v)}
            className={colMenuOpen ? 'text-text' : 'text-text-secondary hover:text-text'}
            title={t('dataTable.columnsMenu.button')}
            data-testid="shot-editor-columns-menu"
          >
            <EyeIcon size={14} />
          </button>
          {colMenuOpen && (
            <div
              ref={colMenuListRef}
              className="overflow-auto rounded border border-border bg-panel p-1 text-xs shadow-lg"
              style={colMenuStyle}
              data-dropdown-open
              data-testid="shot-editor-columns-dropdown"
            >
              {colCheckRow(['length'], t('dataTable.columnsMenu.length'))}
              {colCheckRow([EDITABLE_AZIMUTH_AVG_KEY], t('dataTable.columnsMenu.azimuth'))}
              <div className="flex">
                {colCheckRow(['depth_in'], t('dataTable.columnsMenu.depthIn'), 'flex-1')}
                {colCheckRow(['depth_out'], t('dataTable.columnsMenu.depthOut'), 'flex-1')}
              </div>
              {colCheckRow(['left', 'right', 'up', 'down'], t('dataTable.columnsMenu.lrud'))}
              {colCheckRow(['kind'], t('dataTable.columnsMenu.reference'))}
              {colCheckRow(['comment'], t('dataTable.columnsMenu.comment'))}
            </div>
          )}
        </div>
        {onToggleExpand && (
          <button
            type="button"
            onClick={onToggleExpand}
            className="text-text-secondary hover:text-text"
            title={expanded ? t('newSection.collapse') : t('newSection.expand')}
            aria-label={expanded ? t('newSection.collapse') : t('newSection.expand')}
            data-testid="shot-editor-expand"
          >
            {expanded ? <ShrinkIcon size={14} /> : <ExpandIcon size={14} />}
          </button>
        )}
      </div>
      <div
        ref={gridBoxRef}
        className="min-h-0 flex-1 overflow-hidden rounded border border-border"
        data-testid="shot-table"
      >
        <SpreadsheetGrid<EditableShot>
          columns={columns}
          rows={readOnly ? visibleShots : gridRows}
          rowKey={(s, i) => s.tempId ?? s.id ?? i}
          rowTestId={(_s, i) => `shot-row-${i}`}
          cellTestId={(_s, i, colKey) => `shot-cell-${i}-${colKey}`}
          testIdPrefix="shot-editor"
          locale={getNumberFormatLocale()}
          height={maxHeight === undefined ? measuredHeight : cssHeightToPx(maxHeight)}
          onEdit={onEdit}
          onBatchEdit={onBatchEdit}
          onClearMissing={onClearMissing}
          rowClassName={rowClassName}
          cellClassName={cellClassName}
          labels={gridLabels}
          showToolbar={false}
          selectedRow={selectedVisibleRow}
          onActiveCellChange={onActiveCellChange}
          hiddenColumns={hiddenColumnList}
          columnOrder={columnOrder}
          onColumnOrderChange={setColumnOrder}
          onHiddenColumnsChange={(hidden) => setHiddenColumns(new Set(hidden))}
          columnWidths={columnWidths}
          onColumnWidthsChange={setColumnWidths}
          {...(readOnly ? {} : { onInsertRows, onDeleteRows })}
        />
      </div>
    </div>
  );
}
