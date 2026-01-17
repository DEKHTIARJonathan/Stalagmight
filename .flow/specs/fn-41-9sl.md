# Playwright E2E: Section/Shot Editing

## Overview
Implement Playwright E2E tests for section and shot editing functionality. These tests validate editing shot values, LRUD fields, deleting shots/sections, and adding new shots.

## Scope
- Target: `e2e-playwright/section-shot-editing.spec.ts` (new file)
- Category: Playwright E2E Tests
- Tests: 6
- Priority: P1 - High
- Dependencies: task-06 (project creation helpers)

## Approach
1. Create test file for section/shot editing
2. Update tauri-ipc.ts mocks for update/delete/create commands
3. Test detail panel editing
4. Test LRUD editing
5. Test shot/section deletion with confirmation
6. Test adding new shots

## Quick commands
- `pnpm test:ui --grep "Section and Shot Editing"`
- `pnpm test:ui:headed --grep "Section and Shot Editing"`

## Acceptance
- [ ] Test 8.1: `should edit shot values in detail panel` - Edit length/azimuth/depth
- [ ] Test 8.2: `should edit LRUD values` - Edit L/R/U/D with validation
- [ ] Test 8.3: `should delete shot with confirmation` - Delete with confirm/cancel
- [ ] Test 8.4: `should edit section metadata` - Edit name/surveyor/date/color
- [ ] Test 8.5: `should delete section with confirmation` - Delete section with warning
- [ ] Test 8.6: `should add new shot to section` - Add shot dialog and validation
- [ ] Mocks updated in tauri-ipc.ts
- [ ] Tests pass in headless mode

## References
- Source: `tasks/task-08-section-shot-editing.md`
