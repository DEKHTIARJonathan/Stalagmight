## Description

Audit DmpImportDialog and DmpSelectionDialog for any remaining numeric alignment gaps (add `tabular-nums` if missing), then add a Playwright E2E test verifying `text-align: right` on numeric columns across data tables.

**Size:** M
**Files:** `src/components/Dialogs/DmpImportDialog.tsx`, `src/components/Dialogs/DmpSelectionDialog.tsx`, `e2e-playwright/table-alignment.spec.ts` (new)

## Approach

### DmpImportDialog audit (`DmpImportDialog.tsx`)

Per repo-scout findings, the nested shot table already has `text-right` on L/R/U/D/Pitch headers (lines 890-894) and cells (lines 921-945). Section selection table has Shots column right-aligned (lines 826, 879). Verify:
- All numeric headers have `text-right`
- All numeric cells have `text-right`
- Add `tabular-nums` to numeric cells if missing
- Non-numeric columns (Name, Date, Dir, Index, Comment) remain left-aligned
- Check if Azi In, Azi Out, Length columns in shot detail table also need alignment
- Fix any gaps found

### DmpSelectionDialog audit (`DmpSelectionDialog.tsx`)

Per repo-scout findings, Shots column is already right-aligned (header line 325, cell line 359). Verify completeness:
- Add `tabular-nums` if missing
- May need no other changes

### Playwright E2E test

Create `e2e-playwright/table-alignment.spec.ts` verifying numeric column alignment. Use `toHaveCSS('text-align', 'right')` assertion pattern.

Test should verify:
- `<th>` headers for numeric columns have `text-align: right`
- `<td>` cells for numeric columns have `text-align: right`
- `<input>` elements inside editable numeric cells have `text-align: right`
- At least one representative table (ShotTableEditor via Edit Section dialog)
- Negative test: text/ID columns still have `text-align: left`
- Negative test: checkbox/icon columns (Virtual, Warnings) remain centered

Follow existing test patterns in `e2e-playwright/` directory:
- Use `setupMockedPage()`, `createProject()`, `seedProjectWithSections()` helpers
- Use existing data-testid selectors: `shot-length-{index}`, `shot-azimuth-{index}`, `shot-depth-in-{index}`, etc.
- Follow timeout patterns from existing specs

## Key context

- DmpImportDialog nested shot table headers at lines 890-894: L/R/U/D/Pitch already `text-right`
- DmpImportDialog nested shot table cells at lines 921-945: already `text-right`
- DmpImportDialog section table Shots column at lines 826, 879: already `text-right`
- DmpSelectionDialog Shots column at lines 325, 359: already `text-right`
- Playwright assertion: `await expect(locator).toHaveCSS('text-align', 'right')`
- For tabular-nums: `await expect(locator).toHaveCSS('font-variant-numeric', 'tabular-nums')`
- Test selectors: `data-testid="shot-length-{index}"`, `data-testid="shot-azimuth-{index}"`, etc.
- Test helpers in `e2e-playwright/helpers/app.ts`: `setupMockedPage()`, `createProject()`, `seedProjectWithSections()`
- Existing test patterns in `e2e-playwright/section-shot-editing.spec.ts` for dialog interaction

## Acceptance

- [ ] DmpImportDialog numeric columns verified right-aligned (fix any gaps)
- [ ] DmpImportDialog numeric columns have `tabular-nums`
- [ ] DmpSelectionDialog numeric columns verified right-aligned
- [ ] DmpSelectionDialog numeric columns have `tabular-nums`
- [ ] New Playwright test file verifies `text-align: right` on numeric column headers
- [ ] New Playwright test file verifies `text-align: right` on numeric column cells
- [ ] New Playwright test file verifies `text-align: right` on numeric input elements
- [ ] Test verifies text/ID columns remain left-aligned
- [ ] `pnpm tsc --noEmit` passes
- [ ] `pnpm test:ui` passes

## Done summary
Added tabular-nums to DmpImportDialog (Shots count, L/R/U/D/Pitch cells) and DmpSelectionDialog (Shots column). Created Playwright E2E test (table-alignment.spec.ts) with 4 cases verifying text-align: right on numeric headers/inputs, tabular-nums font variant, and left/center alignment on text/icon columns. All 552 tests pass.
## Evidence
- Commits: 0258870
- Tests: e2e-playwright/table-alignment.spec.ts: 4 test cases, all passing
- PRs: