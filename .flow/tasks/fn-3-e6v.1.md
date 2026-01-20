# fn-3-e6v.1 Add showShots state and Shots toggle to DisplayMenu

## Description
Add `showShots` boolean state to uiStore and the "Shots" toggle to DisplayMenu.

## Files to Modify
- `src/store/uiStore.ts`: Add `showShots: boolean` (default: true) to state and `DisplayToggleKey` type
- `src/components/SingleSystemView/DisplayMenu.tsx`: Add Shots toggle above Virtual Shots

## Implementation Details
1. In `uiStore.ts`:
   - Add `showShots: true` to initial state (around line 143)
   - Add `'showShots'` to `DisplayToggleKey` type (line 217)

2. In `DisplayMenu.tsx`:
   - Add new entry: `{ key: 'showShots', label: 'Shots', description: 'Show survey shot lines' }`
   - Position it above the existing Virtual Shots entry

## Depends On
Nothing - this is a foundational task.
## Acceptance
- [ ] `showShots` state exists in uiStore with default value `true`
- [ ] `showShots` is included in `DisplayToggleKey` type
- [ ] "Shots" toggle appears in Display menu above "Virtual Shots"
- [ ] Toggle checkbox correctly reflects and updates store state
- [ ] TypeScript compiles without errors
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
