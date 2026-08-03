import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore, type PlacementResult } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import type { Shot, SectionData } from '../../types/project';
import { SpreadsheetGrid } from '../common/SpreadsheetGrid';
import type { CellEdit } from '../common/SpreadsheetGrid/types';
import {
  type ShotDraft,
  materializeDraft,
  draftMissing,
} from '../SingleSystemView/dataTableDrafts';
import {
  applyEdits,
  blankRow,
  canSubmit,
  deleteRows,
  deriveAzimuthMode,
  insertBlankRows,
  moveRows,
  summarizeSubmit,
} from './newSectionRows';
import {
  buildNewSectionShotColumns,
  DEFAULT_NEW_SECTION_HIDDEN_COLUMNS,
} from './newSectionShotColumns';
import { useNewSectionViewPersistence } from './useNewSectionViewPersistence';
import { getNextSectionColor } from '../../utils/colors';
import { useDecimalPrecision } from '../../hooks/useDecimalPrecision';
import { useEditingBlocked } from '../../hooks/useEditingBlocked';
import { useGridLabels } from '../../hooks/useGridLabels';
import { getNumberFormatLocale } from '../../i18n/format';
import { nextShotKind } from '../../utils/shotKind';
import { trackDialogComplete } from '../../utils/telemetry';

/** Grid height to assume before the first measurement, and under jsdom (which
 *  has no ResizeObserver). Tall enough that virtualization renders rows. */
const FALLBACK_GRID_HEIGHT = 360;
/** Never size the row area below this, so the grid stays usable on a short
 *  window rather than collapsing to the header. */
const ROW_AREA_MIN = 120;

interface SavedFormState {
  name: string;
  surveyor: string;
  date: string;
  color: string;
  /** The full grid contents, including partially-filled rows, so a cancelled
   *  placement restores exactly what was on screen. */
  drafts: ShotDraft[];
  /** Continues the monotonic key counter, so restored rows can never collide
   *  with rows added afterwards. */
  nextKey: number;
}

export default function ImportDialog() {
  const { t } = useTranslation();
  const { closeDialog, openDialog, startPlacementMode, dialogData, resolvedTheme } = useUIStore();
  const { createSection, createSectionAndMerge, moveSection, project } = useProjectStore();
  const precision = useDecimalPrecision();
  const editingBlocked = useEditingBlocked();
  const gridLabels = useGridLabels('dataTable.shotNoun');
  const numberLocale = getNumberFormatLocale();

  // Restore form state when reopening after placement cancel
  const saved = dialogData as { savedFormState?: SavedFormState } | undefined;
  const restored = saved?.savedFormState;

  // Form state
  const [name, setName] = useState<string>(restored?.name ?? '');
  const [surveyor, setSurveyor] = useState<string>(restored?.surveyor ?? '');
  const [date, setDate] = useState<string>(restored?.date ?? '');

  // Row keys are handed out from a monotonic counter and NEVER reused: the grid
  // keys per-cell state (missing-cell marks) by row identity, so a recycled key
  // would leak one row's red cells onto a later one.
  const keyCounterRef = useRef<number>(restored?.nextKey ?? 0);
  const nextKey = useCallback(() => keyCounterRef.current++, []);
  const [drafts, setDrafts] = useState<ShotDraft[]>(
    () => restored?.drafts ?? [blankRow(keyCounterRef.current++)]
  );

  // Get next available color
  const usedColors = project?.sections.map((s) => s.color) ?? [];
  const [color, setColor] = useState<string>(
    restored?.color ?? getNextSectionColor(usedColors, resolvedTheme)
  );

  // --- Grid layout (persisted under its own config keys) --------------------
  const [columnOrder, setColumnOrder] = useState<string[]>([]);
  const [hiddenColumns, setHiddenColumns] = useState<ReadonlySet<string>>(
    () => new Set(DEFAULT_NEW_SECTION_HIDDEN_COLUMNS)
  );
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const viewSetters = useMemo(
    () => ({ setColumnOrder, setHiddenColumns, setColumnWidths }),
    []
  );
  useNewSectionViewPersistence({ columnOrder, hiddenColumns, columnWidths }, viewSetters);
  const hiddenColumnList = useMemo(() => [...hiddenColumns], [hiddenColumns]);

  // --- Grid height ----------------------------------------------------------
  // Virtualization needs an explicit pixel height, and the fullscreen dialog
  // sizes itself to the window, so the row area has to be measured. The grid's
  // own toolbar sits inside the same box, so subtract its live height rather
  // than a constant (it wraps on a narrow window).
  const gridBoxRef = useRef<HTMLDivElement | null>(null);
  const [gridHeight, setGridHeight] = useState(FALLBACK_GRID_HEIGHT);
  useEffect(() => {
    const el = gridBoxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const toolbar = el.querySelector('.sg-toolbar');
      const chrome = toolbar instanceof HTMLElement ? toolbar.offsetHeight : 0;
      const h = Math.max(ROW_AREA_MIN, el.clientHeight - chrome);
      setGridHeight((prev) => (Math.abs(prev - h) > 1 ? h : prev));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  // --- Rows -----------------------------------------------------------------
  const rows = useMemo<Shot[]>(() => drafts.map(materializeDraft), [drafts]);

  const onCycleShotKind = useCallback(
    (shot: Shot, direction: 1 | -1) => {
      if (editingBlocked) return;
      setDrafts((prev) =>
        prev.map((d) =>
          d.key === shot.id ? { ...d, data: { ...d.data, kind: nextShotKind(shot.kind, direction) } } : d
        )
      );
    },
    [editingBlocked]
  );

  const columns = useMemo(
    () =>
      buildNewSectionShotColumns({
        t,
        precision,
        readOnly: editingBlocked,
        onCycleShotKind,
      }),
    [t, precision, editingBlocked, onCycleShotKind]
  );

  const onEdit = useCallback(
    (rowIndex: number, colKey: string, value: unknown) => {
      if (editingBlocked) return;
      setDrafts((prev) => applyEdits(prev, [{ row: rowIndex, colKey, value }], nextKey));
    },
    [editingBlocked, nextKey]
  );

  const onBatchEdit = useCallback(
    (edits: CellEdit[]) => {
      if (editingBlocked) return;
      setDrafts((prev) => applyEdits(prev, edits, nextKey));
    },
    [editingBlocked, nextKey]
  );

  // A required cell cleared back to "missing": drop the field so it reads as
  // absent to draftMissing/completeDraftData rather than keeping a stale value.
  const onClearMissing = useCallback(
    (rowIndex: number, colKey: string) => {
      if (editingBlocked) return;
      setDrafts((prev) => applyEdits(prev, [{ row: rowIndex, colKey, value: undefined }], nextKey));
    },
    [editingBlocked, nextKey]
  );

  const onInsertRows = useCallback(
    (beforeIndex: number, count: number) => {
      if (editingBlocked) return;
      setDrafts((prev) => insertBlankRows(prev, beforeIndex, count, nextKey));
    },
    [editingBlocked, nextKey]
  );

  const onDeleteRows = useCallback(
    (fromRow: number, toRow: number) => {
      if (editingBlocked) return;
      setDrafts((prev) => deleteRows(prev, fromRow, toRow, nextKey));
    },
    [editingBlocked, nextKey]
  );

  const onMoveRows = useCallback(
    (fromStart: number, fromEnd: number, toIndex: number) => {
      if (editingBlocked) return;
      setDrafts((prev) => moveRows(prev, fromStart, fromEnd, toIndex));
    },
    [editingBlocked]
  );

  // --- Missing-cell marking and the Create gate -----------------------------
  const azimuthMode = useMemo(() => deriveAzimuthMode(hiddenColumns), [hiddenColumns]);
  const missingByRow = useMemo(
    () => drafts.map((d) => draftMissing(d, hiddenColumns, azimuthMode)),
    [drafts, hiddenColumns, azimuthMode]
  );
  const cellClassName = useCallback(
    (_row: Shot, rowIndex: number, colKey: string) =>
      missingByRow[rowIndex]?.cells.has(colKey) ? 'sg-cell-missing' : undefined,
    [missingByRow]
  );

  const submit = useMemo(() => summarizeSubmit(drafts), [drafts]);
  const submitAllowed = canSubmit(submit) && !editingBlocked;

  const handleSubmit = () => {
    if (!submitAllowed) return;
    const sectionData: SectionData = {
      name: name || null,
      surveyor: surveyor || null,
      date: date || null,
      color,
      direction: null,
      quality: 1.0,
      shots: submit.shots,
    };

    // Save form state so we can restore on cancel
    const formState: SavedFormState = {
      name,
      surveyor,
      date,
      color,
      drafts,
      nextKey: keyCounterRef.current,
    };

    // Close dialog and enter placement mode
    trackDialogComplete('import');
    closeDialog();
    startPlacementMode(
      sectionData,
      0, // align station 0 to cursor
      // onComplete: create section, merge if snapped or move to position
      async (result: PlacementResult) => {
        if (result.snappedToStation) {
          await createSectionAndMerge(sectionData, 0, result.snappedToStation, 'Move');
        } else {
          const cmdResult = await createSection(sectionData);
          if (cmdResult.success && cmdResult.section_id != null) {
            await moveSection(cmdResult.section_id, result.position);
          }
        }
      },
      // onCancel: reopen dialog with saved form state
      () => {
        openDialog('import', { savedFormState: formState });
      },
    );
  };

  // Track if form has been modified. Any row carrying data counts, including an
  // incomplete one - discarding it still loses typing.
  const isDirty =
    name !== '' ||
    surveyor !== '' ||
    date !== '' ||
    drafts.some((d) => Object.keys(d.data).length > 0);

  return (
    <DialogWrapper
      title={t('newSection.title')}
      onClose={closeDialog}
      size="fullscreen"
      overflow="hidden"
      isDirty={isDirty}
      data-testid="import-section-dialog"
    >
      <div className="flex h-full flex-col gap-4">
        {/* Metadata */}
        <div className="grid shrink-0 grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              {t('newSection.labels.name')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full"
              placeholder={t('newSection.placeholders.name')}
              data-testid="section-name-input"
            />
          </div>
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              {t('newSection.labels.surveyor')}
            </label>
            <input
              type="text"
              value={surveyor}
              onChange={(e) => setSurveyor(e.target.value)}
              className="w-full"
              data-testid="import-section-surveyor-input"
            />
          </div>
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              {t('newSection.labels.date')}
            </label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full"
              data-testid="import-section-date-input"
            />
          </div>
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              {t('newSection.labels.color')}
            </label>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="w-full h-9"
              data-testid="import-section-color-input"
            />
          </div>
        </div>

        {/* Shots grid. The box is what gets measured, so the grid must be its
            only child - the toolbar the grid draws inside it is subtracted. */}
        <div
          ref={gridBoxRef}
          className="min-h-0 flex-1 overflow-hidden rounded border border-border"
          data-testid="import-section-grid"
        >
          <SpreadsheetGrid<Shot>
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            rowTestId={(_r, index) => `new-section-row-${index}`}
            cellTestId={(_r, index, colKey) => `new-section-cell-${index}-${colKey}`}
            locale={numberLocale}
            height={gridHeight}
            onEdit={onEdit}
            onBatchEdit={onBatchEdit}
            onClearMissing={onClearMissing}
            onMoveRows={onMoveRows}
            onDeleteRows={onDeleteRows}
            cellClassName={cellClassName}
            labels={gridLabels}
            toolbarTestIdPrefix="new-section"
            hiddenColumns={hiddenColumnList}
            columnOrder={columnOrder}
            onColumnOrderChange={setColumnOrder}
            onHiddenColumnsChange={(hidden) => setHiddenColumns(new Set(hidden))}
            columnWidths={columnWidths}
            onColumnWidthsChange={setColumnWidths}
            {...(editingBlocked ? {} : { onInsertRows })}
          />
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center justify-between gap-4 border-t border-border pt-4">
          <p className="text-sm text-error" data-testid="import-section-blocker">
            {submit.incompleteRows.length > 0
              ? t('newSection.incomplete', {
                  count: submit.incompleteRows.length,
                  rows: submit.incompleteRows.join(', '),
                })
              : submit.shots.length === 0
                ? t('newSection.empty')
                : ''}
          </p>
          <div className="flex gap-2">
            <Button onClick={closeDialog} data-testid="import-section-cancel">
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={handleSubmit}
              disabled={!submitAllowed}
              data-testid="import-section-create"
            >
              {t('newSection.create')}
            </Button>
          </div>
        </div>
      </div>
    </DialogWrapper>
  );
}
