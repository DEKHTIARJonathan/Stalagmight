# Add pitch column to DMP Import Dialog

## Overview

Add a "Pitch" column to the shot preview table in DMP Import Dialog. Display the average of pitch_in and pitch_out values for each shot.

## Dependencies

**Requires fn-4-qe3 (LRUD columns)** - the expandable shot preview table must exist first.

## Scope

- Add single "Pitch" column showing average of pitch_in/pitch_out
- Calculation: both present = `(in + out) / 2`, one present = that value, none/zero = "-"
- Use 1 decimal place formatting (`.toFixed(1)`)
- Add data-testid attributes
- Update Playwright tests

### Out of Scope
- Editing pitch in preview
- Degree symbol in display
- Separate columns for pitch_in/pitch_out

## Approach

1. Add Pitch column after LRUD columns in shot preview table
2. Calculate: `(pitch_in + pitch_out) / 2` or single value
3. Display "-" for zero/null values (0.0 means "not measured" in DMP)
4. Add `data-testid="pitch-{sectionIndex}-{shotIndex}"`
5. Update mock data and Playwright tests

### Key Files
- `src/components/Dialogs/DmpImportDialog.tsx` - Add Pitch column
- `src/types/commands.ts:45-46` - DmpShot has pitch_in/pitch_out
- `e2e-playwright/mocks/tauri-ipc.ts` - Add pitch to mock data

### Reuse Points
- Same display pattern as LRUD: `value?.toFixed(1) ?? '-'`
- Same table styling

## Quick commands

```bash
pnpm tsc --noEmit
pnpm test:ui
pnpm tauri dev
```

## Acceptance

- [ ] Pitch column visible in shot preview table
- [ ] Average calculated correctly (both values)
- [ ] Single value shown when only one present
- [ ] "-" shown for zero/null values
- [ ] data-testid attributes present
- [ ] TypeScript types pass
- [ ] Playwright tests pass

## References

- Task spec: `./tasks/task-02-pitch-columns.md`
- DmpShot type: `src/types/commands.ts:45-46`
- Depends on: fn-4-qe3 (LRUD expandable shot table)
