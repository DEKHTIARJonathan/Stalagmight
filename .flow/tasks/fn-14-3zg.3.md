# fn-14-3zg.3 Frontend: UndoHistoryDropdown component with hover trigger

## Description
Create UndoHistoryDropdown React component with hover trigger (300ms delay), scrollable list of up to 10 items, action icons, truncated descriptions, and timestamps.

**Size:** M
**Files:**
- `src/components/SingleSystemView/UndoHistoryDropdown.tsx` - New component
- `src/store/projectStore.ts` - Add undoTo/redoTo actions that call command + refreshProjectState
- `src/types/commands.ts` - Add UndoHistoryItem type

## Approach

1. Follow DisplayMenu.tsx pattern at `DisplayMenu.tsx:36-213` for dropdown structure
2. Use useState for isOpen, useRef for click-outside detection
3. Implement 300ms hover delay with setTimeout/clearTimeout
4. Add `data-dropdown-open` attribute for Escape key coordination (see `useKeyboardShortcuts.ts:276`)
5. Render list with icons, truncated description (~40 chars), timestamps
6. Handle null timestamps by showing "Unknown"
7. Use date-fns formatDistanceToNow for relative timestamps (install if needed)
8. Scrollable container with max 10 items visible, auto-hide scrollbar
9. Guard: Only open dropdown if canUndo/canRedo AND fetched list is non-empty
10. Close dropdown when Ctrl+Z/Y shortcuts are pressed (listen for global shortcut events)
11. **Must use projectStore.undoTo/redoTo** which calls refreshProjectState after command

## Key Context

- Icon mapping uses Command enum snake_case tags:
  - `create_section` -> "+"
  - `update_shot` -> "pencil"
  - `delete_section` -> "X"
  - `merge_stations` -> "merge arrows"
  - `update_section_metadata` -> "pencil"
  - `batch` -> "stack"
- Match existing toolbar icon style at `Toolbar.tsx:90-100`
- Use CSS `text-overflow: ellipsis` for truncation
- For relative time <1 day, use formatDistanceToNow; otherwise show date; null shows "Unknown"
- Index 0 = most recent action (display at top of list)
- Preview data comes inline with stack response (no separate fetch)
- Dropdown must close on Ctrl+Z/Y to prevent stale state
- **Must call projectStore wrapper**, not invoke directly, to ensure refreshProjectState runs

## Acceptance
- [ ] Dropdown appears after 300ms hover delay
- [ ] Dropdown closes on mouse leave (with small delay buffer)
- [ ] Shows up to 10 items, scrollable for more with auto-hide scrollbar
- [ ] Each item shows: icon (mapped from commandType), description (truncated ~40 chars), timestamp
- [ ] Timestamps: relative for <1 day ("2 min ago"), absolute for older, "Unknown" for null
- [ ] Index 0 (most recent) displayed at top of list
- [ ] data-dropdown-open attribute set when open
- [ ] Click on item calls projectStore.undoTo/redoTo (not invoke directly) and closes dropdown
- [ ] projectStore.undoTo/redoTo calls refreshProjectState after command success
- [ ] Dropdown does not open if canUndo/canRedo is false OR if fetched list is empty
- [ ] Dropdown closes when Ctrl+Z/Y keyboard shortcuts are pressed
- [ ] pnpm tsc --noEmit passes

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
