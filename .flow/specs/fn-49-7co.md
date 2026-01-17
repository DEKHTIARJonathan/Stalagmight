# WebdriverIO E2E: Export Integration

## Overview
Implement WebdriverIO E2E tests for export integration. These tests run against the full Tauri application with real backend to validate complete export workflows for CSV, JSON, and image formats.

## Scope
- Target: `e2e/specs/export-integration.spec.ts` (new file)
- Category: WebdriverIO E2E Tests
- Tests: 4
- Priority: P2 - Medium
- Dependencies: task-12 (DMP integration)

## Approach
1. Create test file in e2e/specs/
2. Use temp directories for export files
3. Test CSV export with file verification
4. Test JSON export with structure validation
5. Test PNG export with magic byte verification
6. Test custom export options
7. Test cancellation

## Quick commands
- `CARGO_TARGET_DIR=./src-tauri/target xvfb-run -a pnpm test:e2e --spec e2e/specs/export-integration.spec.ts`

## Acceptance
- [ ] Test 16.1: `should export project as CSV` - CSV file creation and validation
- [ ] Test 16.2: `should export project as JSON` - JSON structure validation
- [ ] Test 16.3: `should export map as PNG image` - PNG magic bytes check
- [ ] Test 16.4: `should export with custom options` - Delimiter, header options
- [ ] Temp directories cleaned up after tests
- [ ] Tests pass with real backend

## References
- Source: `tasks/task-16-export-integration.md`
