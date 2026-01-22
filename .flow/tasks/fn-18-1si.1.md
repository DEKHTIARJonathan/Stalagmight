# fn-18-1si.1 Create stats formatting utility

## Description

Create a reusable utility module for formatting stats values with unit conversion support.

**Size:** S
**Files:** `src/utils/formatStats.ts` (new)

## Approach

- Follow pattern from `export-colors.ts:295` (`formatDepth` function)
- Use existing constant: `FEET_PER_METER = 3.28084`
- Access unit types from `src/types/config.ts:3` (`LengthUnit`)

## Key context

Existing `formatDepth` in export-colors.ts:
```typescript
export function formatDepth(depth: number, unit: string, precision: number): string {
  const value = unit === 'ft' ? depth * 3.28084 : depth;
  return `${value.toFixed(precision)}${unit}`;
}
```

**API Contract:**
- `formatLength` returns just the formatted value with unit (e.g., "42.3m", "138.8ft")
- `formatDepthRange` returns just the range string (e.g., "2.1-15.4m", "--")
- Callers add the "Depth: " prefix themselves for UI consistency
- Accept `LengthUnit` type ('meters' | 'feet') not raw 'ft'/'m' strings
- Handle null/non-finite depth values gracefully (return "--")

## Acceptance
- [ ] `formatLength(meters: number, unit: LengthUnit, precision?: number): string` exported
- [ ] `formatDepthRange(min: number | null, max: number | null, unit: LengthUnit, precision?: number): string` exported
- [ ] `formatDepthRange` returns just the range (e.g., "2.1-15.4m") - callers add "Depth: " prefix
- [ ] Returns "--" (not "Depth: --") when min or max is null or non-finite
- [ ] Converts meters to feet when unit is 'feet' (multiply by 3.28084)
- [ ] Returns suffix 'm' for meters, 'ft' for feet
- [ ] Default precision is 1 decimal place
- [ ] Filters non-finite values (NaN, Infinity) - returns "--" if any input is non-finite
- [ ] TypeScript types pass (pnpm tsc --noEmit)
## Done summary
Created `src/utils/formatStats.ts` with two exported functions:
- `formatLength(meters, unit, precision?)`: Formats length with unit conversion and "--" for non-finite values
- `formatDepthRange(min, max, unit, precision?)`: Formats depth ranges, returns "--" for null/non-finite inputs

Both functions:
- Accept `LengthUnit` type ('meters' | 'feet')
- Convert meters to feet using FEET_PER_METER = 3.28084
- Return 'm' or 'ft' suffix based on unit
- Default to 1 decimal precision
- Handle non-finite values gracefully

Added comprehensive tests in `src/utils/__tests__/formatStats.test.ts` (25 tests passing).
## Evidence
- Commits:
- Tests: pnpm vitest run src/utils/__tests__/formatStats.test.ts - 25 tests passing
- PRs: