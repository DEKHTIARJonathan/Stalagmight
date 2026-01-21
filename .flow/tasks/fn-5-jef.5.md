# fn-5-jef.5 Create DepthLegend component

## Description
Create DepthLegend component that shows depth color gradient with min/max labels.

## New File: `src/components/Map/DepthLegend.tsx`

### Props
```typescript
interface DepthLegendProps {
  minDepth: number;
  maxDepth: number;
  shallowColor?: string;  // Default: '#00bfff'
  deepColor?: string;     // Default: '#ff4444'
  visible: boolean;
}
```

### Position & Style
Use CSS positioning relative to map container bottom-left:
```css
position: absolute;
bottom: 50px;  /* Approximate - above scale bar */
left: 10px;
background: rgba(0, 0, 0, 0.7);
border-radius: 4px;
padding: 8px;
z-index: 1;  /* Above map, below dialogs */
```

### Component Structure with Test IDs
```tsx
export function DepthLegend({ minDepth, maxDepth, shallowColor = '#00bfff', deepColor = '#ff4444', visible }: DepthLegendProps) {
  if (!visible) return null;
  
  const gradientId = React.useId();
  const isFlat = minDepth === maxDepth;
  
  return (
    <div 
      data-testid="depth-legend"  // For E2E testing
      className="depth-legend"
      style={{ position: 'absolute', bottom: 50, left: 10, ... }}
    >
      <svg 
        width="16" 
        height="80" 
        role="img" 
        aria-label={`Depth scale: ${minDepth.toFixed(1)}m (shallow) to ${maxDepth.toFixed(1)}m (deep)`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={shallowColor} />
            <stop offset="100%" stopColor={isFlat ? shallowColor : deepColor} />
          </linearGradient>
        </defs>
        <rect width="16" height="80" fill={`url(#${gradientId})`} rx="2" />
      </svg>
      <div className="legend-labels">
        <span data-testid="depth-legend-min">{minDepth.toFixed(1)}m</span>
        {isFlat && <span>(Flat)</span>}
        <span data-testid="depth-legend-max">{maxDepth.toFixed(1)}m</span>
      </div>
    </div>
  );
}
```

### Labels
- Top label: min depth (shallow) - format: `${minDepth.toFixed(1)}m`
- Bottom label: max depth (deep) - format: `${maxDepth.toFixed(1)}m`
- Style: `font-size: 11px; color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.8);`

### Special Cases
- **minDepth === maxDepth**: Show single value with "(Flat)" indicator, solid color bar
- **not visible**: Return null (don't render)

### Integration in MapCanvas
Add to JSX after map container, conditionally rendered:
```tsx
{showDepthGradient && stats && (
  <DepthLegend
    minDepth={stats.min_depth}
    maxDepth={stats.max_depth}
    visible={showDepthGradient}
  />
)}
```
## New File: `src/components/Map/DepthLegend.tsx`

### Props
```typescript
interface DepthLegendProps {
  minDepth: number;
  maxDepth: number;
  shallowColor?: string;  // Default: '#00bfff'
  deepColor?: string;     // Default: '#ff4444'
  visible: boolean;
}
```

### Position & Style
Use CSS positioning relative to map container bottom-left:
```css
position: absolute;
bottom: 50px;  /* Approximate - above scale bar */
left: 10px;
background: rgba(0, 0, 0, 0.7);
border-radius: 4px;
padding: 8px;
z-index: 1;  /* Above map, below dialogs */
```

### SVG Gradient Bar (Vertical)
```tsx
<svg 
  width="16" 
  height="80" 
  role="img" 
  aria-label={`Depth scale: ${minDepth.toFixed(1)}m (shallow) to ${maxDepth.toFixed(1)}m (deep)`}
>
  <defs>
    <linearGradient id="depth-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stopColor={shallowColor} />
      <stop offset="100%" stopColor={deepColor} />
    </linearGradient>
  </defs>
  <rect width="16" height="80" fill="url(#depth-gradient)" rx="2" />
</svg>
```

### Labels
- Top label: min depth (shallow) - format: `${minDepth.toFixed(1)}m`
- Bottom label: max depth (deep) - format: `${maxDepth.toFixed(1)}m`
- Style: `font-size: 11px; color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.8);`

### Special Cases
- **minDepth === maxDepth**: Show single value with "(Flat)" indicator, solid color bar
- **not visible**: Return null (don't render)

### Integration in MapCanvas
Add to JSX after map container, conditionally rendered:
```tsx
{showDepthGradient && stats && (
  <DepthLegend
    minDepth={stats.min_depth}
    maxDepth={stats.max_depth}
    visible={showDepthGradient}
  />
)}
```
## New File: `src/components/Map/DepthLegend.tsx`

### Props
```typescript
interface DepthLegendProps {
  minDepth: number;
  maxDepth: number;
  shallowColor?: string;  // Default: '#00bfff'
  deepColor?: string;     // Default: '#ff4444'
  unit: 'm' | 'ft';
  visible: boolean;
}
```

### Position & Style
```css
position: absolute;
bottom: 50px;  /* 10px above scale bar (scale bar height ~40px) */
left: 10px;
background: rgba(0, 0, 0, 0.7);
border-radius: 4px;
padding: 8px;
```

### SVG Gradient Bar (Vertical)
```tsx
<svg width="16" height="80" role="img" aria-label={`Depth scale: ${minDepth}${unit} to ${maxDepth}${unit}`}>
  <defs>
    <linearGradient id="depth-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stopColor={shallowColor} />
      <stop offset="100%" stopColor={deepColor} />
    </linearGradient>
  </defs>
  <rect width="16" height="80" fill="url(#depth-gradient)" rx="2" />
</svg>
```

### Labels
- Top label: min depth (shallow) - e.g., "0.0m"
- Bottom label: max depth (deep) - e.g., "45.2m"
- Style: `font-size: 11px; color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.8);`

### Special Cases
- **minDepth === maxDepth**: Show single value with "(Flat)" indicator, solid color bar
- **not visible**: Return null (don't render)

### Accessibility
- `role="img"` on SVG
- `aria-label` with depth range description

## Integration in MapCanvas
Add after scale bar area:
```tsx
{showDepthGradient && stats && (
  <DepthLegend
    minDepth={stats.min_depth}
    maxDepth={stats.max_depth}
    unit={config?.measurement_unit ?? 'm'}
    visible={showDepthGradient}
  />
)}
```
## Component Specification

### Location
`src/components/Map/DepthLegend.tsx`

### Props
```typescript
interface DepthLegendProps {
  minDepth: number;
  maxDepth: number;
  shallowColor: string;  // Default: '#00bfff'
  deepColor: string;     // Default: '#ff4444'
  unit: 'm' | 'ft';      // From project config
  visible: boolean;      // Controlled by showDepthGradient toggle
}
```

### Visual Design
- Position: bottom-left corner, above scale bar (CSS: `bottom: 40px; left: 10px`)
- Size: 16px wide × 80px tall gradient bar
- Background: semi-transparent dark (`rgba(0,0,0,0.7)`, rounded corners)
- Padding: 8px
- Total size with labels: ~40px wide × 100px tall

### SVG Gradient Bar
```tsx
<svg width="16" height="80">
  <defs>
    <linearGradient id="depth-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stopColor={shallowColor} />
      <stop offset="100%" stopColor={deepColor} />
    </linearGradient>
  </defs>
  <rect width="16" height="80" fill="url(#depth-gradient)" rx="2" />
</svg>
```

### Labels
- Top label: min depth (shallow) - e.g., "0.0m"
- Bottom label: max depth (deep) - e.g., "45.2m"
- Font: 11px, white, monospace for alignment
- Match project measurement unit

### Special Cases
- If minDepth === maxDepth: show single value, solid color bar
- If not visible: return null (don't render)

## Integration in MapCanvas
Add DepthLegend as sibling to existing overlays, conditionally rendered when showDepthGradient is true.
## Acceptance
- [ ] DepthLegend component created at `src/components/Map/DepthLegend.tsx`
- [ ] SVG gradient bar 16×80px rendered correctly
- [ ] Min/max depth labels formatted as `X.Xm`
- [ ] Semi-transparent dark background (rgba(0,0,0,0.7))
- [ ] Positioned bottom-left above scale bar area
- [ ] Hidden when showDepthGradient is false (returns null)
- [ ] Single-depth case shows "(Flat)" with solid color
- [ ] Accessible with role="img" and aria-label
- [ ] `data-testid="depth-legend"` on container for E2E testing
- [ ] `data-testid="depth-legend-min"` and `data-testid="depth-legend-max"` on labels
- [ ] Unique gradient ID using React.useId()
- [ ] Integrated in MapCanvas
- [ ] `pnpm tsc --noEmit` passes
## Done summary
Created DepthLegend component showing depth color gradient with min/max labels, positioned bottom-left above scale bar. Integrated into MapCanvas, visible when showDepthGradient toggle is enabled.
## Evidence
- Commits: 16da9bc7c2b60453a5d28ef2b8bb910e5750d95d
- Tests: pnpm tsc --noEmit
- PRs: