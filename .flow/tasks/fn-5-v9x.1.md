# fn-5-v9x.1 Add Pitch column to shot preview table

## Description
## Overview

Add a "Pitch" column to the shot preview table showing average of pitch_in/pitch_out.

**Prerequisite**: fn-4-qe3 (LRUD columns) must be complete - it creates the shot preview table.

## Implementation

### 1. Add Pitch column after LRUD columns

```tsx
// In shot preview table columns
{ key: 'pitch', header: 'Pitch', width: '60px', align: 'right' }
```

### 2. Calculate pitch average

```tsx
const formatPitch = (shot: DmpShot): string => {
  const pitchIn = shot.pitch_in || 0;
  const pitchOut = shot.pitch_out || 0;
  
  // 0.0 means "not measured" in DMP
  if (pitchIn === 0 && pitchOut === 0) return '-';
  if (pitchIn === 0) return pitchOut.toFixed(1);
  if (pitchOut === 0) return pitchIn.toFixed(1);
  
  return ((pitchIn + pitchOut) / 2).toFixed(1);
};
```

### 3. Add data-testid

```tsx
<td data-testid={`pitch-${sectionIndex}-${shotIndex}`}>
  {formatPitch(shot)}
</td>
```

### 4. Update mock data

In `e2e-playwright/mocks/tauri-ipc.ts`, add pitch values to mock shots:
```typescript
{ azimuth: 45, length: 10, depth: -2, pitch_in: 5, pitch_out: 3 }
```

## Files to Modify
- `src/components/Dialogs/DmpImportDialog.tsx`
- `e2e-playwright/mocks/tauri-ipc.ts`
- `e2e-playwright/import-dialog.spec.ts`

## References
- DmpShot type: `src/types/commands.ts:45-46`
- Task spec: `./tasks/task-02-pitch-columns.md`
## Acceptance
- [ ] Pitch column visible in shot preview
- [ ] Average calculation correct (both values present)
- [ ] Single value shown (only one present)
- [ ] "-" shown for zero values
- [ ] data-testid="pitch-{sectionIdx}-{shotIdx}" present
- [ ] Mock data updated with pitch values
- [ ] Playwright test for pitch column added
- [ ] TypeScript types pass
- [ ] All tests pass
## Done summary
Added Pitch column to shot preview table in DMP Import Dialog showing average of pitch_in/pitch_out, with proper normalization of DMP sentinel values and extracted helper functions for cleaner code.
## Evidence
- Commits: ada3230, 4a1cab1
- Tests: pnpm tsc --noEmit, pnpm test:ui
- PRs: