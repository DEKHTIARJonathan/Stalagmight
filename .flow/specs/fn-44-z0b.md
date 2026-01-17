# Playwright E2E: Map Tools

## Overview
Implement Playwright E2E tests for map tools. These tests validate tool switching, selection, panning, measuring, fit view, and deletion via the map interface.

## Scope
- Target: `e2e-playwright/map-tools.spec.ts` (new file)
- Category: Playwright E2E Tests
- Tests: 6
- Priority: P2 - Medium
- Dependencies: task-06 (project creation helpers)

## Approach
1. Create test file for map tools
2. Test all tool keyboard shortcuts (S, P, Z, D, X, M, R, V, T)
3. Test toolbar button clicking
4. Test select tool (single and multi-select)
5. Test pan tool and middle mouse button
6. Test measure tool
7. Test fit view (Ctrl+0)
8. Test delete key with selection

## Quick commands
- `pnpm test:ui --grep "Map Tools"`
- `pnpm test:ui:headed --grep "Map Tools"`

## Acceptance
- [ ] Test 11.1: `should switch between tools with keyboard shortcuts` - All shortcuts
- [ ] Test 11.2: `should select stations with select tool` - Single/multi-select
- [ ] Test 11.3: `should pan map with pan tool or middle mouse button` - Pan behavior
- [ ] Test 11.4: `should measure distance with measure tool` - Distance display
- [ ] Test 11.5: `should fit view to all data with Ctrl+0` - Fit view
- [ ] Test 11.6: `should delete selected items with Delete key` - Delete with confirm
- [ ] Tests pass in headless mode
- [ ] Tool indicator updates correctly

## References
- Source: `tasks/task-11-map-tools.md`
