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
