# fn-48-6as.1 Implement 4 undo/redo integration tests

## Description
Create WebdriverIO E2E tests for undo/redo integration in `e2e/specs/undo-redo-integration.spec.ts`. Tests validate real backend undo/redo behavior including single undo, redo with multiple shortcuts, LIFO ordering for multiple changes, and redo stack clearing.

## Acceptance
- [x] Test 15.1: `should undo section creation with Ctrl+Z` - Single undo operation
- [x] Test 15.2: `should redo undone action with Ctrl+Y` - Redo with both Ctrl+Y and Ctrl+Shift+Z
- [x] Test 15.3: `should undo multiple changes in sequence` - LIFO order verification
- [x] Test 15.4: `should clear redo stack on new command` - Redo stack behavior
- [x] Tests type-check with `pnpm tsc --noEmit`

## Done summary
# fn-48-6as.1 Done Summary

## Implementation
Created WebdriverIO E2E tests for undo/redo integration in `e2e/specs/undo-redo-integration.spec.ts`.

## Tests Implemented (4)
1. **Test 15.1: should undo section creation with Ctrl+Z**
   - Creates a section, verifies it exists
   - Uses Ctrl+Z to undo
   - Verifies section is removed
   - Checks canUndo/canRedo state transitions

2. **Test 15.2: should redo undone action with Ctrl+Y**
   - Creates section, undoes it
   - Redoes with Ctrl+Y, verifies section restored
   - Also tests Ctrl+Shift+Z redo shortcut

3. **Test 15.3: should undo multiple changes in sequence**
   - Creates Section A, then Section B
   - Undoes once - verifies B removed (LIFO), A remains
   - Undoes again - verifies A also removed

4. **Test 15.4: should clear redo stack on new command**
   - Creates Section A, undoes it (redo available)
   - Creates Section B (new command)
   - Verifies redo stack is cleared (canRedo = false)
   - Verifies Section A cannot be restored via redo

## Helper Functions Added
- `createTestSection(name)` - Creates section via store for testing
- `deleteTestSection(sectionId)` - Deletes section via store
- `getUndoRedoState()` - Returns {canUndo, canRedo} state
- `undoViaStore()` - Performs undo via store (not keyboard)
- `redoViaStore()` - Performs redo via store (not keyboard)

## Verification
- TypeScript: `pnpm tsc --noEmit` passes
- Test structure follows existing WebdriverIO test patterns
## Evidence
- Commits:
- Tests: {'name': 'should undo section creation with Ctrl+Z', 'file': 'e2e/specs/undo-redo-integration.spec.ts', 'type': 'webdriverio-e2e', 'status': 'implemented'}, {'name': 'should redo undone action with Ctrl+Y', 'file': 'e2e/specs/undo-redo-integration.spec.ts', 'type': 'webdriverio-e2e', 'status': 'implemented'}, {'name': 'should undo multiple changes in sequence', 'file': 'e2e/specs/undo-redo-integration.spec.ts', 'type': 'webdriverio-e2e', 'status': 'implemented'}, {'name': 'should clear redo stack on new command', 'file': 'e2e/specs/undo-redo-integration.spec.ts', 'type': 'webdriverio-e2e', 'status': 'implemented'}
- PRs: