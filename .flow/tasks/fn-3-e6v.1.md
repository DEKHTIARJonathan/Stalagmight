# fn-3-e6v.1 Add showShots state and Shots toggle to DisplayMenu

## Description
Add `showShots` state and "Shots" toggle - complete implementation.

## Files to Modify

### `src/store/uiStore.ts`
- Add `showShots: boolean` to UIState interface
- Add `'showShots'` to `DisplayToggleKey` union
- Add `showShots: true` to initial state defaults
- **Add `showShots: true` to `resetDisplaySettings()`**

### `src/components/SingleSystemView/DisplayMenu.tsx`
- Add to displayOptions before "Virtual Shots"

### `src/components/Map/MapCanvas.tsx`
- Destructure `showShots`

### `e2e-playwright/mocks/tauri-ipc.ts`
- Add `showShots: true` to mock
## Files to Modify (Complete Checklist)

### 1. `src/store/uiStore.ts`
- **~L143**: Add `showShots: boolean` to UIState interface
- **~L216-226**: Add `'showShots'` to `DisplayToggleKey` type union
- **~L349**: Add `showShots: true` to initial state defaults
- **~L397-403**: Verify `save_display_setting` handles new key (should work automatically)
- If `loadDisplaySettings` exists, verify it handles the key
- If reset logic exists, include `showShots`

### 2. `src/components/SingleSystemView/DisplayMenu.tsx`
- **~L11-32**: Add to `displayOptions` array:
  ```typescript
  { key: 'showShots', label: 'Shots', description: 'Show survey shot lines' }
  ```
- Position above "Virtual Shots" entry

### 3. `src/components/Map/MapCanvas.tsx`
- Destructure `showShots` from uiStore (wherever other display toggles are destructured)

### 4. Tests (check for IPC mocks)
- If Playwright tests mock display settings IPC, ensure they handle `showShots`

## Implementation Notes

Follow exact pattern of existing `showStations`:
- Same type in UIState interface
- Same inclusion in DisplayToggleKey
- Same default value pattern
- Same persistence handling
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
- [ ] `showShots` in UIState interface
- [ ] `'showShots'` in DisplayToggleKey union
- [ ] `showShots: true` in initial state
- [ ] `showShots: true` in resetDisplaySettings()
- [ ] "Shots" toggle in DisplayMenu
- [ ] Playwright mocks updated
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
