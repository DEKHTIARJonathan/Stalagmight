## Description
Track the file hash after a successful import in App.tsx. Make `handleImportSections` return a boolean indicating success, then wrap the `onImport` callback to call `trackImportedFile` when appropriate.

**Size:** M
**Files:** `src/App.tsx`

## Approach
- **Minimal change to `handleImportSections`**: Add `return errors.length === 0;` at the end of the function (line ~341). This preserves all existing error/warning dialog display logic unchanged — it just additionally returns whether the import was error-free. Update the return type annotation to `Promise<boolean>`.
- **Wrap `onImport` at line 548** to track hash:
  1. Capture `(dialogData.selectionConfig as DmpSelectionConfig)?.fileHash` into a local variable BEFORE calling `handleImportSections` (because that function closes the dialog, clearing `dialogData`)
  2. Call `handleImportSections(sections)` and capture the boolean result
  3. If hash exists AND import succeeded, call `trackImportedFile(hash)` wrapped in try/catch (console.warn on failure — non-blocking)
- Add `trackImportedFile` to the `useProjectStore` destructure (line 63)
- Import `DmpSelectionConfig` type if needed

## Key context
- `handleImportSections` currently returns void — adding `return errors.length === 0` at the end is the minimal change
- `dialogData.selectionConfig` gets cleared when `handleImportSections` closes the dialog, so hash must be captured before the call
- `trackImportedFile` is already in projectStore.ts:881-883 — just needs to be destructured
- Track hash only when `errors.length === 0` (zero import errors). If any section fails, hash is NOT tracked so user can retry cleanly

## Acceptance
- [ ] `handleImportSections` returns `Promise<boolean>` — `true` when `errors.length === 0`, `false` otherwise
- [ ] All existing error/warning dialog behavior in `handleImportSections` unchanged
- [ ] `onImport` wrapper captures `fileHash` before calling `handleImportSections`
- [ ] `trackImportedFile(hash)` called only when hash exists AND import succeeded
- [ ] `trackImportedFile` failure is caught and logged with `console.warn` (non-blocking)
- [ ] `trackImportedFile` destructured from `useProjectStore`
- [ ] `pnpm tsc --noEmit` passes

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
