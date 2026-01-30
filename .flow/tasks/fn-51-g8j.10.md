# fn-51-g8j.10 Migrate inline hex colors in TSX component files to CSS variables

## Description

Replace hardcoded hex colors in JSX `style` props and string literals across 10+ TSX/TS component files with CSS variable references. These are map visualization, canvas preview, and UI indicator colors.

**EXCLUDE**: `ExportPreview.tsx` render colors (exports always use dark palette). Only migrate its Tailwind opacity classes, not its canvas drawing colors.

## Files to modify

### Map visualization components
- `src/components/Map/SurveyLayer.tsx` — 13 colors: station default (#4ecdc4), strokes (#000000), hover (#0066ff), selected (#00aaff), snap (#00ffcc), text halos (#1a1a2e, #000000)
- `src/components/Map/surveyLayer/features.ts` — Depth defaults (#00bfff, #ff4444), station label (#ffffff), section color (#ffffff), zero datum (#ffd700), strokes (#000000)
- `src/components/GlobalView/GlobalSurveyLayer.ts` — Strokes (#000000), fallback lines (#888888), fallback circles (#888888), gray text (#aaa)
- `src/components/GlobalView/GlobalViewMap.tsx` — Text (#1a1a2e), error (#ef4444), gray text (#666, #888), borders (#ffffff), light gray (#aaa)
- `src/components/Map/PlacementOverlay.tsx` — Snap colors (#00ffcc), anchor colors (#000, #fff)
- `src/components/Map/MapCanvas.tsx` — Background default (#1a1a2e)
- `src/components/Map/GridOverlay.tsx` — Grid color default (#333366)
- `src/components/Map/DepthLegend.tsx` — Depth shallow (#00bfff), deep (#ff4444), text (rgba(255,255,255,0.7))

### Canvas preview components
- `src/components/Dialogs/SectionPreview.tsx` — Background (#1a1a2e), lines (#888888), circles (#888888), strokes (#000000), compass (#ffcc00), station (#4ecdc4), text (#ffffff)
- `src/components/common/SectionMetadataForm.tsx` — Placeholder color (#4ecdc4)
- `src/components/Dialogs/EditSectionDialog.tsx` — Default section color (#4ecdc4)

## Implementation

For each file, replace hardcoded hex values with CSS variable reads:

### In JSX style props
```typescript
// Before
style={{ backgroundColor: '#1a1a2e' }}

// After — use getComputedStyle to read CSS variable
const styles = getComputedStyle(document.documentElement);
const bgColor = styles.getPropertyValue('--cc-background').trim();
style={{ backgroundColor: bgColor }}
```

### In MapLibre style expressions
MapLibre GL JS style expressions don't support CSS variables directly. These must be read via JS:
```typescript
// Create a helper that reads theme colors for MapLibre
function getThemeColor(varName: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(varName).trim();
}

// Use in paint properties
'circle-color': getThemeColor('--cc-station-default')
```

**Important**: MapLibre styles are set once and don't reactively update when CSS variables change. When the theme changes, map styles must be re-applied. The useTheme hook should expose a theme change event/callback that map components can subscribe to.

### In canvas 2D drawing
```typescript
// Before
ctx.fillStyle = '#1a1a2e';

// After
ctx.fillStyle = getComputedStyle(document.documentElement)
  .getPropertyValue('--cc-preview-bg').trim();
```

## Acceptance

- [ ] All listed files have hardcoded hex colors replaced with CSS variable reads
- [ ] ExportPreview.tsx canvas render colors remain hardcoded (dark palette)
- [ ] MapLibre style expressions read colors via JS helper
- [ ] Canvas 2D drawing contexts read colors from CSS variables
- [ ] Colors render correctly in dark theme (no visual regression)
- [ ] Colors render correctly in light theme (auto-derived, readable)
- [ ] `pnpm tsc --noEmit` passes
