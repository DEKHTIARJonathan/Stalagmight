# fn-49-edi.2 Add per-section warning count computation to useImportState

## Description

Add a `getSectionWarningCount()` function to `useImportState.ts` that counts azimuth/pitch discrepancy warnings for a section's shots using configurable validation thresholds.

### Implementation

- In `useImportState.ts`, add a callback:
  ```typescript
  const getSectionWarningCount = useCallback((
    sectionIndex: number,
    valConfig: { azimuth_diff_threshold: number; pitch_diff_threshold: number }
  ): number => {
    const sectionConfig = sectionConfigs.get(sectionIndex);
    if (!sectionConfig) return 0;
    let warnings = 0;
    for (const shot of sectionConfig.shots) {
      if (shot.isDeleted) continue;
      if (hasAzimuthDiscrepancy(shot.azimuth_in, shot.azimuth_out, valConfig.azimuth_diff_threshold)) warnings++;
      if (hasPitchDiscrepancy(shot.pitch_in, shot.pitch_out, valConfig.pitch_diff_threshold)) warnings++;
    }
    return warnings;
  }, [sectionConfigs]);
  ```
- Import `hasAzimuthDiscrepancy` and `hasPitchDiscrepancy` from `../utils/validation`.
- Return `getSectionWarningCount` from the hook alongside existing exports.
- Note: Check `EditableShot` type for exact field names (`azimuth_in`, `azimuth_out`, `pitch_in`, `pitch_out`) and nullability.

### Files changed
- `src/hooks/useImportState.ts`

## Acceptance
- [ ] `getSectionWarningCount(sectionIndex, valConfig)` returns count of non-deleted shots with azimuth or pitch discrepancies
- [ ] Uses `hasAzimuthDiscrepancy` and `hasPitchDiscrepancy` from `validation.ts`
- [ ] Function is exported from `useImportState` hook return value
- [ ] `pnpm tsc --noEmit` passes

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
