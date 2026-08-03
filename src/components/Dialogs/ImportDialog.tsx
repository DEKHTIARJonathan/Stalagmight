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
  collectShots,
  deleteRows,
  deriveAzimuthMode,
  insertBlankRows,
  moveRows,
  summarizeSubmit,
} from './newSectionRows';
import {
  buildNewSectionShotColumns,
  DEFAULT_NEW_SECTION_HIDDEN_COLUMNS,
  MISSING_PROBLEM_COLUMNS,
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
  const { closeDialog, openDialog, startPlacementMode, dialogData, resolvedTheme, showToast } =
    useUIStore();
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
  useNewSectionViewPersistence(
    { columnOrder, hiddenColumns, columnWidths },
    viewSetters,
    DEFAULT_NEW_SECTION_HIDDEN_COLUMNS
  );
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

  // One funnel for every edit path, so the row cap has a single place to report
  // from: `applyEdits` refuses edits that would grow the list past MAX_PASTE_ROWS
  // and says how many, which would otherwise vanish without a word.
  // Deliberately reads `drafts` rather than using the functional setState form:
  // the toast is a side effect, and a state updater can be invoked more than
  // once (StrictMode), which would double it. The grid emits at most one edit
  // call per interaction, so there is no batching hazard in reading state here.
  const applyGridEdits = useCallback(
    (edits: CellEdit[]) => {
      if (editingBlocked) return;
      const { rows: next, droppedPastCap } = applyEdits(drafts, edits, nextKey);
      setDrafts(next);
      if (droppedPastCap > 0) {
        showToast(
          t('newSection.pasteCapped', { count: droppedPastCap }),
          'new-section-paste-cap',
          'error'
        );
      }
    },
    [editingBlocked, drafts, nextKey, showToast, t]
  );

  const onEdit = useCallback(
    (rowIndex: number, colKey: string, value: unknown) =>
      applyGridEdits([{ row: rowIndex, colKey, value }]),
    [applyGridEdits]
  );

  const onBatchEdit = applyGridEdits;

  // A required cell cleared back to "missing": drop the field so it reads as
  // absent to draftMissing/completeDraftData rather than keeping a stale value.
  const onClearMissing = useCallback(
    (rowIndex: number, colKey: string) =>
      applyGridEdits([{ row: rowIndex, colKey, value: undefined }]),
    [applyGridEdits]
  );

  // What the grid could not fully apply (columns clipped past the last one,
  // cells rejected as read-only or out of range) - the same report the data
  // table surfaces, rather than a paste that silently lands short.
  const onPasteReport = useCallback(
    ({ written, clipped, skipped }: { written: number; clipped: number; skipped: number }) => {
      const parts: string[] = [];
      if (written > 0) parts.push(t('dataTable.pasteReport.written', { count: written }));
      if (clipped > 0) parts.push(t('dataTable.pasteReport.clipped', { count: clipped }));
      if (skipped > 0) parts.push(t('dataTable.pasteReport.skipped', { count: skipped }));
      if (parts.length > 0) showToast(parts.join(' \u00b7 '), 'new-section-paste');
    },
    [t, showToast]
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
      setDrafts((prev) => moveRows(prev, fromStart, fromEnd, toIndex, nextKey));
    },
    [editingBlocked, nextKey]
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

  // A required field whose column is hidden would block Create with nothing on
  // screen to point at: the blocker names the row, but the cell that would go
  // red is off-screen and there is no way to find it. `draftMissing` reports
  // those separately from the visible ones precisely so a host can act, so pull
  // the column back into view. This is a real unhide and persists like any
  // other - a temporary one would be undone by the layout restore on reopen,
  // putting the user straight back into the dead end.
  useEffect(() => {
    const reveal = new Set<string>();
    for (const { hiddenProblems } of missingByRow) {
      for (const problem of hiddenProblems) {
        for (const key of MISSING_PROBLEM_COLUMNS[problem] ?? []) {
          if (hiddenColumns.has(key)) reveal.add(key);
        }
      }
    }
    if (reveal.size === 0) return;
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      for (const key of reveal) next.delete(key);
      return next;
    });
  }, [missingByRow, hiddenColumns]);

  // One blank row for the grid to parse and validate pasted-in rows against,
  // before this host has created them. Only read, never written.
  const growRows = useMemo(
    () => ({ growRowTemplate: () => materializeDraft(blankRow(-1)) }),
    []
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
      shots: collectShots(drafts),
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
            locale={numberLocale}
            height={gridHeight}
            onEdit={onEdit}
            onBatchEdit={onBatchEdit}
            onClearMissing={onClearMissing}
            onPasteReport={onPasteReport}
            cellClassName={cellClassName}
            labels={gridLabels}
            testIdPrefix="new-section"
            hiddenColumns={hiddenColumnList}
            columnOrder={columnOrder}
            onColumnOrderChange={setColumnOrder}
            onHiddenColumnsChange={(hidden) => setHiddenColumns(new Set(hidden))}
            columnWidths={columnWidths}
            onColumnWidthsChange={setColumnWidths}
            // Every row here is provisional, so a paste may run past the last
            // one: applyEdits grows the list to fit rather than clipping a
            // spreadsheet block to the single blank row the dialog opens with.
            // The template is what those not-yet-created rows are parsed and
            // validated against, so a pasted block obeys the same column rules
            // wherever in it a given line happens to fall.
            //
            // All the row affordances are withheld together when editing is
            // blocked: offering a Delete entry or a gutter drag that silently
            // does nothing is worse than not offering it at all.
            {...(editingBlocked
              ? {}
              : { pasteGrowsRows: growRows, onInsertRows, onDeleteRows, onMoveRows })}
          />
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center justify-between gap-4 border-t border-border pt-4">
          <p className="text-sm text-error" data-testid="import-section-blocker">
            {editingBlocked
              ? t('newSection.readOnly')
              : submit.incompleteRows.length > 0
                ? t('newSection.incomplete', {
                    count: submit.incompleteRows.length,
                    rows: submit.incompleteRows.join(', '),
                  })
                : submit.completeCount === 0
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
