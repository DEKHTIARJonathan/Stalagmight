# fn-5-jef.2 Modify getDepthColor() to use HSL interpolation

## Description
Modify `getDepthColor()` in `src/utils/colors.ts` to use HSL interpolation instead of RGB.

## Current Implementation (L52-68)
Currently uses linear RGB interpolation which can produce muddy intermediate colors.

## New Implementation
Use HSL color space interpolation with shortest hue path:

```typescript
export function getDepthColor(
  depth: number,
  shallowColor: string,  // Default: '#00bfff' (light blue)
  deepColor: string,     // Default: '#ff4444' (red)
  shallowDepth: number,  // Default: 0
  deepDepth: number      // Default: project max depth
): string {
  // Clamp depth to range
  const t = Math.max(0, Math.min(1, (depth - shallowDepth) / (deepDepth - shallowDepth)));

  // Convert hex to HSL
  const shallowHSL = hexToHSL(shallowColor);
  const deepHSL = hexToHSL(deepColor);

  // Interpolate in HSL space (shortest hue path)
  const h = interpolateHue(shallowHSL.h, deepHSL.h, t);
  const s = shallowHSL.s + (deepHSL.s - shallowHSL.s) * t;
  const l = shallowHSL.l + (deepHSL.l - shallowHSL.l) * t;

  return hslToHex(h, s, l);
}
```

## Helper Functions to Add
- `hexToHSL(hex: string): { h: number, s: number, l: number }`
- `hslToHex(h: number, s: number, l: number): string`
- `interpolateHue(h1: number, h2: number, t: number): number` - takes shortest path around color wheel

## Notes
- Keep existing function signature for backward compatibility
- Handle edge case: if deepDepth === shallowDepth, return shallowColor
- Default colors: shallow=#00bfff (light blue), deep=#ff4444 (red)
## Acceptance
- [ ] `getDepthColor()` uses HSL interpolation with shortest hue path
- [ ] Helper functions `hexToHSL()`, `hslToHex()`, `interpolateHue()` added
- [ ] Edge case: same shallow/deep depth returns shallow color
- [ ] Function signature unchanged for backward compatibility
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
