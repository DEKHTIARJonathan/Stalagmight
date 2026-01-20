# fn-2-f4f.5 Add = key as zoom in shortcut

## Description
Implement zoom in/out keyboard shortcuts using configured zoom step.

## Note on Existing Code

The code may already have `+` and `=` checks, but they may not use the configured `zoom_step`. This task ensures they use the config value.

## Implementation

**File: `src/hooks/useKeyboardShortcuts.ts`**

### Map Access Pattern

Use `window.__cavechef_map__` (exposed for E2E testing at MapCanvas.tsx:472-480):

```typescript
// In keydown handler:
if (key === '+' || key === '=') {
  e.preventDefault();
  const map = (window as any).__cavechef_map__ as maplibregl.Map | undefined;
  if (map) {
    const config = useProjectStore.getState().config;
    const zoomStep = config?.map.zoom_step ?? 1.0;
    const targetZoom = Math.min(22, map.getZoom() + zoomStep);
    if (targetZoom !== map.getZoom()) {
      map.zoomTo(targetZoom, { duration: 300 });
    }
  }
  return;
}

if (key === '-') {
  e.preventDefault();
  const map = (window as any).__cavechef_map__ as maplibregl.Map | undefined;
  if (map) {
    const config = useProjectStore.getState().config;
    const zoomStep = config?.map.zoom_step ?? 1.0;
    const targetZoom = Math.max(0, map.getZoom() - zoomStep);
    if (targetZoom !== map.getZoom()) {
      map.zoomTo(targetZoom, { duration: 300 });
    }
  }
  return;
}
```

### Import Note

Need to import `maplibregl` type for type safety:
```typescript
import type maplibregl from 'maplibre-gl';
```

Or use `any` cast if import is problematic.

## This task is independent

No dependencies - can be done in parallel with config task.
## Implementation

**File: `src/hooks/useKeyboardShortcuts.ts`**

### Location

There's an existing TODO for zoom shortcuts (line 209-217). Implement it:

```typescript
// Zoom shortcuts
if (key === '+' || key === '=') {
  e.preventDefault();
  // Get map reference - need to expose from MapCanvas or use zustand
  const map = (window as any).__cavechef_map__;
  if (map) {
    const config = useProjectStore.getState().config;
    const zoomStep = config?.map.zoom_step ?? 1.0;
    map.zoomTo(map.getZoom() + zoomStep, { duration: 300 });
  }
}

if (key === '-') {
  e.preventDefault();
  const map = (window as any).__cavechef_map__;
  if (map) {
    const config = useProjectStore.getState().config;
    const zoomStep = config?.map.zoom_step ?? 1.0;
    map.zoomTo(map.getZoom() - zoomStep, { duration: 300 });
  }
}
```

### Note on map access

The map is already exposed for E2E testing at `window.__cavechef_map__` (see MapCanvas.tsx line 472-480). This is acceptable for keyboard shortcuts since it's the same pattern.

## This task is independent

No dependencies - can be done in parallel with other tasks.
## Acceptance
- [ ] `=` key zooms in by `config.map.zoom_step`
- [ ] `+` key zooms in by `config.map.zoom_step`
- [ ] `-` key zooms out by `config.map.zoom_step`
- [ ] All use `zoomTo()` with 300ms duration
- [ ] Early return if at zoom limit
- [ ] Works from any tool
- [ ] Uses `window.__cavechef_map__` for map access
- [ ] Falls back to 1.0 if config not loaded
- [ ] `pnpm tsc --noEmit` passes
## Done summary
Implemented keyboard shortcuts for zoom in (+/=) and zoom out (-) using configurable zoom_step from config.map, with proper handling for zoom limits, Ctrl/Cmd modifier preservation, and disabled MapLibre's built-in keyboard zoom to prevent conflicts.
## Evidence
- Commits: 38687a8, 0ec94ecafe7d8da7c03999928c4729189c2d21d5
- Tests: pnpm tsc --noEmit, pnpm test:ui
- PRs: