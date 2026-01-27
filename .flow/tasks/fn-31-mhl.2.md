## Description

Update all existing Playwright e2e tests broken by the Select portal change, add new e2e tests verifying the fix works correctly, and update TESTING.md with Select component test patterns.

**Size:** M
**Files:**
- `e2e-playwright/export-dialog.spec.ts` (update `.absolute` selectors to use role/id-based selectors)
- `e2e-playwright/export-preview.spec.ts` (update `.absolute` selectors)
- `e2e-playwright/export-color-modes.spec.ts` (update `.absolute` selectors)
- `e2e-playwright/panel-interactions.spec.ts` (update scoped option selectors)
- `e2e-playwright/id-zero-regression.spec.ts` (update scoped option selectors)
- `e2e-playwright/select-dropdown.spec.ts` (new test file)
- `docs/TESTING.md` (add Select portal test patterns)

## Approach

### Update existing tests (CRITICAL — these will break)

The portal change moves the listbox from inside the Select container to `document.body`. All existing tests that locate options via `.absolute` class scoped under the select container must be updated.

**Pattern to replace:**
- `formatSelect.locator('.absolute')` → locate the open listbox globally
- `formatSelect.locator('.absolute [role="option"]')` → locate options globally

**Replacement strategy:** Use the `aria-controls` attribute on the trigger button to find the associated listbox by ID:
```
const trigger = page.getByTestId('data-format-select').locator('button');
await trigger.click();
const listboxId = await trigger.getAttribute('aria-controls');
const listbox = page.locator(`#${listboxId}`);
```
Or use `page.getByRole('listbox')` when only one listbox is open at a time.

**Files with `.absolute` selectors to update:**
- `export-dialog.spec.ts` lines ~52, 79, 111, 266
- `export-preview.spec.ts` line ~312
- `export-color-modes.spec.ts` lines ~121, 147, 153, 177, 183, 213, 368, 395

**Files scoping options under select container:**
- `id-zero-regression.spec.ts` line ~301: `sectionSelect.locator('[role="option"]')` — may still work if `role="option"` is on the trigger's descendant, but verify
- `panel-interactions.spec.ts` lines ~281-287: similar pattern

### New e2e tests

Create `e2e-playwright/select-dropdown.spec.ts` with tests for the DataTable section selector.

**Tests:**

1. **Dropdown visible above sticky header (z-order proof)**: Open the section selector dropdown while table header is sticky. Use `document.elementFromPoint()` at an overlapping coordinate to verify the dropdown option is the topmost element, not the sticky header. This proves z-order, not just visibility.

2. **Close on external scroll**: Open dropdown, scroll the page or table container, verify dropdown closes. Ensure this is an external scroll (not inside the dropdown).

3. **Internal scroll preserved**: Open dropdown with many options (if possible), scroll inside the listbox, verify dropdown stays open.

4. **Keyboard navigation**: Open dropdown via Enter/Space on trigger, navigate with ArrowDown/ArrowUp, select with Enter, close with Escape. Verify `aria-activedescendant` updates. Note: Select.tsx sets `aria-activedescendant` directly from state (no setTimeout), so standard assertions work — no need for timing workarounds.

5. **Click outside closes**: Open dropdown, click elsewhere on the page, verify dropdown closes.

### Test selectors (portal-aware)

With portal, the listbox is at `document.body` level. Use:
- Trigger: `[data-testid="data-table-section-select"] button` or `page.getByRole('combobox')`
- Listbox: `page.getByRole('listbox')` or locate by `aria-controls` ID from trigger
- Options: `page.getByRole('option')` scoped to the listbox

### TESTING.md update

Add a "Testing Select Dropdowns (Portal)" subsection. Document:
- Portal rendering means listbox is in `document.body`, not inside component container
- Do NOT use `.absolute` class to locate dropdown — use `aria-controls`/`role="listbox"` instead
- Use `document.elementFromPoint()` to verify z-order in stacking context tests
- Scroll-close only fires for external scroll — internal dropdown scroll is ignored
- `aria-activedescendant` is set synchronously (no setTimeout workaround needed for Select)

## Key context

- Do NOT use `.absolute` to locate portaled dropdowns — this class no longer applies to portaled elements
- Use `page.getByRole('listbox')` or `aria-controls` ID linkage from trigger
- `document.elementFromPoint()` is the correct way to verify z-order/stacking — `toBeVisible()` alone cannot detect "behind sticky header"
- Select.tsx sets `aria-activedescendant` directly from state, no setTimeout — standard assertions work
- Replace `waitForTimeout()` with deterministic assertions (from project memory)
- Use specific `data-testid` selectors, not generic CSS selectors (from project memory)

## Acceptance

- [ ] All existing e2e tests updated to work with portaled Select (no `.absolute` selectors)
- [ ] Existing tests in export-dialog.spec.ts pass
- [ ] Existing tests in export-preview.spec.ts pass
- [ ] Existing tests in export-color-modes.spec.ts pass
- [ ] Existing tests in panel-interactions.spec.ts pass
- [ ] Existing tests in id-zero-regression.spec.ts pass
- [ ] New e2e test: dropdown visible above sticky header (elementFromPoint z-order proof)
- [ ] New e2e test: dropdown closes on external scroll
- [ ] New e2e test: keyboard navigation works (ArrowDown/Up, Enter, Escape)
- [ ] New e2e test: click outside closes dropdown
- [ ] All tests pass: `pnpm test:ui`
- [ ] No existing tests broken
- [ ] TESTING.md updated with Select portal test patterns
- [ ] `pnpm tsc --noEmit` passes

## Done summary

<!-- filled on completion -->

## Evidence

<!-- filled on completion -->
