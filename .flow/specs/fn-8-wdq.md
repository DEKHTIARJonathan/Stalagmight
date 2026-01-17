# Add inline validation warnings to DMP Import Dialog

## Overview

Display warning/error icons on shots with validation issues. Uses config thresholds for validation rules.

## Scope

- Warning icon column in shot preview table
- Cell highlighting for problem fields
- Hover tooltips with messages
- Summary count in header
- Proceed checkbox for warnings (errors block)
- Severity: Error (red) blocks, Warning (yellow) can bypass

### Validation Rules
- Shot length exceeds max
- Azimuth out of range
- Depth change exceeds threshold
- LRUD exceeds passage max
- Duplicate station names
- Missing required fields

## Dependencies

Depends on fn-4-qe3 (shot preview table must exist).

## Quick commands

```bash
pnpm tsc --noEmit
pnpm test:ui
```

## Acceptance

- [ ] Warning icons on invalid rows
- [ ] Error/warning severity levels
- [ ] Cell highlighting
- [ ] Hover tooltips
- [ ] Summary count in header
- [ ] Proceed checkbox for warnings
- [ ] Errors block import
- [ ] Uses config thresholds
- [ ] WCAG 2.1 AA (not color-only)
- [ ] Tests pass

## References

- Task spec: `./tasks/task-05-validation-warnings.md`
- Config thresholds: `src-tauri/src/config/defaults.rs`
