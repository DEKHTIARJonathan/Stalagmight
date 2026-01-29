# Wire File Hash Tracking into DMP Import Flow

## Overview
All backend infrastructure for file hash tracking exists but is not wired into the DMP import flow. This epic connects the existing Rust commands (`calculate_file_hash`, `check_duplicate_import`, `track_imported_file`), TypeScript store wrappers, and project model field (`imported_file_hashes`) into the actual import workflow.

Additionally, this epic **replaces** the existing session-based path tracking (`hasImportedDmpPath`/`addImportedDmpPath` in uiStore + `DuplicateImportDialog`) with the persistent hash-based system. The hash check happens inside `DmpSelectionDialog` (Step 1) as an inline warning banner, replacing the separate `DuplicateImportDialog` that previously intercepted before Step 1.

## Current State
- **Rust commands**: `calculate_file_hash` (SHA256), `check_duplicate_import`, `track_imported_file` — all implemented and tested
- **Project model**: `imported_file_hashes: Vec<String>` field exists with `#[serde(default)]`
- **AppState methods**: `check_duplicate_import()` and `track_imported_file()` in `import_tracking.rs`
- **TypeScript wrappers**: `projectStore.calculateFileHash()`, `.checkDuplicateImport()`, `.trackImportedFile()` — all exist in `projectStore.ts:873-883`
- **E2E mocks**: Mock handlers for all three commands in `tauri-ipc.ts:664-674`
- **Session-based path tracking (TO BE REMOVED)**: `hasImportedDmpPath`/`addImportedDmpPath`/`clearImportedDmpPaths`/`importedDmpPaths` in `uiStore.ts:219-222,596-606`
- **DuplicateImportDialog (TO BE REMOVED)**: `src/components/Dialogs/DuplicateImportDialog.tsx` — separate confirmation dialog for session-based duplicates

## Interview Decisions
1. **Track scope**: Only track hash when `errors.length === 0` (zero import errors). If any section fails, hash is NOT tracked so user can retry cleanly.
2. **Hash capture timing**: Capture `selectionConfig.fileHash` into a local variable BEFORE calling `handleImportSections`, since that function closes the dialog (clearing `dialogData`).
3. **Test location**: Add hash tracking tests to existing `e2e-playwright/dmp-import.spec.ts`.
4. **Dual warnings**: Full replacement — remove session-based path tracking and DuplicateImportDialog entirely. Hash-based inline banner in DmpSelectionDialog handles both same-session and cross-session detection.

## Review Fixes (from plan review)
1. **handleImportSections returns boolean, not object**: Instead of refactoring `handleImportSections` to return `{ errors, warnings }` (which would change its internal dialog-showing behavior), just add `return errors.length === 0;` at the end. The function keeps all its existing error/warning dialog display logic unchanged. The wrapper only needs the boolean to decide whether to track.
2. **Atomic session-tracking removal**: All session-based path tracking removal (usage sites in App.tsx/hooks AND declarations in uiStore/DuplicateImportDialog) happens in a single task to avoid intermediate compile errors.
3. **useEffect deps lint**: Include `calculateFileHash` and `checkDuplicateImport` in the dependency array. Zustand store methods are stable references so this won't cause re-runs, but satisfies `react-hooks/exhaustive-deps`.

## What Needs to Change

### Task 1: Add `fileHash` to DmpSelectionConfig
**File**: `src/components/Dialogs/DmpSelectionDialog.tsx`
- Add `fileHash: string | null` field to the `DmpSelectionConfig` interface (lines 15-22)
- This carries the computed hash from Step 1 through to the parent (App.tsx)

### Task 2: Compute hash and check duplicate in DmpSelectionDialog
**File**: `src/components/Dialogs/DmpSelectionDialog.tsx`
- Add `useEffect` import
- Add state: `const [fileHash, setFileHash] = useState<string | null>(null)` and `const [isDuplicate, setIsDuplicate] = useState(false)`
- Add `useEffect` on mount:
  ```typescript
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const hash = await calculateFileHash(filePath);
        if (cancelled) return;
        setFileHash(hash);
        const isDup = await checkDuplicateImport(hash);
        if (cancelled) return;
        setIsDuplicate(isDup);
      } catch {
        // Graceful degradation: proceed without warning
      }
    })();
    return () => { cancelled = true; };
  }, [filePath, calculateFileHash, checkDuplicateImport]);
  ```
- Get `calculateFileHash` and `checkDuplicateImport` from `useProjectStore`
- Include `fileHash` in the `DmpSelectionConfig` returned by `handleContinue` (around line 209-219)

### Task 3: Show duplicate warning banner in DmpSelectionDialog
**File**: `src/components/Dialogs/DmpSelectionDialog.tsx`
- When `isDuplicate` is true, render a warning banner between the file metadata header and the Default Values panel (after line 254, before line 256)
- Use existing warning styling pattern: `bg-warning/10 border border-warning/20 rounded text-warning text-sm`
- Exact text per SPEC.md line 810: `"⚠ File may have been imported before (same hash detected)"`
- Add `data-testid="duplicate-hash-warning"` for testability
- Non-blocking — user can proceed normally

### Task 4: Track file hash after successful import in App.tsx
**File**: `src/App.tsx`

**Minimal change to `handleImportSections`**: Add `return errors.length === 0;` at the end of the function (line ~341). This preserves all existing error/warning dialog behavior unchanged — it just additionally returns whether the import was error-free. Update the return type annotation to `Promise<boolean>`.

**Wrap `onImport` at line 548** to track hash:
```typescript
onImport={async (sections) => {
  // Capture hash before handleImportSections closes dialog (clears dialogData)
  const hash = (dialogData.selectionConfig as DmpSelectionConfig)?.fileHash;
  const succeeded = await handleImportSections(sections);
  if (hash && succeeded) {
    try {
      await trackImportedFile(hash);
    } catch (e) {
      console.warn('Failed to track imported file hash:', e);
    }
  }
}}
```
- Add `trackImportedFile` to the `useProjectStore` destructure (line 63)

### Task 5: Remove all session-based path tracking and DuplicateImportDialog
**This task is atomic** — all removals happen together to avoid intermediate compile errors.

**Files**: `src/App.tsx`, `src/hooks/useGlobalViewShortcuts.ts`, `src/hooks/useKeyboardShortcuts.ts`, `src/store/uiStore.ts`, `src/components/Dialogs/DuplicateImportDialog.tsx`, `src/components/Dialogs/index.ts`

**Delete file**:
- `src/components/Dialogs/DuplicateImportDialog.tsx`

**Remove from `src/components/Dialogs/index.ts`**:
- Remove `DuplicateImportDialog` export (line 19)

**Remove from `src/store/uiStore.ts`**:
- Remove interface members: `importedDmpPaths`, `addImportedDmpPath`, `hasImportedDmpPath`, `clearImportedDmpPaths` (lines 219-222)
- Remove implementation: `importedDmpPaths`, `addImportedDmpPath`, `hasImportedDmpPath`, `clearImportedDmpPaths` (lines 596-606)

**Remove from `src/App.tsx`**:
- Remove `DuplicateImportDialog` from import (line 10)
- Remove `hasImportedDmpPath`, `addImportedDmpPath` from uiStore destructure (line 64)
- Remove duplicate check block in `handleDmpFileDrop` (lines 391-398) — the `if (currentProject)` branch should now go straight to parse+open dialog
- Remove `addImportedDmpPath(filePath)` calls (lines 407, 427)
- Remove `hasImportedDmpPath`, `addImportedDmpPath` from `handleDmpFileDrop` deps array (line 443)
- Remove `{activeDialog === 'confirm-duplicate-import' && <DuplicateImportDialog />}` (line 564)

**Remove from `src/hooks/useGlobalViewShortcuts.ts`**:
- Remove `hasImportedDmpPath`, `addImportedDmpPath` from uiStore destructure (line 98)
- Remove duplicate check block (lines 376-383) — proceed directly to parse+open dialog
- Remove `addImportedDmpPath(selected)` call (line 388)
- Remove from deps array (line 417)

**Remove from `src/hooks/useKeyboardShortcuts.ts`**:
- Remove `hasImportedDmpPath`, `addImportedDmpPath` from uiStore destructure (line 272)
- Remove duplicate check block (lines 627-635) — proceed directly to parse+open dialog
- Remove `addImportedDmpPath(selected)` call (line 641)
- Remove from deps array (lines 689-690)

### Task 6: Update E2E tests for hash tracking
**Files**: `e2e-playwright/dmp-import.spec.ts`, `e2e-playwright/mocks/tauri-ipc.ts`

**Update mocks**:
- Make `check_duplicate_import` return value configurable (e.g., via a global flag or mock state)
- Default: return `false` (no duplicate)
- For duplicate test: set to return `true`

**Update existing tests**:
- Test 6.5 (line 247): Currently re-opens and expects `duplicate-import-dialog`. Change to expect `dmp-selection-dialog` with `duplicate-hash-warning` banner visible (by setting mock to return `true` for `check_duplicate_import`).
- Test 6.7 (line 300): Same — expect inline banner in Step 1 instead of separate dialog. Remove references to `confirm-duplicate-import-button`.

**Add new test cases**:
- Verify `duplicate-hash-warning` banner NOT visible on first import (mock returns false)
- Verify `duplicate-hash-warning` banner IS visible when mock returns true
- Verify `track_imported_file` IPC call is made after successful import
- Verify `track_imported_file` is NOT called when import has errors

## Files to Modify
1. `src/components/Dialogs/DmpSelectionDialog.tsx` — Tasks 1-3
2. `src/App.tsx` — Tasks 4, 5
3. `src/hooks/useGlobalViewShortcuts.ts` — Task 5
4. `src/hooks/useKeyboardShortcuts.ts` — Task 5
5. `src/components/Dialogs/DuplicateImportDialog.tsx` — Task 5 (DELETE)
6. `src/components/Dialogs/index.ts` — Task 5
7. `src/store/uiStore.ts` — Task 5
8. `e2e-playwright/dmp-import.spec.ts` — Task 6
9. `e2e-playwright/mocks/tauri-ipc.ts` — Task 6

## Key Design Decisions
- **Full replacement**: Hash-based detection replaces session-based path tracking entirely
- **Non-blocking warning**: Inline banner in DmpSelectionDialog, consistent with "warnings don't block, errors block" pattern
- **Hash computed on dialog open**: Fast feedback via useEffect, doesn't delay interaction
- **Track only on zero errors**: Hash recorded only when all sections import without errors
- **Capture hash before handler**: Read `selectionConfig.fileHash` before `handleImportSections` closes dialog (which clears `dialogData`)
- **Graceful degradation**: If hash computation fails, import proceeds without warning
- **handleImportSections returns boolean**: Minimal change — add `return errors.length === 0` at end. Keeps all existing error/warning dialog behavior unchanged.
- **Atomic cleanup**: All session-based tracking removal in one task to avoid intermediate compile errors

## Acceptance Criteria
- [ ] Importing a DMP file for the first time: no warning shown, hash tracked after import
- [ ] Re-importing the same DMP file (after save/reopen or same session): warning banner visible in Step 1
- [ ] Warning banner matches spec text: "⚠ File may have been imported before (same hash detected)"
- [ ] Warning is non-blocking — user can still proceed
- [ ] Hash NOT tracked if import has errors (errors.length > 0)
- [ ] DuplicateImportDialog removed, no more session-based path tracking
- [ ] All import entry points (Ctrl+I, file drop, keyboard shortcut) go directly to DmpSelectionDialog
- [ ] All existing E2E tests updated and passing
- [ ] `pnpm tsc --noEmit` passes
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes (no Rust changes expected)
