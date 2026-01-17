# Task 36: Validation Thresholds Tab

## Overview
Configure validation warning thresholds and severity levels in the settings dialog. Includes min/max shot length, depth change, and azimuth deviation thresholds.

## Priority
Medium - Phase B (Settings)

## Risk Level
Low-Medium

## Dependencies
- Task 34: Settings dialog shell

## Files to Modify
- `src/components/Dialogs/settings/TabValidation.tsx` - New file
- `src-tauri/src/config/mod.rs` - Add validation threshold fields
- `src/types/config.ts` - Update TypeScript types

## Specifications

### Validation Thresholds
```typescript
interface ValidationThresholds {
  minShotLength: number;    // Default: 0.1m
  maxShotLength: number;    // Default: 100m
  maxDepthChange: number;   // Default: 50m
  maxAzimuthDeviation: number; // Default: 180°
}
```

### Severity System
- Errors: Block save/export operations
- Warnings: Advise user but allow proceed
- Configurable per-validation type

### UI Layout
- Input fields with validation
- Slider alternative for common ranges
- Preview button: "Revalidate Project"

### Revalidate Button
- Optional button to re-run validation with new thresholds
- Shows validation results summary
- Does NOT auto-revalidate on threshold change

### Validation Scope
- Global only (applies to all projects)
- No per-project overrides in v1

### Reset Behavior
- Reset icon next to each threshold
- "Reset Validation Settings" button

## Acceptance Criteria
- [ ] All threshold inputs work
- [ ] Severity selection per validation type
- [ ] Revalidate button triggers validation
- [ ] Settings persist to config file
- [ ] Validation uses configured thresholds
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Rust Tests
1. Test config save with validation threshold fields
2. Test config load with validation threshold fields
3. Test validation uses configured minShotLength
4. Test validation uses configured maxShotLength
5. Test validation uses configured maxDepthChange
6. Test default threshold values applied

### Playwright Tests (Mocked IPC)
1. Test minShotLength input accepts valid values
2. Test maxShotLength input accepts valid values
3. Test maxDepthChange input accepts valid values
4. Test severity dropdown for each validation type
5. Test "Revalidate Project" button triggers validation
6. Test validation results summary displays
7. Test reset icon restores individual threshold
8. Test "Reset Validation Settings" restores all

### WebdriverIO Tests (Full App)
1. Test threshold changes affect actual validation
2. Test revalidate with real project data
3. Test settings persist to config file
4. Test validation respects severity levels

## Edge Cases
- Invalid threshold values (negative, zero)
- Max < min for range thresholds
- Very large threshold values
