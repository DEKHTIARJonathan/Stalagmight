# fn-3-e6v.1 Add showShots state and Shots toggle to DisplayMenu

## Description
Add `showShots` boolean state to uiStore and the "Shots" toggle to DisplayMenu.

## Files to Modify

### `src/store/uiStore.ts`
- **L143 area**: Add `showShots: boolean` to UIState interface
- **L216-226**: Add `'showShots'` to `DisplayToggleKey` type union
- **L349 area**: Add `showShots: true` to initial state (default visible)
- **L360-366**: `toggleDisplay` function already handles generic toggles

### `src/components/SingleSystemView/DisplayMenu.tsx`
- **L11-32**: Add to `displayOptions` array in "Map Elements" group
- Position above existing "Virtual Shots" entry (L16)
- Entry: `{ key: 'showShots', label: 'Shots', description: 'Show survey shot lines' }`

## Implementation Details

Follow existing pattern for `showStations` (L143, L349):
```typescript
// In UIState interface
showShots: boolean;

// In initial state
showShots: true,

// In DisplayToggleKey
export type DisplayToggleKey = 
  | 'showStations'
  | 'showShots'  // ADD THIS
  | 'showVirtualShots'
  // ... rest
```
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
- [ ] `showShots: boolean` exists in UIState interface (uiStore.ts ~L143)
- [ ] `showShots` included in `DisplayToggleKey` type union (uiStore.ts ~L216)
- [ ] `showShots: true` in initial state (uiStore.ts ~L349)
- [ ] "Shots" toggle appears in Display menu above "Virtual Shots"
- [ ] Toggle checkbox correctly reflects and updates store state
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
