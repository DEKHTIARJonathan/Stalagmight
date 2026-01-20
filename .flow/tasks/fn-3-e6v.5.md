# fn-3-e6v.5 Clear selection and cancel operations when visibility changes

## Description
Clear selection and cancel in-progress operations when visibility changes.

## Files to Modify
- `src/components/Map/MapCanvas.tsx` or relevant hook
- Potentially `src/hooks/useMapTools.ts`

## Implementation Details

### Clear Selection on Toggle
When `showStations` changes from true to false:
- Clear any selected stations from the selection state
- Keep any selected shots (if shots are still visible)

When `showShots` changes from true to false:
- Clear any selected shots from the selection state
- Keep any selected stations (if stations are still visible)

### Cancel In-Progress Operations
When visibility toggles change during an active tool operation:
- Cancel Draw operation (clear pending points)
- Cancel Merge operation (clear selected merge targets)
- Cancel Measure operation (clear measurement points)
- Show toast notification: "Operation canceled - [stations/shots] hidden"

## Depends On
- Task 3: Visibility toggle wiring must be in place
## Acceptance
- [ ] Selected stations are cleared when Stations toggle is turned off
- [ ] Selected shots are cleared when Shots toggle is turned off
- [ ] Mixed selections (stations + shots) only clear the type being hidden
- [ ] In-progress Draw operation is canceled when relevant toggle changes
- [ ] In-progress Merge operation is canceled when relevant toggle changes
- [ ] In-progress Measure operation is canceled when relevant toggle changes
- [ ] Toast notification "Operation canceled - [element] hidden" is shown
- [ ] Selection clearing happens immediately on toggle change
- [ ] TypeScript compiles without errors
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
