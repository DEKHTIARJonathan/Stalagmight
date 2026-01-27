## Description

Audit DmpImportDialog and DmpSelectionDialog for any remaining numeric alignment gaps, then add a Playwright E2E test verifying `text-align: right` on numeric columns across all data tables.

**Size:** M
**Files:** `src/components/Dialogs/DmpImportDialog.tsx`, `src/components/Dialogs/DmpSelectionDialog.tsx`, `e2e-playwright/table-alignment.spec.ts` (new)

## Approach

### DmpImportDialog audit (`DmpImportDialog.tsx`)

Per repo-scout findings, the nested shot table already has `text-right` on L/R/U/D/Pitch headers (lines 886-894) and cells (lines 920-959). Section selection table has Shots column right-aligned (lines 820-828, 879). Verify:
- All numeric headers have `text-right`
- All numeric cells have `text-right`
- Non-numeric columns (Name, Date, Dir, Index, Comment) remain left-aligned
- Fix any gaps found

### DmpSelectionDialog audit (`DmpSelectionDialog.tsx`)

Per repo-scout findings, Shots column is already right-aligned (header line 325, cell line 359). Verify completeness. May need no changes.

### Playwright E2E test

Create a new test file that verifies numeric column alignment. Use `toHaveCSS('text-align', 'right')` assertion pattern.

Test should verify:
- `<th>` headers for numeric columns have `text-align: right`
- `<td>` cells for numeric columns have `text-align: right`
- `<input>` elements inside editable numeric cells have `text-align: right`
- At least one representative table (DataTable or ShotTableEditor)
- Text/ID columns still have `text-align: left`

Follow existing test patterns in `e2e-playwright/` directory (data-testid selectors, timeout patterns). Tests in this project use `e2e-playwright/` for Playwright specs.

## Key context

- DmpImportDialog nested shot table headers at lines 886-894: L/R/U/D/Pitch already `text-right`
- DmpImportDialog nested shot table cells at lines 920-959: already `text-right`
- DmpImportDialog section table Shots column at lines 820-828: already `text-right`
- DmpSelectionDialog Shots column at lines 321-325, 359: already `text-right`
- Playwright assertion: `await expect(locator).toHaveCSS('text-align', 'right')`
- Test selectors: `data-testid="table-cell-{rowKey}-{columnKey}"` pattern in EditableTable

## Acceptance

- [ ] DmpImportDialog numeric columns verified right-aligned (fix if any gaps)
- [ ] DmpSelectionDialog numeric columns verified right-aligned
- [ ] New Playwright test file verifies `text-align: right` on numeric column headers
- [ ] New Playwright test file verifies `text-align: right` on numeric column cells
- [ ] New Playwright test file verifies `text-align: right` on numeric input elements
- [ ] Test verifies text/ID columns remain left-aligned
- [ ] `pnpm tsc --noEmit` passes
- [ ] `pnpm test:ui` passes

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
