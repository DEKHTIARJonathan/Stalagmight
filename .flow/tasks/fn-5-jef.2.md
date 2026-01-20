# fn-5-jef.2 Modify getDepthColor() to use HSL interpolation

## Description
Modify `getDepthColor()` in `src/utils/colors.ts` to use HSL interpolation and return null for invalid inputs.

## Current Implementation (L52-68)
Uses linear RGB interpolation which produces muddy intermediate colors.

## New Implementation
```typescript
export function getDepthColor(
  depth: number,
  shallowColor: string,  // Default: '#00bfff' (light blue)
  deepColor: string,     // Default: '#ff4444' (red)
  minDepth: number,      // Shallowest (smallest z)
  maxDepth: number       // Deepest (largest z)
): string | null {
  // Return null for invalid inputs - caller should fallback to section color
  if (!isFinite(depth) || !isFinite(minDepth) || !isFinite(maxDepth)) {
    return null;
  }
  
  // Handle equal depths (flat cave)
  if (maxDepth === minDepth) {
    return shallowColor;
  }
  
  // Clamp depth to range
  const clampedDepth = Math.max(minDepth, Math.min(maxDepth, depth));
  const t = (clampedDepth - minDepth) / (maxDepth - minDepth);

  // Convert hex to HSL
  const shallowHSL = hexToHSL(shallowColor);
  const deepHSL = hexToHSL(deepColor);
  
  if (!shallowHSL || !deepHSL) return null;  // Invalid color format

  // Interpolate in HSL space (shortest hue path)
  const h = interpolateHue(shallowHSL.h, deepHSL.h, t);
  const s = shallowHSL.s + (deepHSL.s - shallowHSL.s) * t;
  const l = shallowHSL.l + (deepHSL.l - shallowHSL.l) * t;

  return hslToHex(h, s, l);
}
```

## Helper Functions to Add
```typescript
function hexToHSL(hex: string): { h: number, s: number, l: number } | null
function hslToHex(h: number, s: number, l: number): string
function interpolateHue(h1: number, h2: number, t: number): number
```

**interpolateHue**: Take shortest path around color wheel (handle 350° → 10° going through 0°).

## Contract
- Returns valid hex color on success
- Returns `null` for invalid input (NaN, bad colors)
- Caller must handle null by falling back to section color
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
- [ ] Returns `null` for invalid inputs (NaN depth, bad colors)
- [ ] Returns shallow color when minDepth === maxDepth
- [ ] Clamps depth to [minDepth, maxDepth] range
- [ ] Helper functions `hexToHSL()`, `hslToHex()`, `interpolateHue()` added
- [ ] `pnpm tsc --noEmit` passes
## Done summary
Implemented HSL color space interpolation for getDepthColor() with shortest hue path, replacing RGB interpolation. Returns null for invalid inputs (NaN, bad hex colors) with proper caller fallback to section colors.
## Evidence
- Commits: a15c86d92bf4b9c946d1c52c123d7c3b4f99c8e5, fee4059983aeb9f79d7443c5500b1014872ed2c1
- Tests: pnpm tsc --noEmit, pnpm test --run
- PRs: