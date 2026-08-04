/**
 * Keyboard support for `noInlineEdit` columns.
 *
 * Such a column's own {@link GridColumn.render} IS the control - a cycling badge,
 * a toggle - so the grid deliberately refuses to open a cell editor over it. But
 * every keyboard route into a cell (F2, Space, type-to-edit) went through that
 * editor, so the flag also removed the only ways to change the cell without a
 * mouse, in a grid where every other column stays keyboard-editable.
 *
 * These two resolvers give the flag a keyboard half: `activate` for the key that
 * stands in for a click, and the column's own `parse` for a typed character that
 * already means something (`j` -> Jump). They live here rather than inline so the
 * grid file stays under its size ratchet.
 */
import type { GridColumn } from './types';

/**
 * Run a click-only column's {@link GridColumn.activate}. Returns false when this
 * cell has none, so the caller falls back to whatever the key normally does -
 * F2 opens the editor, Space types a space.
 */
export function activateCellIn<Row>(
  col: GridColumn<Row> | undefined,
  row: Row | undefined,
  rowIdx: number,
  dir: 1 | -1,
  editable: boolean
): boolean {
  if (!col?.activate || row === undefined || !editable) return false;
  col.activate(row, rowIdx, dir);
  return true;
}

/**
 * A printable character typed at a click-only cell. There is no editor to seed,
 * but the column's parser still knows what the character means, so it commits
 * directly. `undefined` means the character was rejected and nothing happens -
 * never a silent write of a fallback value.
 */
export function directTypedValue<Row>(
  col: GridColumn<Row> | undefined,
  row: Row | undefined,
  key: string
): unknown {
  if (col?.noInlineEdit !== true || row === undefined) return undefined;
  return col.parse?.(key, row);
}
