# fn-38-4ja.1 Extract shared padding helper, fix horizontal margin, add skip-zoom-in logic

## Description

Extract a shared padding calculation helper and use it in both `fitToBounds` and `fitToSection`. Fix horizontal margin in `fitToSection` to include 10% of container width (on top of panel offsets). Add skip-zoom-in logic that detects when the section already fits within the viewport AND occupies ≥30% of the viewport, using `easeTo` (center/pan only with padding) instead of `fitBounds`.

**Size:** M
**Files:**
- `src/components/Map/MapCanvas.tsx` (primary — lines 1208-1307)
- `docs/SPEC.md` (line 570 — update zoom behavior description)

## Approach

### 1. Extract shared padding helper

Create a helper function (inside MapCanvas.tsx or a local module) that computes `{ top, bottom, left, right }` padding. It should accept:
- Container element (for `clientWidth`/`clientHeight`)
- Whether to include panel offsets (and which panels are open + their widths)

Replace the duplicated padding calculations in:
- `fitToBounds` (lines 1218-1221) — uses 10% on all sides, no panel offsets
- `fitToSection` (lines 1257-1263) — uses 10% vertical + panel offsets only

After extraction, both call the same helper. `fitToBounds` passes no panel info; `fitToSection` passes panel state. The single-station and zero-area paths in `fitToSection` already use the computed `padding` object (lines 1274, 1290), so they will automatically gain horizontal margin via the shared helper. This is desired for consistency.

### 2. Fix horizontal margin in fitToSection

In the shared helper, horizontal padding = `Math.round(containerWidth * 0.1) + panelOffset`. This ensures 10% margin from the container edge even when panels are closed (panelOffset=0).

The `padding` object at line 1263 should change from:
- `left: sectionsPanelOpen ? sectionsPanelWidth : 0` → `left: marginX + (sectionsPanelOpen ? sectionsPanelWidth : 0)`
- `right: detailPanelOpen ? detailPanelWidth : 0` → `right: marginX + (detailPanelOpen ? detailPanelWidth : 0)`

### 3. Add skip-zoom-in logic

Before the `fitBounds` call (line 1299), add a viewport occupancy check:
1. Project `sw` and `ne` to screen pixels using `map.project()`
2. Calculate `screenWidth = Math.abs(ne.x - sw.x)` and `screenHeight = Math.abs(ne.y - sw.y)`
3. Calculate `ratioX = screenWidth / container.clientWidth` and `ratioY = screenHeight / container.clientHeight`
4. **Skip condition**: Both `ratioX ≤ 1.0` AND `ratioY ≤ 1.0` (section fits in viewport) AND at least one of `ratioX ≥ 0.3` or `ratioY ≥ 0.3` (section is already large enough)
5. If skip condition met: use `easeTo` to center on the bounds midpoint at current zoom, **with the computed `padding` object** (10% + panel offsets), and configured animation duration
6. If section exceeds viewport (either ratio > 1.0): always use `fitBounds` to zoom out
7. If section is small in both axes (both ratios < 0.3): use `fitBounds` to zoom in

For the `easeTo` center-only path, calculate the geographic midpoint:
- `centerLng = (sw[0] + ne[0]) / 2`, `centerLat = (sw[1] + ne[1]) / 2`

**Critical: The `easeTo` center-only path MUST include the `padding` object** so the section is centered within the usable viewport area, not behind panels.

### 4. Update docs/SPEC.md

Update line 570 from:
```
- Sections: Uses `fitBounds()` with padding (fits all points)
```
to describe the new behavior: 10% margin on all sides plus panel offsets, and skip-zoom-in when section already fits and occupies ≥30% of viewport.

## Key context

- **setPadding workaround is mandatory** — Reset padding to `{0,0,0,0}` before any `fitBounds`/`easeTo` call (MapLibre accumulation bug, issue #6744). Already done at line 1247.
- **`map.project()` uses current zoom** — The skip check intentionally operates at the current zoom level to decide whether re-zooming is needed.
- **`easeTo` inherits padding** — Must call `map.stop()` and `setPadding({0})` before `easeTo`. Already handled at lines 1244-1247.
- **`linear: true`** — The existing `fitBounds` call uses `linear: true` (line 1301) which triggers `easeTo`-style animation instead of `flyTo` curve. Preserve this.
- **Single-station/zero-area paths** gain horizontal margin automatically through the shared padding helper. This is desired behavior.

## Acceptance
- [ ] Shared padding helper function exists and is called by both `fitToBounds` and `fitToSection`
- [ ] `fitToSection` applies 10% horizontal margin (Math.round(containerWidth * 0.1)) on top of panel offsets
- [ ] Skip-zoom-in triggers only when section fits within viewport (both ratios ≤ 1.0) AND occupies ≥30% in at least one axis
- [ ] When section exceeds viewport (any ratio > 1.0), `fitBounds` is used to zoom out
- [ ] The center-only `easeTo` path includes the full padding object (10% + panel offsets)
- [ ] The center-only path uses `easeTo` with configured animation duration
- [ ] `fitToBounds` behavior is unchanged (still 10% on all sides, no panel offsets)
- [ ] Single-station and zero-area paths gain horizontal margin via the shared helper
- [ ] `setPadding` reset workaround is preserved
- [ ] `maxZoom` cap (`config.map.zoom_max ?? 22`) is preserved in `fitBounds` call
- [ ] `docs/SPEC.md` line 570 updated to describe new section zoom behavior
- [ ] `pnpm tsc --noEmit` passes

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
