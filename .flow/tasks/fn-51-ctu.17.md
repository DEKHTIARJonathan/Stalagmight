# fn-51-ctu.17 Implement Configurable Validation Thresholds

## Description
Make azimuth and pitch difference thresholds configurable for warning display.

## Files to Modify
- `src/types/config.ts`
- `src-tauri/src/config/defaults.rs`
- `src/utils/validation.ts`
- `src/components/common/ShotTableEditor.tsx`

## Config Changes
```tsx
interface ValidationConfig {
  azimuthDiffThreshold: number;  // degrees, default 10
  pitchDiffThreshold: number;    // degrees, default 5
}
```

## Validation Functions
```tsx
function hasAzimuthDiscrepancy(azimuthIn: number, azimuthOut: number, threshold: number): boolean
function hasPitchDiscrepancy(pitchIn: number | null, pitchOut: number | null, threshold: number): boolean
```

## References
- `tasks/urgent/task-17-validation-thresholds.md`
## Acceptance
- [ ] Config type has azimuthDiffThreshold and pitchDiffThreshold
- [ ] Default values: azimuth 10deg, pitch 5deg
- [ ] hasAzimuthDiscrepancy function handles 0/360 wrap
- [ ] hasPitchDiscrepancy function works with null values
- [ ] Warning icon shown in Warnings column when exceeded
- [ ] Tooltip explains the warning
- [ ] Thresholds read from config
- [ ] TypeScript and Rust compile without errors
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
