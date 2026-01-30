## Description
Compute the SHA256 file hash and check for duplicates when DmpSelectionDialog mounts. Wire the result into the `DmpSelectionConfig` returned by `handleContinue`.

**Size:** M
**Files:** `src/components/Dialogs/DmpSelectionDialog.tsx`

## Approach
- Add `useEffect` import (if not already present)
- Add state: `const [fileHash, setFileHash] = useState<string | null>(null)` and `const [isDuplicate, setIsDuplicate] = useState(false)`
- Add `useEffect` on mount that:
  1. Calls `calculateFileHash(filePath)` to get hash
  2. Calls `checkDuplicateImport(hash)` to check if previously imported
  3. Sets both state values, with cancellation flag for cleanup
  4. Catches errors silently (graceful degradation — import proceeds without warning)
- Get `calculateFileHash` and `checkDuplicateImport` from `useProjectStore`
- Include `fileHash` value in the `DmpSelectionConfig` returned by `handleContinue` (around line 209-219)
- Include `calculateFileHash` and `checkDuplicateImport` in the useEffect dependency array (Zustand store methods are stable references, so no re-run risk, but satisfies `react-hooks/exhaustive-deps`)

## Key context
- `calculateFileHash` and `checkDuplicateImport` are already in projectStore.ts:873-883
- Use `let cancelled = false` pattern with cleanup `return () => { cancelled = true; }` to prevent state updates after unmount
- `filePath` comes from component props/dialogData — use it as the useEffect dependency

## Acceptance
- [ ] `useEffect` computes hash on mount using `calculateFileHash(filePath)`
- [ ] `useEffect` checks duplicate using `checkDuplicateImport(hash)`
- [ ] State: `fileHash` (string | null) and `isDuplicate` (boolean) managed correctly
- [ ] Cleanup function prevents state updates after unmount
- [ ] `fileHash` included in `DmpSelectionConfig` returned by `handleContinue`
- [ ] Errors caught silently — import proceeds without warning on hash failure
- [ ] `pnpm tsc --noEmit` passes

## Done summary
Added useEffect to DmpSelectionDialog that computes SHA256 file hash via calculateFileHash and checks for duplicates via checkDuplicateImport on mount. Manages fileHash and isDuplicate state with proper cancellation cleanup, state reset on filePath change, and hashSettled gating on the Continue button. The computed fileHash is included in the DmpSelectionConfig returned by handleContinue.
## Evidence
- Commits: 53ec668, ae75361
- Tests: pnpm tsc --noEmit
- PRs: