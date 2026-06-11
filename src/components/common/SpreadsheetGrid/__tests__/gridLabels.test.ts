import { describe, it, expect } from 'vitest';
import { DEFAULT_GRID_LABELS } from '../gridLabels';

// Drift guard: the defaults must stay byte-identical to the strings the grid
// hard-coded before the `labels` prop existed (hosts and e2e text assertions
// rely on the English chrome being unchanged when no labels are passed).
describe('DEFAULT_GRID_LABELS', () => {
  it('reproduces the legacy context-menu entries', () => {
    // Plain range → no shape suffix.
    expect(DEFAULT_GRID_LABELS.copy('')).toBe('Copy');
    expect(DEFAULT_GRID_LABELS.cut('')).toBe('Cut');
    expect(DEFAULT_GRID_LABELS.clear('')).toBe('Clear');
    expect(DEFAULT_GRID_LABELS.paste).toBe('Paste');
    expect(DEFAULT_GRID_LABELS.fillDown).toBe('Fill down');
  });

  it('reproduces the legacy full-row / full-column suffixed entries', () => {
    // The grid builds the suffix as ` ${rowsLabel}` / ` ${colsLabel}` where a
    // single row is the bare noun and multiples are "<n> <noun>".
    const rowsLabel = (n: number) =>
      n === 1 ? DEFAULT_GRID_LABELS.rowNoun(1) : `${n} ${DEFAULT_GRID_LABELS.rowNoun(n)}`;
    const colsLabel = (n: number) =>
      n === 1 ? DEFAULT_GRID_LABELS.columnNoun(1) : `${n} ${DEFAULT_GRID_LABELS.columnNoun(n)}`;
    expect(DEFAULT_GRID_LABELS.copy(` ${rowsLabel(1)}`)).toBe('Copy row');
    expect(DEFAULT_GRID_LABELS.copy(` ${rowsLabel(3)}`)).toBe('Copy 3 rows');
    expect(DEFAULT_GRID_LABELS.cut(` ${colsLabel(1)}`)).toBe('Cut column');
    expect(DEFAULT_GRID_LABELS.cut(` ${colsLabel(2)}`)).toBe('Cut 2 columns');
    expect(DEFAULT_GRID_LABELS.clear(` ${rowsLabel(2)}`)).toBe('Clear 2 rows');
  });

  it('reproduces the legacy insert/delete row entries', () => {
    expect(DEFAULT_GRID_LABELS.insertAbove('row')).toBe('Insert row above');
    expect(DEFAULT_GRID_LABELS.insertBelow('3 rows')).toBe('Insert 3 rows below');
    expect(DEFAULT_GRID_LABELS.deleteRows('2 rows')).toBe('Delete 2 rows');
  });

  it('reproduces the legacy row/column nouns', () => {
    expect(DEFAULT_GRID_LABELS.rowNoun(1)).toBe('row');
    expect(DEFAULT_GRID_LABELS.rowNoun(3)).toBe('rows');
    expect(DEFAULT_GRID_LABELS.columnNoun(1)).toBe('column');
    expect(DEFAULT_GRID_LABELS.columnNoun(2)).toBe('columns');
  });

  it('reproduces the legacy toolbar buttons', () => {
    expect(DEFAULT_GRID_LABELS.columnsButton).toBe('Columns');
    expect(DEFAULT_GRID_LABELS.maximize).toBe('Maximize');
    expect(DEFAULT_GRID_LABELS.restore).toBe('Restore');
  });

  it('reproduces the legacy editor aria-label', () => {
    expect(DEFAULT_GRID_LABELS.editCellAria('Len (m)', 3)).toBe('Edit Len (m) row 3');
  });

  it('reproduces the legacy shortcut hints', () => {
    expect(DEFAULT_GRID_LABELS.shortcutCopy).toBe('Ctrl+C');
    expect(DEFAULT_GRID_LABELS.shortcutCut).toBe('Ctrl+X');
    expect(DEFAULT_GRID_LABELS.shortcutPaste).toBe('Ctrl+V');
    expect(DEFAULT_GRID_LABELS.shortcutClear).toBe('Del');
    expect(DEFAULT_GRID_LABELS.shortcutFillDown).toBe('Ctrl+D');
  });
});
