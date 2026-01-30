## Description
Add `fileHash: string | null` field to the `DmpSelectionConfig` interface in DmpSelectionDialog.tsx. This field carries the computed SHA256 hash from Step 1 (DmpSelectionDialog) through to the parent (App.tsx) so the import handler can track it after successful import.

**Size:** S
**Files:** `src/components/Dialogs/DmpSelectionDialog.tsx`

## Approach
- Add `fileHash: string | null` to the `DmpSelectionConfig` interface (lines 15-22)
- Follow existing interface pattern — other fields like `filePath`, `wallsShotsFn`, `defaultValues` are already there
- Initialize `fileHash` to `null` in `handleContinue` for now (tasks 2 will wire the actual value)

## Key context
- `DmpSelectionConfig` is the data object returned by `handleContinue` callback (line 208-220) and consumed by the parent via `onContinue` prop
- The parent (App.tsx) reads this config from `dialogData.selectionConfig`

## Acceptance
- [ ] `DmpSelectionConfig` interface includes `fileHash: string | null`
- [ ] `handleContinue` returns `fileHash` in the config object (initially null, wired in task 2)
- [ ] `pnpm tsc --noEmit` passes

## Done summary
Added `fileHash: string | null` field to the `DmpSelectionConfig` interface and initialized it to `null` in `handleContinue`. This carries the SHA256 hash from Step 1 through to the parent for import tracking (actual hash wired in task 2).
## Evidence
- Commits: ae463abd0902d3040094778ebead1ea886d1b7e2
- Tests: pnpm tsc --noEmit
- PRs: