# fn-2-f4f.8 Add Playwright tests for zoom interactions

## Description
Add comprehensive Playwright tests for zoom tool interactions including click-to-zoom, box zoom, spring-loaded Z key, keyboard shortcuts, and config integration.

## Acceptance
- [x] Left-click zoom in test
- [x] Right-click zoom out test
- [x] Context menu prevention test
- [x] Max zoom boundary test
- [x] Min zoom boundary test
- [x] Box zoom drag overlay test
- [x] Escape cancels box zoom test
- [x] Small drag treated as click test
- [x] Ctrl+drag pans test
- [x] Spring-loaded Z key tests
- [x] Cursor behavior tests
- [x] Keyboard shortcut tests (=, -)
- [x] Toolbar interaction tests
- [x] Config integration tests (zoom_step, zoom_min, zoom_max)
- [x] Wheel zoom tests
- [x] Center on click test

## Done summary
# Task fn-2-f4f.8 Summary

Added 30 comprehensive Playwright tests for zoom tool functionality in e2e-playwright/zoom-tool.spec.ts covering:
- Click zoom (left-click in, right-click out, boundaries)
- Box zoom (drag overlay, escape cancel, small drag threshold, Ctrl+drag pan)
- Spring-loaded Z key (hold/release, tap behavior, state preservation)
- Cursor behavior (zoom-in cursor when active)
- Keyboard shortcuts (= and - keys)
- Toolbar interaction (button activation, cursor updates)
- Config integration (zoom_step, zoom_min, zoom_max boundaries)
- Wheel zoom (scroll zoom in/out, tool-agnostic)
- Center on click (map centers on click location)

All 30 tests pass.
## Evidence
- Commits: 67a31de
- Tests: pnpm test:ui
- PRs: