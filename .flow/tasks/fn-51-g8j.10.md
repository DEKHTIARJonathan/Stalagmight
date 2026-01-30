# fn-51-g8j.10 Migrate inline hex colors in TSX component files to CSS variables

## Description

Replace hardcoded hex colors in JSX `style` props and string literals across 10+ TSX/TS component files with CSS variable references. These are map visualization, canvas preview, and UI indicator colors.

**EXCLUDE**: `ExportPreview.tsx` render colors (exports always use dark palette). Only migrate its Tailwind opacity classes (handled in task 11), not its canvas drawing colors.

**CRITICAL**: MapLibre GL JS does NOT read CSS variables. Colors passed to `setPaintProperty()`, `addLayer()`, and style expressions must be literal values read from CSS variables via JS. When the theme changes, MapLibre styles must be explicitly re-applied.

## Files to modify

### Map visualization components (MapLibre — need re-apply on theme change)
- `src/components/Map/SurveyLayer.tsx` — 13 colors: station default (#4ecdc4), strokes (#000000), hover (#0066ff), selected (#00aaff), snap (#00ffcc), text halos (#1a1a2e, #000000)
- `src/components/Map/surveyLayer/features.ts` — Depth defaults (#00bfff, #ff4444), station label (#ffffff), section color (#ffffff), zero datum (#ffd700), strokes (#000000)
- `src/components/GlobalView/GlobalSurveyLayer.ts` — Strokes (#000000), fallback lines (#888888), fallback circles (#888888), gray text (#aaa)
- `src/components/GlobalView/GlobalViewMap.tsx` — Text (#1a1a2e), error (#ef4444), gray text (#666, #888), borders (#ffffff), light gray (#aaa)
- `src/components/Map/PlacementOverlay.tsx` — Snap colors (#00ffcc), anchor colors (#000, #fff)
- `src/components/Map/MapCanvas.tsx` — Background default (#1a1a2e)
- `src/components/Map/GridOverlay.tsx` — Grid color default (#333366)
- `src/components/Map/DepthLegend.tsx` — Depth shallow (#00bfff), deep (#ff4444), text (rgba(255,255,255,0.7))

### Canvas preview components (MapLibre-based — need re-apply on theme change)
- `src/components/Dialogs/SectionPreview.tsx` — Background (#1a1a2e), lines (#888888), circles (#888888), strokes (#000000), compass (#ffcc00), station default (#4ecdc4), text (#ffffff)

### Simple component defaults
- `src/components/common/SectionMetadataForm.tsx` — Placeholder color (#4ecdc4) → use `--cc-accent`
- `src/components/Dialogs/EditSectionDialog.tsx` — Default section color (#4ecdc4) → use `--cc-station-default`

## Implementation

### Theme color helper utility

Create `src/utils/themeColors.ts`:
```typescript
/**
 * Reads a CSS custom property value from the document root.
 * Used for MapLibre and canvas contexts that can't read CSS variables directly.
 */
export function getThemeColor(varName: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(varName).trim();
}

/**
 * Returns a complete color map for MapLibre paint properties.
 * Called once on mount and again when resolvedTheme changes.
 */
export function getMapThemeColors() {
  return {
    snapColor: getThemeColor('--cc-snap-color'),
    hoverHighlight: getThemeColor('--cc-hover-highlight'),
    selectHighlight: getThemeColor('--cc-select-highlight'),
    strokeColor: getThemeColor('--cc-stroke-color'),
    strokeLight: getThemeColor('--cc-stroke-light'),
    textHalo: getThemeColor('--cc-text-halo'),
    textHaloAlt: getThemeColor('--cc-text-halo-alt'),
    stationDefault: getThemeColor('--cc-station-default'),
    grayLine: getThemeColor('--cc-gray-line'),
    grayText: getThemeColor('--cc-gray-text'),
    gridDefault: getThemeColor('--cc-grid-default'),
    zeroDatum: getThemeColor('--cc-zero-datum'),
    compassColor: getThemeColor('--cc-compass-color'),
    depthShallow: getThemeColor('--cc-depth-shallow'),
    depthDeep: getThemeColor('--cc-depth-deep'),
    depthText: getThemeColor('--cc-depth-text'),
    previewBg: getThemeColor('--cc-preview-bg'),
    previewText: getThemeColor('--cc-preview-text'),
    background: getThemeColor('--cc-background'),
    accent: getThemeColor('--cc-accent'),
    textPrimary: getThemeColor('--cc-text-primary'),
  };
}
```

### MapLibre component pattern — re-apply on theme change

Each MapLibre component must:
1. Read `resolvedTheme` from `useUIStore`
2. Call `getMapThemeColors()` to get current color values
3. Re-apply paint/layout properties when `resolvedTheme` changes

```typescript
// In SurveyLayer.tsx (or similar)
const resolvedTheme = useUIStore((s) => s.resolvedTheme);

useEffect(() => {
  if (!map) return;
  const colors = getMapThemeColors();
  
  // Re-apply all paint properties that use theme colors
  map.setPaintProperty('stations-highlight', 'circle-color', colors.snapColor);
  map.setPaintProperty('ghost-merge', 'circle-color', colors.stationDefault);
  // ... etc for all themed paint properties
}, [resolvedTheme, map]);
```

### SectionPreview.tsx pattern

SectionPreview uses MapLibre internally. Its color prop defaults to `#4ecdc4`:
```typescript
// Before
color = '#4ecdc4'

// After — read from CSS variable
color = getThemeColor('--cc-station-default')
```

Parent components passing `color` prop should also use theme-aware values.

### Simple component defaults

For non-MapLibre components (EditSectionDialog, SectionMetadataForm), use CSS variable reads:
```typescript
// Before
const [color, setColor] = useState('#4ecdc4');

// After
const [color, setColor] = useState(() => getThemeColor('--cc-station-default'));
```

## Acceptance

- [ ] `src/utils/themeColors.ts` utility created with `getThemeColor()` and `getMapThemeColors()`
- [ ] All listed files have hardcoded hex colors replaced with theme color reads
- [ ] ExportPreview.tsx canvas render colors remain hardcoded (dark palette)
- [ ] MapLibre components re-apply paint/layout properties when `resolvedTheme` changes
- [ ] SectionPreview color prop uses theme-aware default
- [ ] EditSectionDialog default color uses `--cc-station-default`
- [ ] Colors render correctly in dark theme (no visual regression)
- [ ] Colors render correctly in light theme (readable, visible)
- [ ] `pnpm tsc --noEmit` passes
