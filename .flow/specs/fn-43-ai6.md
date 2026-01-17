# Playwright E2E: Panel Interactions

## Overview
Implement Playwright E2E tests for panel interactions. These tests validate panel toggling, resizing, section expand/collapse, and scrolling behavior.

## Scope
- Target: `e2e-playwright/panel-interactions.spec.ts` (new file)
- Category: Playwright E2E Tests
- Tests: 6
- Priority: P2 - Medium
- Dependencies: task-06 (project creation helpers)

## Approach
1. Create test file for panel interactions
2. Test keyboard shortcuts for panel toggling (Ctrl+1/2/3)
3. Test panel resize by dragging
4. Test section expand/collapse
5. Test scrolling for long lists
6. Test panel state persistence

## Quick commands
- `pnpm test:ui --grep "Panel Interactions"`
- `pnpm test:ui:headed --grep "Panel Interactions"`

## Acceptance
- [ ] Test 10.1: `should toggle sections panel with Ctrl+1` - Toggle on/off
- [ ] Test 10.2: `should toggle detail panel with Ctrl+2` - Toggle with context
- [ ] Test 10.3: `should toggle data table panel with Ctrl+3` - Toggle table
- [ ] Test 10.4: `should resize panels by dragging` - Resize with min/max limits
- [ ] Test 10.5: `should expand/collapse section in sections panel` - Expand/collapse
- [ ] Test 10.6: `should handle panel overflow with scrolling` - Scroll behavior
- [ ] Tests pass in headless mode
- [ ] All three panels tested

## References
- Source: `tasks/task-10-panel-interactions.md`
