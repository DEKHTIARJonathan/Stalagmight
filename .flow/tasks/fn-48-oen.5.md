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
TBD

## Evidence
- Commits:
- Tests:
- PRs:
