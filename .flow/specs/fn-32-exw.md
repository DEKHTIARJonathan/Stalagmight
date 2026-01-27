# Right-align numeric columns in all data tables

## Overview

Numeric columns in data tables are inconsistently aligned. The main DataTable already right-aligns via the `align: 'right'` column prop, but ShotTableEditor (manual table), ImportDialog (manual table), and EditableTable inputs lack alignment. DmpImportDialog and DmpSelectionDialog are already mostly/fully done. This epic brings all tables to consistent Excel-like right-alignment.

## Scope

**In scope:**
- EditableTable input element alignment fix (`Table.tsx`)
- ShotTableEditor numeric headers, cells, and inputs (`ShotTableEditor.tsx`)
- ImportDialog numeric headers, cells, and inputs (`ImportDialog.tsx`)
- DmpImportDialog audit — verify existing alignment is complete (`DmpImportDialog.tsx`)
- DmpSelectionDialog audit — verify existing alignment is complete (`DmpSelectionDialog.tsx`)
- Playwright E2E test for numeric column alignment (DataTable, ShotTableEditor, ImportDialog)

**Out of scope:**
- Stats panels, non-table displays
- Form dialogs (EditShotDialog is a form, not a table)
- Column resizing or responsive behavior
- RTL language support
- Negative number coloring
- `tabular-nums` font variant (nice-to-have, not required)

**Column classification:**
- **Numeric data columns** (right-aligned): Length, Azimuth, Depth In, Depth Out, L, R, U, D, Azi In, Azi Out, Shots count, Pitch
- **Ordinal/identifier columns** (left-aligned): Row index (#), Shot ID, From, To, station names, section names
- Index/row number columns are ordinal identifiers, not comparative numeric data, so they stay left-aligned

## Approach

### EditableTable input fix (shared component)

The `Column<T>` interface at `Table.tsx:3-17` already has `align?: 'left' | 'center' | 'right'`. Headers and cells already get alignment classes via `alignmentClasses` mapping (`Table.tsx:144-148`). The **input element** at `Table.tsx:373-383` does NOT get the alignment class. Fix: add `${alignmentClasses[column.align ?? 'left']}` to the input's className.

### Manual tables (ShotTableEditor, ImportDialog)

These tables don't use EditableTable. Add `text-right` class to:
- Header `<th>` elements for numeric columns
- **`<td>` cell wrappers** for numeric columns (so the input element is right-aligned within the cell)
- Input elements for numeric columns (so text within the input is right-aligned)

Both `<td>` and `<input>` need `text-right` because the input may be narrower than the cell (e.g., LRUD inputs use `w-10` under a wider `<th>`).

### DmpImportDialog / DmpSelectionDialog (audit only)

Code audit only. DmpImportDialog is not mountable via standard App.tsx navigation, so no Playwright test — audit by reading code. DmpSelectionDialog already has Shots column right-aligned.

### Playwright test

E2E test covers three testable table contexts: DataTable (EditableTable), ShotTableEditor, ImportDialog. DmpImportDialog excluded from Playwright (not mountable via UI). Test uses seeded data via existing helpers.

## Risks / Dependencies

- **fn-31-mhl** (open) touches Table.tsx sticky header z-index — different code section, low conflict risk.
- **fn-33-i3r** (open) touches Table.tsx first-cell border styling — moderate conflict risk in same className area.

## Test Notes

- Use `await expect(cell).toHaveCSS('text-align', 'right')` for Playwright assertions
- Seed data using existing helpers before testing
- Cover DataTable, ShotTableEditor, ImportDialog in Playwright
- DmpImportDialog verified via code audit only (not mountable in UI)
- Use role-based selectors for manual tables, data-testid for EditableTable

## Key Context

- `alignmentClasses` at `Table.tsx:144-148` — maps `'right'` → `'text-right'`
- Input element at `Table.tsx:373-383` — missing alignment class (the bug)
- ShotTableEditor headers at `ShotTableEditor.tsx:312-321` — all `text-left`
- ImportDialog headers at `ImportDialog.tsx:118-128` — no alignment classes
- DmpImportDialog nested shot table at `DmpImportDialog.tsx:886-959` — already has `text-right`
- DmpSelectionDialog at `DmpSelectionDialog.tsx:321-325, 359` — already has `text-right`
- Global CSS at `index.css:179-182` — `th, td { text-align: left }` (keep unchanged)

## Quick commands

```bash
./scripts/dev.sh
pnpm tsc --noEmit
pnpm test:ui
```

## Acceptance

- [ ] All numeric columns in DataTable display right-aligned (headers and cells)
- [ ] All numeric columns in ShotTableEditor display right-aligned (headers, cells, and inputs)
- [ ] All numeric columns in ImportDialog display right-aligned (headers, cells, and inputs)
- [ ] All numeric columns in DmpImportDialog verified right-aligned (code audit)
- [ ] DmpSelectionDialog numeric columns are right-aligned
- [ ] EditableTable input elements in right-aligned columns have `text-align: right`
- [ ] Ordinal/identifier columns remain left-aligned
- [ ] Global CSS default (`th, td { text-align: left }`) is unchanged
- [ ] E2E Playwright test covers DataTable, ShotTableEditor, and ImportDialog
