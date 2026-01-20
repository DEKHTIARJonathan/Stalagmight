# fn-2-f4f.3 Implement box zoom (drag-to-zoom)

## Description
Implement box zoom in MapCanvas.tsx with state, handlers, event routing, and Escape cancel.

## State

```typescript
const [zoomBox, setZoomBox] = useState<BoxSelectState>({ start: null, end: null });
```

## Handlers

```typescript
const handleZoomBoxStart = useCallback((e: React.MouseEvent) => {
  if (activeTool !== 'zoom' || !mapContainer.current) return;
  if (e.button !== 0 || e.ctrlKey) return;
  
  const rect = mapContainer.current.getBoundingClientRect();
  setZoomBox({
    start: { x: e.clientX - rect.left, y: e.clientY - rect.top },
    end: { x: e.clientX - rect.left, y: e.clientY - rect.top },
  });
}, [activeTool]);

const handleZoomBoxMove = useCallback((e: React.MouseEvent) => {
  if (!zoomBox.start || !mapContainer.current) return;
  const rect = mapContainer.current.getBoundingClientRect();
  setZoomBox(prev => ({ ...prev, end: { x: e.clientX - rect.left, y: e.clientY - rect.top } }));
}, [zoomBox.start]);

const handleZoomBoxEnd = useCallback(() => {
  if (!zoomBox.start || !zoomBox.end || !map.current) {
    setZoomBox({ start: null, end: null });
    return;
  }
  
  const minX = Math.min(zoomBox.start.x, zoomBox.end.x);
  const maxX = Math.max(zoomBox.start.x, zoomBox.end.x);
  const minY = Math.min(zoomBox.start.y, zoomBox.end.y);
  const maxY = Math.max(zoomBox.start.y, zoomBox.end.y);
  
  if (maxX - minX < 10 || maxY - minY < 10) {
    // Small drag = click zoom-in at center
    const centerLngLat = map.current.unproject([(minX + maxX) / 2, (minY + maxY) / 2]);
    const step = config?.map.zoom_step ?? 1.0;
    const maxZoom = config?.map.zoom_max ?? 22;
    const target = Math.min(maxZoom, map.current.getZoom() + step);
    if (target !== map.current.getZoom()) {
      map.current.easeTo({ center: centerLngLat, zoom: target, duration: 300 });
    }
    setZoomBox({ start: null, end: null });
    return;
  }
  
  // Large drag = fitBounds
  const sw = map.current.unproject([minX, maxY]);
  const ne = map.current.unproject([maxX, minY]);
  map.current.fitBounds([sw, ne], { padding: 20, linear: true, duration: 300 });
  setZoomBox({ start: null, end: null });
}, [zoomBox, config]);
```

## Event Routing (update container handlers)

```typescript
onMouseDown={(e) => {
  if (placementMode) handlePlacementClick(e);
  else if (activeTool === 'zoom' && e.button === 0 && !e.ctrlKey) handleZoomBoxStart(e);
  else if (activeTool === 'select') handleBoxSelectStart(e);
}}
onMouseMove={(e) => {
  if (zoomBox.start) handleZoomBoxMove(e);
  else handleMouseMove(e);
}}
onMouseUp={() => {
  if (zoomBox.start) handleZoomBoxEnd();
  else handleMouseUp();
}}
onMouseLeave={() => {
  if (zoomBox.start) handleZoomBoxEnd();
  else handleMouseUp();
}}
```

## Escape Key Cancel (scoped effect)

```typescript
useEffect(() => {
  if (!zoomBox.start) return;
  
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') setZoomBox({ start: null, end: null });
  };
  
  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, [zoomBox.start]);
```

## Disable dragPan - Update BOTH noPanTools arrays (line ~584 and ~851)

```typescript
const noPanTools = ['select', 'zoom', 'draw', 'delete', 'merge', 'measure', 'move_section', 'move_station'];
```

## Add zoom to CTRL_PAN_TOOLS (line ~13)

```typescript
const CTRL_PAN_TOOLS = ['select', 'zoom', 'draw', 'delete', 'merge', 'measure'];
```

## Overlay (after box select overlay)

```tsx
{zoomBox.start && zoomBox.end && (
  <div
    className="absolute border-2 border-accent bg-accent/20 pointer-events-none"
    style={{
      left: Math.min(zoomBox.start.x, zoomBox.end.x),
      top: Math.min(zoomBox.start.y, zoomBox.end.y),
      width: Math.abs(zoomBox.end.x - zoomBox.start.x),
      height: Math.abs(zoomBox.end.y - zoomBox.start.y),
    }}
    data-testid="zoom-box-overlay"
  />
)}
```
## State

```typescript
const [zoomBox, setZoomBox] = useState<BoxSelectState>({ start: null, end: null });
```

## Handlers

```typescript
const handleZoomBoxStart = useCallback((e: React.MouseEvent) => {
  if (activeTool !== 'zoom' || !mapContainer.current) return;
  if (e.button !== 0 || e.ctrlKey) return;
  
  const rect = mapContainer.current.getBoundingClientRect();
  setZoomBox({
    start: { x: e.clientX - rect.left, y: e.clientY - rect.top },
    end: { x: e.clientX - rect.left, y: e.clientY - rect.top },
  });
}, [activeTool]);

const handleZoomBoxMove = useCallback((e: React.MouseEvent) => {
  if (!zoomBox.start || !mapContainer.current) return;
  const rect = mapContainer.current.getBoundingClientRect();
  setZoomBox(prev => ({ ...prev, end: { x: e.clientX - rect.left, y: e.clientY - rect.top } }));
}, [zoomBox.start]);

const handleZoomBoxEnd = useCallback(() => {
  if (!zoomBox.start || !zoomBox.end || !map.current) {
    setZoomBox({ start: null, end: null });
    return;
  }
  
  const minX = Math.min(zoomBox.start.x, zoomBox.end.x);
  const maxX = Math.max(zoomBox.start.x, zoomBox.end.x);
  const minY = Math.min(zoomBox.start.y, zoomBox.end.y);
  const maxY = Math.max(zoomBox.start.y, zoomBox.end.y);
  
  if (maxX - minX < 10 || maxY - minY < 10) {
    // Treat as click zoom-in at center
    const centerLngLat = map.current.unproject([(minX + maxX) / 2, (minY + maxY) / 2]);
    const step = config?.map.zoom_step ?? 1.0;
    const maxZoom = config?.map.zoom_max ?? 22;
    const target = Math.min(maxZoom, map.current.getZoom() + step);
    if (target !== map.current.getZoom()) {
      map.current.easeTo({ center: centerLngLat, zoom: target, duration: 300 });
    }
    setZoomBox({ start: null, end: null });
    return;
  }
  
  const sw = map.current.unproject([minX, maxY]);
  const ne = map.current.unproject([maxX, minY]);
  map.current.fitBounds([sw, ne], { padding: 20, linear: true, duration: 300 });
  setZoomBox({ start: null, end: null });
}, [zoomBox, config]);
```

## Event Routing

```typescript
onMouseDown={(e) => {
  if (placementMode) handlePlacementClick(e);
  else if (activeTool === 'zoom' && e.button === 0 && !e.ctrlKey) handleZoomBoxStart(e);
  else if (activeTool === 'select') handleBoxSelectStart(e);
}}
onMouseMove={(e) => {
  if (zoomBox.start) handleZoomBoxMove(e);
  else handleMouseMove(e);
}}
onMouseUp={() => {
  if (zoomBox.start) handleZoomBoxEnd();
  else handleMouseUp();
}}
onMouseLeave={() => {
  if (zoomBox.start) handleZoomBoxEnd();
  else handleMouseUp();
}}
```

## Escape Key Cancel

```typescript
useEffect(() => {
  if (!zoomBox.start) return;
  
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      setZoomBox({ start: null, end: null });
    }
  };
  
  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, [zoomBox.start]);
```

## Disable dragPan

Update BOTH noPanTools arrays (line ~584 and ~851):
```typescript
const noPanTools = ['select', 'zoom', 'draw', 'delete', 'merge', 'measure', 'move_section', 'move_station'];
```

Add to CTRL_PAN_TOOLS:
```typescript
const CTRL_PAN_TOOLS = ['select', 'zoom', 'draw', 'delete', 'merge', 'measure'];
```
## State

Add alongside existing boxSelect state:
```typescript
const [zoomBox, setZoomBox] = useState<BoxSelectState>({ start: null, end: null });
```

## Handlers

```typescript
const handleZoomBoxStart = useCallback((e: React.MouseEvent) => {
  if (activeTool !== 'zoom' || !mapContainer.current) return;
  if (e.button !== 0) return;
  if (e.ctrlKey) return; // Ctrl+drag = pan
  
  const rect = mapContainer.current.getBoundingClientRect();
  setZoomBox({
    start: { x: e.clientX - rect.left, y: e.clientY - rect.top },
    end: { x: e.clientX - rect.left, y: e.clientY - rect.top },
  });
}, [activeTool]);

const handleZoomBoxMove = useCallback((e: React.MouseEvent) => {
  if (!zoomBox.start || !mapContainer.current) return;
  
  const rect = mapContainer.current.getBoundingClientRect();
  setZoomBox(prev => ({
    ...prev,
    end: { x: e.clientX - rect.left, y: e.clientY - rect.top },
  }));
}, [zoomBox.start]);

const handleZoomBoxEnd = useCallback(() => {
  if (!zoomBox.start || !zoomBox.end || !map.current) {
    setZoomBox({ start: null, end: null });
    return;
  }
  
  const minX = Math.min(zoomBox.start.x, zoomBox.end.x);
  const maxX = Math.max(zoomBox.start.x, zoomBox.end.x);
  const minY = Math.min(zoomBox.start.y, zoomBox.end.y);
  const maxY = Math.max(zoomBox.start.y, zoomBox.end.y);
  
  if (maxX - minX < 10 || maxY - minY < 10) {
    // Small drag = click zoom-in at center
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const clickLngLat = map.current.unproject([centerX, centerY]);
    const step = config?.map.zoom_step ?? 1.0;
    const target = Math.min(22, map.current.getZoom() + step);
    if (target !== map.current.getZoom()) {
      map.current.easeTo({ center: clickLngLat, zoom: target, duration: 300 });
    }
    setZoomBox({ start: null, end: null });
    return;
  }
  
  const sw = map.current.unproject([minX, maxY]);
  const ne = map.current.unproject([maxX, minY]);
  map.current.fitBounds([sw, ne], { padding: 20, linear: true, duration: 300 });
  setZoomBox({ start: null, end: null });
}, [zoomBox, config]);
```

## Event Routing

Update container handlers:
```typescript
onMouseDown={(e) => {
  if (placementMode) handlePlacementClick(e);
  else if (activeTool === 'zoom' && e.button === 0 && !e.ctrlKey) handleZoomBoxStart(e);
  else if (activeTool === 'select') handleBoxSelectStart(e);
}}
onMouseMove={(e) => {
  if (zoomBox.start) handleZoomBoxMove(e);
  else handleMouseMove(e);
}}
onMouseUp={() => {
  if (zoomBox.start) handleZoomBoxEnd();
  else handleMouseUp();
}}
```

## CRITICAL: Disable dragPan

Add 'zoom' to noPanTools:
```typescript
const noPanTools = ['select', 'zoom', 'draw', 'delete', 'merge', 'measure', 'move_section', 'move_station'];
```

Add 'zoom' to CTRL_PAN_TOOLS:
```typescript
const CTRL_PAN_TOOLS = ['select', 'zoom', 'draw', 'delete', 'merge', 'measure'];
```

Update Ctrl+drag cursor restore to include zoom.

## Overlay

```tsx
{zoomBox.start && zoomBox.end && (
  <div
    className="absolute border-2 border-accent bg-accent/20 pointer-events-none"
    style={{ /* position calc */ }}
    data-testid="zoom-box-overlay"
  />
)}
```

## Escape Cancel

Add scoped keydown listener.
## CRITICAL Fixes Required

### 1. Disable dragPan for zoom tool

**File: `src/components/Map/MapCanvas.tsx` (~line 584-594)**

Update noPanTools array:
```typescript
const noPanTools = ['select', 'zoom', 'draw', 'delete', 'merge', 'measure', 'move_section', 'move_station'];
//                          ^^^^^ ADD THIS
```

### 2. Add zoom to CTRL_PAN_TOOLS

**Line ~13:**
```typescript
const CTRL_PAN_TOOLS = ['select', 'zoom', 'draw', 'delete', 'merge', 'measure'];
//                              ^^^^^ ADD THIS
```

### 3. Update Ctrl+drag cursor restore

**In the mouseup capture handler (~line 670-682):**
```typescript
const cursors: Record<string, string> = {
  select: 'default',
  zoom: 'zoom-in', // ADD THIS
  draw: 'crosshair',
  delete: 'crosshair',
  merge: 'crosshair',
  measure: 'crosshair',
};
```

## Box Zoom Implementation

### 4. Add zoom box state

Near line 35:
```typescript
const [zoomBox, setZoomBox] = useState<BoxSelectState>({ start: null, end: null });
```

### 5. Add box zoom handlers

```typescript
const handleZoomBoxStart = useCallback((e: React.MouseEvent) => {
  if (activeTool !== 'zoom' || !mapContainer.current) return;
  if (e.button !== 0) return;
  if (e.ctrlKey) return; // Ctrl+drag = pan
  
  const rect = mapContainer.current.getBoundingClientRect();
  setZoomBox({
    start: { x: e.clientX - rect.left, y: e.clientY - rect.top },
    end: { x: e.clientX - rect.left, y: e.clientY - rect.top },
  });
}, [activeTool]);

const handleZoomBoxMove = useCallback((e: React.MouseEvent) => {
  if (!zoomBox.start || !mapContainer.current) return;
  
  const rect = mapContainer.current.getBoundingClientRect();
  setZoomBox(prev => ({
    ...prev,
    end: { x: e.clientX - rect.left, y: e.clientY - rect.top },
  }));
}, [zoomBox.start]);

const handleZoomBoxEnd = useCallback(() => {
  if (!zoomBox.start || !zoomBox.end || !map.current) {
    setZoomBox({ start: null, end: null });
    return;
  }
  
  const minX = Math.min(zoomBox.start.x, zoomBox.end.x);
  const maxX = Math.max(zoomBox.start.x, zoomBox.end.x);
  const minY = Math.min(zoomBox.start.y, zoomBox.end.y);
  const maxY = Math.max(zoomBox.start.y, zoomBox.end.y);
  
  // Minimum 10px threshold
  if (maxX - minX < 10 || maxY - minY < 10) {
    // Treat as click - zoom in at center
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const clickLngLat = map.current.unproject([centerX, centerY]);
    const zoomStep = config?.map.zoom_step ?? 1.0;
    const targetZoom = Math.min(22, map.current.getZoom() + zoomStep);
    
    if (targetZoom !== map.current.getZoom()) {
      map.current.easeTo({ center: clickLngLat, zoom: targetZoom, duration: 300 });
    }
    setZoomBox({ start: null, end: null });
    return;
  }
  
  // Convert to map bounds (Y inverted in screen coords)
  const sw = map.current.unproject([minX, maxY]);
  const ne = map.current.unproject([maxX, minY]);
  
  map.current.fitBounds([sw, ne], {
    padding: 20,
    linear: true,
    duration: 300,
  });
  
  setZoomBox({ start: null, end: null });
}, [zoomBox, config]);

const handleZoomBoxCancel = useCallback(() => {
  setZoomBox({ start: null, end: null });
}, []);
```

### 6. Add Escape key listener (scoped to zoomBox active)

```typescript
useEffect(() => {
  if (!zoomBox.start) return;
  
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      setZoomBox({ start: null, end: null });
    }
  };
  
  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, [zoomBox.start]);
```

### 7. Right-click cancel during drag

Update contextmenu capture handler (from Task 2):
```typescript
const handleContextMenuCapture = (e: MouseEvent) => {
  e.preventDefault();
  e.stopPropagation();
  
  // If box zooming, cancel instead of zoom out
  if (zoomBox.start) {
    setZoomBox({ start: null, end: null });
    return;
  }
  
  performZoom(e, false);
};
```

### 8. Update event routing in JSX

```typescript
onMouseDown={(e) => {
  if (placementMode) handlePlacementClick(e);
  else if (activeTool === 'zoom' && e.button === 0 && !e.ctrlKey) handleZoomBoxStart(e);
  else if (activeTool === 'select') handleBoxSelectStart(e);
}}
onMouseMove={(e) => {
  if (zoomBox.start) handleZoomBoxMove(e);
  else handleMouseMove(e);
}}
onMouseUp={() => {
  if (zoomBox.start) handleZoomBoxEnd();
  else handleMouseUp();
}}
```

### 9. Add zoom box overlay

After box select overlay:
```tsx
{zoomBox.start && zoomBox.end && (
  <div
    className="absolute border-2 border-accent bg-accent/20 pointer-events-none"
    style={{
      left: Math.min(zoomBox.start.x, zoomBox.end.x),
      top: Math.min(zoomBox.start.y, zoomBox.end.y),
      width: Math.abs(zoomBox.end.x - zoomBox.start.x),
      height: Math.abs(zoomBox.end.y - zoomBox.start.y),
    }}
    data-testid="zoom-box-overlay"
  />
)}
```

## Dependency

Depends on fn-2-f4f.2 for context menu capture handler pattern.
## Implementation

**File: `src/components/Map/MapCanvas.tsx`**

### 1. Add zoom box state (near line 35-36)

```typescript
const [zoomBox, setZoomBox] = useState<BoxSelectState>({ start: null, end: null });
```

Reuse existing `BoxSelectState` interface (line 14-18).

### 2. Add box zoom handlers

Copy pattern from box select handlers (line 240-316):

```typescript
const handleZoomBoxStart = useCallback((e: React.MouseEvent) => {
  if (activeTool !== 'zoom' || !mapContainer.current) return;
  if (e.button !== 0) return; // Only left-drag
  if (e.ctrlKey) return; // Ctrl+drag = pan
  
  const rect = mapContainer.current.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  
  setZoomBox({ start: { x, y }, end: { x, y } });
}, [activeTool]);

const handleZoomBoxMove = useCallback((e: React.MouseEvent) => {
  if (!zoomBox.start || !mapContainer.current) return;
  
  const rect = mapContainer.current.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  
  setZoomBox(prev => ({ ...prev, end: { x, y } }));
}, [zoomBox.start]);

const handleZoomBoxEnd = useCallback(() => {
  if (!zoomBox.start || !zoomBox.end || !map.current) {
    setZoomBox({ start: null, end: null });
    return;
  }
  
  const minX = Math.min(zoomBox.start.x, zoomBox.end.x);
  const maxX = Math.max(zoomBox.start.x, zoomBox.end.x);
  const minY = Math.min(zoomBox.start.y, zoomBox.end.y);
  const maxY = Math.max(zoomBox.start.y, zoomBox.end.y);
  
  // Check minimum size (10x10 px)
  if (maxX - minX < 10 || maxY - minY < 10) {
    // Treat as click at center of box
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    // ... call zoom-in at center point
    setZoomBox({ start: null, end: null });
    return;
  }
  
  // Convert screen coords to map bounds
  const sw = map.current.unproject([minX, maxY]); // Note: Y is inverted
  const ne = map.current.unproject([maxX, minY]);
  
  // Zoom to fit bounds
  map.current.fitBounds([sw, ne], {
    padding: 20,
    linear: true, // Use easeTo not flyTo
    duration: 300,
  });
  
  setZoomBox({ start: null, end: null });
}, [zoomBox]);

const handleZoomBoxCancel = useCallback(() => {
  setZoomBox({ start: null, end: null });
}, []);
```

### 3. Add right-click cancel during drag

In `handleContextMenu`, add early check:
```typescript
// Cancel zoom box on right-click
if (zoomBox.start) {
  e.preventDefault();
  handleZoomBoxCancel();
  return;
}
```

### 4. Add Escape key handler

Add to the existing Escape key effect (or create new):
```typescript
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && zoomBox.start) {
      handleZoomBoxCancel();
    }
  };
  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, [zoomBox.start, handleZoomBoxCancel]);
```

### 5. Update mouse handlers in JSX

Update container handlers:
```typescript
onMouseDown={(e) => {
  if (placementMode) handlePlacementClick(e);
  else if (activeTool === 'zoom' && e.button === 0 && !e.ctrlKey) handleZoomBoxStart(e);
  else if (activeTool === 'zoom') handleZoomClick(e);
  else handleBoxSelectStart(e);
}}
onMouseMove={(e) => {
  if (zoomBox.start) handleZoomBoxMove(e);
  else handleMouseMove(e);
}}
onMouseUp={() => {
  if (zoomBox.start) handleZoomBoxEnd();
  else handleMouseUp();
}}
```

### 6. Add zoom box overlay

After the box select overlay (line 969-973):
```tsx
{/* Zoom box overlay */}
{zoomBox.start && zoomBox.end && (
  <div
    className="absolute border-2 border-accent bg-accent/20 pointer-events-none"
    style={{
      left: Math.min(zoomBox.start.x, zoomBox.end.x),
      top: Math.min(zoomBox.start.y, zoomBox.end.y),
      width: Math.abs(zoomBox.end.x - zoomBox.start.x),
      height: Math.abs(zoomBox.end.y - zoomBox.start.y),
    }}
    data-testid="zoom-box-overlay"
  />
)}
```

Note: Using `bg-accent/20` (slightly more opaque) vs select box `bg-accent/10` for visual distinction.

## Dependency

Depends on fn-2-f4f.2 for `handleZoomClick` function.
## Acceptance
- [ ] zoomBox state using BoxSelectState type
- [ ] handleZoomBoxStart handler
- [ ] handleZoomBoxMove handler
- [ ] handleZoomBoxEnd handler with <10px threshold for click behavior
- [ ] Event routing in onMouseDown checks zoom tool first
- [ ] Event routing in onMouseMove checks zoomBox.start first
- [ ] Event routing in onMouseUp checks zoomBox.start first
- [ ] Event routing in onMouseLeave checks zoomBox.start first
- [ ] Escape key listener scoped to zoomBox.start
- [ ] 'zoom' added to noPanTools array at line ~584
- [ ] 'zoom' added to noPanTools array at line ~851
- [ ] 'zoom' added to CTRL_PAN_TOOLS array at line ~13
- [ ] Zoom box overlay with data-testid="zoom-box-overlay"
- [ ] pnpm tsc --noEmit passes
## Done summary
Implemented box zoom (drag-to-zoom) behavior: large drags (>= 10px) call fitBounds on the selected area, small drags act as click-to-zoom. Added zoom box overlay, Escape key cancel, Ctrl key cancel on blur, e.buttons guard to prevent stuck state on focus loss, and proper Ctrl+drag cursor handling.
## Evidence
- Commits: 0400fb9, 5cc4546
- Tests: pnpm tsc --noEmit
- PRs: