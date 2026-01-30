## Description
Show a non-blocking warning banner in DmpSelectionDialog when `isDuplicate` is true. The banner appears between the file metadata header and the Default Values panel.

**Size:** S
**Files:** `src/components/Dialogs/DmpSelectionDialog.tsx`

## Approach
- First, change the `isDuplicate` destructuring from `const [, setIsDuplicate] = useState(false)` to `const [isDuplicate, setIsDuplicate] = useState(false)` so the value is accessible (task 2 left it unnamed since it wasn't consumed yet)
<!-- Updated by plan-sync: fn-48-oen.2 used `const [, setIsDuplicate]` (unnamed) since task 3 hadn't consumed it yet -->
- When `isDuplicate` is true, render a warning banner after the file metadata header (after line 296, before line 298 — the Default Values panel)
<!-- Updated by plan-sync: fn-48-oen.1 added fileHash field to DmpSelectionConfig interface, shifting line numbers by ~3 -->
<!-- Updated by plan-sync: fn-48-oen.2 added hashSettled state/useEffect/store selectors, shifting line numbers further; metadata header now ends at ~line 296, Default Values starts ~line 298 -->
- Use existing warning styling pattern: `bg-warning/10 border border-warning/20 rounded text-warning text-sm`
- Exact text per SPEC.md line 810: "⚠ File may have been imported before (same hash detected)"
- Add `data-testid="duplicate-hash-warning"` for E2E testability
- Non-blocking — user can proceed normally, no button/dismiss needed

## Key context
- `isDuplicate` state is set in task 2's useEffect (line 125-149 in DmpSelectionDialog.tsx), but currently destructured without a name — change `[, setIsDuplicate]` to `[isDuplicate, setIsDuplicate]`
- Task 2 also added a `hashSettled` state that gates the Continue button (disabled while hash is computing, shows "Computing file hash..." text) — the warning banner should only appear after hash settles, so consider gating on `isDuplicate && hashSettled`
- The warning styling pattern is used elsewhere in the codebase — follow existing convention
- Banner placement: between file metadata header (ends ~line 296) and Default Values panel (starts ~line 298) in DmpSelectionDialog

## Acceptance
- [ ] Warning banner visible when `isDuplicate` is true
- [ ] Warning banner hidden when `isDuplicate` is false
- [ ] Banner text matches spec: "⚠ File may have been imported before (same hash detected)"
- [ ] Banner has `data-testid="duplicate-hash-warning"`
- [ ] Banner uses existing warning styling pattern
- [ ] Warning is non-blocking — user can still click Continue
- [ ] `pnpm tsc --noEmit` passes

## Done summary
Added duplicate hash warning banner to DmpSelectionDialog. The banner appears between the file metadata header and Default Values panel when isDuplicate && hashSettled is true, using existing warning styling pattern and spec-matching text with data-testid for E2E testability.
## Evidence
- Commits: 0c44a03b27b2f21da8f8444584de0432ca72fa41
- Tests: pnpm tsc --noEmit
- PRs: