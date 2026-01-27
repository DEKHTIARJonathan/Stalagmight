## Description

Audit DmpImportDialog and DmpSelectionDialog for any remaining numeric alignment gaps, then add a Playwright E2E test verifying `text-align: right` on numeric columns across testable table contexts.

**Size:** M
**Files:** `src/components/Dialogs/DmpImportDialog.tsx`, `src/components/Dialogs/DmpSelectionDialog.tsx`, `e2e-playwright/table-alignment.spec.ts` (new)

## Approach

### DmpImportDialog audit (`DmpImportDialog.tsx`) — code audit only, no Playwright test

DmpImportDialog is not directly mountable via App.tsx UI (no standard navigation path), so it cannot be tested via Playwright. Audit by reading the code:
- Verify all numeric headers have `text-right` (nested shot table L/R/U/D/Pitch at lines 886-894)
- Verify all numeric cells have `text-right` (lines 920-959)
- Verify non-numeric columns (Name, Date, Dir, Index, Comment) remain left-aligned
- Fix any gaps found in the code

### DmpSelectionDialog audit (`DmpSelectionDialog.tsx`)

Per repo-scout findings, Shots column is already right-aligned (header line 325, cell line 359). Verify completeness. May need no changes.

### Playwright E2E test

Create `e2e-playwright/table-alignment.spec.ts` covering alignment across **three testable table contexts** (DmpImportDialog excluded — audit-only):

**Test setup**: Use existing helpers (e.g., `seedProjectWithSections`) to seed shot data before opening tables. Without seeded data, DataTable may be empty.

1. **DataTable (EditableTable)**: Seed data, open data table panel (Ctrl+3), verify numeric input has `text-align: right`. Use `data-testid="table-cell-{rowKey}-{columnKey}"` for inputs; navigate to ancestor `td` for cell assertion.
2. **ShotTableEditor**: Seed data, open Edit Section dialog, verify numeric `<th>` and `<td>`/`<input>` have `text-align: right`. Use `getByRole('columnheader', { name: 'Length' })` scoped to dialog.
3. **ImportDialog**: Open Import/Create Section dialog, verify numeric `<th>` and `<input>` have `text-align: right`. Use `getByRole('columnheader', { name: 'Depth In' })` scoped to `data-testid="import-section-dialog"`.

Also verify at least one text/index column has `text-align: left` (negative test).

**Note on index columns**: Row index (#) columns are ordinal identifiers, not comparative numeric data. They stay left-aligned across all tables. This is consistent with the epic's scope ("only numeric data columns — length, azimuth, depths, LRUD").

**Selector strategy**:
- **EditableTable**: `data-testid="table-cell-{rowKey}-{columnKey}"` for inputs
- **Manual tables**: `getByRole('columnheader', { name: '...' })` scoped to dialog `data-testid`
- **Headers**: role-based selectors (`columnheader`) scoped to table container
- **Cells**: role-based or nth-child selectors scoped to table

## Key context

- DmpImportDialog is not mountable via standard App.tsx navigation — audit-only
- DmpImportDialog nested shot table headers at lines 886-894: L/R/U/D/Pitch already `text-right`
- DmpImportDialog nested shot table cells at lines 920-959: already `text-right`
- DmpSelectionDialog Shots column at lines 321-325, 359: already `text-right`
- Playwright assertion: `await expect(locator).toHaveCSS('text-align', 'right')`
- EditableTable test selectors: `data-testid="table-cell-{rowKey}-{columnKey}"` on `<input>`
- ImportDialog container: `data-testid="import-section-dialog"`
- DataTable container: `data-testid="data-table"`
- Use `seedProjectWithSections` or similar helpers to seed data before testing

## Acceptance

- [ ] DmpImportDialog numeric columns verified right-aligned via code audit (fix if any gaps)
- [ ] DmpSelectionDialog numeric columns verified right-aligned
- [ ] Playwright test seeds data using existing helpers
- [ ] Playwright test covers DataTable (EditableTable) numeric input and cell alignment
- [ ] Playwright test covers ShotTableEditor numeric header, cell, and input alignment
- [ ] Playwright test covers ImportDialog numeric header, cell, and input alignment
- [ ] Playwright test verifies text/index column stays left-aligned (negative test)
- [ ] `pnpm tsc --noEmit` passes
- [ ] `pnpm test:ui` passes

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
