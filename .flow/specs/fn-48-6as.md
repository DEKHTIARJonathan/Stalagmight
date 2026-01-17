# WebdriverIO E2E: Undo/Redo Integration

## Overview
Implement WebdriverIO E2E tests for undo/redo integration. These tests run against the full Tauri application with real backend to validate undo/redo behavior with actual commands.

## Scope
- Target: `e2e/specs/undo-redo-integration.spec.ts` (new file)
- Category: WebdriverIO E2E Tests
- Tests: 4
- Priority: P1 - High
- Dependencies: task-12 (DMP integration), task-14 (persistence)

## Approach
1. Create test file in e2e/specs/
2. Test single undo (Ctrl+Z)
3. Test redo (Ctrl+Y and Ctrl+Shift+Z)
4. Test multiple undo sequence
5. Test redo stack clearing on new command

## Quick commands
- `CARGO_TARGET_DIR=./src-tauri/target xvfb-run -a pnpm test:e2e --spec e2e/specs/undo-redo-integration.spec.ts`

## Acceptance
- [ ] Test 15.1: `should undo shot edit with Ctrl+Z` - Single undo
- [ ] Test 15.2: `should redo undone action with Ctrl+Y` - Redo with both shortcuts
- [ ] Test 15.3: `should undo multiple changes in sequence` - LIFO order
- [ ] Test 15.4: `should clear redo stack on new command` - Redo stack behavior
- [ ] Tests pass with real backend
- [ ] Undo/redo reflect in UI immediately

## References
- Source: `tasks/task-15-undo-redo-integration.md`
