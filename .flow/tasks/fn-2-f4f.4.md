# fn-2-f4f.4 Implement spring-loaded Z key for temporary zoom

## Description
Implement spring-loaded Z key in uiStore.ts and useKeyboardShortcuts.ts.

## uiStore.ts Changes

### Add Interface (after line 55)

```typescript
interface SpringLoadedState {
  previousTool: ToolType;
  targetTool: ToolType;
  mergeStationA: StationRef | null;
  measureStart: StationRef | Coordinates | null;
  measureEnd: StationRef | Coordinates | null;
  drawFromStation: StationRef | null;
  activatedAt: number;
}
```

### Add to UIStore Interface

```typescript
springLoadedState: SpringLoadedState | null;
activateSpringLoaded: (targetTool: ToolType) => void;
deactivateSpringLoaded: () => void;
```

### Add to Store Implementation

```typescript
springLoadedState: null,

activateSpringLoaded: (targetTool: ToolType) =>
  set((state) => {
    if (state.activeTool === targetTool) return state;
    if (state.springLoadedState) return state;
    
    return {
      springLoadedState: {
        previousTool: state.activeTool,
        targetTool: targetTool,
        mergeStationA: state.mergeStationA,
        measureStart: state.measureStart,
        measureEnd: state.measureEnd,
        drawFromStation: state.drawFromStation,
        activatedAt: Date.now(),
      },
      activeTool: targetTool,
    };
  }),

deactivateSpringLoaded: () =>
  set((state) => {
    if (!state.springLoadedState) return state;
    
    if (state.activeTool !== state.springLoadedState.targetTool) {
      return { springLoadedState: null };
    }
    
    const elapsed = Date.now() - state.springLoadedState.activatedAt;
    if (elapsed > 200) {
      return {
        activeTool: state.springLoadedState.previousTool,
        mergeStationA: state.springLoadedState.mergeStationA,
        measureStart: state.springLoadedState.measureStart,
        measureEnd: state.springLoadedState.measureEnd,
        drawFromStation: state.springLoadedState.drawFromStation,
        springLoadedState: null,
      };
    } else {
      return { springLoadedState: null };
    }
  }),
```

## useKeyboardShortcuts.ts Changes

### Z Keydown Handler (modify existing)

```typescript
if (key === 'z' && !e.repeat) {
  const { activeDialog, placementMode, activeTool, springLoadedState } = useUIStore.getState();
  if (activeDialog || placementMode) return;
  if (activeTool === 'zoom' || springLoadedState) return;
  activateSpringLoaded('zoom');
  return;
}
```

### Add Keyup Effect

```typescript
useEffect(() => {
  const handleKeyUp = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() === 'z') {
      deactivateSpringLoaded();
    }
  };
  window.addEventListener('keyup', handleKeyUp);
  return () => window.removeEventListener('keyup', handleKeyUp);
}, [deactivateSpringLoaded]);
```

### Add Blur Effect (handles Alt+Tab with Z held)

```typescript
useEffect(() => {
  const handleBlur = () => {
    const s = useUIStore.getState();
    if (s.springLoadedState) s.deactivateSpringLoaded();
  };
  window.addEventListener('blur', handleBlur);
  return () => window.removeEventListener('blur', handleBlur);
}, []);
```
## uiStore.ts Changes

### Interface

Add to types:
```typescript
interface SpringLoadedState {
  previousTool: ToolType;
  targetTool: ToolType;
  mergeStationA: StationRef | null;
  measureStart: StationRef | Coordinates | null;
  measureEnd: StationRef | Coordinates | null;
  drawFromStation: StationRef | null;
  activatedAt: number;
}
```

Add to UIStore interface:
```typescript
springLoadedState: SpringLoadedState | null;
activateSpringLoaded: (targetTool: ToolType) => void;
deactivateSpringLoaded: () => void;
```

### Implementation

Add to store:
```typescript
// State
springLoadedState: null,

// Actions
activateSpringLoaded: (targetTool: ToolType) =>
  set((state) => {
    if (state.activeTool === targetTool) return state;
    if (state.springLoadedState) return state; // Already spring-loaded
    
    return {
      springLoadedState: {
        previousTool: state.activeTool,
        targetTool: targetTool,
        mergeStationA: state.mergeStationA,
        measureStart: state.measureStart,
        measureEnd: state.measureEnd,
        drawFromStation: state.drawFromStation,
        activatedAt: Date.now(),
      },
      activeTool: targetTool,
    };
  }),

deactivateSpringLoaded: () =>
  set((state) => {
    if (!state.springLoadedState) return state;
    
    // Only restore if still on target tool
    if (state.activeTool !== state.springLoadedState.targetTool) {
      return { springLoadedState: null };
    }
    
    const elapsed = Date.now() - state.springLoadedState.activatedAt;
    if (elapsed > 200) {
      return {
        activeTool: state.springLoadedState.previousTool,
        mergeStationA: state.springLoadedState.mergeStationA,
        measureStart: state.springLoadedState.measureStart,
        measureEnd: state.springLoadedState.measureEnd,
        drawFromStation: state.springLoadedState.drawFromStation,
        springLoadedState: null,
      };
    } else {
      return { springLoadedState: null };
    }
  }),
```

## useKeyboardShortcuts.ts Changes

### Z Keydown

```typescript
if (key === 'z' && !e.repeat) {
  const { activeDialog, placementMode, activeTool, springLoadedState } = useUIStore.getState();
  if (activeDialog || placementMode) return;
  if (activeTool === 'zoom' || springLoadedState) return;
  activateSpringLoaded('zoom');
  return;
}
```

### Keyup Handler

```typescript
useEffect(() => {
  const handleKeyUp = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() === 'z') {
      deactivateSpringLoaded();
    }
  };
  window.addEventListener('keyup', handleKeyUp);
  return () => window.removeEventListener('keyup', handleKeyUp);
}, [deactivateSpringLoaded]);
```

### Blur Handler

```typescript
useEffect(() => {
  const handleBlur = () => {
    const s = useUIStore.getState();
    if (s.springLoadedState) s.deactivateSpringLoaded();
  };
  window.addEventListener('blur', handleBlur);
  return () => window.removeEventListener('blur', handleBlur);
}, []);
```
## CRITICAL: Store targetTool and check before restore

```typescript
interface SpringLoadedState {
  previousTool: ToolType;
  targetTool: ToolType; // The tool we switched TO (e.g., 'zoom')
  mergeStationA: StationRef | null;
  measureStart: StationRef | Coordinates | null;
  measureEnd: StationRef | Coordinates | null;
  drawFromStation: StationRef | null;
  activatedAt: number;
}

activateSpringLoaded: (targetTool: ToolType) => set((state) => {
  if (state.activeTool === targetTool) return state;
  return {
    springLoadedState: {
      previousTool: state.activeTool,
      targetTool: targetTool, // STORE THIS
      mergeStationA: state.mergeStationA,
      measureStart: state.measureStart,
      measureEnd: state.measureEnd,
      drawFromStation: state.drawFromStation,
      activatedAt: Date.now(),
    },
    activeTool: targetTool,
  };
}),

deactivateSpringLoaded: () => set((state) => {
  if (!state.springLoadedState) return state;
  
  // CRITICAL: Only restore if still on the target tool
  if (state.activeTool !== state.springLoadedState.targetTool) {
    return { springLoadedState: null }; // User switched away, just clear
  }
  
  const elapsed = Date.now() - state.springLoadedState.activatedAt;
  if (elapsed > 200) {
    return {
      activeTool: state.springLoadedState.previousTool,
      mergeStationA: state.springLoadedState.mergeStationA,
      measureStart: state.springLoadedState.measureStart,
      measureEnd: state.springLoadedState.measureEnd,
      drawFromStation: state.springLoadedState.drawFromStation,
      springLoadedState: null,
    };
  } else {
    return { springLoadedState: null };
  }
}),
```

## useKeyboardShortcuts

See epic spec for keydown, keyup, and blur handlers.
## CRITICAL: Must Add keyup AND blur Handlers

The current `useKeyboardShortcuts.ts` only handles `keydown`. Spring-loaded requires `keyup` and `blur` to restore state.

## uiStore Changes

**File: `src/store/uiStore.ts`**

Add interface and state as specified in previous version (unchanged).

## useKeyboardShortcuts Changes

**File: `src/hooks/useKeyboardShortcuts.ts`**

### 1. Import spring-loaded actions

```typescript
const {
  activeTool,
  setActiveTool,
  springLoadedState,
  activateSpringLoaded,
  deactivateSpringLoaded,
  // ... other imports
} = useUIStore();
```

### 2. Modify Z key in keydown handler

Replace direct `setActiveTool('zoom')` with spring-loaded activation:

```typescript
// In the existing keydown handler, for 'z' key:
if (key === 'z' && !e.repeat) {
  // Don't activate during dialogs
  if (activeDialog) return;
  
  activateSpringLoaded('zoom');
  return; // Don't fall through to normal shortcut handling
}
```

### 3. Add keyup handler

```typescript
// Add new useEffect for keyup
useEffect(() => {
  const handleKeyUp = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase();
    
    if (key === 'z') {
      // Deactivate spring-loaded (will check timing internally)
      deactivateSpringLoaded();
    }
  };
  
  window.addEventListener('keyup', handleKeyUp);
  return () => window.removeEventListener('keyup', handleKeyUp);
}, [deactivateSpringLoaded]);
```

### 4. Add blur handler for stuck key

```typescript
// Add new useEffect for blur (handles Alt+Tab while Z held)
useEffect(() => {
  const handleBlur = () => {
    // Force deactivate if spring-loaded is active
    const state = useUIStore.getState();
    if (state.springLoadedState) {
      state.deactivateSpringLoaded();
    }
  };
  
  window.addEventListener('blur', handleBlur);
  return () => window.removeEventListener('blur', handleBlur);
}, []); // No dependencies - uses getState() for latest
```

## uiStore Implementation Details

```typescript
interface SpringLoadedState {
  previousTool: ToolType;
  mergeStationA: StationRef | null;
  measureStart: StationRef | Coordinates | null;
  measureEnd: StationRef | Coordinates | null;
  drawFromStation: StationRef | null;
  activatedAt: number;
}

// In store:
springLoadedState: null,

activateSpringLoaded: (targetTool: ToolType) =>
  set((state) => {
    if (state.activeTool === targetTool) return state; // Already in target tool
    
    return {
      springLoadedState: {
        previousTool: state.activeTool,
        mergeStationA: state.mergeStationA,
        measureStart: state.measureStart,
        measureEnd: state.measureEnd,
        drawFromStation: state.drawFromStation,
        activatedAt: Date.now(),
      },
      activeTool: targetTool,
    };
  }),

deactivateSpringLoaded: () =>
  set((state) => {
    if (!state.springLoadedState) return state;
    
    const holdDuration = Date.now() - state.springLoadedState.activatedAt;
    const wasHeld = holdDuration > 200; // 200ms threshold
    
    if (wasHeld) {
      // Restore all state
      return {
        activeTool: state.springLoadedState.previousTool,
        mergeStationA: state.springLoadedState.mergeStationA,
        measureStart: state.springLoadedState.measureStart,
        measureEnd: state.springLoadedState.measureEnd,
        drawFromStation: state.springLoadedState.drawFromStation,
        springLoadedState: null,
      };
    } else {
      // Tap - keep new tool, just clear spring state
      return { springLoadedState: null };
    }
  }),
```

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Z keydown (not repeat) | Activates spring-loaded |
| Z keyup < 200ms | Tap - keeps zoom tool |
| Z keyup > 200ms | Hold - restores previous tool+state |
| Window blur while Z held | Immediate restore (via blur handler) |
| Z pressed in zoom tool | No-op (activateSpringLoaded returns early) |
| Z during dialog | Ignored (activeDialog check) |
| Z during placement | Ignored (need to add check) |
## uiStore Changes

**File: `src/store/uiStore.ts`**

### 1. Add types and state

Add interface (after line 55):
```typescript
interface SpringLoadedState {
  previousTool: ToolType;
  mergeStationA: StationRef | null;
  measureStart: StationRef | Coordinates | null;
  measureEnd: StationRef | Coordinates | null;
  drawFromStation: StationRef | null;
  activatedAt: number; // timestamp for tap vs hold detection
}
```

Add to `UIStore` interface:
```typescript
springLoadedState: SpringLoadedState | null;
activateSpringLoaded: (targetTool: ToolType) => void;
deactivateSpringLoaded: () => void;
```

### 2. Add to store implementation

```typescript
// Spring-loaded state
springLoadedState: null,

activateSpringLoaded: (targetTool: ToolType) =>
  set((state) => {
    // Don't activate if already in target tool
    if (state.activeTool === targetTool) return state;
    
    return {
      springLoadedState: {
        previousTool: state.activeTool,
        mergeStationA: state.mergeStationA,
        measureStart: state.measureStart,
        measureEnd: state.measureEnd,
        drawFromStation: state.drawFromStation,
        activatedAt: Date.now(),
      },
      activeTool: targetTool,
    };
  }),

deactivateSpringLoaded: () =>
  set((state) => {
    if (!state.springLoadedState) return state;
    
    const held = Date.now() - state.springLoadedState.activatedAt;
    const wasHeld = held > 200; // 200ms threshold
    
    if (wasHeld) {
      // Restore previous state
      return {
        activeTool: state.springLoadedState.previousTool,
        mergeStationA: state.springLoadedState.mergeStationA,
        measureStart: state.springLoadedState.measureStart,
        measureEnd: state.springLoadedState.measureEnd,
        drawFromStation: state.springLoadedState.drawFromStation,
        springLoadedState: null,
      };
    } else {
      // Tap - keep new tool, clear spring state
      return { springLoadedState: null };
    }
  }),
```

## Keyboard Shortcut Changes

**File: `src/hooks/useKeyboardShortcuts.ts`**

### 1. Modify Z key handling

Current behavior (line ~220): Z keydown calls `setActiveTool('zoom')`.

New behavior:
```typescript
const { activateSpringLoaded, deactivateSpringLoaded, springLoadedState } = useUIStore();

// In keydown handler, for 'z':
if (key === 'z' && !e.repeat) {
  // Don't activate during dialogs
  if (activeDialog) return;
  
  activateSpringLoaded('zoom');
}

// Add keyup handler:
useEffect(() => {
  const handleKeyUp = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() === 'z') {
      deactivateSpringLoaded();
    }
  };
  
  window.addEventListener('keyup', handleKeyUp);
  return () => window.removeEventListener('keyup', handleKeyUp);
}, [deactivateSpringLoaded]);

// Handle blur (stuck key case):
useEffect(() => {
  const handleBlur = () => {
    if (springLoadedState) {
      deactivateSpringLoaded();
    }
  };
  
  window.addEventListener('blur', handleBlur);
  return () => window.removeEventListener('blur', handleBlur);
}, [springLoadedState, deactivateSpringLoaded]);
```

### 2. Integration with existing shortcut system

The existing `DEFAULT_SHORTCUTS` has `z: 'zoom'`. The spring-loaded behavior overrides this:
- Keydown (no repeat): `activateSpringLoaded('zoom')`
- Keyup: `deactivateSpringLoaded()` (which checks timing)

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Z held during dialog | Ignore (activeDialog check) |
| Z released < 200ms | Keep zoom tool (tap behavior) |
| Z released > 200ms | Restore previous tool+state |
| Window loses focus | Treat as keyup, restore |
| Already in zoom tool | No-op (don't save state) |
| Z during placement mode | Ignore (placement blocks tool changes) |
## Acceptance
- [ ] SpringLoadedState interface with targetTool field in uiStore.ts
- [ ] springLoadedState: null initial state in uiStore.ts
- [ ] activateSpringLoaded action in uiStore.ts
- [ ] deactivateSpringLoaded action with targetTool check in uiStore.ts
- [ ] 200ms threshold for tap vs hold in deactivateSpringLoaded
- [ ] Z keydown handler guards: activeDialog, placementMode, activeTool === 'zoom', springLoadedState
- [ ] Z keydown calls activateSpringLoaded('zoom')
- [ ] keyup effect calls deactivateSpringLoaded on 'z'
- [ ] blur effect calls deactivateSpringLoaded
- [ ] pnpm tsc --noEmit passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
