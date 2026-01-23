# fn-15-ygz.8 Implement soft bounds with rubber-band panning

## Description

Implement soft bounds with rubber-band panning effect. MapLibre GL JS 4.7.1 doesn't expose `transformConstrain`, so use alternative approach.

**Size:** S
**Files:**
- `src/components/GlobalView/GlobalViewMap.tsx` (bounds handling)

## Approach

- Use `maxBounds` for hard outer limit (combined system bounds + 50% padding)
- Add `moveend` listener that detects when outside soft bounds (20% padding zone)
- If outside soft zone on moveend, animate back using `easeTo` with gentle easing
- This creates a "rubber band" feel without requiring internal MapLibre APIs
- Fit All button still zooms to all systems

## Acceptance

- [ ] Can pan within hard bounds (50% padding)
- [ ] Released pan outside soft zone (20%) smoothly returns via easeTo
- [ ] Fit All button works

## Done summary
Implemented soft bounds with rubber-band panning for GlobalView map. Added hard bounds (50% padding) via maxBounds constraint and soft bounds (20% padding) with easeTo animation when user pans outside. Bounds update dynamically when projects change.
## Evidence
- Commits: b84faf4, 58d7a33
- Tests: pnpm tsc --noEmit, pnpm test:ui
- PRs: