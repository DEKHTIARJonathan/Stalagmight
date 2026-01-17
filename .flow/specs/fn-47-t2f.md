# WebdriverIO E2E: Project Persistence

## Overview
Implement WebdriverIO E2E tests for project persistence. These tests run against the full Tauri application with real backend to validate save/load cycles, data integrity, and file operations.

## Scope
- Target: `e2e/specs/project-persistence.spec.ts` (new file)
- Category: WebdriverIO E2E Tests
- Tests: 6
- Priority: P0 - Critical
- Dependencies: task-12 (DMP integration)

## Approach
1. Create test file in e2e/specs/
2. Use temp directories for test files
3. Test complete save/load round-trips
4. Test station merge persistence
5. Test zero datum persistence with GPS precision
6. Test error handling for permissions
7. Test recent projects list
8. Test dirty indicator

## Quick commands
- `CARGO_TARGET_DIR=./src-tauri/target xvfb-run -a pnpm test:e2e --spec e2e/specs/project-persistence.spec.ts`

## Acceptance
- [ ] Test 14.1: `should save and reload project data` - Full save/load cycle
- [ ] Test 14.2: `should preserve station merges across save/load` - Merge persistence
- [ ] Test 14.3: `should preserve zero datums across save/load` - GPS precision (8+ decimals)
- [ ] Test 14.4: `should handle save to read-only location` - Permission error handling
- [ ] Test 14.5: `should update recent projects list` - Recent projects tracking
- [ ] Test 14.6: `should show dirty indicator for unsaved changes` - Window title asterisk
- [ ] Tests use temp directories with cleanup
- [ ] Tests pass with real backend

## References
- Source: `tasks/task-14-project-persistence.md`
