# fn-20-mwj.1 Extract shared utilities (circularMean, formatShotId)

## Description
Extract the `circularMeanDegrees` function from SectionPreview.tsx to a shared utils file, and create a new `formatShotId` utility for consistent ID display across components.

**Size:** S
**Files:** 
- `src/utils/angles.ts` (new)
- `src/utils/formatters.ts` (new or add to existing)
- `src/components/Dialogs/SectionPreview.tsx` (update import)

## Approach

1. Create `src/utils/angles.ts` with:
   - `circularMeanDegrees(a: number, b: number): number` - copied from SectionPreview.tsx:24-36
   - `normalizeAngle(degrees: number): number` - normalize to 0-360 range

2. Create `formatShotId` utility:
   - Signature: `formatShotId(sectionId: number, shotPosition: number): string`
   - Returns `${sectionId}:${shotPosition}` (both are 1-indexed for display)
   - Shot position = index in shots array + 1

3. Update SectionPreview.tsx to import from new utils

## Key context

Existing function at `src/components/Dialogs/SectionPreview.tsx:24-36`:
```typescript
function circularMeanDegrees(a: number, b: number): number {
  const aRad = (a * Math.PI) / 180;
  const bRad = (b * Math.PI) / 180;
  const x = (Math.cos(aRad) + Math.cos(bRad)) / 2;
  const y = (Math.sin(aRad) + Math.sin(bRad)) / 2;
  let result = Math.atan2(y, x) * (180 / Math.PI);
  if (result < 0) result += 360;
  return result;
}
```
## Acceptance
- [ ] `circularMeanDegrees` exported from `src/utils/angles.ts`
- [ ] `normalizeAngle` exported from `src/utils/angles.ts`
- [ ] `formatShotId` exported from `src/utils/formatters.ts`
- [ ] SectionPreview.tsx imports from utils instead of local function
- [ ] `circularMeanDegrees(350, 10)` returns ~0 (not 180)
- [ ] `circularMeanDegrees(10, 20)` returns 15
- [ ] `formatShotId(5, 3)` returns "5:3"
- [ ] Type check passes: `pnpm tsc --noEmit`
## Done summary
Extracted circularMeanDegrees and normalizeAngle to src/utils/angles.ts, and formatShotId to src/utils/formatters.ts. Updated SectionPreview.tsx to import from shared utils. Added comprehensive unit tests for all utilities.
## Evidence
- Commits: 2edcbd71f84c7ae502f6d18ccb41f39976d3dad7
- Tests: pnpm vitest run src/utils/__tests__/angles.test.ts src/utils/__tests__/formatters.test.ts, pnpm tsc --noEmit
- PRs: