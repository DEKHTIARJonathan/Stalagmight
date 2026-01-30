# fn-48-oen.5 Remove all session-based path tracking and DuplicateImportDialog

## Description
Atomic removal of all session-based duplicate import detection. This replaces the old path-based system with the hash-based system wired in tasks 1-4.

**Delete file**: `src/components/Dialogs/DuplicateImportDialog.tsx`

**Remove from index**: `src/components/Dialogs/index.ts` — remove DuplicateImportDialog export

**Remove from uiStore.ts**: `importedDmpPaths`, `addImportedDmpPath`, `hasImportedDmpPath`, `clearImportedDmpPaths` (interface + implementation)

**Remove from App.tsx**: DuplicateImportDialog import, hasImportedDmpPath/addImportedDmpPath from destructure, duplicate check block in handleDmpFileDrop, addImportedDmpPath calls, confirm-duplicate-import dialog render

**Remove from useGlobalViewShortcuts.ts**: hasImportedDmpPath/addImportedDmpPath usage, duplicate check block, deps array entries

**Remove from useKeyboardShortcuts.ts**: hasImportedDmpPath/addImportedDmpPath usage, duplicate check block, deps array entries

See epic spec Task 5 section for exact line numbers.

## Acceptance
- [ ] DuplicateImportDialog.tsx deleted
- [ ] No references to hasImportedDmpPath, addImportedDmpPath, importedDmpPaths, clearImportedDmpPaths anywhere in codebase
- [ ] No references to confirm-duplicate-import dialog anywhere in codebase
- [ ] All import entry points (Ctrl+I, file drop, keyboard shortcut) go directly to DmpSelectionDialog
- [ ] `pnpm tsc --noEmit` passes

## Done summary
Removed all session-based duplicate import detection (DuplicateImportDialog, importedDmpPaths, hasImportedDmpPath, addImportedDmpPath, clearImportedDmpPaths) from uiStore, App.tsx, useGlobalViewShortcuts, and useKeyboardShortcuts. All import entry points (Ctrl+I, file drop, keyboard shortcut) now go directly to DmpSelectionDialog without session-based path interception. Updated E2E tests to reflect the new behavior.
## Evidence
- Commits: 106bf904, e6bae32f
- Tests: pnpm tsc --noEmit
- PRs: