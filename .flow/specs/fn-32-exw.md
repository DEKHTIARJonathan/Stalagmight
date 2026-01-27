# Right-align numeric columns in all data tables

## Overview

Numeric columns in data tables are inconsistently aligned. The main DataTable already right-aligns via the `align: 'right'` column prop, but ShotTableEditor (manual table), ImportDialog (manual table), and EditableTable inputs lack alignment. DmpImportDialog and DmpSelectionDialog are already mostly/fully done. This epic brings all tables to consistent Excel-like right-alignment.

Additionally, `tabular-nums` (font-variant-numeric: tabular-nums) will be applied alongside `text-right` for all numeric columns. This ensures all digits render at equal width, preventing jitter and improving vertical alignment of numbers — a standard best practice for data tables (confirmed by Tailwind docs, W3C WAI, Grafana, and A List Apart).

## Scope

**In scope:**
- EditableTable input element alignment fix (`Table.tsx`)
- ShotTableEditor numeric headers + inputs (`ShotTableEditor.tsx`)
- ImportDialog numeric headers + inputs (`ImportDialog.tsx`)
- DmpImportDialog audit — verify existing alignment is complete (`DmpImportDialog.tsx`)
- DmpSelectionDialog audit — verify existing alignment is complete (`DmpSelectionDialog.tsx`)
- Add `tabular-nums` class alongside `text-right` on all numeric columns
- Playwright E2E test for numeric column alignment

**Out of scope:**
- Stats panels, non-table displays
- Form dialogs (EditShotDialog is a form, not a table)
- Settings form numeric inputs (already have `text-right`, use form patterns not table patterns)
- Column resizing or responsive behavior
- RTL language support
- Negative number coloring
- Decimal-point alignment (beyond right-align + tabular-nums)

## Approach

### EditableTable input fix (shared component)

The `Column<T>` interface at `Table.tsx:3-17` already has `align?: 'left' | 'center' | 'right'`. Headers and cells already get alignment classes via `alignmentClasses` mapping (`Table.tsx:38-42`). The **input element** at `Table.tsx:381` does NOT get the alignment class. Fix: add `${alignmentClasses[column.align ?? 'left']}` to the input's className. This automatically fixes DataTable's editable cells.

### Manual tables (ShotTableEditor, ImportDialog)

These tables don't use EditableTable — they have inline `<table>` with manually coded `<th>` and `<td>/<input>` elements. Add `text-right` class to:
- Header `<th>` elements for numeric columns
- Input elements and display `<td>` cells for numeric columns

Also add `tabular-nums` to numeric cell/input elements for consistent digit widths.

Numeric columns by component:
- **ShotTableEditor**: Length, Azimuth, Depth In, Depth Out, L, R, U, D
- **ImportDialog**: Length, Azi In, Azi Out, Depth In, Depth Out

Non-numeric columns to keep left/center-aligned:
- ShotTableEditor: # (row number), Warnings (text-center icon), Delete button
- ImportDialog: # (row number), Virtual (text-center checkbox), Delete button

### DmpImportDialog / DmpSelectionDialog (audit only)

Per repo-scout findings:
- DmpImportDialog nested shot table already has `text-right` on L/R/U/D/Pitch headers and cells (lines 886-959). Section table has Shots column right-aligned (lines 820-828, 879).
- DmpSelectionDialog already has Shots column right-aligned (lines 321-325, 359).
- Audit these for completeness — verify all numeric columns have `text-right`. Check if Azi In/Out, Length are also right-aligned in DmpImportDialog shot detail table.
- Add `tabular-nums` if missing from numeric cells.

### tabular-nums strategy

Apply `tabular-nums` alongside `text-right` on numeric cells. For EditableTable, consider adding it to the `alignmentClasses` mapping or as a separate concern. For manual tables, add directly to className strings.

### Playwright test

Add E2E test verifying `text-align: right` computed style on numeric cells using `toHaveCSS('text-align', 'right')`. Test should cover:
- `<th>` headers for numeric columns
- `<td>` cells for numeric columns
- `<input>` elements inside editable numeric cells
- Negative test: verify text/ID columns remain `text-align: left`
- Verify checkbox/icon columns (Virtual, Warnings) remain centered

## Risks / Dependencies

- **fn-31-mhl** (open) touches Table.tsx sticky header z-index — different code section, low conflict risk.
- **fn-33-i3r** (open) touches Table.tsx first-cell border styling at line 368 — same className string area. **Moderate conflict risk** if both in flight. They modify disjoint concerns (border vs text-align) but same className string. Easy to merge manually.
- **Tailwind JIT**: `text-right` is a standard utility, already used in 12+ files — no purge risk. `tabular-nums` is also standard Tailwind utility.
- **Global CSS**: `index.css:179-182` sets `th, td { text-align: left }` — Tailwind `text-right` class has sufficient specificity to override this. Do NOT change global CSS.

## Test Notes

- Use `await expect(cell).toHaveCSS('text-align', 'right')` for Playwright assertions
- Test both `<td>` cells AND `<input>` elements inside editable cells
- Verify headers `<th>` match data cell alignment
- Test at least one representative table (DataTable or ShotTableEditor)
- Include negative test: text/ID columns still `text-align: left`
- Existing data-testid attributes available: `shot-length-{index}`, `shot-azimuth-{index}`, `shot-depth-in-{index}`, etc.
- Test helpers: `setupMockedPage()`, `createProject()`, `seedProjectWithSections()`
- Tests live in `e2e-playwright/` directory

## Key Context

- `alignmentClasses` at `Table.tsx:38-42` — maps `'right'` → `'text-right'`
- Column interface at `Table.tsx:3-17` — `align?: 'left' | 'center' | 'right'`
- Header alignment at `Table.tsx:54` — `${alignmentClasses[column.align ?? 'left']}`
- Cell alignment at `Table.tsx:100` and `Table.tsx:368` — `${alignmentClasses[column.align ?? 'left']}`
- Input element at `Table.tsx:381` — missing alignment class (the bug)
- ShotTableEditor headers at `ShotTableEditor.tsx:312-323` — all `text-left`
- ShotTableEditor inputs — `className="w-16 text-xs px-1 py-0.5"` or `"w-10 text-xs px-1 py-0.5"` (no alignment)
- ImportDialog headers at `ImportDialog.tsx:120-127` — no alignment classes
- ImportDialog inputs at `ImportDialog.tsx:134-177` — no alignment classes
- DmpImportDialog nested shot table at `DmpImportDialog.tsx:886-959` — already has `text-right`
- DmpSelectionDialog at `DmpSelectionDialog.tsx:321-325, 359` — already has `text-right`
- Global CSS at `index.css:179-182` — `th, td { text-align: left }` (keep unchanged)
- Settings numeric inputs already use `text-right` (form pattern, not table)
- `tabular-nums` Tailwind utility maps to `font-variant-numeric: tabular-nums`

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
- [ ] Numeric columns use `tabular-nums` for consistent digit widths
- [ ] Text and ID columns remain left-aligned
- [ ] Checkbox/icon columns (Virtual, Warnings) remain centered
- [ ] Global CSS default (`th, td { text-align: left }`) is unchanged
- [ ] E2E Playwright test verifies text-align on numeric cells
- [ ] `pnpm tsc --noEmit` passes
- [ ] `pnpm test:ui` passes
