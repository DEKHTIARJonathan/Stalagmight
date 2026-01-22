# fn-14-3zg.4 Frontend: Detail preview popup with viewport positioning

## Description
Add detail preview popup that appears when hovering items in the dropdown, showing old->new field values with smart viewport positioning. Preview data is already included in the stack response from task 1 - this task only consumes it.

**Size:** M
**Files:**
- `src/components/SingleSystemView/UndoHistoryDropdown.tsx` - Add preview sub-component

## Approach

1. Use previewData from UndoHistoryItem (already fetched with stack, no separate endpoint)
2. Render changes array in "Old -> New" format
3. Show additionalChanges count as "+X more" if > 0
4. Preview appears to right of dropdown on item hover
5. Detect viewport overflow - flip to left if would overflow right edge
6. Use 150ms fade-in animation (CSS @keyframes)
7. Respect prefers-reduced-motion
8. Show nothing or "No details" if previewData is null (legacy entries)

## Key Context

- previewData.changes: Array of {field, oldValue, newValue}
- previewData.additionalChanges: count of fields beyond the 3 shown (display as "+X more")
- Use getBoundingClientRect() to detect viewport overflow
- Preview should use createPortal to body for proper stacking
- No separate backend call needed - data comes with stack response from task 1

## Acceptance
- [ ] Preview popup appears on item hover (no delay)
- [ ] Uses previewData from stack response (no separate API call)
- [ ] Shows changes in "Old -> New" format
- [ ] Shows additionalChanges as "+X more" if > 0
- [ ] Gracefully handles null previewData (shows nothing or "No details")
- [ ] Preview positioned to right of dropdown
- [ ] Flips to left if would overflow right viewport edge
- [ ] 150ms fade-in animation
- [ ] Respects prefers-reduced-motion
- [ ] pnpm tsc --noEmit passes

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
