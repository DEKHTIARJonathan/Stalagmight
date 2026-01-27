# Right-align numeric columns in all data tables

## Overview

Numeric columns in data tables are inconsistently aligned. The main DataTable already right-aligns via the `align: 'right'` column prop, but ShotTableEditor (manual table), ImportDialog (manual table), and EditableTable inputs lack alignment. DmpImportDialog and DmpSelectionDialog are already mostly/fully done. This epic brings all tables to consistent Excel-like right-alignment.

## Scope

**In scope:**
- EditableTable input element alignment fix (`Table.tsx`)
- ShotTableEditor numeric headers + inputs (`ShotTableEditor.tsx`)
- ImportDialog numeric headers + inputs (`ImportDialog.tsx`)
- DmpImportDialog audit — verify existing alignment is complete (`DmpImportDialog.tsx`)
- DmpSelectionDialog audit — verify existing alignment is complete (`DmpSelectionDialog.tsx`)
- Playwright E2E test for numeric column alignment

**Out of scope:**
- Stats panels, non-table displays
- Form dialogs (EditShotDialog is a form, not a table)
- Column resizing or responsive behavior
- RTL language support
- Negative number coloring

## Approach

### EditableTable input fix (shared component)

The `Column<T>` interface at `Table.tsx:3-17` already has `align?: 'left' | 'center' | 'right'`. Headers and cells already get alignment classes via `alignmentClasses` mapping (`Table.tsx:144-148`). The **input element** at `Table.tsx:373-383` does NOT get the alignment class. Fix: add `${alignmentClasses[column.align ?? 'left']}` to the input's className. This automatically fixes DataTable's editable cells.

### Manual tables (ShotTableEditor, ImportDialog)

These tables don't use EditableTable — they have inline `<table>` with manually coded `<th>` and `<td>/<input>` elements. Add `text-right` class to:
- Header `<th>` elements for numeric columns
- Input elements and display `<td>` cells for numeric columns

Numeric columns by component:
- **ShotTableEditor**: Length, Azimuth, Depth In, Depth Out, L, R, U, D
- **ImportDialog**: Length, Azi In, Azi Out, Depth In, Depth Out

### DmpImportDialog / DmpSelectionDialog (audit only)

Per repo-scout findings:
- DmpImportDialog nested shot table already has `text-right` on L/R/U/D/Pitch headers and cells (lines 886-959). Section table has Shots column right-aligned.
- DmpSelectionDialog already has Shots column right-aligned (lines 321-325, 359).
- Audit these for completeness — may need no changes.

### Playwright test

Add E2E test verifying `text-align: right` computed style on numeric cells using `toHaveCSS('text-align', 'right')`. Test should cover:
- `<th>` headers for numeric columns
- `<td>` cells for numeric columns
- `<input>` elements inside editable numeric cells

## Risks / Dependencies

- **fn-31-mhl** (open) touches Table.tsx sticky header z-index — different code section, low conflict risk.
- **fn-33-i3r** (open) touches Table.tsx first-cell border styling at line 368 — same area as alignment classes. **Moderate conflict risk** if both in flight. They modify disjoint concerns (border vs text-align) but same className string.
- **Tailwind JIT**: `text-right` is a standard utility, already used in 12+ files — no purge risk.

## Test Notes

- Use `await expect(cell).toHaveCSS('text-align', 'right')` for Playwright assertions
- Test both `<td>` cells AND `<input>` elements inside editable cells
- Verify headers `<th>` match data cell alignment
- Test at least one representative table (DataTable or ShotTableEditor)
- Tests live in `e2e-playwright/` directory

## Key Context

- `alignmentClasses` at `Table.tsx:144-148` — maps `'right'` → `'text-right'`
- Column interface at `Table.tsx:3-17` — `align?: 'left' | 'center' | 'right'`
- Header alignment at `Table.tsx:306-312` — `${alignmentClasses[column.align ?? 'left']}`
- Cell alignment at `Table.tsx:366-368` — `${alignmentClasses[column.align ?? 'left']}`
- Input element at `Table.tsx:373-383` — missing alignment class (the bug)
- ShotTableEditor headers at `ShotTableEditor.tsx:312-321` — all `text-left`
- ShotTableEditor inputs — `className="w-16 text-xs px-1 py-0.5"` or `"w-10 text-xs px-1 py-0.5"` (no alignment)
- ImportDialog headers at `ImportDialog.tsx:118-128` — no alignment classes
- ImportDialog inputs at `ImportDialog.tsx:134-177` — no alignment classes
- DmpImportDialog nested shot table at `DmpImportDialog.tsx:886-959` — already has `text-right`
- DmpSelectionDialog at `DmpSelectionDialog.tsx:321-325, 359` — already has `text-right`
- Global CSS at `index.css:179-182` — `th, td { text-align: left }` (keep unchanged)
- Practice scout recommends also adding `tabular-nums` for numeric columns

## Quick commands

```bash
# Dev server
./scripts/dev.sh

# Type check
pnpm tsc --noEmit

# Playwright tests
pnpm test:ui
```

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
