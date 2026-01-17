# WebdriverIO E2E: Map Integration

## Overview
Implement WebdriverIO E2E tests for map integration. These tests run against the full Tauri application with real backend to validate map rendering, selection, merging, and navigation.

## Scope
- Target: `e2e/specs/map-integration.spec.ts` (new file)
- Category: WebdriverIO E2E Tests
- Tests: 6
- Priority: P1 - High
- Dependencies: task-12 (DMP integration)

## Approach
1. Create test file in e2e/specs/
2. Test survey rendering after import
3. Test station selection on map
4. Test station merging
5. Test section moving
6. Test zoom and pan
7. Test station label display

## Quick commands
- `CARGO_TARGET_DIR=./src-tauri/target xvfb-run -a pnpm test:e2e --spec e2e/specs/map-integration.spec.ts`

## Acceptance
- [ ] Test 13.1: `should render survey on map after import` - Survey layer visible
- [ ] Test 13.2: `should select station on map click` - Click selection
- [ ] Test 13.3: `should merge stations on map` - Merge tool workflow
- [ ] Test 13.4: `should move section on map with move tool` - Section dragging
- [ ] Test 13.5: `should zoom and pan map` - Navigation controls
- [ ] Test 13.6: `should display station labels on map` - Label rendering
- [ ] Tests pass with real backend
- [ ] Map renders correctly

## References
- Source: `tasks/task-13-map-integration.md`
