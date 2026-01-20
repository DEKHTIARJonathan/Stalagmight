# fn-3-e6v.6 Block selection and show throttled toast for hidden elements

## Description
Block selection and show throttled toast for hidden elements.

## Files to Modify

### `src/store/uiStore.ts` - Add toast state

**Add to UIState interface (~L143):**
```typescript
toast: { message: string; timestamp: number } | null;
```

**Add to initial state (~L349):**
```typescript
toast: null,
```

**Add actions:**
```typescript
showToast: (message: string) => void;
clearToast: () => void;
```

**Throttle implementation:**
```typescript
showToast: (message: string) => {
  const now = Date.now();
  const current = get().toast;
  // Throttle: only show if no recent toast (5 second cooldown)
  if (!current || now - current.timestamp > 5000) {
    set({ toast: { message, timestamp: now } });
    // Auto-clear after 3 seconds
    setTimeout(() => {
      const t = get().toast;
      if (t && t.timestamp === now) {
        set({ toast: null });
      }
    }, 3000);
  }
},
```

### `src/App.tsx` or layout component - Render toast

Add toast display component at root level:
```tsx
const toast = useUIStore(state => state.toast);

{toast && (
  <div className="toast-notification">
    {toast.message}
  </div>
)}
```

### `src/hooks/useMapTools.ts` - Show toast on blocked interaction

**In handleStationClick (L75-183):**
```typescript
// At start of handler
if (!showStations) {
  showToast("Enable 'Stations' in Display menu to interact with station markers");
  return;
}
```

**In handleShotClick (L186-217):**
```typescript
if (!showShots) {
  showToast("Enable 'Shots' in Display menu to interact with shot lines");
  return;
}
```

## Notes

- MapLibre's `queryRenderedFeatures` naturally returns empty for hidden layers
- But we should show toast BEFORE the query, when user attempts to click
- Need to detect click intent on hidden element area (may need separate logic)
- Alternative: show toast when query returns empty but click was near expected element position
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
- [ ] Toast state exists in uiStore (`toast: { message, timestamp } | null`)
- [ ] `showToast(message)` action with 5-second throttle logic
- [ ] Toast auto-clears after 3 seconds
- [ ] Toast UI renders at root level (visible above all content)
- [ ] Toast positioned at bottom-center of screen
- [ ] Clicking hidden station area shows toast
- [ ] Clicking hidden shot area shows toast  
- [ ] Toast throttled to max once per 5 seconds per trigger
- [ ] No hover effect on hidden station positions
- [ ] No hover effect on hidden shot lines
- [ ] Toast message for stations: "Enable 'Stations' in Display menu to interact with station markers"
- [ ] Toast message for shots: "Enable 'Shots' in Display menu to interact with shot lines"
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
