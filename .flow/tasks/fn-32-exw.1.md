## Description

Fix numeric column alignment in three components: (1) EditableTable's input element that doesn't inherit column alignment, (2) ShotTableEditor's manually coded table, and (3) ImportDialog's manually coded table. All numeric headers, `<td>` cells, and inputs should get `text-right`.

**Size:** M
**Files:** `src/components/common/Table.tsx`, `src/components/common/ShotTableEditor.tsx`, `src/components/Dialogs/ImportDialog.tsx`

## Approach

### EditableTable input fix (`Table.tsx`)

The input element at `Table.tsx:373-383` has className `"w-full px-2 py-1 bg-transparent border-none focus:bg-panel"` — missing alignment. Add `${alignmentClasses[column.align ?? 'left']}` to this className string, using the same `alignmentClasses` mapping already used for headers (line 306) and cells (line 366).

### ShotTableEditor (`ShotTableEditor.tsx`)

Manual table — not using EditableTable. Fix:
- Headers at lines 312-321: change numeric column `<th>` elements from `text-left` to `text-right` (Length, Azimuth, Depth In, Depth Out, L, R, U, D)
- `<td>` cell wrappers: add `text-right` to each numeric column's `<td>` so the input element is right-aligned within the cell (inputs use `w-16` or `w-10` which may be narrower than the column)
- Input elements at lines 348-485: add `text-right` to each numeric input's className
- Keep text/index columns left-aligned: row index (#), From, To

### ImportDialog (`ImportDialog.tsx`)

Manual table — not using EditableTable. Fix:
- Headers at lines 118-128: add `text-right` to numeric column `<th>` elements (Length, Azi In, Azi Out, Depth In, Depth Out)
- `<td>` cell wrappers: add `text-right` to numeric column `<td>` elements
- Input elements at lines 134-177: add `text-right` to numeric input classNames
- Keep row index (#) column left-aligned

## Key context

- `alignmentClasses` at `Table.tsx:144-148`: `{ left: 'text-left', center: 'text-center', right: 'text-right' }`
- Column interface at `Table.tsx:3-17`: `align?: 'left' | 'center' | 'right'`
- Header alignment pattern at `Table.tsx:306-312`: `${alignmentClasses[column.align ?? 'left']}`
- Cell alignment pattern at `Table.tsx:366-368`: `${alignmentClasses[column.align ?? 'left']}`
- ShotTableEditor numeric inputs: `className="w-16 text-xs px-1 py-0.5"` (Length, Azimuth, Depths) and `"w-10 text-xs px-1 py-0.5"` (LRUD) — narrower than column, need `text-right` on `<td>` too
- ImportDialog numeric inputs: similar pattern, no alignment class
- Global CSS `th, td { text-align: left }` at `index.css:179-182` — do NOT change

## Acceptance

- [ ] EditableTable input elements in right-aligned columns have `text-right` class
- [ ] ShotTableEditor numeric column headers are right-aligned
- [ ] ShotTableEditor numeric `<td>` cells are right-aligned
- [ ] ShotTableEditor numeric inputs are right-aligned
- [ ] ImportDialog numeric column headers are right-aligned
- [ ] ImportDialog numeric `<td>` cells are right-aligned
- [ ] ImportDialog numeric inputs are right-aligned
- [ ] Text/index columns remain left-aligned in all three components
- [ ] Global CSS default unchanged
- [ ] `pnpm tsc --noEmit` passes

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
