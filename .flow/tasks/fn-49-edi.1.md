# fn-49-edi.1 Pass validation config from store to ShotTableEditor

## Description

In `DmpSectionConfigDialog.tsx`, derive the `ShotTableEditor.ValidationConfig` from the project store's `config.validation` and pass it as a prop to `ShotTableEditor`.

### Implementation

- `DmpSectionConfigDialog` already has `const config = useProjectStore((state) => state.config)` (line ~74).
- Derive the ShotTableEditor-compatible config:
  ```typescript
  const validationConfig = useMemo(() => ({
    azimuth_diff_threshold: config?.validation?.azimuth_diff_threshold ?? defaultConfig.validation.azimuth_diff_threshold,
    pitch_diff_threshold: config?.validation?.pitch_diff_threshold ?? defaultConfig.validation.pitch_diff_threshold,
  }), [config?.validation?.azimuth_diff_threshold, config?.validation?.pitch_diff_threshold]);
  ```
- Pass `validationConfig={validationConfig}` to the `<ShotTableEditor>` JSX element (~line 1553).
- Import `useMemo` if not already imported, and `defaultConfig` from `../../types/config`.

### Files changed
- `src/components/Dialogs/DmpSectionConfigDialog.tsx`

## Acceptance
- [ ] ShotTableEditor receives `validationConfig` prop derived from project store
- [ ] Falls back to `defaultConfig.validation` values when config is null
- [ ] `pnpm tsc --noEmit` passes

## Done summary
Passed validation config (azimuth/pitch thresholds) from project store to ShotTableEditor in DmpSectionConfigDialog, with defaultConfig fallback via useMemo.
## Evidence
- Commits: b1537ef, 1fde79a
- Tests: pnpm tsc --noEmit
- PRs: