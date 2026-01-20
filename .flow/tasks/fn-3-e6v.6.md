# fn-3-e6v.6 Block selection and show throttled toast for hidden elements

## Description
Block selection and show throttled toast for hidden elements.

## Files to Modify
- `src/hooks/useMapTools.ts` (or selection handling code)
- `src/components/Map/MapCanvas.tsx` (or event handlers)
- Possibly add/use a toast notification utility

## Implementation Details

### Block Selection
When user clicks on a hidden element location:
- If stations hidden and click would select a station: do nothing
- If shots hidden and click would select a shot: do nothing
- Disable hover effects for hidden elements

### Throttled Toast
When user attempts to interact with hidden elements:
- Show toast: "Enable 'Stations' in Display menu to interact with station markers"
- Throttle: maximum once per 5 seconds
- Use same throttle key per element type (stations/shots)

Implementation:
```typescript
// Throttle utility (can use lodash/throttle or simple timestamp check)
let lastStationsToast = 0;
const TOAST_THROTTLE_MS = 5000;

function showStationsHiddenToast() {
  const now = Date.now();
  if (now - lastStationsToast > TOAST_THROTTLE_MS) {
    toast("Enable 'Stations' in Display menu to interact with station markers");
    lastStationsToast = now;
  }
}
```

### Disable Hover
When stations are hidden:
- No blue hover highlight on station positions
- Cursor doesn't change when hovering over hidden station areas

## Depends On
- Task 3: Visibility state must be accessible in tool handlers
## Acceptance
- [ ] Clicking on hidden station location does not select it
- [ ] Clicking on hidden shot location does not select it
- [ ] No hover effect (blue highlight) on hidden station positions
- [ ] No hover effect on hidden shot lines
- [ ] Toast appears on first interaction attempt with hidden element
- [ ] Toast is throttled to max once per 5 seconds
- [ ] Toast message matches spec: "Enable 'Stations' in Display menu..."
- [ ] Separate throttle tracking for stations vs shots
- [ ] TypeScript compiles without errors
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
