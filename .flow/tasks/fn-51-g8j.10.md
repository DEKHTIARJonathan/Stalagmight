# fn-51-g8j.10 Migrate inline hex colors in TSX component files to CSS variables

## Description

Replace hardcoded hex colors in JSX `style` props and string literals across 10+ TSX/TS component files with CSS variable references. Create the `themeColors.ts` utility with fallback map. Wire the concrete MapLibre re-styling integration points including GeoJSON feature rebuild.

**EXCLUDE**: `ExportPreview.tsx` render colors (exports always use dark palette).

**CRITICAL**: MapLibre GL JS does NOT read CSS variables. Colors passed to `setPaintProperty()`, `addLayer()`, and style expressions must be literal values read from CSS variables via JS. When the theme changes, MapLibre styles must be explicitly re-applied AND features must be rebuilt (because `buildSurveyFeatures()` embeds theme colors in GeoJSON properties).

**Size:** L (split candidate, but component coupling makes splitting impractical — all MapLibre theme wiring must be coherent)

**Files:**
- `src/utils/themeColors.ts` (new)
- `src/components/Map/SurveyLayer.tsx` — Replace 13 colors + add `applyThemeColors()` method + cache last data for rebuild
- `src/components/Map/MapCanvas.tsx` — Subscribe to `resolvedTheme`, call `surveyLayer.applyThemeColors()` on change
- `src/components/Map/surveyLayer/features.ts` — Accept theme colors parameter; replace hardcoded depth/station/label colors
- `src/components/GlobalView/GlobalSurveyLayer.ts` — Replace 8 colors + add theme re-apply method with feature rebuild
- `src/components/GlobalView/GlobalViewMap.tsx` — Replace 8 colors, wire GlobalSurveyLayer theme re-apply
- `src/components/Dialogs/SectionPreview.tsx` — Replace 12 colors + add `useEffect` on `resolvedTheme` for re-apply
- `src/components/Map/PlacementOverlay.tsx` — Replace 6 snap/anchor colors
- `src/components/Map/MapCanvas.tsx` — Replace background default
- `src/components/Map/GridOverlay.tsx` — Replace grid color default
- `src/components/Map/DepthLegend.tsx` — Replace 3 depth/text colors
- `src/components/common/SectionMetadataForm.tsx` — Replace placeholder color
- `src/components/Dialogs/EditSectionDialog.tsx` — Replace default section color
- `src/components/common/Button.tsx` — Replace `text-background` with `text-accent-on`

## Approach

### Theme color helper utility (`src/utils/themeColors.ts`)

- `getThemeColor(varName: string): string` — reads CSS custom property via `getComputedStyle()`. Includes a **fallback map** with dark-theme defaults for each `--cc-*` variable, preventing empty strings if called before CSS loads or during unusual mount timing.
- `getMapThemeColors()` — returns complete color map object for MapLibre paint properties. Called once on mount and again when `resolvedTheme` changes.

### MapLibre re-styling integration points

1. **`MapCanvas.tsx`** (React component): Subscribes to `useUIStore((s) => s.resolvedTheme)`. On change, calls `surveyLayer.applyThemeColors(getMapThemeColors())` to update all theme-dependent paint/layout properties AND rebuild features.

2. **`SurveyLayer.tsx`** (class): Add `applyThemeColors(colors)` method that:
   - Updates all theme-dependent paint/layout properties via `map.setPaintProperty()` / `map.setLayoutProperty()`
   - **Rebuilds feature data** by calling `update()` with cached sections/stations/loopClosures, because `buildSurveyFeatures()` embeds theme colors in GeoJSON properties
   - Must cache last input data (sections, stations, loopClosures, display settings) for rebuild

3. **`features.ts`**: `buildSurveyFeatures()` must accept theme colors as a parameter instead of using hardcoded hex values. Colors affected: depth gradient defaults (`#00bfff`, `#ff4444`), label color (`#ffffff`), zero-datum color (`#ffd700`), stroke color (`#000000`), section color default (`#ffffff`).

4. **`SectionPreview.tsx`** (owns MapLibre instance): Add `useEffect` on `resolvedTheme` (from `useUIStore`) that calls `getMapThemeColors()` and updates background color + all constant paint properties (gray lines, compass, strokes, halos).

5. **`GlobalSurveyLayer.ts`** (class): Same pattern as SurveyLayer — add theme re-apply method with feature rebuild, called from parent `GlobalViewMap.tsx` when `resolvedTheme` changes.

### Button.tsx on-accent fix

Replace `text-background` with `text-accent-on` in primary variant (line 14). In dark theme `accent-on` is `#1a1a2e` (same as current `background`). In light theme `accent-on` is `#ffffff` (visible on darkened accent).

## Key context

- `SurveyLayer.tsx` is a class, not a function component — it receives theme updates via method call from MapCanvas, not via hooks
- `getThemeColor()` fallback map prevents empty strings that could leak into MapLibre paint props
- Colors are computed once per theme change, not per feature/per frame
- ExportPreview.tsx canvas render colors stay hardcoded (dark palette for exported artifacts)
- `buildSurveyFeatures()` in `features.ts` embeds theme-dependent colors directly in GeoJSON feature properties — changing paint properties alone is NOT sufficient; features must be rebuilt

## Acceptance

- [ ] `src/utils/themeColors.ts` utility created with `getThemeColor()` (with fallback map) and `getMapThemeColors()`
- [ ] All listed files have hardcoded hex colors replaced with theme color reads
- [ ] ExportPreview.tsx canvas render colors remain hardcoded (dark palette)
- [ ] MapCanvas subscribes to `resolvedTheme` and calls `surveyLayer.applyThemeColors()` on change
- [ ] SurveyLayer has `applyThemeColors()` method that updates paint/layout properties AND rebuilds features with new theme colors
- [ ] SurveyLayer caches last input data for feature rebuild on theme change
- [ ] `buildSurveyFeatures()` in `features.ts` accepts theme colors parameter (no hardcoded hex)
- [ ] SectionPreview has `useEffect` on `resolvedTheme` that updates background + constant paint props
- [ ] GlobalSurveyLayer has theme re-apply method (with feature rebuild) called from GlobalViewMap
- [ ] Button.tsx primary variant uses `text-accent-on` instead of `text-background`
- [ ] SectionPreview color prop uses theme-aware default via `getThemeColor()`
- [ ] EditSectionDialog default color uses `getThemeColor('--cc-station-default')`
- [ ] Colors render correctly in dark theme (no visual regression)
- [ ] Colors render correctly in light theme (readable, visible)
- [ ] `pnpm tsc --noEmit` passes

## Done summary

(To be filled on completion)

## Evidence

(To be filled on completion)
