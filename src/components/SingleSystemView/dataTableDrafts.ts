/**
 * Pure draft-row helpers for the data-table shots grid.
 *
 * The grid always shows one empty "new shot" row at the end (the end draft);
 * "Insert shot above/below" adds more drafts anchored before/after a real
 * shot. Drafts live entirely in DataTable state until their required fields
 * are present, then commit via create_shot with the anchor as the insertion
 * point. These helpers own the anchor bookkeeping: interleaving drafts with
 * the section's shots into the grid's row list, mapping a grid insertion
 * boundary to an anchor, completeness, and the missing-field marking.
 *
 * Kept free of React/store imports so it is unit-testable in the node vitest env.
 */
import type { Shot, ShotData } from '../../types/project';
import { AZIMUTH_AVG_KEY } from './dataTableEdits';

/** Where a draft sits relative to the real shots. `'end'` is the always-present
 *  trailing draft; the id anchors pin an inserted draft to a neighbour shot
 *  (surviving unrelated inserts/deletes - a deleted anchor prunes the draft). */
export type DraftAnchor = { afterShotId: number } | { beforeShotId: number } | 'end';

export interface ShotDraft {
  /** Negative, unique per draft - doubles as the grid row id (real shot ids
   *  are positive). The end draft is always {@link END_DRAFT_KEY}. */
  key: number;
  anchor: DraftAnchor;
  data: Partial<ShotData>;
}

/** One grid row: a real shot (with its index into the shots array) or a draft. */
export type RowEntry =
  | { kind: 'shot'; shot: Shot; shotIndex: number }
  | { kind: 'draft'; draft: ShotDraft };

/** Sentinel key of the always-present end-of-table draft. */
export const END_DRAFT_KEY = -1;

/** A fresh, empty end draft. Callers allocate keys from a monotonic counter so
 *  a key is NEVER reused - grid-internal per-cell state (missing-cell marks)
 *  is keyed by row identity and must not leak onto a later draft. */
export const endDraft = (key: number = END_DRAFT_KEY): ShotDraft => ({ key, anchor: 'end', data: {} });

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Build the grid's row list: each draft adjacent to its anchor shot (after-
 *  anchored drafts right below it, before-anchored right above, same-anchor
 *  drafts in array order), `'end'` drafts last. Drafts whose anchor shot no
 *  longer exists are pruned (not emitted). */
export function interleaveRows(shots: Shot[], drafts: ShotDraft[]): RowEntry[] {
  const before = new Map<number, ShotDraft[]>();
  const after = new Map<number, ShotDraft[]>();
  const end: ShotDraft[] = [];
  const ids = new Set(shots.map((s) => s.id));
  const push = (map: Map<number, ShotDraft[]>, id: number, d: ShotDraft) => {
    const arr = map.get(id);
    if (arr) arr.push(d);
    else map.set(id, [d]);
  };
  for (const d of drafts) {
    if (d.anchor === 'end') end.push(d);
    else if ('afterShotId' in d.anchor) {
      if (ids.has(d.anchor.afterShotId)) push(after, d.anchor.afterShotId, d);
    } else if (ids.has(d.anchor.beforeShotId)) {
      push(before, d.anchor.beforeShotId, d);
    }
  }
  const entries: RowEntry[] = [];
  shots.forEach((shot, shotIndex) => {
    for (const draft of before.get(shot.id) ?? []) entries.push({ kind: 'draft', draft });
    entries.push({ kind: 'shot', shot, shotIndex });
    for (const draft of after.get(shot.id) ?? []) entries.push({ kind: 'draft', draft });
  });
  for (const draft of end) entries.push({ kind: 'draft', draft });
  return entries;
}

/** Drop drafts whose anchor shot was deleted (`'end'` drafts always survive).
 *  Returns the input array when nothing changed, so it is setState-friendly. */
export function pruneDrafts(drafts: ShotDraft[], shots: Shot[]): ShotDraft[] {
  const ids = new Set(shots.map((s) => s.id));
  const kept = drafts.filter(
    (d) =>
      d.anchor === 'end' ||
      ids.has('afterShotId' in d.anchor ? d.anchor.afterShotId : d.anchor.beforeShotId),
  );
  return kept.length === drafts.length ? drafts : kept;
}

/** Insert `count` blank drafts at a grid insertion boundary (an index into
 *  {@link interleaveRows}' entries, as the grid's onInsertRows reports it).
 *  The new drafts anchor to the boundary's neighbour: after the shot above,
 *  before the first shot at the very top, and between same-anchor drafts they
 *  keep the clicked position. Returns the new drafts array, or `null` when
 *  there is nothing to anchor to (no shots yet - the end draft IS the insert
 *  affordance there). */
export function insertDraftsAt(
  shots: Shot[],
  drafts: ShotDraft[],
  beforeIndex: number,
  count: number,
  nextKey: () => number,
): ShotDraft[] | null {
  const firstShot = shots[0];
  const lastShot = shots[shots.length - 1];
  if (firstShot === undefined || lastShot === undefined || count < 1) return null;
  const entries = interleaveRows(shots, drafts);
  const boundary = Math.max(0, Math.min(beforeIndex, entries.length));
  const prev = entries[boundary - 1];
  const next = entries[boundary];
  let anchor: DraftAnchor;
  if (prev === undefined) {
    // Top boundary: join a draft already sitting above the first shot, else
    // anchor before the first shot itself.
    anchor =
      next !== undefined && next.kind === 'draft' && next.draft.anchor !== 'end'
        ? next.draft.anchor
        : { beforeShotId: firstShot.id };
  } else if (prev.kind === 'shot') {
    anchor = { afterShotId: prev.shot.id };
  } else if (prev.draft.anchor === 'end') {
    // Below the end draft - there is no further row, so after the last shot.
    anchor = { afterShotId: lastShot.id };
  } else {
    anchor = prev.draft.anchor;
  }
  const created: RowEntry[] = Array.from({ length: count }, () => ({
    kind: 'draft' as const,
    draft: { key: nextKey(), anchor, data: {} },
  }));
  // Splice into the display order and read the drafts back out: same-anchor
  // groups keep array order through interleaveRows, so the new drafts land
  // exactly at the clicked boundary.
  const spliced = [...entries.slice(0, boundary), ...created, ...entries.slice(boundary)];
  return spliced.flatMap((e) => (e.kind === 'draft' ? [e.draft] : []));
}

/** Shot-shaped grid row for a draft: `id` is the (negative) draft key; unset
 *  required numbers render as NaN (the grid formats non-finite as blank). */
export function materializeDraft(draft: ShotDraft): Shot {
  const d = draft.data;
  return {
    id: draft.key,
    azimuth_in: (d.azimuth_in ?? NaN) as number,
    azimuth_out: (d.azimuth_out ?? NaN) as number,
    length: (d.length ?? NaN) as number,
    depth_in: (d.depth_in ?? NaN) as number,
    depth_out: (d.depth_out ?? NaN) as number,
    pitch_in: d.pitch_in ?? null,
    pitch_out: d.pitch_out ?? null,
    left: d.left ?? null,
    right: d.right ?? null,
    up: d.up ?? null,
    down: d.down ?? null,
    comment: d.comment ?? null,
    kind: d.kind ?? 'Normal',
    marker_index: null,
    temperature: null,
  };
}

/** The draft's still-missing required fields, split into visible columns (tint
 *  the cell red) and hidden ones (tint the columns button / menu row instead).
 *  Inserted drafts surface them immediately - the user asked for a row there,
 *  so it is incomplete by construction. The end draft is an invitation, not an
 *  obligation: it stays quiet until it holds ANY value. */
export function draftMissing(
  draft: ShotDraft,
  hiddenCols: ReadonlySet<string>,
  azimuthMode: 'avg' | 'inout' | 'off',
): { cells: Set<string>; hiddenProblems: Set<string> } {
  const cells = new Set<string>();
  const hiddenProblems = new Set<string>();
  const d = draft.data;
  if (draft.anchor === 'end' && Object.keys(d).length === 0) return { cells, hiddenProblems };
  const need = (colKey: string, menuKey: string) => {
    if (hiddenCols.has(colKey)) hiddenProblems.add(menuKey);
    else cells.add(colKey);
  };
  if (!fin(d.length)) need('length', 'length');
  if (!fin(d.depth_in)) need('depth_in', 'depthIn');
  if (!fin(d.depth_out)) need('depth_out', 'depthOut');
  if (!fin(d.azimuth_in) && !fin(d.azimuth_out)) {
    if (azimuthMode === 'avg') cells.add(AZIMUTH_AVG_KEY);
    else if (azimuthMode === 'inout') {
      cells.add('azimuth_in');
      cells.add('azimuth_out');
    } else {
      hiddenProblems.add('azimuth');
    }
  }
  return { cells, hiddenProblems };
}

/** The full ShotData to commit, or `null` while required fields are missing
 *  (length > 0, both depths, at least one azimuth - the missing azimuth leg
 *  duplicates the other; inclination/LRUD/comment stay optional). */
export function completeDraftData(draft: ShotDraft): ShotData | null {
  const d = draft.data;
  const azimuth = fin(d.azimuth_in) ? d.azimuth_in : d.azimuth_out;
  if (!(fin(d.length) && d.length > 0 && fin(d.depth_in) && fin(d.depth_out) && fin(azimuth))) {
    return null;
  }
  return {
    azimuth_in: fin(d.azimuth_in) ? d.azimuth_in : azimuth,
    azimuth_out: fin(d.azimuth_out) ? d.azimuth_out : azimuth,
    length: d.length,
    depth_in: d.depth_in,
    depth_out: d.depth_out,
    pitch_in: d.pitch_in ?? null,
    pitch_out: d.pitch_out ?? null,
    left: d.left ?? null,
    right: d.right ?? null,
    up: d.up ?? null,
    down: d.down ?? null,
    comment: d.comment ?? null,
    kind: d.kind ?? 'Normal',
    marker_index: null,
    temperature: null,
  };
}

/** create_shot insertion args for a draft: its anchor, with `'end'` resolved
 *  to "after the current last shot" at commit time (append when none). */
export function commitAnchorArgs(
  draft: ShotDraft,
  shots: Shot[],
): { afterShotId?: number; beforeShotId?: number } {
  if (draft.anchor === 'end') {
    const last = shots[shots.length - 1];
    return last ? { afterShotId: last.id } : {};
  }
  return 'afterShotId' in draft.anchor
    ? { afterShotId: draft.anchor.afterShotId }
    : { beforeShotId: draft.anchor.beforeShotId };
}
