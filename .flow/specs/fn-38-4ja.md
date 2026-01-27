# Fix section zoom to leave 10% margin

## Problem

Double-clicking a section (or clicking the "Center" button in the detail panel) zooms too aggressively. The `fitToSection` function in `MapCanvas.tsx` calculates 10% vertical padding (top/bottom) but uses **zero horizontal margin** when panels are closed — left/right padding only accounts for panel widths. This causes the section to fill the entire horizontal viewport with no breathing room.

By contrast, `fitToBounds` ("fit to view") correctly applies 10% padding on all four sides.

## Key Decisions

- **Match fitToBounds approach**: Add 10% of container width as horizontal margin, stacked on top of panel offsets. 10% of container height for vertical (already present).
- **Margin measured from container edge**: Use full container width/height (before panel subtraction) as the basis for the 10% calculation. Panel offsets are added separately.
- **Percentage per axis**: 10% of width for left/right, 10% of height for top/bottom. No uniform-pixel normalization needed.
- **Skip zoom-in when section is already large enough**: If the section's bounding box already occupies ≥30% of the viewport in either X or Y dimension at the current zoom level, only center (pan) without changing zoom. Use `easeTo` with the configured animation duration.
- **30% threshold measured as pixel ratio**: Project section bounds to screen pixels and compare width to viewport width, height to viewport height.
- **Max zoom**: Keep `config.map.zoom_max` (default 22) as the ceiling. Do not over-zoom.
- **Multi-station path only**: The single-station `easeTo` and zero-area bounds cases already work correctly with padding. Only the `fitBounds` path (multi-station, non-degenerate bounds) needs fixing.
- **Single code path**: Both double-click and detail panel center button call `triggerZoomToSection → fitToSection`. Fix applies to both automatically.
- **Same behavior for both triggers**: No differentiation between double-click and center button.
- **Extract shared padding helper**: Create a shared function for the common 10% margin calculation used by both `fitToBounds` and `fitToSection` to reduce duplication.
- **Animation**: Use `easeTo` with configured animation duration for the "center + keep zoom" case (when skip-zoom-in triggers).
- **E2E test**: Add a Playwright test asserting both that section bounds have visible margin from viewport edges AND the zoom level is within a reasonable range.

## Edge Cases

- Section with all stations at the same XY (zero-area bounds): Handled by existing degenerate-bounds path — uses `easeTo` to point_zoom. No change needed.
- Single-station section: Handled by existing single-station path — uses `easeTo` to point_zoom with padding. No change needed.
- Section with extreme aspect ratio (very wide or very narrow): Percentage-per-axis padding means the shorter dimension gets proportionally more visual space. Accepted behavior, matches fitToBounds.
- Very small section at high zoom: `config.map.zoom_max` caps the zoom level. The 30% skip-zoom-in threshold prevents unnecessary zoom-in when the section is already visible.
- Section already centered and visible at current zoom: The 30% threshold check causes only a center-pan (no zoom change), avoiding jarring zoom-in.
- Panels open/closed: Panel offsets are added on top of the 10% margin. When panels are closed, the section still has 10% margin from the container edge.

## Open Questions

None — all requirements clarified during interview.

## Acceptance

- [ ] Double-clicking a section zooms to show the section with ~10% margin on all sides (plus panel offsets on left/right)
- [ ] The "Center" button in the detail panel produces the same zoom behavior
- [ ] If the section already occupies ≥30% of viewport in X or Y, only center (pan) without zoom change
- [ ] The pan-only case uses animated transition (easeTo with configured duration)
- [ ] fitToBounds and fitToSection share a common padding calculation helper
- [ ] Max zoom never exceeds config.map.zoom_max
- [ ] Single-station and zero-area cases are unchanged
- [ ] E2E Playwright test verifies: section bounds have margin from viewport edges AND zoom level is reasonable
- [ ] MapLibre padding accumulation workaround (setPadding reset) is preserved
