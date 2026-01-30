## Description
Show a non-blocking warning banner in DmpSelectionDialog when `isDuplicate` is true. The banner appears between the file metadata header and the Default Values panel.

**Size:** S
**Files:** `src/components/Dialogs/DmpSelectionDialog.tsx`

## Approach
- When `isDuplicate` is true, render a warning banner after the file metadata header (after line 257, before line 259)
<!-- Updated by plan-sync: fn-48-oen.1 added fileHash field to DmpSelectionConfig interface, shifting line numbers by ~3 -->
- Use existing warning styling pattern: `bg-warning/10 border border-warning/20 rounded text-warning text-sm`
- Exact text per SPEC.md line 810: "⚠ File may have been imported before (same hash detected)"
- Add `data-testid="duplicate-hash-warning"` for E2E testability
- Non-blocking — user can proceed normally, no button/dismiss needed

## Key context
- `isDuplicate` state is set in task 2's useEffect
- The warning styling pattern is used elsewhere in the codebase — follow existing convention
- Banner placement: between file metadata header and Default Values panel in DmpSelectionDialog

## Acceptance
- [ ] Warning banner visible when `isDuplicate` is true
- [ ] Warning banner hidden when `isDuplicate` is false
- [ ] Banner text matches spec: "⚠ File may have been imported before (same hash detected)"
- [ ] Banner has `data-testid="duplicate-hash-warning"`
- [ ] Banner uses existing warning styling pattern
- [ ] Warning is non-blocking — user can still click Continue
- [ ] `pnpm tsc --noEmit` passes

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
