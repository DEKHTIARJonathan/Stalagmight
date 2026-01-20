# fn-5-jef.5 Create DepthLegend component

## Description
Create DepthLegend component that shows depth color gradient with min/max labels.

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
- [ ] Min/max depth labels in correct units
- [ ] Semi-transparent dark background
- [ ] Positioned bottom-left above scale bar
- [ ] Hidden when showDepthGradient is false
- [ ] Single-depth case shows single value with solid color
- [ ] Integrated in MapCanvas
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
