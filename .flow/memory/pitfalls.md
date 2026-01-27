# Pitfalls

Lessons learned from NEEDS_WORK feedback. Things models tend to miss.

<!-- Entries added automatically by hooks or manually via `flowctl memory add` -->

## 2026-01-17 manual [pitfall]
Math.min/max with spread operator can cause stack overflow on large arrays - use reduce or loop instead

## 2026-01-17 manual [pitfall]
Frontend validation rules must match backend Validator exactly to avoid preview/import mismatches

## 2026-01-17 manual [pitfall]
Per-project settings need in-memory cache for new unsaved projects (no DB exists until first save)

## 2026-01-17 manual [pitfall]
Regex alternations with different group positions create brittle code - use explicit variable extraction instead of complex index remapping

## 2026-01-20 manual [pitfall]
In SQLite queries, distinguish QueryReturnedNoRows (expected miss) from other errors (corruption/IO) - don't mask all errors with unwrap_or(default)

## 2026-01-20 manual [pitfall]
f64::clamp does not handle NaN/inf - always check is_finite() first when normalizing user-supplied floats

## 2026-01-20 manual [pitfall]
When intercepting map clicks, attach capture handlers to canvas element not container - container includes UI controls that need to remain clickable

## 2026-01-20 manual [pitfall]
React mouse drag handlers should check e.buttons to prevent stuck state on focus loss - window blur may not fire mouseup

## 2026-01-20 manual [pitfall]
When adding keyboard shortcuts for map zoom, disable the map library's built-in keyboard handler to prevent double-zoom with conflicting step values

## 2026-01-20 manual [pitfall]
Playwright tests must waitForFunction(__cavechef_map__) after canvas appears to avoid false positives from uninitialized map state

## 2026-01-20 manual [pitfall]
When clearing hover state for one feature type (stations/shots), only fire onFeatureHover(false) if no other feature type is currently hovered

## 2026-01-20 manual [pitfall]
MapLibre hitbox layers should use opaque colors with tiny opacity (0.001) - using rgba(0,0,0,0) can cause queryRenderedFeatures to fail due to render optimization

## 2026-01-21 manual [pitfall]
useEffect syncing state to a ref-based object (e.g. SurveyLayer) should include mapLoaded in deps to re-run after ref becomes valid

## 2026-01-21 manual [pitfall]
When combining mouse hover and keyboard focus for highlight state, mouse leave handlers must check if keyboard focus is active to avoid clearing the highlight

## 2026-01-21 manual [pitfall]
Tauri State<'_, T> cannot be cloned into spawn_blocking - use AppHandle.state::<T>() instead for 'static ownership

## 2026-01-21 manual [pitfall]
AtomicU64::new(0) with fetch_add returns 0 for first call; reserve 0 for sentinel by starting at 1

## 2026-01-21 manual [pitfall]
When clearing async requests in useEffect, always clear immediately before any early returns AND store in ref if target state not ready, then process in separate effect when ready

## 2026-01-21 manual [pitfall]
React event handlers in useEffect can have stale closures; use refs for values needed in keydown/keyup handlers

## 2026-01-22 manual [pitfall]
Hover dropdown: use a centralized hardClose helper that cancels all timers (hover/leave) and invalidates tokens, call from ALL close paths (click, escape, keyboard shortcuts)

## 2026-01-22 manual [pitfall]
Props used in setTimeout callbacks become stale closures - track them in a ref (e.g., disabledRef.current = disabled) and check the ref inside the callback

## 2026-01-22 manual [pitfall]
In E2E tests, wait for aria-activedescendant to be set before asserting on keyboard navigation (components often set it in setTimeout(0))

## 2026-01-22 manual [pitfall]
Wrapping non-labelable elements (div with role=switch) in <label> does not associate them - use aria-labelledby with an id on the label text instead

## 2026-01-22 manual [pitfall]
Replace waitForTimeout() with deterministic assertions (e.g., toHaveAttribute, toContainText) after UI state changes to prevent flaky E2E tests

## 2026-01-22 manual [pitfall]
User-controlled color strings in SVG/HTML must be validated (#RGB/#RRGGBB only) to prevent markup injection attacks

## 2026-01-22 manual [pitfall]
When parsing SVG/XML attributes in tests, use dedicated parsers or well-structured string splitting rather than magic offsets that silently skip assertions on failure

## 2026-01-23 manual [pitfall]
React useEffect reading derived state (e.g., selectedSection) may see stale value during transitions - compute from source (e.g., sections.find) using the selection's own IDs

## 2026-01-23 manual [pitfall]
React refs don't trigger re-renders - use state for mapLoaded flags so dependent effects re-run; buffer data arriving before async initialization completes

## 2026-01-23 manual [pitfall]
Database::open can create/mutate files - use open_readonly for read-only operations like lazy loading geometry

## 2026-01-23 manual [pitfall]
Tooltips using innerHTML with user data (names, paths) are XSS vectors in Tauri webview - use textContent or DOM building instead

## 2026-01-23 manual [pitfall]
Percentage-based bounds padding produces degenerate results when span is 0 (single point/line) - enforce a minimum span before applying padding factor

## 2026-01-23 manual [pitfall]
MapLibre easeTo() inherits current padding; call map.stop() and setPadding({0}) before easeTo() to ensure deterministic centering

## 2026-01-23 manual [pitfall]
When testing map centering in E2E tests, first pan the map off-target before clicking center buttons, otherwise the test may pass/fail depending on whether the map was already centered on the target

## 2026-01-25 manual [pitfall]
React onMouseEnter/Leave requires dispatching mouseover/mouseout with bubbles:true, not mouseenter/mouseleave

## 2026-01-27 manual [pitfall]
When clamping a value, do not also reject out-of-range values in the validation guard - the guard makes the clamp unreachable for the values it is supposed to handle

## 2026-01-27 manual [pitfall]
Async action queues (ref-based) must be cleared on all close/teardown paths to prevent stale closures from executing against changed state after reopen

## 2026-01-27 manual [pitfall]
Capture-phase keyboard shortcut interceptors must guard against input/textarea/select/contentEditable focus to avoid breaking native text editing undo/redo

## 2026-01-27 manual [pitfall]
After an error in an action queue, still refresh the UI state from the backend (fetchStack) before showing the error dialog - backend may have partially mutated state

## 2026-01-27 manual [pitfall]
E2E tests for async action queues must assert observable post-action effects (call counts, announcement text) not just DOM state that was already true before the action
