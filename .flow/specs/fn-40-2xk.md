# Playwright E2E: Export Dialog

## Overview
Implement Playwright E2E tests for the Export Dialog. These tests use mocked Tauri IPC to validate export functionality for CSV, JSON, and image formats with various options.

## Scope
- Target: `e2e-playwright/export-dialog.spec.ts` (new file)
- Category: Playwright E2E Tests
- Tests: 6
- Priority: P2 - Medium
- Dependencies: task-06 (project creation helpers)

## Approach
1. Create export dialog test file
2. Update tauri-ipc.ts mocks for export commands
3. Test each export format (CSV, JSON, Image)
4. Test format-specific options
5. Test success/error states

## Quick commands
- `pnpm test:ui --grep "Export Dialog"`
- `pnpm test:ui:headed --grep "Export Dialog"`

## Acceptance
- [ ] Test 7.1: `should open export dialog with Ctrl+E` - Verify dialog opens
- [ ] Test 7.2: `should show CSV format options and preview` - Verify CSV options
- [ ] Test 7.3: `should show JSON format options and preview` - Verify JSON options
- [ ] Test 7.4: `should show image export options` - Verify image options
- [ ] Test 7.5: `should execute export and show success` - Verify export works
- [ ] Test 7.6: `should close dialog on Cancel` - Verify cancel works
- [ ] Mocks updated in tauri-ipc.ts for export commands
- [ ] Tests pass in headless mode
- [ ] Dialog has correct ARIA attributes

## References
- Source: `tasks/task-07-export-dialog.md`
