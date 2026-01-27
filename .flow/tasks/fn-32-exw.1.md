## Description

Fix numeric column alignment in three components: (1) EditableTable's input element that doesn't inherit column alignment, (2) ShotTableEditor's manually coded table, and (3) ImportDialog's manually coded table. All numeric headers and cells/inputs should get `text-right` and `tabular-nums`.

**Size:** M
**Files:** `src/components/common/Table.tsx`, `src/components/common/ShotTableEditor.tsx`, `src/components/Dialogs/ImportDialog.tsx`

## Approach

### EditableTable input fix (`Table.tsx`)

The input element at `Table.tsx:381` has className `"w-full px-2 py-1 bg-transparent border-none focus:bg-panel"` — missing alignment. Add `${alignmentClasses[column.align ?? 'left']}` to this className string, using the same `alignmentClasses` mapping already used for headers (line 54) and cells (line 100, 368).

Also add `tabular-nums` to numeric cells. Consider whether to add it conditionally (only when `align === 'right'`) or always.

### ShotTableEditor (`ShotTableEditor.tsx`)

Manual table — not using EditableTable. Fix:
- Headers at lines 312-323: change numeric column `<th>` elements from `text-left` to `text-right` (Length, Azimuth, Depth In, Depth Out, L, R, U, D)
- Input elements at lines 349-485: add `text-right tabular-nums` class to each numeric input's className
- Keep non-numeric columns left-aligned: # (row number)
- Keep centered columns: Warnings (text-center icon), Delete button

### ImportDialog (`ImportDialog.tsx`)

Manual table — not using EditableTable. Fix:
- Headers at lines 120-127: add `text-right` to numeric column `<th>` elements (Length, Azi In, Azi Out, Depth In, Depth Out)
- Input elements at lines 134-177: add `text-right tabular-nums` to numeric input classNames
- Keep # column left-aligned
- Keep Virtual column centered (already has `text-center` at line 179)

## Key context

- `alignmentClasses` at `Table.tsx:38-42`: `{ left: 'text-left', center: 'text-center', right: 'text-right' }`
- Column interface at `Table.tsx:3-17`: `align?: 'left' | 'center' | 'right'`
- Header alignment pattern at `Table.tsx:54`: `${alignmentClasses[column.align ?? 'left']}`
- Cell alignment pattern at `Table.tsx:100, 368`: `${alignmentClasses[column.align ?? 'left']}`
- ShotTableEditor numeric inputs: `className="w-16 text-xs px-1 py-0.5"` (Length, Azimuth, Depths) and `"w-10 text-xs px-1 py-0.5"` (LRUD)
- ImportDialog numeric inputs: `className="w-full"` — no alignment class
- Global CSS `th, td { text-align: left }` at `index.css:179-182` — do NOT change
- `tabular-nums` is standard Tailwind utility: `font-variant-numeric: tabular-nums`
- fn-33-i3r conflict risk: both modify Table.tsx line 368 className — disjoint concerns, easy merge

## Acceptance

- [ ] EditableTable input elements in right-aligned columns have `text-right` class
- [ ] ShotTableEditor numeric column headers are right-aligned
- [ ] ShotTableEditor numeric inputs are right-aligned with `tabular-nums`
- [ ] ImportDialog numeric column headers are right-aligned
- [ ] ImportDialog numeric inputs are right-aligned with `tabular-nums`
- [ ] Text/ID columns remain left-aligned in all three components
- [ ] Checkbox/icon columns remain centered
- [ ] Global CSS default unchanged
- [ ] `pnpm tsc --noEmit` passes

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
