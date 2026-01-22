# fn-14-3zg.6 Integration: Wire dropdown to Toolbar with chevron indicator

## Description
Integrate UndoHistoryDropdown into Toolbar component and add chevron indicator to Undo/Redo buttons.

**Size:** S
**Files:**
- `src/components/SingleSystemView/Toolbar.tsx` - Wrap buttons with dropdown, add chevron

## Approach

1. Import UndoHistoryDropdown component
2. Wrap existing Undo button with dropdown trigger (type="undo")
3. Wrap existing Redo button with dropdown trigger (type="redo")
4. Add small chevron/down arrow indicator to button text
5. Chevron only shows when canUndo/canRedo is true

## Key Context

- Current buttons at `Toolbar.tsx:55-60`
- Maintain existing click behavior (single undo/redo)
- Dropdown adds hover behavior on top
- Match existing button styling
## Acceptance
- [ ] Undo button shows dropdown on hover when canUndo
- [ ] Redo button shows dropdown on hover when canRedo
- [ ] Small chevron indicator added to button text
- [ ] Chevron hidden when button disabled
- [ ] Single click still performs single undo/redo
- [ ] Existing button styling preserved
- [ ] pnpm tsc --noEmit passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
