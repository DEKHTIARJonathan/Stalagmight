# Task 17: Implement Configurable Validation Thresholds

## Description

Make the azimuth and pitch difference thresholds configurable. Show warnings in the shot table when in/out values differ by more than the configured threshold.

## Files to Modify

- `src/types/config.ts`
- `src-tauri/src/config/defaults.rs`
- `src/utils/validation.ts`
- `src/components/common/ShotTableEditor.tsx`

## Implementation

### 1. Add Thresholds to Config Type

```tsx
// In src/types/config.ts
export interface ValidationConfig {
  // ... existing fields
  azimuthDiffThreshold: number;  // degrees, default 10
  pitchDiffThreshold: number;    // degrees, default 5
}

export const defaultConfig: Config = {
  validation: {
    // ... existing
    azimuthDiffThreshold: 10,
    pitchDiffThreshold: 5,
  },
};
```

### 2. Update Rust Config Defaults

```rust
// In src-tauri/src/config/defaults.rs
pub struct ValidationConfig {
    // ... existing
    pub azimuth_diff_threshold: f64,  // degrees
    pub pitch_diff_threshold: f64,    // degrees
}

impl Default for ValidationConfig {
    fn default() -> Self {
        Self {
            // ... existing
            azimuth_diff_threshold: 10.0,
            pitch_diff_threshold: 5.0,
        }
    }
}
```

### 3. Add Validation Functions

```tsx
// In src/utils/validation.ts

/**
 * Check if azimuth in/out values differ by more than expected.
 * For most shots, azimuth_out should be azimuth_in ± 180°
 */
export function hasAzimuthDiscrepancy(
  azimuthIn: number,
  azimuthOut: number,
  threshold: number
): boolean {
  // Normalize difference to handle 0/360 wrap
  let diff = Math.abs(azimuthIn - azimuthOut);
  if (diff > 180) diff = 360 - diff;

  // Expected difference is 180° (surveyor faces back)
  const expectedDiff = 180;
  return Math.abs(diff - expectedDiff) > threshold;
}

/**
 * Check if pitch in/out values differ significantly.
 */
export function hasPitchDiscrepancy(
  pitchIn: number | null,
  pitchOut: number | null,
  threshold: number
): boolean {
  if (pitchIn === null || pitchOut === null) return false;
  return Math.abs(pitchIn - pitchOut) > threshold;
}
```

### 4. Use in ShotTableEditor

```tsx
// In ShotTableEditor.tsx
const { azimuthDiffThreshold, pitchDiffThreshold } = validationConfig;

// For each shot
const azimuthWarning = hasAzimuthDiscrepancy(
  shot.azimuth_in,
  shot.azimuth_out,
  azimuthDiffThreshold
);

const pitchWarning = hasPitchDiscrepancy(
  shot.pitch_in,
  shot.pitch_out,
  pitchDiffThreshold
);

// Show warning icon in Warnings column
{(azimuthWarning || pitchWarning) && (
  <span
    className="text-warning"
    title={[
      azimuthWarning && `Azimuth in/out differ by more than ${azimuthDiffThreshold}°`,
      pitchWarning && `Pitch in/out differ by more than ${pitchDiffThreshold}°`,
    ].filter(Boolean).join('\n')}
  >
    ⚠
  </span>
)}
```

### 5. Tooltip Details

Warning icon tooltip shows:
- "Azimuth in/out differ by more than X°" (if applicable)
- "Pitch in/out differ by more than Y°" (if applicable)

## Acceptance Criteria

- [ ] Config type has azimuthDiffThreshold and pitchDiffThreshold
- [ ] Default values: azimuth 10°, pitch 5°
- [ ] hasAzimuthDiscrepancy function handles 0/360 wrap
- [ ] hasPitchDiscrepancy function works with null values
- [ ] Warning icon shown in Warnings column when exceeded
- [ ] Tooltip explains the warning
- [ ] Thresholds read from config
- [ ] TypeScript and Rust compile without errors

## Test Suggestions

### Unit Tests (Rust)
1. Test default config has correct threshold values
2. Test config serialization/deserialization
3. Test config persistence

### Playwright Tests (3-10)
1. Test no warning when azimuth in/out correct (180° diff)
2. Test warning when azimuth in/out differ significantly
3. Test no warning when pitch in/out match
4. Test warning when pitch in/out differ
5. Test tooltip shows correct message
6. Test warning with 0/360 wrap case (e.g., 5° in, 185° out)
7. Test no pitch warning when values are null

### WebdriverIO Tests (3-10)
1. Test warning displays with real DMP data
2. Test multiple warnings on same row
3. Test warnings update after editing values

## Done Summary
(To be filled when complete)

## Evidence
- Commits:
- Tests:
- PRs:
