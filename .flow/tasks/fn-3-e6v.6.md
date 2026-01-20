# fn-3-e6v.6 Block selection and show throttled toast for hidden elements

## Description
Block selection via guards in useMapTools and add toast system.

## Files to Modify

### `src/store/uiStore.ts` - Toast state

```typescript
// State
toast: { message: string; key: string; timestamp: number } | null;
lastToastByKey: Record<string, number>;

// Initial
toast: null,
lastToastByKey: {},

// Actions
showToast: (message: string, key: string) => {
  const now = Date.now();
  const lastTime = get().lastToastByKey[key] || 0;
  if (now - lastTime > 5000) {
    set({
      toast: { message, key, timestamp: now },
      lastToastByKey: { ...get().lastToastByKey, [key]: now },
    });
    setTimeout(() => {
      const t = get().toast;
      if (t && t.timestamp === now) set({ toast: null });
    }, 3000);
  }
},

clearToast: () => set({ toast: null }),
```

### `src/App.tsx` - Toast with React Portal

```tsx
import { createPortal } from 'react-dom';

const toast = useUIStore(state => state.toast);

// At end of component, before closing tag:
{toast && createPortal(
  <div className="fixed inset-0 pointer-events-none z-[99999]">
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 pointer-events-auto">
      <div className="bg-gray-800 text-white px-4 py-2 rounded-lg shadow-lg">
        {toast.message}
      </div>
    </div>
  </div>,
  document.body
)}
```

### `src/hooks/useMapTools.ts` - Add guards

**CRITICAL: Add guards at START of click handlers**

```typescript
// In handleStationClick (L75)
const handleStationClick = (stationId: StationId, event: MapMouseEvent) => {
  // GUARD: Block all station interactions when hidden
  if (!showStations) {
    showToast("Enable 'Stations' in Display menu to interact with station markers", 'stations-hidden');
    return;
  }
  // ... rest of existing handler
};

// In handleShotClick (L186)
const handleShotClick = (shotId: ShotId, event: MapMouseEvent) => {
  // GUARD: Block all shot interactions when hidden
  if (!showShots) {
    showToast("Enable 'Shots' in Display menu to interact with shot lines", 'shots-hidden');
    return;
  }
  // ... rest of existing handler
};
```

### `src/hooks/useKeyboardShortcuts.ts` - Block Ctrl+A

```typescript
// In Ctrl+A handler (~L108)
if (event.key === 'a' && (event.ctrlKey || event.metaKey)) {
  if (!showStations) {
    showToast("Enable 'Stations' in Display menu to select all", 'stations-hidden');
    event.preventDefault();
    return;
  }
  // ... existing select all logic
}
```
## Files to Modify

### `src/store/uiStore.ts` - Add per-key toast state

**Add to UIState interface (~L143):**
```typescript
toast: { message: string; key: string; timestamp: number } | null;
lastToastByKey: Record<string, number>;
```

**Add to initial state (~L349):**
```typescript
toast: null,
lastToastByKey: {},
```

**Add actions:**
```typescript
showToast: (message: string, key: string) => {
  const now = Date.now();
  const lastTime = get().lastToastByKey[key] || 0;
  
  // Throttle: only show if no recent toast for this key (5 second cooldown)
  if (now - lastTime > 5000) {
    set({
      toast: { message, key, timestamp: now },
      lastToastByKey: { ...get().lastToastByKey, [key]: now },
    });
    // Auto-clear after 3 seconds
    setTimeout(() => {
      const t = get().toast;
      if (t && t.timestamp === now) {
        set({ toast: null });
      }
    }, 3000);
  }
},

clearToast: () => set({ toast: null }),
```

**Toast keys:**
- `'stations-hidden'` - for station interaction attempts
- `'shots-hidden'` - for shot interaction attempts
- `'operation-canceled'` - for operation cancellation

### `src/App.tsx` - Render toast overlay

Add at root level with high z-index:
```tsx
const toast = useUIStore(state => state.toast);

{toast && (
  <div 
    className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] pointer-events-none"
  >
    <div className="bg-gray-800 text-white px-4 py-2 rounded-lg shadow-lg pointer-events-auto">
      {toast.message}
    </div>
  </div>
)}
```

### `src/hooks/useMapTools.ts` - Show toast on blocked interaction

**In station click handler:**
```typescript
if (!showStations) {
  showToast("Enable 'Stations' in Display menu to interact with station markers", 'stations-hidden');
  return;
}
```

**In shot click handler:**
```typescript
if (!showShots) {
  showToast("Enable 'Shots' in Display menu to interact with shot lines", 'shots-hidden');
  return;
}
```

### `src/hooks/useKeyboardShortcuts.ts` - Block Ctrl+A

**In Ctrl+A handler (~L108):**
```typescript
if (!showStations) {
  showToast("Enable 'Stations' in Display menu to select all", 'stations-hidden');
  return;
}
```
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
- [ ] Toast state has `key` property for per-key throttle tracking
- [ ] `lastToastByKey: Record<string, number>` in state
- [ ] `showToast(message, key)` throttles per-key (5 second cooldown)
- [ ] Toast auto-clears after 3 seconds
- [ ] Toast uses React Portal to document.body
- [ ] Toast has z-index 99999 (above all other UI)
- [ ] Toast positioned bottom-center
- [ ] **Guard in handleStationClick** blocks when `!showStations`
- [ ] **Guard in handleShotClick** blocks when `!showShots`
- [ ] Guards show throttled toast before returning
- [ ] Ctrl+A blocked when stations hidden, shows toast
- [ ] Toast messages match spec text exactly
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
