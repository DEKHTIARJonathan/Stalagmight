# Fix section zoom to leave 10% margin

## Overview

The `fitToSection` function in `MapCanvas.tsx` applies 10% vertical padding (top/bottom) but uses **zero horizontal margin** when panels are closed — left/right padding only accounts for panel widths. This causes sections to fill the entire horizontal viewport with no breathing room. By contrast, `fitToBounds` ("fit to view") correctly applies 10% padding on all four sides.

**Scope:**
- Add 10% horizontal margin to `fitToSection` (stacked on top of panel offsets)
- Skip zoom-in when section already occupies ≥30% of viewport in either axis AND fully fits within viewport (center/pan only)
- Extract shared padding calculation helper to reduce duplication between `fitToBounds` and `fitToSection`
- Update `docs/SPEC.md` to reflect new zoom behavior
- Add Playwright E2E test verifying margin and zoom level

**Out of scope:**
- `fitToBounds` behavior changes (already correct)
- Panel toggle mid-animation handling (accepted limitation)

**Clarification on single-station/zero-area paths:** The shared padding helper will be used by `fitToSection`'s padding calculation (line 1257-1263). Since single-station and zero-area paths already use this same `padding` object (lines 1274 and 1290), they will automatically gain horizontal margin. This is correct and desirable — single-station sections should also have margin from the container edge, consistent with multi-station sections.

## Approach

1. **Extract shared padding helper** — Create a helper function (local to MapCanvas or in a utils file) that computes `{ top, bottom, left, right }` padding given container dimensions, margin percentage, and optional panel offsets. Replace duplicated calculations in both `fitToBounds` (line 1218-1221) and `fitToSection` (line 1257-1263).

2. **Fix horizontal margin** — In the shared helper, always add `Math.round(containerWidth * 0.1)` to left/right padding, on top of any panel offset. This ensures 10% margin from the container edge even when panels are closed.

3. **Add skip-zoom-in check** — Before calling `fitBounds` in the multi-station path (line 1299), project the section's SW/NE bounds to screen pixels using `map.project()`. Compare the screen-space width to `container.clientWidth` and height to `container.clientHeight`. Apply the skip condition:
   - Calculate `ratioX = screenWidth / containerWidth` and `ratioY = screenHeight / containerHeight`
   - **Skip zoom-in only if**: both `ratioX ≤ 1.0` and `ratioY ≤ 1.0` (section fits within viewport) AND at least one of `ratioX ≥ 0.3` or `ratioY ≥ 0.3` (section is already large enough)
   - If the section is larger than the viewport (either ratio > 1.0), always use `fitBounds` to zoom out and fit it
   - If the section is smaller than 30% in both axes, use `fitBounds` to zoom in

4. **Center-only `easeTo` must include padding** — When the skip-zoom-in check triggers (section fits and ≥30%), the `easeTo` call must include the full `padding` object (10% margin + panel offsets). This ensures the section is centered within the usable viewport area, not behind panels.

5. **Update SPEC.md** — Update line 570 to describe the new margin and skip-zoom-in behavior.

6. **Playwright E2E test** — Create a test that seeds a multi-station section, triggers zoom-to-section, then asserts that projected station bounds have visible margin from viewport edges and zoom level is within range.

## Risks / Dependencies

| Risk | Mitigation |
|------|------------|
| MapLibre padding accumulation bug | Already handled: `setPadding({0,0,0,0})` called before operations (line 1247) |
| `map.project()` depends on current zoom for skip check | Intentional — we compare at current zoom to decide whether to re-zoom |
| fn-5-jef touches MapCanvas.tsx (depth gradient, line ~580) | Different section of file, no functional overlap |
| `easeTo` inherits padding — must reset first | Already done at line 1247 (memory pitfall confirmed) |
| Single-station/zero-area paths gain horizontal margin | Desired behavior — consistent padding across all section types |

## Acceptance

- [ ] Double-clicking a section zooms to show the section with ~10% margin on all sides (plus panel offsets on left/right)
- [ ] The "Center" button in the detail panel produces the same zoom behavior
- [ ] If the section fits within viewport AND already occupies ≥30% of viewport in X or Y, only center (pan) without zoom change
- [ ] If the section exceeds viewport in any axis, fitBounds is used to zoom out and fit
- [ ] The pan-only case uses animated transition (easeTo with configured duration) AND includes padding (10% + panel offsets)
- [ ] fitToBounds and fitToSection share a common padding calculation helper
- [ ] Max zoom never exceeds config.map.zoom_max
- [ ] Single-station and zero-area cases use the shared padding helper (gaining horizontal margin)
- [ ] E2E Playwright test verifies: section bounds have margin from viewport edges AND zoom level is reasonable
- [ ] MapLibre padding accumulation workaround (setPadding reset) is preserved
- [ ] docs/SPEC.md updated to reflect new section zoom behavior

## Test Notes

- Use `seedProjectWithSections` helper to create multi-station test sections
- Access map via `window.__cavechef_map__` in `page.evaluate()`
- Use `map.project()` to convert section station coords to screen pixels for margin assertions
- Pan map off-target before triggering zoom (memory pitfall: avoid false passes from pre-centered state)
- Use `expect.poll()` for stability instead of `waitForTimeout()`
- Verify both double-click and center button triggers

## Quick commands

```bash
# Type check
pnpm tsc --noEmit

# Run Playwright tests
pnpm test:ui

# Run Rust tests (no backend changes expected)
cargo test --manifest-path src-tauri/Cargo.toml
```

## References

- `fitToSection`: `src/components/Map/MapCanvas.tsx:1231-1307`
- `fitToBounds`: `src/components/Map/MapCanvas.tsx:1208-1228`
- Panel state: `src/store/uiStore.ts:384-386`
- `triggerZoomToSection`: `src/store/uiStore.ts:424`
- zoom_max config: `src/types/config.ts:291`
- Existing zoom test: `e2e-playwright/zoom-tool.spec.ts`
- Test helpers: `e2e-playwright/helpers/app.ts`
- SPEC.md zoom behavior: `docs/SPEC.md:570`
- MapLibre padding accumulation: https://github.com/maplibre/maplibre-gl-js/issues/6744
