import { useState } from 'react';
import { SpreadsheetGrid } from './SpreadsheetGrid';
import type { CellEdit, GridColumn } from './types';

/**
 * TEMPORARY dev harness for SpreadsheetGrid (reachable at `/?grid-demo`).
 * Renders the standalone grid with mock survey-like data and local state, so the
 * grid can be exercised without the Tauri backend or DataTable integration.
 * Not part of the shipped app; safe to delete once integrated.
 */
interface DemoShot {
  id: number;
  station: string;
  azimuth: number;
  length: number;
  depthIn: number;
  depthOut: number;
  comment: string | null;
  frozen: boolean;
}

function makeRows(n: number): DemoShot[] {
  const rows: DemoShot[] = [];
  let az = 0;
  for (let i = 0; i < n; i++) {
    az = (az + 17.5) % 360;
    rows.push({
      id: i + 1,
      station: `A${i}`,
      azimuth: Math.round(az * 10) / 10,
      length: Math.round((3 + (i % 9) * 1.7) * 10) / 10,
      depthIn: Math.round((i * 0.4) * 10) / 10,
      depthOut: Math.round((i * 0.4 + 0.6) * 10) / 10,
      comment: i % 6 === 0 ? `note ${i}` : null,
      frozen: i % 11 === 0, // demonstrate per-row read-only (like isShotFrozen)
    });
  }
  return rows;
}

export function SpreadsheetGridDemo() {
  const [rows, setRows] = useState<DemoShot[]>(() => makeRows(500));
  const [hidden, setHidden] = useState<string[]>([]);
  const [order, setOrder] = useState<string[]>([
    'id',
    'station',
    'azimuth',
    'length',
    'depthIn',
    'depthOut',
    'comment',
  ]);
  const [maximized, setMaximized] = useState(false);

  const num =
    (
      key: keyof DemoShot,
      header: string,
      nullable = false,
      validate?: (value: unknown) => string | null,
    ): GridColumn<DemoShot> => ({
      key: key as string,
      header,
      width: 96,
      align: 'right',
      editable: true,
      isEditable: (r) => !r.frozen,
      kind: nullable ? 'number-nullable' : 'number',
      getValue: (r) => r[key],
      format: (v) => (v == null ? '' : String(v)),
      ...(validate ? { validate: (v: unknown) => validate(v) } : {}),
    });

  const columns: GridColumn<DemoShot>[] = [
    {
      key: 'id',
      header: '#',
      width: 56,
      getValue: (r) => r.id,
      render: (r) => (
        <span style={r.frozen ? { color: '#80868b' } : undefined}>
          {r.id}
          {r.frozen ? ' 🔒' : ''}
        </span>
      ),
    },
    { key: 'station', header: 'Station', width: 90, getValue: (r) => r.station },
    num('azimuth', 'Azimuth', false, (v) =>
      typeof v === 'number' && (v < 0 || v > 360) ? 'Azimuth must be 0–360' : null,
    ),
    num('length', 'Length', false, (v) =>
      typeof v === 'number' && v < 0 ? 'Length must be ≥ 0' : null,
    ),
    num('depthIn', 'Depth in'),
    num('depthOut', 'Depth out'),
    {
      key: 'comment',
      header: 'Comment',
      width: 240,
      editable: true,
      isEditable: (r) => !r.frozen,
      kind: 'text',
      getValue: (r) => r.comment ?? '',
    },
  ];

  const applyOne = (rowIndex: number, colKey: string, value: unknown) =>
    setRows((rs) =>
      rs.map((r, i) =>
        i === rowIndex ? { ...r, [colKey]: colKey === 'comment' && value === '' ? null : value } : r,
      ),
    );

  const applyBatch = (edits: CellEdit[]) =>
    setRows((rs) => {
      const next = rs.slice();
      for (const e of edits) {
        const cur = next[e.row];
        if (cur) {
          next[e.row] = {
            ...cur,
            [e.colKey]: e.colKey === 'comment' && e.value === '' ? null : e.value,
          };
        }
      }
      return next;
    });

  const insertRows = (beforeIndex: number, count: number) =>
    setRows((rs) => {
      const maxId = rs.reduce((m, r) => Math.max(m, r.id), 0);
      const blanks: DemoShot[] = Array.from({ length: count }, (_, k) => ({
        id: maxId + 1 + k,
        station: '',
        azimuth: 0,
        length: 0,
        depthIn: 0,
        depthOut: 0,
        comment: null,
        frozen: false,
      }));
      return [...rs.slice(0, beforeIndex), ...blanks, ...rs.slice(beforeIndex)];
    });

  const deleteRows = (fromRow: number, toRow: number) =>
    setRows((rs) => [...rs.slice(0, fromRow), ...rs.slice(toRow + 1)]);

  const moveRows = (fromStart: number, fromEnd: number, toIndex: number) =>
    setRows((rs) => {
      const block = rs.slice(fromStart, fromEnd + 1);
      const rest = [...rs.slice(0, fromStart), ...rs.slice(fromEnd + 1)];
      let insertAt = toIndex;
      if (toIndex > fromEnd) insertAt = toIndex - block.length;
      else if (toIndex > fromStart) insertAt = fromStart;
      insertAt = Math.max(0, Math.min(rest.length, insertAt));
      return [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)];
    });

  return (
    <div className="min-h-screen p-6 text-sm" style={{ background: '#f0f2f5', color: '#3c4043' }}>
      <h1 className="mb-1 text-lg font-semibold" style={{ color: '#202124' }}>SpreadsheetGrid — dev demo</h1>
      <p className="mb-3 max-w-3xl text-xs">
        Standalone, library-free, Excel-like grid (issue #61), not yet integrated into DataTable.
        Try: click + Shift+click / Shift+Arrow to select a range; type to edit, Enter/Tab to commit,
        Esc to cancel; Ctrl/Cmd+C / V to copy/paste (paste a block from a spreadsheet too);
        Ctrl/Cmd+D / R to fill; Delete to clear; drag column headers to reorder; use the Columns menu
        to hide; Maximize for full-screen. Rows marked 🔒 are read-only (mimics frozen shots).
      </p>
      <div className="overflow-hidden rounded" style={{ border: '1px solid #c0c0c0' }}>
        <SpreadsheetGrid<DemoShot>
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          locale="en-US"
          height={520}
          hiddenColumns={hidden}
          onHiddenColumnsChange={setHidden}
          columnOrder={order}
          onColumnOrderChange={setOrder}
          maximized={maximized}
          onToggleMaximize={() => setMaximized((v) => !v)}
          onEdit={applyOne}
          onBatchEdit={applyBatch}
          onMoveRows={moveRows}
          onInsertRows={insertRows}
          onDeleteRows={deleteRows}
        />
      </div>
    </div>
  );
}
