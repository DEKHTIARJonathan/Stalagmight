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

## 2026-01-28 manual [pitfall]
E2E tests that click map markers must switch to markers mode first; survey mode hides markers after geometry loads, causing flaky click failures

## 2026-01-28 manual [pitfall]
When using CSS inline style width/height on elements that also have Tailwind w-full and mx-N classes, the margins can push total size beyond viewport - move margin classes inside the non-fixedSize branch or bake margins into the CSS calc

## 2026-01-28 manual [pitfall]
Mock data must use correct runtime types (e.g. numeric IDs not strings) to match TypeScript type aliases - string 'section-1' vs number 1 for SectionId

## 2026-01-28 manual [pitfall]
Multi-step operations (undo_to/redo_to) that can partially fail must set isDirty when some steps applied before failure - not just on full success - to prevent users closing without the unsaved changes guard

## 2026-01-28 manual [pitfall]
Portal dropdowns with visibility:hidden must have final width set during hidden pass so height measurement accounts for text wrapping - shrink-to-fit at auto width produces incorrect flip detection

## 2026-01-28 manual [pitfall]
Capture-phase scroll event.target can be window or document (not a Node) - guard with instanceof Node before calling .contains() to prevent TypeError

## 2026-01-28 manual [pitfall]
When reading aria-controls in Playwright tests after opening a portal-rendered dropdown, always await expect(trigger).toHaveAttribute('aria-controls', /.+/) before getAttribute to avoid React render cycle race conditions

## 2026-01-28 manual [pitfall]
Global th/td CSS rules in index.css are unlayered and override Tailwind utility classes (text-right, text-center) on table elements; use !text-right (!important modifier) or inline styles to override

## 2026-01-28 manual [pitfall]
Select.tsx has 8+ close paths (6 explicit + scroll + resize). When adding callbacks that must fire on close, audit ALL close paths including implicit ones (scroll, resize) not just the 6 documented in specs.

## 2026-01-28 manual [pitfall]
Playwright keyboard nav tests on React Select are flaky under parallel load due to React state batching; use mouse hover positioning + dispatchEvent instead of sequential keyboard presses for multi-step navigation

## 2026-01-28 manual [pitfall]
E2E computed style assertions must parse colors numerically (not exact string match) and use individual border side properties (borderTopColor) instead of shorthand (borderColor) for cross-engine stability

## 2026-01-28 manual [pitfall]
When adding a parameter to a function, always add tests that assert formatted output strings with non-default parameter values to prevent regressions

## 2026-01-28 manual [pitfall]
When validating data in commands that create entities, compute the correct context (IDs, indices) from existing state rather than using placeholder values like 0

## 2026-01-28 manual [pitfall]
When checking if content fits in a viewport with padding/panels, compute ratios against usable dimensions (container minus padding) not raw container dimensions, to avoid clipping behind panels

## 2026-01-28 manual [pitfall]
Mock IPC config in tauri-ipc.ts must include all config fields used by MapCanvas (e.g., map.animation); missing fields cause React component crash on first use

## 2026-01-28 manual [pitfall]
When sharing feature-state keys (hover/selected) between individual and section-level highlights, individual clear must restore section state using Math.floor(featureId/encodingFactor) to check membership without querying

## 2026-01-28 manual [pitfall]
Cache querySourceFeatures results when the same query runs on high-frequency paths (mousemove/RAF); invalidate cache on data changes (setData) and section ID changes

## 2026-01-28 manual [pitfall]
After setData() on GeoJSON sources, guard re-apply calls with hasLiveStyle(map) to prevent crashes during teardown races

## 2026-01-28 manual [pitfall]
E2E tests checking MapLibre feature-state must poll (not one-shot assert) because updateVisualState() can lag behind store updates by a tick/frame, and must assert total>0 to prevent vacuous 0===0 passes

## 2026-01-28 manual [pitfall]
When removing items from data structures (sets/maps), also update all JSDoc comments and inline comments that enumerate those items -- reviewers flag stale documentation as NEEDS_WORK

## 2026-01-28 manual [pitfall]
Tailwind v3 min-w-N utilities only support 0/full/min/max/fit -- use min-w-[Nrem] arbitrary values for custom min-widths instead of assuming width scale applies

## 2026-01-28 manual [pitfall]
Tailwind utility classes referencing undefined color tokens (e.g. bg-muted when muted is not in tailwind.config.js) silently produce no CSS output -- always verify color tokens exist in the config before using them

## 2026-01-28 manual [pitfall]
E2E tests using Control+Shift+I as keyboard shortcut will be intercepted by Chromium DevTools -- use non-browser-reserved combos like Control+Shift+K in Playwright tests

## 2026-01-28 manual [pitfall]
Chromium reserves Ctrl+Shift+I/J/C/N/B/T/Delete -- never use these combos in Playwright E2E tests as they get intercepted by the browser and never reach the page

## 2026-01-28 manual [pitfall]
When adding InverseCommand undo for a command, also add that command to execute_without_undo match in undo.rs or undo/redo will silently fail

## 2026-01-28 manual [pitfall]
MapLibre drag deltas are in lng/lat degrees; always convert to meters via mapCoordsToMeters before passing to backend commands that expect meter offsets

## 2026-01-28 manual [pitfall]
When applying per-item offsets in a coordinate accumulator loop, use a local copy for display coordinates -- never mutate the running accumulator or all downstream items shift

## 2026-01-28 manual [pitfall]
HashMap<StructKey, V> in a serde Serialize/Deserialize struct will fail JSON serialization because serde_json requires string map keys -- use custom serialize_with/deserialize_with converting to Vec<(K, V)>

## 2026-01-28 manual [pitfall]
Monotonic ID counters (next_closure_id) must be normalized before use -- legacy deserialization with serde(default) can reset them to 0, causing ID reuse after deletions
