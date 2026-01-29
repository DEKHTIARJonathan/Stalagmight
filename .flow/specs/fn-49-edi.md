# Wire Validation Thresholds into DMP Import Flow

## Overview

Wire the user's validation config (from Settings → Validation Thresholds tab) into the DMP import Step 2 dialog (`DmpSectionConfigDialog`) so that `ShotTableEditor` uses the configured azimuth/pitch thresholds instead of hardcoded defaults. Additionally, show warning count badges (yellow) on the section list sidebar items.

## Scope

### In Scope
- Wire existing `config.validation` through `DmpSectionConfigDialog` → `ShotTableEditor` prop
- Add per-section warning count computation (azimuth/pitch discrepancies only)
- Yellow warning badges on section list sidebar items
- Yellow status icon when section has warnings but no errors

### Out of Scope
- Adding new warning types to ShotTableEditor (no shot length, depth, or azimuth deviation warnings)
- Inline threshold editing in the import dialog
- Warning counts in the error summary text at bottom of sidebar

### Badge Visibility Rules
- **Errors + warnings**: Show error badge only (suppress warning badge when errors exist)
- **Placed sections**: No warning badge (data is committed)
- **Excluded sections**: No warning badge (section won't be imported)
- **Unplaced, no errors**: Show warning badge if warnings exist

## Approach

### Current State
- `ValidationSettings.tsx` manages 6 thresholds in `config.validation`
- `DmpSectionConfigDialog.tsx` already reads `config` from `useProjectStore` for unit display, but never passes `config.validation` to `ShotTableEditor`
- `ShotTableEditor.tsx` accepts optional `validationConfig?: ValidationConfig` prop (interface: `{ azimuth_diff_threshold: number; pitch_diff_threshold: number }`), defaults to `DEFAULT_VALIDATION_CONFIG` (10°/5°)
- `ShotTableEditor` internally uses `getShotWarnings()` → `hasAzimuthWarning()` + `hasPitchWarning()`
- `validation.ts` exports `hasAzimuthDiscrepancy()` and `hasPitchDiscrepancy()`
- `useImportState.ts` has `getSectionDataErrorCount()` for blocking errors but no warning count

### Key Files

| File | Role |
|------|------|
| `src/components/Dialogs/DmpSectionConfigDialog.tsx` | Main changes — pass config, compute warnings, render badges |
| `src/components/common/ShotTableEditor.tsx` | Already supports `validationConfig` prop — no changes needed |
| `src/utils/validation.ts` | `hasAzimuthDiscrepancy()`, `hasPitchDiscrepancy()` — use as-is |
| `src/types/config.ts` | `ValidationConfig` type, `defaultConfig.validation` — reference only |
| `src/hooks/useImportState.ts` | Add warning count function alongside existing error count |

## Quick commands
- `pnpm tsc --noEmit`
- `pnpm test:ui`

## Tasks

| ID | Title | Priority | Depends On |
|----|-------|----------|------------|
| 1 | Pass validation config from store to ShotTableEditor | 1 | — |
| 2 | Add per-section warning count computation to useImportState | 1 | — |
| 3 | Render warning badges and yellow status icons in section list | 2 | 1, 2 |

### Dependencies

```
Task 1 (wire config prop) ──────────┐
                                     ├── Task 3 (render badges + icons)
Task 2 (warning count function) ────┘
```

Tasks 1 and 2 can be done in parallel. Task 3 integrates both.

## Task Details

### Task 1: Pass validation config from store to ShotTableEditor

**What**: In `DmpSectionConfigDialog.tsx`, derive the `ShotTableEditor.ValidationConfig` from the project store's `config.validation` and pass it as a prop.

**Implementation**:
- `DmpSectionConfigDialog` already has `const config = useProjectStore((state) => state.config)` (line ~74).
- Derive the ShotTableEditor-compatible config:
  ```typescript
  const validationConfig = useMemo(() => ({
    azimuth_diff_threshold: config?.validation?.azimuth_diff_threshold ?? defaultConfig.validation.azimuth_diff_threshold,
    pitch_diff_threshold: config?.validation?.pitch_diff_threshold ?? defaultConfig.validation.pitch_diff_threshold,
  }), [config?.validation?.azimuth_diff_threshold, config?.validation?.pitch_diff_threshold]);
  ```
- Pass `validationConfig={validationConfig}` to the `<ShotTableEditor>` JSX element (~line 1553).

**Files changed**: `src/components/Dialogs/DmpSectionConfigDialog.tsx`

### Task 2: Add per-section warning count computation to useImportState

**What**: Add a `getSectionWarningCount()` function that counts azimuth/pitch discrepancy warnings for a section's shots using the validation config thresholds.

**Implementation**:
- In `useImportState.ts`, add a callback that accepts `sectionIndex` and `validationConfig`:
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

**Files changed**: `src/hooks/useImportState.ts`

### Task 3: Render warning badges and yellow status icons in section list

**What**: Update the section list sidebar in `DmpSectionConfigDialog` to show yellow warning count badges and yellow status icons when a section has warnings but no errors.

**Implementation**:
- In the section list `map()` (~line 1038), compute `sectionWarnings` using `getSectionWarningCount(sectionIdx, validationConfig)`.
- Determine whether to show warnings based on visibility rules:
  ```typescript
  const showWarnings = sectionWarnings > 0
    && sectionDataErrors === 0
    && status !== 'excluded'
    && status !== 'placed';
  ```
- Update the status icon logic:
  ```typescript
  if (status === 'excluded') {
    statusIcon = '✕'; statusColor = 'text-error';
  } else if (status === 'errors' || sectionDataErrors > 0) {
    statusIcon = '!'; statusColor = 'text-error';
  } else if (showWarnings) {
    statusIcon = '⚠'; statusColor = 'text-warning';
  } else if (status === 'placed') {
    statusIcon = '✓'; statusColor = 'text-success';
  } else {
    statusIcon = '○'; statusColor = 'text-text-secondary';
  }
  ```
- Add a yellow warning badge (only when `showWarnings` is true):
  ```tsx
  {showWarnings && (
    <span
      className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 bg-warning text-black rounded-full text-[10px] font-medium"
      data-testid={`section-warning-count-${arrayIdx}`}
      title={`${sectionWarnings} warning${sectionWarnings > 1 ? 's' : ''}`}
    >
      {sectionWarnings}
    </span>
  )}
  ```
- **Badge visibility rules**:
  - Suppress warning badge when section has errors (error badge takes precedence)
  - Suppress warning badge on placed sections (data committed)
  - Suppress warning badge on excluded sections (won't be imported)
  - Show warning badge only on unplaced sections with no errors
- Error summary text at bottom of sidebar stays unchanged (errors only).

**Files changed**: `src/components/Dialogs/DmpSectionConfigDialog.tsx`

## Acceptance Criteria

- [ ] ShotTableEditor in DMP import uses the user's configured azimuth/pitch thresholds from Settings
- [ ] Changing thresholds in Settings and reopening import reflects new thresholds
- [ ] Section list shows yellow warning count badge on unplaced sections with azimuth/pitch discrepancies and no errors
- [ ] Section status icon is yellow ⚠ when section has warnings but no errors and is not placed/excluded
- [ ] Section status icon priority: excluded (red ✕) > errors (red !) > warnings (yellow ⚠) > placed (green ✓) > default (gray ○)
- [ ] Warning badge suppressed when section has errors (error badge only)
- [ ] Warning badge suppressed on placed sections
- [ ] Warning badge suppressed on excluded sections
- [ ] Error summary at bottom of sidebar shows only error counts (unchanged)
- [ ] `pnpm tsc --noEmit` passes
- [ ] `pnpm test:ui` passes

## References
- `src/components/Dialogs/settings/ValidationSettings.tsx` — threshold UI
- `src/components/Dialogs/DmpSectionConfigDialog.tsx` — import dialog Step 2
- `src/components/common/ShotTableEditor.tsx` — shot table with warning display
- `src/utils/validation.ts` — shared validation functions
- `src/hooks/useImportState.ts` — import state management hook
