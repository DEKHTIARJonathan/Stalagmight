# Implementation Plan — Spreadsheet Editing for the Data Table (Issue #61)

> Clean-room note: this plan is derived solely from observable Excel/Google Sheets user-facing behavior, well-known general algorithms (rectangle selection, RFC-4180-style TSV quoting, `Intl`-based locale parsing), and this repository's own source. No third-party grid library source was read or referenced.

---

## 1. Goal & scope

Issue #61 turns the data-entry tables (`EditableTable` in `src/components/common/Table.tsx`, configured by `src/components/SingleSystemView/DataTable.tsx`) into a spreadsheet-like editing surface: a roving **active cell** with full keyboard grid navigation (arrows, Tab/Shift+Tab, Home/End, Ctrl+arrows, PageUp/Down, Enter/Shift+Enter); **type-to-edit / F2 / Esc-cancel / Enter-commit**; **rectangular multi-cell selection**; **single- and range-level copy/cut/paste including paste from external spreadsheets** (Excel/Sheets put TSV on `text/plain`); **fill-down / fill-across / drag-fill**; **column hiding**; and **column reordering**; plus a **full-screen / maximized** mode. Per a prior decision this is built **in-house on the existing hand-rolled `EditableTable`** — no third-party grid library (disqualified on license/rendering). Every behavior must respect the existing editability guards (`editableColumns`, `isRowEditable`, `isShotFrozen` geometry-freeze, and `geometryReadOnly`/closure-adjusted mode); no new write path may bypass them.

**Key de-risking discovery (corrects the maps):** the Rust core `Command` enum **already** has `UpdateShot { section_id, shot_id, updates }` (`src-tauri/src/core/command.rs:84`), `SetStationComment { station_ref, comment }` (`command.rs:129`), and a `Batch { commands: Vec<Command> }` variant (`command.rs:156`); `execute_batch(commands: Vec<Command>)` wraps them into one undo unit (`src-tauri/src/commands/section.rs:131-136`). The enum uses `#[serde(tag = "type", rename_all = "snake_case")]` (`command.rs:32-33`), so each command deserializes from `{ "type": "update_shot", ... }`. **The only gap is the hand-authored TypeScript `BatchCommand` union (`src/types/commands.ts:77-84`), which omits `update_shot` and `set_station_comment`.** Atomic multi-cell paste/fill/clear is therefore a **TS-only** addition of two union members — no Rust change, no `pnpm gen:ipc-types` run (the `BatchCommand` union is hand-maintained, not generated).

---

## 2. Architecture

### 2.1 The logical selection model — keyed by data identity, never DOM

The grid's selection is a single rectangle defined by two corners:

```ts
interface CellCoord { row: number; colKey: string }   // row = data index; colKey = Column<T>.key
interface GridSelection {
  anchor: CellCoord;   // fixed corner (set when a selection starts)
  focus:  CellCoord;   // moving corner == active cell == where typing/editing happens
}
```

The rectangle is the inclusive bounding box between `anchor` and `focus`. A single active cell is the degenerate case `anchor == focus`.

- **`row` is the data index** into `selectedSection.shots` (shots view) or the station rows array (stations view) — *not* a virtual/DOM index.
- **`colKey` is the `Column<T>.key`** (`Table.tsx:6`), *not* a positional column index. This is the keystone for column reorder/hide: the visible column order changes, but a cell's identity (`row`, `colKey`) is stable. Positional column indices are computed on demand from the *current* visible-column array (`visibleColumns.findIndex(c => c.key === colKey)`), so reordering/hiding never desyncs a selection from its data.

### 2.2 KEYSTONE constraint: rows are virtualized → selection/copy/fill operate on the data model, selection rectangle is drawn as an OVERLAY

`EditableTable` virtualizes rows via `useVirtualizer` (`Table.tsx:376-381`, `ROW_HEIGHT = 33`, `overscan: 5`) and only mounts `getVirtualItems()` rows plus top/bottom spacer `<tr data-spacer>` rows (`Table.tsx:542-655`). **Off-screen cells do not exist in the DOM.** Therefore:

1. **All read/copy/fill/paste logic reads the data model** (`selectedSection.shots[row]` + `column.getValue?.(item) ?? item[key]`, mirroring `Table.tsx:94-96` / `621-646`), never the DOM. A copy of rows 0–500 must work even though only ~20 rows are mounted.
2. **Selection membership is computed from indices**, not DOM presence: a cell `(row, colKey)` is "in selection" iff `minRow ≤ row ≤ maxRow && minColIdx ≤ visibleColIdx(colKey) ≤ maxColIdx`. Mounted cells in range get a `bg-accent-10`/`bg-accent-20` fill class and the focus cell an outline ring (extend the per-cell class logic at `Table.tsx:621-646`; today only the first column of a selected row gets `selected-cell-indicator`, `Table.tsx:106`/`625`).
3. **The selection rectangle border / fill handle / marching-ants is a single absolutely-positioned OVERLAY** inside `scrollContainerRef` (`Table.tsx:373`), computed from virtualizer offsets + column geometry — *not* per-cell borders (which would vanish when rows unmount). Concretely:
   - **Top/height** from the virtualizer: `topPx = virtualizer.getOffsetForIndex?.(minRow)` (or `minRow * ROW_HEIGHT`, since `estimateSize` is constant 33px); `heightPx = (maxRow - minRow + 1) * ROW_HEIGHT`. Add the sticky `<thead>` height offset.
   - **Left/width from column widths**: column widths are declared strings on `Column<T>.width` (`Table.tsx:8`, e.g. `'100px'`). Maintain a `colLeftOffsets: number[]` prefix-sum computed from the visible columns' measured widths (read once per layout via the header `<th>` `getBoundingClientRect()` into a ref keyed by colKey; recompute on resize / reorder / hide / full-screen toggle). `leftPx = colLeftOffsets[minColIdx]`, `widthPx = colLeftOffsets[maxColIdx+1] - colLeftOffsets[minColIdx]`.
   - The overlay is `position:absolute; pointer-events:none` (except the fill handle, which is `pointer-events:auto`), `z`-above cells but below the textarea-overlay editor (which is `z-50`, `Table.tsx:267-313`). It translates with scroll because it lives *inside* the scroll container's positioned content, alongside the spacer-driven table.
4. **Navigation to an off-screen target** reuses the existing pattern: `virtualizer.scrollToIndex(targetRow, {align:'auto'})` then focus in `requestAnimationFrame` after mount (`Table.tsx:486-505`). The active-cell *ring* does not require the cell to be focused as an `<input>` — it is drawn by the overlay — so navigation can move the logical focus immediately and lazily mount/focus the editor only on edit.

### 2.3 Where the state lives

- **Grid cell-range selection + active cell + edit-mode + maximized flag live in a small local slice colocated with `EditableTable`** (a `useReducer` or a few `useState`/`useRef` in the component), because they are transient, per-mount, and high-frequency (drag, arrow spam). Putting per-keystroke selection in Zustand would cause excessive global re-renders.
- **The focus cell drives the existing app `selection`** (`uiStore.ts` `setSelection`) so the map/detail panel stay in sync — exactly as a row click does today (`DataTable.tsx:307-320`), guarded by `internalSelectionRef.current = true` (`DataTable.tsx:36,147-151,271`) to suppress scroll feedback. The grid range does **not** populate `uiStore.multiSelection` (out of scope; that's for map multi-highlight).
- **Persisted prefs (hidden columns, column order per view, panel sizes) live in config** via the `PanelsConfig`/`update_panel_sizes` path (see §4 step 10/11).
- **`dataTableMaximized` lives in `uiStore`** (transient, but it's a layout concern affecting sibling panels), snapshotting prior layout for lossless exit (mirror `enterSectionFocus`/`exitSectionFocus`, `uiStore.ts:572-612`).

---

## 3. Data structures & signatures

### 3.1 Selection slice (local to EditableTable)

```ts
type EditMode = { editing: false } | { editing: true; initial: string; replace: boolean };

interface GridState {
  selection: GridSelection | null;     // null = no active cell
  edit: EditMode;
  tabAnchorColKey: string | null;       // §1.3/§1.4 Tab-run anchor; cleared by non-Tab nav
  clipboardMark: { range: GridSelection; mode: 'copy' | 'cut' } | null; // marching ants
}
```

### 3.2 Column metadata addition (extend `Column<T>`, `Table.tsx:5-21`)

Add fields so the grid can decide navigability, edit-eligibility, paste coercion, and clear semantics generically (instead of `DataTable` special-casing inside `handleCellEdit`):

```ts
interface Column<T> {
  // ...existing: key, header, width, render, align, getValue, formatValue, inputType, inputStep, inputMode
  /** This column accepts edits (paste/fill/type). If absent, derived from editableColumns prop. */
  editable?: boolean;
  /** Value kind for paste coercion + clear semantics. */
  cellKind?: 'number' | 'number-nullable' | 'text' | 'readonly';
  /**
   * Parse a raw string (typed or pasted, locale-aware) into the value passed to onCellEdit.
   * Return undefined to REJECT (skip write). Default impl supplied by the grid per cellKind.
   */
  parsePasted?: (raw: string, locale: string) => unknown | undefined;
  /** Serialize the cell to clipboard text (default: formatValue(getValue/item[key])). */
  serializeCell?: (item: T) => string;
}
```

`DataTable.tsx` sets `cellKind` per column: `length/depth_in/depth_out/_azimuth_avg` → `'number'`; `left/right/up/down` → `'number-nullable'`; `comment` → `'text'`; `_warnings/id/is_reference/_x/_y/_depth/_zeroDatum/_connections` → `'readonly'`. The grid still consults `editableColumns` + `isRowEditable` + frozen-geometry as the *authoritative* gate (§3.5); `cellKind` only informs coercion/clear behavior.

### 3.3 Pure helpers (new file `src/components/common/gridClipboard.ts`)

```ts
// TSV serialize: RFC-4180-style quoting (quote if cell contains \t, \n, or "; double embedded ").
export function serializeRangeToTSV<T>(
  rows: T[], cols: Column<T>[], rect: { r0:number; r1:number; c0:number; c1:number }
): string;

// TSV parse: returns a rectangular string[][]; understands quoted multiline/tabbed cells.
// Trailing empty final line (from a terminal \n) is dropped.
export function parseTSV(text: string): string[][];

// Locale number parsing (the shared fix for the parseFloat bug). Returns undefined if not finite.
export function parseLocaleNumber(raw: string, locale: string): number | undefined;
```

`parseLocaleNumber` (replaces bare `parseFloat` at `Table.tsx:421-423` and `DataTable.tsx:287`): derive group + decimal separators from `Intl.NumberFormat(locale).formatToParts(11111.1)`; strip group chars; replace locale decimal with `.`; `parseFloat`; if the string has no locale-decimal but has a `.`, parse as dot-decimal (so foreign machine values still paste); reject non-finite. Uses `getNumberLocale()`/`getCurrentLocale()` from `src/i18n/format.ts:36-48` (export a small `getActiveNumberLocale()` from `format.ts` since `getNumberLocale` is currently module-private).

### 3.4 Range edit application (new in `DataTable.tsx`, dispatched via store)

```ts
// Builds one BatchCommand[] from a set of (row, colKey, rawValue) writes, applying:
//  - editability gate (§3.5): skip read-only cols, non-editable rows, frozen geometry cells
//  - per-column coercion (parsePasted / cellKind), incl. _azimuth_avg delta expansion
//  - non-nullable-empty rule (skip; never write 0)
//  - merge multiple colKey writes targeting the SAME shot into one update_shot
// Returns { commands, skipped } and runs executeBatch(commands) → ONE undo entry.
async function applyRangeEdits(
  writes: Array<{ row: number; colKey: string; raw: string }>
): Promise<{ skipped: number }>;
```

This routes through `useProjectStore.executeBatch(commands)` (`projectStore.ts:1548-1554`). Each shot write becomes a `BatchCommand` of new type `{ type:'update_shot', section_id, shot_id, updates: ShotUpdates }`; station-comment writes become `{ type:'set_station_comment', station_ref, comment }`. A single `_azimuth_avg` write expands to one `update_shot` carrying both `azimuth_in` + `azimuth_out` (reusing the delta math at `DataTable.tsx:285-301`). Single-cell edits keep using `updateShot`/`updateStationComment` directly (1 undo each, unchanged).

### 3.5 The authoritative editability gate (one shared predicate)

```ts
function cellWritable(row: number, colKey: string): boolean {
  if (geometryReadOnly) return false;                       // closure-adjusted (DataTable.tsx:845)
  if (!editableColumns.includes(colKey)) return false;       // DataTable.tsx:752-762
  const item = data[row];
  if (!isRowEditable(item, row)) return false;               // DataTable.tsx:764-771
  if (GEOMETRY_COLUMNS.includes(colKey) && isShotFrozen(selectedSectionId, row)) return false; // DataTable.tsx:260,280-282; projectStore.ts:976
  return true;
}
```

Every write path (type-to-edit, paste, fill, clear) consults `cellWritable`; reads/copy/selection ignore it.

### 3.6 New `BatchCommand` variants (`src/types/commands.ts:77-84`)

```ts
export type BatchCommand =
  | /* ...existing 7 variants... */
  | { type: 'update_shot'; section_id: number; shot_id: number; updates: ShotUpdates }
  | { type: 'set_station_comment'; station_ref: StationRef; comment: string | null };
```

`ShotUpdates` imported from the generated IPC types (matches `Command::UpdateShot.updates`). No Rust change; verify with a round-trip test (§5).

---

## 4. Step-by-step implementation (~12 ordered steps)

Dependencies are noted as **dep: [step n]**. Sizes: S ≤ ½ day, M ≈ 1–2 days, L ≈ 3–5 days.

### Step 0 — Foundations: `BatchCommand` variants + `parseLocaleNumber` + `Column.cellKind` (S–M)
**Files:** `src/types/commands.ts:77-84` (add 2 union members, §3.6); `src/i18n/format.ts` (export `getActiveNumberLocale()`); new `src/components/common/gridClipboard.ts` (`parseLocaleNumber`, §3.3); `src/components/common/Table.tsx:5-21` (extend `Column<T>`, §3.2); `src/components/SingleSystemView/DataTable.tsx` (annotate `cellKind` per column in the shot/station column defs, `:592-750`/`:469-542`).
**Replace** bare `parseFloat` at `Table.tsx:421-423` (`handleInputChange`) and `DataTable.tsx:287` (azimuth path) with `parseLocaleNumber(raw, getActiveNumberLocale())`.
**Edge cases:** locale comma-decimal (`"1,5"` must → `1.5`, today → `1`); non-finite → reject (no write), matching `Number.isFinite` guard at `DataTable.tsx:288-291`. **Unit-tested** (§5). **dep:** none. This unblocks everything and fixes a standing data-corruption bug.

### Step 1 — Roving active cell + per-cell focus ring overlay (M) ★ enables nav
**Files:** `Table.tsx` (`EditableTable`, `:347-660`). Add `GridState.selection` (§3.1). Make the scroll container / a grid wrapper focusable (`tabIndex={0}`) so it receives keys when not editing (today only the `<input>`/`<textarea>` gets keys, `Table.tsx:638`). Add the absolutely-positioned **selection overlay** inside `scrollContainerRef` (§2.2): compute `topPx`/`heightPx` from `ROW_HEIGHT`/virtualizer, `leftPx`/`widthPx` from a `colLeftOffsets` prefix-sum built from header `<th>` rects. Mounted in-range cells get a fill class; focus cell gets the ring (extend `Table.tsx:621-646`).
**On click:** set `anchor=focus=cell` and drive app selection via the existing `onRowClick` → `setSelection` path (`DataTable.tsx:307-320`).
**Edge cases:** sticky `<thead>` offset in `topPx`; recompute `colLeftOffsets` on resize/full-screen. **dep:** [0].

### Step 2 — Keyboard navigation (arrows, Tab/Shift+Tab, Enter/Shift+Enter, Home/End, Ctrl+arrow, PageUp/Down) (M) ★
**Files:** `Table.tsx` — generalize `handleCellKeyDown` (`:471-507`) into a grid-level `onKeyDown` on the focusable wrapper that branches on nav-mode vs edit-mode.
- **Arrows:** move focus 1 cell; **no wrap**; land on *every* visible cell incl. read-only (§1.2). `scrollToIndex` before drawing (reuse `:486-505`).
- **Tab/Shift+Tab:** move horizontally **skipping non-`cellWritable` columns** (§1.7); wrap to next/prev row's first/last navigable col; no-op at grid extremes. Set `tabAnchorColKey` on first Tab.
- **Enter/Shift+Enter:** nav-mode = enter edit-in-place (Excel) *or* if `tabAnchorColKey` set, advance to next row at the anchor column (§1.4). Edit-mode = commit + advance (existing `EditableCell` commit, `Table.tsx:198-205`).
- **Home/End/Ctrl+Home/End/Ctrl+Arrow/PageUp/Down:** §1.5/§1.6/§1.8 (data-block edge jump; page = `floor(viewportH/33) - 1`).
**Edge cases:** comment textarea owns Enter (newline) — Tab/Ctrl+Enter commits (`Table.tsx:220-230`); editing inputs must `stopPropagation` for caret keys and let Enter/Tab/Esc bubble to the grid handler (§8). **dep:** [1].

### Step 3 — Type-to-edit / F2 / Esc / double-click (S–M)
**Files:** `Table.tsx` (`EditableCell` `:127-330` + grid handler). Printable key on a `cellWritable` cell → enter edit mode with `replace:true` seeding the keystroke; **F2** → edit-in-place (no clear, cursor at end); **double-click cell** → edit-in-place with `stopPropagation` so it doesn't trigger row double-click map-pan (`DataTable.tsx:323-331`); **Esc** → revert + stay (existing `:206-219`).
**Edge cases:** read-only cells swallow printable keys (no-op + optional subtle affordance); numeric cells only accept digit/`-`/locale-decimal as the seeding char; editor shows `rawValue` while focused (`Table.tsx:153,234`). **dep:** [2].

### Step 4 — Single-cell copy / cut / paste (S–M) — proves the clipboard plumbing
**Files:** new `gridClipboard.ts` (already started in [0]); grid handler in `Table.tsx`. `Ctrl/Cmd+C` → `serializeRangeToTSV` of the 1×1 range → `navigator.clipboard.writeText`. `Ctrl/Cmd+V` → `navigator.clipboard.readText()` → `parseTSV` → single value → `applyRangeEdits([{row,colKey,raw}])`. `Ctrl/Cmd+X` → copy + mark `clipboardMark.mode='cut'`; clear source on paste where clearable.
**Edge cases:** Tauri webview clipboard read permission (verify capability; fallback to a hidden `paste`-event capture if `readText` unavailable, §4.4 spec); paste onto read-only/frozen cell = no-op. **dep:** [0],[2].

### Step 5 — ★ KEYSTONE: rectangular range selection (L)
**Files:** `Table.tsx`. Implement `anchor`/`focus` extension:
- **Shift+Click** → keep anchor, set focus (rectangle).
- **Shift+Arrow** → move focus 1 cell (no col-skip; rectangles are contiguous).
- **Ctrl+Shift+Arrow** → extend focus to data-block edge (§3 / §1.6 semantics).
- **Mouse drag** → extend the row mouse handlers (`Table.tsx:435-468`) to cell granularity; **auto-scroll** the virtualized list when dragging past top/bottom (rAF loop calling `scrollToIndex`).
- **Ctrl+A** → select all (top-left … bottom-right); `preventDefault` to stop page select-all.
- Render the multi-cell fill + rectangle border via the **overlay** from §2.2 (membership by index, correct for scrolled-out rows).
**Edge cases:** single-rectangle only (non-contiguous Ctrl+click multi-rect is out of scope); overlay must track scroll and survive row unmount; focus cell still drives app `selection` to its shot/station. **dep:** [1],[2].

### Step 6 — Range copy/cut → TSV (S–M)
**Files:** `gridClipboard.ts` + grid handler. `Ctrl+C`/`Ctrl+X` over a rectangle → `serializeRangeToTSV(data, visibleCols, rect)` reading the **data model** (`getValue ?? item[key]` then `serializeCell`/`formatValue`), joining `\t`/`\n` with RFC-4180 quoting for multiline `comment` cells. Marching-ants overlay until next copy/Esc/commit.
**Edge cases:** copy includes only **visible** columns in current order (§6.1); copied numeric uses locale-formatted display so it round-trips into a same-locale sheet (§4.1); reads off-screen rows fine (data model). **dep:** [5].

### Step 7 — External + internal range paste with locale + sizing/tiling (M) ★
**Files:** grid handler + `applyRangeEdits` (§3.4). `parseTSV` clipboard → `R×C`. Placement: anchored at focus = top-left; **1×1 onto a multi-cell selection fills all** (§4.5); **R×C onto single/smaller selection pastes the block, auto-growing**; **exact-integer-multiple selection tiles/repeats** the clipboard; non-multiple → paste once at anchor; **clip** at last data row / last visible column (never create rows/cols) and toast "N cells outside the table were not pasted".
**Column mapping:** clipboard col *i* → *i*-th **visible** column right of anchor (positional onto visible; writes skipped on read-only/frozen — §4.5 chosen rule).
**Per-cell coercion** via `parsePasted`/`parseLocaleNumber`; `_azimuth_avg` paste = delta expansion (§4.7); empty clipboard cell → `null` for `number-nullable`/`comment`, **skip** for non-nullable numeric (never write 0, §4.7); frozen-geometry & read-only cells skipped (count + toast).
**Atomicity:** all writes → one `executeBatch` → **one undo entry**. **dep:** [5],[6],[0].

### Step 8 — `applyRangeEdits` via `executeBatch`, skipping read-only/frozen (M) ★ — shared by paste + fill + clear
**Files:** `DataTable.tsx` (implement `applyRangeEdits`, §3.4) using `useProjectStore.executeBatch` (`projectStore.ts:1548-1554`) with the new `BatchCommand` variants (§3.6). Merge multiple colKey writes for the same shot into one `update_shot`. Implement multi-cell **Delete/Backspace clear** (§2.5): nullable numeric → `null`; non-nullable numeric → skip (toast); comment → `null` (matches `handleStationCellEdit`, `DataTable.tsx:573-580`); read-only never cleared.
**Edge cases:** `cellWritable` gate on every write; verify single-undo via Playwright (do one paste, assert exactly one undo collapses it). **dep:** [0],[7]. (Steps 7 and 8 land together.)

### Step 9 — Fill-down / fill-right / drag-fill (M)
**Files:** grid handler + `applyRangeEdits`. `Ctrl/Cmd+D` (top row → down), `Ctrl/Cmd+R` (left col → right); single-cell `Ctrl+D`/`Ctrl+R` fills from the cell above/left. Drag-fill handle at the rectangle's bottom-right (overlay `pointer-events:auto`).
**Edge cases:** **copy-fill only, NO numeric auto-series** (explicit non-goal for cave data — document, §5.3 spec); ≥2 source cells → tile/repeat (same rule as paste); `_azimuth_avg` fill recomputes per-row delta from each target's own in/out; cross-column fill copies the *value* not the field meaning; skip read-only/frozen/non-nullable-empty; one undo per fill. **dep:** [8].

### Step 10 — Column hiding (M)
**Files:** `DataTable.tsx` (header "Columns" menu / right-click header context menu) + `Table.tsx` (filter `columns` to `visibleColumns` before render and before all index math). Persist a per-view `hidden: string[]`.
**Persistence:** add Rust fields to `PanelsConfig` (`src-tauri/src/config/types.rs:287`) — e.g. `data_table_shot_columns_hidden`, `data_table_station_columns_hidden` — extend `update_panel_sizes_impl` (`src-tauri/src/commands/config.rs:49-65`), run `pnpm gen:ipc-types` (these ARE generated config types, unlike `BatchCommand`), seed via `uiStore.initPanelSizes` (`uiStore.ts:548-553`).
**Edge cases:** keep `id` always-on; hidden cols excluded from copy and not paste targets; unknown persisted keys ignored (forward-compat); must not break `_azimuth_avg` or row keys. **dep:** [1] (visible-column abstraction). Independent of [5–9].

### Step 11 — Column reordering (M)
**Files:** `DataTable.tsx` header drag-reorder (drop indicator) + `Table.tsx` ordering `visibleColumns` by a persisted `order: string[]`. All nav/selection/copy/paste/fill use the **displayed** order via `colKey`→index lookup (§2.1), so no index desync.
**Persistence:** `data_table_shot_column_order` / `_station_column_order` alongside step 10's config fields (same `PanelsConfig` + `update_panel_sizes` + `gen:ipc-types`). Defaults: declaration order; unknown keys ignored; optionally pin `id`/`_warnings` left.
**dep:** [10] (shared config plumbing + visible-column abstraction). Independent of [5–9].

### Step 12 — Full-screen / maximized mode (M)
**Files:** `uiStore.ts` (add `dataTableMaximized: boolean` + `enterDataTableMaximize`/`exitDataTableMaximize`, snapshotting prior layout like `enterSectionFocus`/`exitSectionFocus`, `uiStore.ts:572-612`); `DataTable.tsx:785-793` (add a maximize/restore icon button next to the collapse chevron); SingleSystemView layout to expand the table over map+panels when maximized.
**Entry:** maximize button, optional `Ctrl/Cmd+Shift+Enter` when grid focused, optional header double-click. **Exit:** restore button; `Esc` exits full-screen *only when not editing* (first Esc cancels an active edit per §2.4, second exits). Transient (not persisted); dropped on project/view switch (mirror `setView`→`exitSectionFocus`, `uiStore.ts:368-378`).
**Edge cases:** virtualization unchanged; all spreadsheet features work identically maximized. **dep:** [1] (independent of others; can land early or last).

---

## 5. Testability

Per the project's Playwright/testability conventions, add **stable `data-testid` hooks** and assertable `data-*` attributes; keep clipboard/TSV/fill/range math as **pure, unit-tested helpers**.

### Required test hooks (extend `Table.tsx`)
- Active/selection cell: `data-active-cell="true"` on the focus cell; `data-in-selection="true"` on every mounted in-range cell. (Existing: `data-testid={table-cell-${key}-${col.key}}` at `Table.tsx:637`, `data-selected` at `:606`/`:625`, `data-spacer` on spacers.)
- Selection overlay element: `data-testid="grid-selection-overlay"` with `data-rect="r0,c0,r1,c1"` (assert geometry without pixel math).
- Fill handle: `data-testid="grid-fill-handle"`. Clipboard mark: `data-clipboard-mark="copy|cut"`.
- Column menu: `data-testid="data-table-columns-menu"`; per-column toggle `data-testid="col-toggle-${key}"`. Maximize button: `data-testid="data-table-maximize"`.

### Pure unit tests (Vitest)
- `parseTSV`: tabs, newlines, quoted multiline `comment`, doubled `""`, trailing newline dropped, single cell.
- `serializeRangeToTSV`: round-trips with `parseTSV`; quotes only when needed.
- `parseLocaleNumber`: `"1,5"`@de→`1.5`; `"1.234,5"`@de→`1234.5`; `"1.5"`@en→`1.5`; dot-fallback; `""`→`undefined`; `"abc"`→`undefined`. **Regression-locks the `parseFloat` bug.**
- Range math: rectangle from anchor/focus; tiling multiple check; clip-to-bounds; `colKey↔visibleColIdx` after hide/reorder.
- `applyRangeEdits` (logic-level): non-nullable-empty skipped; frozen-geometry skipped; same-shot writes merged into one `update_shot`; `_azimuth_avg`→both azimuths.

### Playwright (per feature)
- **Nav:** arrow/Tab moves `data-active-cell`; Tab skips `id`/`_warnings`; no-wrap at edges; Enter-after-Tab-run lands at anchor column.
- **Type-to-edit:** type digit → editor seeded; Esc reverts (value unchanged); Enter commits + advances.
- **Range select:** Shift+Arrow / drag grows `data-rect`; Ctrl+A selects all; overlay present after scrolling a selected range out and back (asserts overlay survives virtualization — the keystone).
- **Copy/paste:** copy a 2×2, paste at new anchor, assert 4 cells updated **and exactly one undo** reverts all 4 (asserts atomic `executeBatch`). External-paste sim: set clipboard to a TSV string, paste, assert mapped values.
- **Locale:** with de locale, type `1,5` into `length`, assert stored/displayed `1,5` (not `1`).
- **Fill:** Ctrl+D over 1×3, assert rows 2–3 copy row 1; assert **no** auto-increment.
- **Guards:** paste/fill onto a frozen row's geometry → unchanged + skip toast; closure-adjusted mode → all edits inert.
- **Hide/reorder:** toggle column off → absent from DOM + copy TSV; reorder → cell values follow header order; both **persist after reload**.
- **Full-screen:** maximize covers map; Esc (not editing) restores prior height.

### Rust
- Round-trip test in `src-tauri/src/core/state/tests.rs` (or `commands/section.rs` tests): `execute_batch` with `Command::UpdateShot` + `Command::SetStationComment` applies all and produces **one** undo entry (confirms the new TS `BatchCommand` members deserialize into the existing enum via `#[serde(tag="type", rename_all="snake_case")]`).

---

## 6. Risks & long-tail

- **★ Virtualization × selection (the keystone):** off-screen rows unmount, so per-cell borders/state are unreliable. Mitigation enforced in §2.2: all logic on the data model; selection membership by index; rectangle/handle/marching-ants as a single overlay computed from virtualizer offsets + `colLeftOffsets`. Auto-scroll-during-drag and `scrollToIndex`-before-focus are the fiddly bits — budget extra test time. `estimateSize` is constant 33px (`Table.tsx:375`) so offset math is exact; if row heights ever become dynamic, switch to `virtualizer.getOffsetForIndex`.
- **Locale parsing ambiguity:** `"1.234"` is 1234 (de grouping) vs 1.234 (en/dot) — resolve by "matches locale's own formatted pattern → parse per locale, else dot-fallback" and document precedence. The shared `parseLocaleNumber` must be the *only* numeric entry parser (no stray `parseFloat`).
- **IME / composition:** don't treat `keydown` during IME composition as type-to-edit; gate on `event.isComposing`/`compositionend`. Affects CJK comment entry.
- **RTL:** column geometry uses LTR prefix-sums; if RTL UI is ever supported, `colLeftOffsets` and Tab/arrow direction need mirroring. Out of scope now; note it.
- **Big-paste performance:** a 10k-cell paste builds one `BatchCommand[]` and one `executeBatch`; ensure the Rust `Command::Batch` path and `refreshProjectState()`/`checkProjectIntegrity()` (`projectStore.ts:358-376`) run once, not per cell. Cap/clip absurd pastes and toast; consider a confirm above N cells.
- **a11y for the active cell:** the focusable wrapper needs `role="grid"`/`gridcell` semantics, `aria-selected`, and the active cell announced; keyboard-only users must reach the grid (tab stop) and the column menu must be keyboard-operable.
- **Clipboard permissions in Tauri:** `navigator.clipboard.readText()` may be gated; verify the webview capability and ship the hidden-`paste`-event fallback.
- **Cut semantics on non-nullable geometry:** "cut" can't empty a `length`; document that geometry cut = copy + (source left intact), to avoid silent data loss.

---

## 7. Sequencing & checkpoints (recommended PR breakdown)

Each PR must pass the pre-push checklist (`pnpm tsc --noEmit`, `pnpm test:ui` headless, `cargo test --manifest-path src-tauri/Cargo.toml`) and is independently shippable.

- **PR-A — Foundations (Step 0).** `BatchCommand` variants, `parseLocaleNumber` + the `parseFloat` bug fix, `Column.cellKind`, Rust round-trip test. Low risk, fixes a real locale data-corruption bug immediately. *Checkpoint: locale typing correct; batch update_shot round-trips with 1 undo.*
- **PR-B — Navigation core (Steps 1–3).** Roving active cell + overlay focus ring, full keyboard nav, type-to-edit/F2/Esc/double-click. *Checkpoint: keyboard-drive the grid; single edits still 1 undo; map selection stays in sync.*
- **PR-C — Single-cell clipboard (Step 4).** Proves clipboard plumbing + Tauri permission before tackling ranges. *Checkpoint: copy/paste/cut a single cell, internal and from a real spreadsheet.*
- **PR-D — Range selection KEYSTONE (Step 5).** The riskiest PR; isolate it. *Checkpoint: drag/shift/ctrl-A selection, overlay correct across scroll (the virtualization assertion).*
- **PR-E — Range copy + paste + apply (Steps 6–8).** TSV serialize, external paste with locale/tiling/clip, `applyRangeEdits` via `executeBatch`, multi-cell clear. *Checkpoint: 2×2 paste = 4 writes, 1 undo; guards enforced.*
- **PR-F — Fill (Step 9).** Fill-down/right/drag, copy-fill only. *Checkpoint: Ctrl+D/R + drag; no auto-series; 1 undo per fill.*
- **PR-G — Columns (Steps 10–11).** Hide + reorder + config persistence (`PanelsConfig` + `gen:ipc-types`). *Checkpoint: hide/reorder persist across reload; copy/paste honor visible order.*
- **PR-H — Full-screen (Step 12).** Maximize/restore in `uiStore` + header control. *Checkpoint: maximize/Esc round-trip; features work maximized.*

PR-A → PR-B → (PR-C → PR-D → PR-E → PR-F) is the critical path; **PR-G and PR-H depend only on PR-B** and can land in parallel with the clipboard chain to de-risk schedule.
