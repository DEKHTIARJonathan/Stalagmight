# fn-20-mwj.4 Implement single azimuth column with circular mean

## Description
Replace the two azimuth columns (Azi In, Azi Out) with a single "Azi" column showing the circular mean. Make it editable with delta-offset behavior.

**Size:** M
**Files:**
- `src/components/SingleSystemView/DataTable.tsx`
- `src/utils/angles.ts` (import)

## Approach

1. Remove columns for `azimuth_in` and `azimuth_out` from columns array

2. Add new "Azi" column:
   - Display: `circularMeanDegrees(shot.azimuth_in, shot.azimuth_out).toFixed(1)`
   - Key: Use virtual key like `_azimuth_avg` (not a real shot field)

3. Custom edit handler for azimuth:
   - Calculate current mean: `currentMean = circularMeanDegrees(shot.azimuth_in, shot.azimuth_out)`
   - Calculate delta: `delta = newValue - currentMean`
   - Apply delta to both: `newIn = normalizeAngle(shot.azimuth_in + delta)`
   - Apply delta to both: `newOut = normalizeAngle(shot.azimuth_out + delta)`
   - Call `updateShot` with both values

4. Update `editableColumns` to include `_azimuth_avg` and handle specially in `handleCellEdit`

## Key context

Circular mean handles wrap-around: 350° and 10° average to ~0°, not 180°.

Edit example: If in=45, out=55 (mean=50), user enters 60:
- delta = 60 - 50 = 10
- newIn = 45 + 10 = 55
- newOut = 55 + 10 = 65
- Mean of 55 and 65 = 60 ✓
## Acceptance
- [ ] Single "Azi" column replaces "Azi In" and "Azi Out" columns
- [ ] Displays circular mean with 1 decimal place (e.g., "123.4")
- [ ] Handles wrap-around: 350° and 10° shows ~0°
- [ ] Column is editable
- [ ] Editing offsets both azimuth_in and azimuth_out by delta
- [ ] Results are normalized to 0-360 range
- [ ] Deviation between in/out is preserved after edit
- [ ] Type check passes: `pnpm tsc --noEmit`
## Done summary
# fn-20-mwj.4 Implementation Summary

## What was implemented
Implemented a single "Azi" column in the DataTable that replaces the separate "Azi In" and "Azi Out" columns with a circular mean display and delta-offset editing.

## Key changes
- **DataTable.tsx:127-139**: Added new `_azimuth_avg` virtual column that displays the circular mean of `azimuth_in` and `azimuth_out` with 1 decimal place
- **DataTable.tsx:69-84**: Implemented custom edit handler for the virtual azimuth column that:
  - Calculates the delta between new value and current circular mean
  - Applies delta to both `azimuth_in` and `azimuth_out`
  - Normalizes results to [0, 360) range
  - Preserves the deviation between in/out values
- **DataTable.tsx:158**: Added `_azimuth_avg` to editableColumns array

## Acceptance criteria verification
- ✅ Single "Azi" column replaces "Azi In" and "Azi Out" columns
- ✅ Displays circular mean with 1 decimal place (e.g., "123.4")
- ✅ Handles wrap-around: 350° and 10° shows ~0° (via circularMeanDegrees)
- ✅ Column is editable
- ✅ Editing offsets both azimuth_in and azimuth_out by delta
- ✅ Results are normalized to 0-360 range (via normalizeAngle)
- ✅ Deviation between in/out is preserved after edit
- ✅ Type check passes: `pnpm tsc --noEmit`

## Tests
- All 464 Playwright tests pass
- TypeScript type check passes

## Review
- Codex impl-review: SHIP verdict
- Minor suggestions noted but no blockers
## Evidence
- Commits: 08d5061 feat(table): implement single azimuth column with circular mean
- Tests: playwright, typescript
- PRs: