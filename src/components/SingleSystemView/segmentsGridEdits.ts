/**
 * Pure edit reducer for the Plan-mode Segments grid (#403).
 *
 * The grid emits `{ row, colKey, value }` with values already coerced by each
 * column's parser; this turns a batch of those into the next `PlanSegment[]` for
 * `gasPlanStore.setSegments`. It is the SINGLE write path for the table - the
 * checkbox's own `onChange`, the grid's `activate`, and paste/fill/clear all
 * funnel through here - so the scooter/speed coupling below cannot be bypassed
 * by whichever gesture the diver happened to use.
 *
 * ⚠ Unit space: values arrive in DISPLAY units (m/min or ft/min), because the
 * grid seeds its editor from `getValue` and fill/internal-paste transfer that
 * raw result without re-parsing. The store is canonical SI, so this reducer is
 * the one place display -> canonical conversion (and clamping) happens.
 *
 * Kept free of React/store imports so it unit-tests in the node vitest env.
 */
import type { CellEdit } from '../common/SpreadsheetGrid/types';
import type { DpvRig, GasUnits, PlanSegment } from '../../types/ipc.generated';
import { speedFromDisplay } from '../../utils/formatGas';
import { clamp } from '../../utils/clamp';

/** Column keys of the Segments grid. `from`/`to` are read-only, so no edit ever
 *  names them; they are listed here because the column factory keys off the same
 *  constants and a typo would then silently produce an unreachable column. */
export const SEG_COL = {
  from: 'from',
  to: 'to',
  speed: 'speed',
  scooter: 'scooter',
} as const;

/**
 * Mirrors `MIN_SEGMENT_SPEED_M_PER_MIN` in `src-tauri/src/models/project/gas/scooter.rs`. Outside
 * `[MIN, MAX]`, `resolve_segments` silently discards the segment's own speed and falls back to the
 * plan speed - so a committed value outside this range would show one number in this table and
 * price a different one in the engine (and in the exported dive profile). Clamped here so the value
 * the row displays after commit is always the value the engine will actually use.
 *
 * `SegmentsTable.tsx` still declares its own copies while it is on the legacy
 * markup; those die with the component rewrite that follows this commit.
 */
export const MIN_SEGMENT_SPEED_M_PER_MIN = 0.1;
/** Mirrors `MAX_SEGMENT_SPEED_M_PER_MIN` in the same file. */
export const MAX_SEGMENT_SPEED_M_PER_MIN = 1000;

/** Clamp a CANONICAL speed (m/min) into the range the engine will actually fly. */
export function clampSegmentSpeed(mPerMin: number): number {
  return clamp(mPerMin, MIN_SEGMENT_SPEED_M_PER_MIN, MAX_SEGMENT_SPEED_M_PER_MIN);
}

/** Truthy tokens a typed/pasted boolean cell accepts (lowercased, trimmed). */
const TRUE_TOKENS = new Set(['1', 'true', 't', 'yes', 'y', 'on', 'x', '✓']);
/** Falsy tokens, same normalisation. */
const FALSE_TOKENS = new Set(['0', 'false', 'f', 'no', 'n', 'off']);

/**
 * Parse a raw cell string into a boolean, or `undefined` to SKIP the write.
 *
 * An EMPTY string returns `current`, deliberately: clearing a checkbox cell is a
 * no-op, so a stray Ctrl+A + Delete over the table cannot silently unequip a DPV
 * or switch off a tank - two edits whose only visible trace is a cheaper gas
 * number. Anything unrecognised is skipped rather than guessed.
 */
export function parseGridBoolean(raw: string, current: boolean): boolean | undefined {
  const token = raw.trim().toLowerCase();
  if (token === '') return current;
  if (TRUE_TOKENS.has(token)) return true;
  if (FALSE_TOKENS.has(token)) return false;
  return undefined;
}

/** Context the reducer needs from the live store: display units, and the rig
 *  whose primary speed a scooter tick auto-fills (null = no rig configured). */
export interface SegmentEditContext {
  units: GasUnits;
  dpv: DpvRig | null;
}

/** Coerce whatever a boolean-column edit carries into a boolean.
 *  `activate`/paste already deliver a boolean via the column's `parse`; a string
 *  can still arrive from a direct caller, so both are handled and everything
 *  else is skipped rather than coerced. */
function booleanValue(value: unknown, current: boolean): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return parseGridBoolean(value, current);
  return undefined;
}

function sameSegment(a: PlanSegment, b: PlanSegment): boolean {
  return a.speed_m_per_min === b.speed_m_per_min && a.on_scooter === b.on_scooter;
}

/** Apply one edit to one segment. Returns the segment unchanged (identity) when
 *  the edit is a skip or a no-op. */
function applyOne(seg: PlanSegment, edit: CellEdit, ctx: SegmentEditContext): PlanSegment {
  if (edit.colKey === SEG_COL.speed) {
    // `number-nullable`: a cleared cell returns the span to inheriting the plan
    // speed, which is what `speed_m_per_min: null` has meant since `defaultSegment`.
    if (edit.value === null) return { ...seg, speed_m_per_min: null };
    if (typeof edit.value !== 'number' || !Number.isFinite(edit.value)) return seg;
    return {
      ...seg,
      speed_m_per_min: clampSegmentSpeed(speedFromDisplay(edit.value, ctx.units)),
    };
  }
  if (edit.colKey === SEG_COL.scooter) {
    const next = booleanValue(edit.value, seg.on_scooter);
    if (next === undefined) return seg;
    // CHANGE GUARD: the speed coupling fires only when the flag actually moves.
    // A paste stamping `false` over an already-false cell must not wipe a speed
    // the same batch just wrote, and re-ticking an already-ticked span must not
    // re-auto-fill over a speed the diver typed afterwards.
    if (next === seg.on_scooter) return seg;
    // Unticking ALWAYS returns the span to inheriting: leaving the auto-filled
    // scooter pace behind would price a swum span at a scooter's speed, silently
    // overstating range and understating gas.
    if (!next) return { on_scooter: false, speed_m_per_min: null };
    // Ticking a span that has no speed of its own adopts the rig's primary speed:
    // the range model spends the rig's battery by METRES, so riding at swim pace
    // would understate the real drain. A span with an explicit speed keeps it.
    const speed =
      seg.speed_m_per_min == null && ctx.dpv
        ? ctx.dpv.primary.speed_m_per_min
        : seg.speed_m_per_min;
    return { ...seg, on_scooter: true, speed_m_per_min: speed };
  }
  return seg;
}

/**
 * Fold a batch of grid edits into the next segment list.
 *
 * Edits are applied IN ORDER against a single working copy, so a batch that
 * writes a speed and then ticks the scooter on the same row sees the new speed
 * (and therefore does not auto-fill over it).
 *
 * Returns the IDENTICAL input array when nothing changed, so the caller can skip
 * the store write - `setSegments` nulls the cached reach field, and a gratuitous
 * null there costs a full map recompute.
 */
export function applySegmentEdits(
  segments: PlanSegment[],
  edits: CellEdit[],
  ctx: SegmentEditContext
): PlanSegment[] {
  let next: PlanSegment[] | null = null;
  for (const edit of edits) {
    const current = next ?? segments;
    const seg = current[edit.row];
    if (seg === undefined) continue;
    const updated = applyOne(seg, edit, ctx);
    if (sameSegment(updated, seg)) continue;
    if (next === null) next = segments.slice();
    next[edit.row] = updated;
  }
  return next ?? segments;
}
