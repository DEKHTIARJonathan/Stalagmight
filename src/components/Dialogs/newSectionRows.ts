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
  isDraftComplete,
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
  toIndex: number,
  nextKey: () => number
): ShotDraft[] {
  const from = Math.max(0, Math.min(fromStart, rows.length - 1));
  const to = Math.max(from, Math.min(fromEnd, rows.length - 1));
  const block = rows.slice(from, to + 1);
  if (block.length === 0) return rows;
  const rest = [...rows.slice(0, from), ...rows.slice(to + 1)];
  const removedBefore = toIndex > from ? Math.min(toIndex, to + 1) - from : 0;
  const at = Math.max(0, Math.min(toIndex - removedBefore, rest.length));
  // Normalized like every other mutator: dragging the trailing blank row up
  // would otherwise leave the last row occupied, and with it nowhere to type
  // the next shot except the context menu.
  return normalizeRows([...rest.slice(0, at), ...block, ...rest.slice(at)], nextKey);
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

/** How many edits `applyEdits` refused because they would have grown the list
 *  past the cap, so the host can say so rather than dropping them in silence. */
export interface ApplyEditsResult {
  rows: ShotDraft[];
  droppedPastCap: number;
}

export function applyEdits(
  rows: ShotDraft[],
  edits: CellEdit[],
  nextKey: () => number
): ApplyEditsResult {
  const byRow = new Map<number, CellEdit[]>();
  let maxRow = -1;
  let droppedPastCap = 0;
  // The cap bounds GROWTH, never editing: a row that already exists is always
  // editable, however far down it is. Bounding by the raw index instead meant
  // that once the list legitimately passed the cap (two big pastes), typing
  // into those rows was discarded and the cell silently reverted.
  const limit = Math.max(rows.length, MAX_PASTE_ROWS);
  for (const e of edits) {
    if (e.row >= limit) {
      droppedPastCap++;
      continue;
    }
    if (e.row > maxRow) maxRow = e.row;
    const arr = byRow.get(e.row);
    if (arr) arr.push(e);
    else byRow.set(e.row, [e]);
  }
  if (byRow.size === 0) return { rows, droppedPastCap };
  const grown =
    maxRow < rows.length
      ? rows
      : [...rows, ...Array.from({ length: maxRow + 1 - rows.length }, () => blankRow(nextKey()))];
  const touched = new Set(byRow.keys());
  const next = grown.map((draft, i) => {
    const rowEdits = byRow.get(i);
    if (!rowEdits) return draft;
    // A row being typed into for the first time inherits Depth In from the row
    // above, the way the old dialog's "+ Add Row" seeded it - depth in IS the
    // previous shot's depth out on a continuous survey. Done on first touch
    // rather than at row creation so the trailing row stays genuinely blank
    // (a seeded value would make it count as touched and block Create), and
    // skipped when the edit supplies its own depth or the row above is itself
    // being written in the same batch (a paste already carries its depths).
    const wasBlank = isBlankRow(draft);
    let data = draft.data;
    for (const { colKey, value } of rowEdits) data = applyEditToData(data, colKey, value);
    if (wasBlank && data.depth_in === undefined && !touched.has(i - 1)) {
      const above = grown[i - 1]?.data.depth_out;
      if (typeof above === 'number' && Number.isFinite(above)) data = { ...data, depth_in: above };
    }
    return { ...draft, data };
  });
  return { rows: normalizeRows(next, nextKey), droppedPastCap };
}

/**
 * Which of an angle family's columns are on screen, in the three-way shape the
 * data table's column menu uses.
 *
 * Derived from the hidden set rather than tracked as separate mode state: the
 * dialog has exactly one source of truth for its layout, and that is what gets
 * persisted. `draftMissing` wants this for azimuth, and the column menu wants it
 * for both families.
 */
export function deriveAngleMode(
  hiddenColumns: ReadonlySet<string>,
  avgKey: string,
  legIn: string,
  legOut: string
): AzimuthMode {
  if (!hiddenColumns.has(avgKey)) return 'avg';
  if (!hiddenColumns.has(legIn) || !hiddenColumns.has(legOut)) return 'inout';
  return 'off';
}

export function deriveAzimuthMode(hiddenColumns: ReadonlySet<string>): AzimuthMode {
  return deriveAngleMode(hiddenColumns, AZIMUTH_AVG_KEY, 'azimuth_in', 'azimuth_out');
}

/** The column keys each angle family shows per mode. */
export const ANGLE_FAMILY_KEYS = {
  azimuth: { avg: [AZIMUTH_AVG_KEY], inout: ['azimuth_in', 'azimuth_out'], off: [] },
  inclination: { avg: [PITCH_AVG_KEY], inout: ['pitch_in', 'pitch_out'], off: [] },
} as const satisfies Record<string, Record<AzimuthMode, readonly string[]>>;

/**
 * The column order with an angle family's incoming columns dropped into the SLOT
 * its outgoing ones held.
 *
 * Without this, switching Avg -> In+Out does not move a column so much as reveal
 * two that were hidden wherever they happened to sit in the order - so the legs
 * appear at the far end of the table instead of where the average just was, and
 * switching back leaves the average somewhere else again. The user's mental model
 * is one azimuth slot with three ways to show it, so the slot has to be the thing
 * that persists.
 *
 * `allKeys` is every column the grid has, needed because an order that has never
 * been customized is stored empty (meaning "declaration order").
 */
export function reorderForAngleMode(
  order: readonly string[],
  allKeys: readonly string[],
  prevKeys: readonly string[],
  nextKeys: readonly string[]
): string[] {
  const base = order.length > 0 ? [...order] : [...allKeys];
  for (const key of allKeys) if (!base.includes(key)) base.push(key);
  const without = base.filter((k) => !nextKeys.includes(k));
  const anchor = prevKeys.length > 0 ? without.indexOf(prevKeys[0]!) : -1;
  without.splice(anchor < 0 ? without.length : anchor, 0, ...nextKeys);
  return without;
}

/**
 * The hidden set forced into agreement with the mode it reports: an angle family
 * shows its average OR its two legs, never both.
 *
 * A stored set can say "both", because the columns a grid has can change under a
 * preference that was saved before they existed - which is exactly what happened
 * when the legs and the inclination family were added to the shot editor. Every
 * config written until then listed neither, so nothing hid them and the editor
 * opened showing Az, Az In and Az Out at once. Toggling the menu fixed it only
 * because that writes a mode back.
 *
 * Idempotent, so a set that is already consistent passes through untouched. Run
 * it on the way to the grid rather than on the stored value: the stored one is
 * the user's, and a repair that writes is a save they did not ask for.
 */
export function normalizeAngleFamilies(hiddenColumns: ReadonlySet<string>): Set<string> {
  let next = applyAngleMode(
    hiddenColumns,
    deriveAngleMode(hiddenColumns, AZIMUTH_AVG_KEY, 'azimuth_in', 'azimuth_out'),
    AZIMUTH_AVG_KEY,
    'azimuth_in',
    'azimuth_out'
  );
  next = applyAngleMode(
    next,
    deriveAngleMode(next, PITCH_AVG_KEY, 'pitch_in', 'pitch_out'),
    PITCH_AVG_KEY,
    'pitch_in',
    'pitch_out'
  );
  return next;
}

/** The hidden set after switching an angle family to `mode` - the inverse of
 *  {@link deriveAngleMode}, so the menu's three-way control writes back into the
 *  same single source of truth it reads from. */
export function applyAngleMode(
  hiddenColumns: ReadonlySet<string>,
  mode: AzimuthMode,
  avgKey: string,
  legIn: string,
  legOut: string
): Set<string> {
  const next = new Set(hiddenColumns);
  const show = (k: string) => next.delete(k);
  const hide = (k: string) => next.add(k);
  if (mode === 'avg') {
    show(avgKey);
    hide(legIn);
    hide(legOut);
  } else if (mode === 'inout') {
    hide(avgKey);
    show(legIn);
    show(legOut);
  } else {
    hide(avgKey);
    hide(legIn);
    hide(legOut);
  }
  return next;
}

/**
 * What is standing between the rows and a Create, without building anything.
 *
 * `incompleteRows` holds 1-based display row numbers, matching the grid's row
 * gutter. Deliberately does NOT return the ShotData: this runs for every row on
 * every keystroke to decide whether Create is available, and materializing a
 * 15-field shot per complete row only to discard it is pure waste on a grid that
 * can hold thousands of pasted rows. {@link collectShots} builds them once, when
 * the user actually presses Create.
 */
export interface SubmitSummary {
  /** 1-based row numbers that hold data but are missing a required field. */
  incompleteRows: number[];
  /** How many rows would be written. */
  completeCount: number;
}

export function summarizeSubmit(rows: ShotDraft[]): SubmitSummary {
  const incompleteRows: number[] = [];
  let completeCount = 0;
  rows.forEach((draft, i) => {
    if (isBlankRow(draft)) return; // the trailing blank, and any blank inserted row
    if (isDraftComplete(draft)) completeCount++;
    else incompleteRows.push(i + 1);
  });
  return { incompleteRows, completeCount };
}

/** The payload for Create. Blank rows are dropped; callers gate on
 *  {@link canSubmit} first, so an incomplete row cannot reach here. */
export function collectShots(rows: ShotDraft[]): ShotData[] {
  const shots: ShotData[] = [];
  for (const draft of rows) {
    if (isBlankRow(draft)) continue;
    const data = completeDraftData(draft);
    if (data) shots.push(data);
  }
  return shots;
}

/** Create is available only once every touched row is complete and at least one
 *  shot would be written. */
export const canSubmit = (summary: SubmitSummary): boolean =>
  summary.incompleteRows.length === 0 && summary.completeCount > 0;
