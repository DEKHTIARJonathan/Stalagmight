/**
 * Pure row helpers for the new-section dialog's shots grid.
 *
 * The dialog's model is a list of {@link ShotDraft}s - the same provisional-row
 * type the data table uses for its uncommitted "new shot" rows, reused wholesale
 * so `materializeDraft` / `draftMissing` / `completeDraftData` apply unchanged.
 * The difference is that here EVERY row is a draft: nothing is committed until
 * Create, so there are no real shots to anchor against and display order is
 * plain array order. Every row therefore carries `anchor: 'end'`, which also
 * buys the "a wholly blank row is an invitation, not an obligation" rule that
 * `draftMissing` already encodes for the end draft.
 *
 * Kept free of React/store imports so it unit-tests in the node vitest env,
 * matching `dataTableEdits.ts` / `dataTableDrafts.ts`.
 */
import type { ShotData } from '../../types/project';
import type { CellEdit } from '../common/SpreadsheetGrid/types';
import { AZIMUTH_AVG_KEY, PITCH_AVG_KEY, buildShotUpdates } from '../SingleSystemView/dataTableEdits';
import {
  type ShotDraft,
  endDraft,
  materializeDraft,
  completeDraftData,
} from '../SingleSystemView/dataTableDrafts';

/** Which azimuth column family is on screen, in the shape `draftMissing` wants. */
export type AzimuthMode = 'avg' | 'inout' | 'off';

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A row the user has not touched at all. Blank rows are dropped at submit and
 *  never reported as incomplete. */
export const isBlankRow = (draft: ShotDraft): boolean => Object.keys(draft.data).length === 0;

/** A fresh blank row. Keys come from a monotonic counter and are NEVER reused:
 *  the grid keys per-cell state (missing-cell marks) by row identity, so a
 *  recycled key would leak one row's red cells onto a later one. */
export const blankRow = (key: number): ShotDraft => endDraft(key);

/**
 * Structural invariants applied after every mutation: at least one row, and the
 * last row blank so there is always somewhere to type. Returns the input array
 * unchanged when both already hold, so it is setState-friendly.
 */
export function normalizeRows(rows: ShotDraft[], nextKey: () => number): ShotDraft[] {
  const last = rows[rows.length - 1];
  if (last !== undefined && isBlankRow(last)) return rows;
  return [...rows, blankRow(nextKey())];
}

/** Insert `count` blank rows before `beforeIndex` (the grid's insertion
 *  boundary). */
export function insertBlankRows(
  rows: ShotDraft[],
  beforeIndex: number,
  count: number,
  nextKey: () => number
): ShotDraft[] {
  if (count < 1) return rows;
  const at = Math.max(0, Math.min(beforeIndex, rows.length));
  const created = Array.from({ length: count }, () => blankRow(nextKey()));
  return normalizeRows([...rows.slice(0, at), ...created, ...rows.slice(at)], nextKey);
}

/** Delete the contiguous rows [fromRow..toRow]. Deleting everything leaves one
 *  fresh blank row rather than an empty grid. */
export function deleteRows(
  rows: ShotDraft[],
  fromRow: number,
  toRow: number,
  nextKey: () => number
): ShotDraft[] {
  const from = Math.max(0, Math.min(fromRow, toRow));
  const to = Math.min(rows.length - 1, Math.max(fromRow, toRow));
  if (from > to) return rows;
  const kept = [...rows.slice(0, from), ...rows.slice(to + 1)];
  return normalizeRows(kept.length === 0 ? [blankRow(nextKey())] : kept, nextKey);
}

/**
 * Move the contiguous block [fromStart..fromEnd] so it starts before `toIndex`,
 * where `toIndex` is an insertion boundary in the ORIGINAL indexing (the grid's
 * `onMoveRows` contract). The boundary is shifted back by however much of the
 * moved block sat in front of it.
 */
export function moveRows(
  rows: ShotDraft[],
  fromStart: number,
  fromEnd: number,
  toIndex: number
): ShotDraft[] {
  const from = Math.max(0, Math.min(fromStart, rows.length - 1));
  const to = Math.max(from, Math.min(fromEnd, rows.length - 1));
  const block = rows.slice(from, to + 1);
  if (block.length === 0) return rows;
  const rest = [...rows.slice(0, from), ...rows.slice(to + 1)];
  const removedBefore = toIndex > from ? Math.min(toIndex, to + 1) - from : 0;
  const at = Math.max(0, Math.min(toIndex - removedBefore, rest.length));
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}

/**
 * Apply one coerced cell value to a draft's data.
 *
 * `undefined` means "drop the field" - a required cell cleared back to missing,
 * reported by the grid through `onClearMissing`. Deleting rather than zeroing is
 * what keeps `completeDraftData` from resurrecting a value the user blanked.
 *
 * The virtual average columns fan out to both legs via `buildShotUpdates`, so
 * the delta-offset and cleared-Avg-clears-both rules have exactly one home. The
 * one case it cannot serve is an average azimuth typed into a row whose legs are
 * still unset: `materializeDraft` renders those as NaN, and `buildShotUpdates`
 * would rotate by a NaN delta. There the typed mean simply IS both legs. (The
 * pitch branch already handles its own unset case, because unset pitch
 * materializes as `null`, not NaN.)
 */
export function applyEditToData(
  data: Partial<ShotData>,
  colKey: string,
  value: unknown
): Partial<ShotData> {
  const d: Record<string, unknown> = { ...data };
  const put = (k: string, v: unknown) => {
    if (v === undefined) delete d[k];
    else d[k] = v;
  };

  if (colKey === AZIMUTH_AVG_KEY || colKey === PITCH_AVG_KEY) {
    const legs: [string, string] =
      colKey === AZIMUTH_AVG_KEY ? ['azimuth_in', 'azimuth_out'] : ['pitch_in', 'pitch_out'];
    if (value === undefined) {
      put(legs[0], undefined);
      put(legs[1], undefined);
      return d as Partial<ShotData>;
    }
    if (colKey === AZIMUTH_AVG_KEY && !(fin(data.azimuth_in) && fin(data.azimuth_out))) {
      put('azimuth_in', value);
      put('azimuth_out', value);
      return d as Partial<ShotData>;
    }
  } else if (value === undefined) {
    put(colKey, undefined);
    return d as Partial<ShotData>;
  }

  const patch = buildShotUpdates(materializeDraft({ key: 0, anchor: 'end', data }), [
    { colKey, value },
  ]);
  for (const [k, v] of Object.entries(patch)) put(k, v);
  return d as Partial<ShotData>;
}

/**
 * Apply a batch of grid edits, grouped so several cells on one row cost one
 * pass.
 *
 * Edits landing PAST the last row grow the list rather than being dropped: the
 * grid is given `pasteGrowsRows`, so pasting a block of shots out of a
 * spreadsheet into a dialog that starts with a single blank row lands in full
 * instead of clipping to that one row. {@link MAX_PASTE_ROWS} bounds what a
 * stray clipboard can conjure.
 */
export const MAX_PASTE_ROWS = 5000;

export function applyEdits(rows: ShotDraft[], edits: CellEdit[], nextKey: () => number): ShotDraft[] {
  const byRow = new Map<number, CellEdit[]>();
  let maxRow = -1;
  for (const e of edits) {
    if (e.row >= MAX_PASTE_ROWS) continue;
    if (e.row > maxRow) maxRow = e.row;
    const arr = byRow.get(e.row);
    if (arr) arr.push(e);
    else byRow.set(e.row, [e]);
  }
  if (byRow.size === 0) return rows;
  const grown =
    maxRow < rows.length
      ? rows
      : [...rows, ...Array.from({ length: maxRow + 1 - rows.length }, () => blankRow(nextKey()))];
  const next = grown.map((draft, i) => {
    const rowEdits = byRow.get(i);
    if (!rowEdits) return draft;
    let data = draft.data;
    for (const { colKey, value } of rowEdits) data = applyEditToData(data, colKey, value);
    return { ...draft, data };
  });
  return normalizeRows(next, nextKey);
}

/** Which azimuth family `draftMissing` should tint, derived from what is
 *  actually on screen rather than tracked as separate mode state. */
export function deriveAzimuthMode(hiddenColumns: ReadonlySet<string>): AzimuthMode {
  if (!hiddenColumns.has(AZIMUTH_AVG_KEY)) return 'avg';
  if (!hiddenColumns.has('azimuth_in') || !hiddenColumns.has('azimuth_out')) return 'inout';
  return 'off';
}

/** What Create would submit, and what is standing in its way. `incompleteRows`
 *  holds 1-based display row numbers, matching the grid's row gutter. */
export interface SubmitSummary {
  shots: ShotData[];
  incompleteRows: number[];
}

export function summarizeSubmit(rows: ShotDraft[]): SubmitSummary {
  const shots: ShotData[] = [];
  const incompleteRows: number[] = [];
  rows.forEach((draft, i) => {
    if (isBlankRow(draft)) return; // the trailing blank, and any blank inserted row
    const data = completeDraftData(draft);
    if (data) shots.push(data);
    else incompleteRows.push(i + 1);
  });
  return { shots, incompleteRows };
}

/** Create is available only once every touched row is complete and at least one
 *  shot would be written. */
export const canSubmit = (summary: SubmitSummary): boolean =>
  summary.incompleteRows.length === 0 && summary.shots.length > 0;
