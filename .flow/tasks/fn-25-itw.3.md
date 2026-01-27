## Description

Update project documentation (SPEC.md, TESTING.md) to reflect the new dropdown behavior and update the E2E test suite to cover all new and changed behaviors.

**Size:** M
**Files:**
- `docs/SPEC.md` (section 6.3 close behavior + scrolling, section 11.3 ARIA live)
- `docs/TESTING.md` (UndoHistoryDropdown testing section, lines ~640-750)
- `e2e-playwright/undo-redo-dropdown.spec.ts` (update existing + add new tests)

## Approach

### SPEC.md section 6.3 updates

**Close Behavior** (lines ~677-684): Replace current close behavior list with the updated rules from the epic spec. The dropdown now stays open on button click, item click, and keyboard shortcuts. It closes only on mouse leave, Escape, click outside, and empty stack.

**Scrolling** (lines ~665-669): Change "Maximum height: 10 items visible (~440px)" to "Fixed height: 5 items visible (~220px)".

**New subsection — Action Behavior**: Add after "Index Semantics" to document loading indicator, navigation reset, detail preview dismissal, rapid click queuing, and error handling behavior.

### SPEC.md section 11.3 update

Add undo/redo dropdown refresh to the "Announcement Events (Configurable)" list for ARIA live regions.

### TESTING.md updates

Update the UndoHistoryDropdown testing section (lines ~640-750):
- Update close behavior tests to reflect new rules (Ctrl+Z no longer closes)
- Add test patterns for: stay-open + refresh, loading indicator, navigation reset, empty stack close, aria-live announcements, error dialog

### E2E test updates

**Update existing tests that will break:**
- Tests expecting dropdown close after item click (lines ~290-291)
- Tests expecting dropdown close after Enter key (lines ~392-393)
- Tests expecting dropdown close on Ctrl+Z/Y (lines ~510-539)

**Add new tests for:**
- Button click keeps dropdown open and refreshes items
- Item click keeps dropdown open and refreshes items
- Ctrl+Z/Y keeps dropdown open and refreshes items
- Dropdown closes when stack becomes empty after action
- Loading indicator appears during refresh
- Navigation resets to top after refresh
- Detail preview dismisses on action
- Error dialog on backend failure (if testable via mock)
- aria-live announcements after refresh
- Rapid click queuing (multiple quick clicks all execute)
- Fixed 5-item height renders correctly

### Test identifiers

Use existing `data-testid` values documented in TESTING.md:
- `toolbar-undo-button`, `toolbar-redo-button`
- `toolbar-undo-button-dropdown`, `toolbar-redo-button-dropdown`
- `toolbar-undo-button-item-{index}`
- `detail-preview-popup`
- `error-dialog` (from ErrorDialog.tsx)

New test IDs to expect (from tasks 1 and 2):
- Loading indicator element (TBD by task 1)
- aria-live announcer span (TBD by task 2)

## Key context

- Wait for `aria-activedescendant` to be set before asserting keyboard navigation — components set it in `setTimeout(0)` (from project memory)
- Replace `waitForTimeout()` with deterministic assertions (`toHaveAttribute`, `toContainText`) to prevent flaky tests (from project memory)
- Use specific `data-testid` selectors, not generic CSS selectors (from project memory)
- Hover trigger test pattern: `await page.hover('[data-testid="toolbar-undo-button"]')` then `waitForSelector` (from TESTING.md:664-671)

## Acceptance

- [ ] SPEC.md section 6.3 Close Behavior updated with new rules
- [ ] SPEC.md section 6.3 Scrolling updated to 5 items / 220px
- [ ] SPEC.md section 6.3 has new Action Behavior subsection
- [ ] SPEC.md section 11.3 includes undo/redo dropdown refresh in announcement events
- [ ] TESTING.md UndoHistoryDropdown section updated with new test patterns
- [ ] Existing e2e tests that expected close-on-action are updated to expect stay-open
- [ ] New e2e test: button click keeps dropdown open and refreshes
- [ ] New e2e test: item click keeps dropdown open and refreshes
- [ ] New e2e test: Ctrl+Z/Y keeps dropdown open and refreshes
- [ ] New e2e test: dropdown closes on empty stack
- [ ] New e2e test: loading indicator appears during refresh
- [ ] New e2e test: navigation resets to top after refresh
- [ ] New e2e test: detail preview dismisses on action
- [ ] New e2e test: aria-live announcement after action
- [ ] All e2e tests pass: `pnpm test:ui`
- [ ] `pnpm tsc --noEmit` passes

## Done summary

<!-- filled on completion -->

## Evidence

<!-- filled on completion -->
