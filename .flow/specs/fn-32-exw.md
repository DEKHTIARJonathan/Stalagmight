# Right-align numeric columns in all data tables

## Problem

Numeric columns in data tables are inconsistently aligned. The main DataTable (shot data grid) already right-aligns numbers via the `align: 'right'` column prop, but other tables in the app — ShotTableEditor, ImportDialog, and DMP import dialogs — display numbers left-aligned. This looks unprofessional compared to spreadsheet applications like Excel, where numbers always float right.

Additionally, the EditableTable component's input elements inside right-aligned columns may not have `text-align: right` applied, meaning the typed text and cursor are left-aligned even though the cell data displays right-aligned.

## Key Decisions

- **Scope: all shot data tables** — DataTable, ShotTableEditor, ImportDialog, DmpImportDialog, DmpSelectionDialog. Does NOT include stats panels or non-table displays.
- **Headers right-aligned too** — Column headers for numeric columns should be right-aligned to match the data below them (Excel behavior).
- **Text/ID columns stay left-aligned** — Shot IDs, station names, and other text remain left-aligned. Only numeric data columns (length, azimuth, depths, LRUD) get right-aligned.
- **Input fields always right-aligned** — Number inputs inside editable cells should have `text-align: right` at all times (while typing and when idle), matching Excel.
- **Keep global CSS default** — The `th, td { text-align: left }` rule in index.css stays. Override per-component with Tailwind `text-right` classes.
- **Negative numbers: plain** — No special color or formatting for negative numbers. Just right-aligned with a minus sign.
- **E2E test** — Add a Playwright test verifying CSS text-align on numeric cells to prevent regression.

## Components to Fix

1. **EditableTable input styling** (`src/components/common/Table.tsx`) — Verify and fix that inputs in `align: 'right'` columns have `text-align: right`
2. **ShotTableEditor** (`src/components/common/ShotTableEditor.tsx`) — Add `text-right` to numeric column headers and cells (Length, Azimuth, Depth In, Depth Out, L, R, U, D)
3. **ImportDialog** (`src/components/Dialogs/ImportDialog.tsx`) — Add `text-right` to numeric column headers and cells (Length, Azi In, Azi Out, Depth In, Depth Out)
4. **DmpImportDialog** (`src/components/Dialogs/DmpImportDialog.tsx`) — Audit nested shot tables; fix any numeric columns missing `text-right` (Length, Azimuth already may be missing)
5. **DmpSelectionDialog** (`src/components/Dialogs/DmpSelectionDialog.tsx`) — Verify Shots column is right-aligned (partially done)

## Edge Cases

- Empty numeric cells (no value entered yet) — right-alignment still applies to the empty cell/input
- Very long numbers (e.g., 6+ decimal places) — right-alignment handles this naturally; column width is the constraining factor
- Mixed content columns (unlikely but possible) — if a column has both text and numbers, follow the column's declared type

## Open Questions

- Verify exactly which columns in DmpImportDialog are already right-aligned and which are missing (need code audit during planning)

## Acceptance

- [ ] All numeric columns in DataTable display right-aligned (headers and cells)
- [ ] All numeric columns in ShotTableEditor display right-aligned (headers and cells)
- [ ] All numeric columns in ImportDialog display right-aligned (headers and cells)
- [ ] All numeric columns in DmpImportDialog display right-aligned (headers and cells)
- [ ] DmpSelectionDialog numeric columns are right-aligned
- [ ] EditableTable input elements in right-aligned columns have `text-align: right`
- [ ] Text and ID columns remain left-aligned
- [ ] Global CSS default (`th, td { text-align: left }`) is unchanged
- [ ] E2E Playwright test verifies text-align on numeric cells
