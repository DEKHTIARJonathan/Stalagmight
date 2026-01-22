# fn-14-3zg.7 Testing: E2E Playwright tests for undo/redo dropdown

## Description
Create E2E Playwright tests for the undo/redo history dropdown covering hover, click, keyboard, and edge cases.

**Size:** M
**Files:**
- `e2e-playwright/undo-redo-dropdown.spec.ts` - New test file

## Approach

1. Test dropdown appears after hover delay
2. Test clicking item executes multi-step undo (index N = N+1 undos)
3. Test keyboard navigation (Arrow Down, arrows, Enter, Escape)
4. Test detail preview appears on item hover
5. Test empty state (no dropdown when nothing to undo/redo)
6. Test dropdown closes on Ctrl+Z shortcut

## Key Context

- Follow existing Playwright patterns in `e2e-playwright/`
- Use setupTauriMocks() pattern from `settings-shortcuts.spec.ts`
- May need to mock invoke('get_undo_stack') responses
- Test with `data-testid` attributes added to dropdown elements
- Index semantics: clicking item at index 2 = 3 undos (indices 0,1,2)

## Acceptance
- [ ] Test: dropdown appears after ~300ms hover on Undo button
- [ ] Test: dropdown appears after ~300ms hover on Redo button
- [ ] Test: clicking item at index 2 executes 3 undos (indices 0,1,2)
- [ ] Test: Arrow Down opens dropdown from focused button
- [ ] Test: Arrow keys navigate items
- [ ] Test: Enter selects item and closes dropdown
- [ ] Test: Escape closes dropdown
- [ ] Test: detail preview appears on item hover
- [ ] Test: no dropdown when canUndo is false
- [ ] Test: dropdown closes on Ctrl+Z
- [ ] pnpm test:ui passes

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
