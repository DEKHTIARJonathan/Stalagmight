# fn-2-f4f.2 Implement click-to-zoom behavior

## Description
Implement click-to-zoom with capture-phase handlers in MapCanvas.tsx.

## Capture Phase Effect (intercepts before SurveyLayer)

```typescript
useEffect(() => {
  const mapElement = mapContainer.current;
  if (!mapElement || !map.current || activeTool !== 'zoom') return;
  
  // LEFT-CLICK: Stop propagation to prevent SurveyLayer selection
  const handleClickCapture = (e: MouseEvent) => {
    if (e.button === 0) {
      e.stopPropagation();
      // Actual zoom handled by box end handler
    }
  };
  
  // RIGHT-CLICK: Zoom out or cancel box
  const handleContextMenuCapture = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (zoomBox.start) {
      setZoomBox({ start: null, end: null });
      return;
    }
    
    const rect = mapContainer.current!.getBoundingClientRect();
    const clickLngLat = map.current!.unproject([e.clientX - rect.left, e.clientY - rect.top]);
    const step = config?.map.zoom_step ?? 1.0;
    const minZoom = config?.map.zoom_min ?? 0;
    const target = Math.max(minZoom, map.current!.getZoom() - step);
    
    if (target !== map.current!.getZoom()) {
      map.current!.easeTo({ center: clickLngLat, zoom: target, duration: 300 });
    }
  };
  
  mapElement.addEventListener('click', handleClickCapture, { capture: true });
  mapElement.addEventListener('contextmenu', handleContextMenuCapture, { capture: true });
  
  return () => {
    mapElement.removeEventListener('click', handleClickCapture, { capture: true });
    mapElement.removeEventListener('contextmenu', handleContextMenuCapture, { capture: true });
  };
}, [activeTool, zoomBox.start, config]);
```

## doubleClickZoom Toggle (per activeTool)

```typescript
useEffect(() => {
  if (!map.current) return;
  if (activeTool === 'zoom') {
    map.current.doubleClickZoom.disable();
  } else {
    map.current.doubleClickZoom.enable();
  }
}, [activeTool]);
```

## Force Cursor to zoom-in

```typescript
if (activeTool === 'zoom') {
  map.current.getCanvas().style.cursor = 'zoom-in';
}
```
## Capture Phase Handlers

```typescript
useEffect(() => {
  const mapElement = mapContainer.current;
  if (!mapElement || !map.current || activeTool !== 'zoom') return;
  
  // Left-click capture: stop propagation to prevent SurveyLayer selection
  const handleClickCapture = (e: MouseEvent) => {
    if (e.button === 0) {
      e.stopPropagation();
      // Actual zoom handled by box end handler (for <10px drags)
    }
  };
  
  // Right-click capture: zoom out or cancel box
  const handleContextMenuCapture = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (zoomBox.start) {
      setZoomBox({ start: null, end: null });
      return;
    }
    
    // Zoom out at click point
    const rect = mapContainer.current!.getBoundingClientRect();
    const clickLngLat = map.current!.unproject([
      e.clientX - rect.left,
      e.clientY - rect.top
    ]);
    const step = config?.map.zoom_step ?? 1.0;
    const minZoom = config?.map.zoom_min ?? 0;
    const current = map.current!.getZoom();
    const target = Math.max(minZoom, current - step);
    
    if (target !== current) {
      map.current!.easeTo({ center: clickLngLat, zoom: target, duration: 300 });
    }
  };
  
  mapElement.addEventListener('click', handleClickCapture, { capture: true });
  mapElement.addEventListener('contextmenu', handleContextMenuCapture, { capture: true });
  
  return () => {
    mapElement.removeEventListener('click', handleClickCapture, { capture: true });
    mapElement.removeEventListener('contextmenu', handleContextMenuCapture, { capture: true });
  };
}, [activeTool, zoomBox.start, config]);
```

## doubleClickZoom Toggle

```typescript
useEffect(() => {
  if (!map.current) return;
  if (activeTool === 'zoom') {
    map.current.doubleClickZoom.disable();
  } else {
    map.current.doubleClickZoom.enable();
  }
}, [activeTool]);
```

## Cursor Force

```typescript
if (activeTool === 'zoom') {
  map.current.getCanvas().style.cursor = 'zoom-in';
} else if (!isHoveringFeature) {
  map.current.getCanvas().style.cursor = cursors[activeTool] ?? 'default';
}
```
## Key Points

### 1. doubleClickZoom toggle (NOT permanent disable)

```typescript
useEffect(() => {
  if (!map.current) return;
  if (activeTool === 'zoom') {
    map.current.doubleClickZoom.disable();
  } else {
    map.current.doubleClickZoom.enable();
  }
}, [activeTool]);
```

### 2. Capture phase for right-click

See epic spec for full implementation.

### 3. Use config zoom limits

```typescript
const minZoom = config?.map.zoom_min ?? 0;
const maxZoom = config?.map.zoom_max ?? 22;
```

### 4. Cursor priority over hover

```typescript
if (activeTool === 'zoom') {
  map.current.getCanvas().style.cursor = 'zoom-in';
} else if (!isHoveringFeature) {
  map.current.getCanvas().style.cursor = cursors[activeTool] ?? 'default';
}
```
## CRITICAL: Capture Phase Interception

React `stopPropagation()` does NOT prevent MapLibre event handlers. Must use DOM capture phase.

**File: `src/components/Map/MapCanvas.tsx`**

### 1. Add capture phase click/context handlers

Add new useEffect (after the Ctrl+drag pan effect, ~line 720):

```typescript
// Zoom tool click handler - capture phase to prevent SurveyLayer
useEffect(() => {
  const mapElement = mapContainer.current;
  if (!mapElement || !map.current || activeTool !== 'zoom') return;
  
  const zoomStep = config?.map.zoom_step ?? 1.0;
  
  const performZoom = (e: MouseEvent, zoomIn: boolean) => {
    if (!map.current || !mapContainer.current) return;
    
    const currentZoom = map.current.getZoom();
    const targetZoom = zoomIn
      ? Math.min(22, currentZoom + zoomStep)
      : Math.max(0, currentZoom - zoomStep);
    
    // Early return if at limit (no recenter)
    if (targetZoom === currentZoom) return;
    
    // Convert click to map coords
    const rect = mapContainer.current.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const clickLngLat = map.current.unproject([screenX, screenY]);
    
    map.current.easeTo({
      center: clickLngLat,
      zoom: targetZoom,
      duration: 300,
    });
  };
  
  const handleClickCapture = (e: MouseEvent) => {
    if (e.button === 0 && !e.ctrlKey) {
      e.stopPropagation();
      // Left click is handled by box zoom start, not here
      // This capture is mainly to block SurveyLayer
    }
  };
  
  const handleContextMenuCapture = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    performZoom(e, false); // Right-click = zoom out
  };
  
  mapElement.addEventListener('click', handleClickCapture, { capture: true });
  mapElement.addEventListener('contextmenu', handleContextMenuCapture, { capture: true });
  
  return () => {
    mapElement.removeEventListener('click', handleClickCapture, { capture: true });
    mapElement.removeEventListener('contextmenu', handleContextMenuCapture, { capture: true });
  };
}, [activeTool, config]);
```

### 2. Force zoom cursor even on feature hover

Update cursor effect (~line 554-580):

```typescript
// Current code: if (!isHoveringFeature) { ... }
// Change to:
if (!isHoveringFeature || activeTool === 'zoom') {
  // In supported tools with Ctrl held, show grab cursor for panning
  if (CTRL_PAN_TOOLS.includes(activeTool) && ctrlHeld) {
    map.current.getCanvas().style.cursor = 'grab';
  } else {
    map.current.getCanvas().style.cursor = cursors[activeTool] ?? 'default';
  }
}
```

### 3. Disable doubleClickZoom

In map initialization (~line 410-413):
```typescript
map.current.boxZoom.disable();
map.current.doubleClickZoom.disable(); // Add this
```

### 4. Zoom limit early return

The capture handler above already includes:
```typescript
if (targetZoom === currentZoom) return; // At limit, no action, no recenter
```

## Dependency

Requires fn-2-f4f.1 for `config.map.zoom_step`.
## Implementation Location

**File: `src/components/Map/MapCanvas.tsx`**

### 1. Add zoom click handler

Add new handler function (after `handlePlacementClick` around line 942):
```typescript
const handleZoomClick = useCallback((e: React.MouseEvent) => {
  if (activeTool !== 'zoom' || !map.current || !config) return;
  
  // Get zoom step from config
  const zoomStep = config.map.zoom_step ?? 1.0;
  const currentZoom = map.current.getZoom();
  
  // Calculate target zoom
  let targetZoom: number;
  if (e.button === 0) {
    // Left click = zoom in
    targetZoom = Math.min(22, currentZoom + zoomStep);
  } else if (e.button === 2) {
    // Right click = zoom out
    targetZoom = Math.max(0, currentZoom - zoomStep);
  } else {
    return;
  }
  
  // Skip if at limit
  if (targetZoom === currentZoom) return;
  
  // Convert click position to map coordinates
  const rect = mapContainer.current!.getBoundingClientRect();
  const screenX = e.clientX - rect.left;
  const screenY = e.clientY - rect.top;
  const clickLngLat = map.current.unproject([screenX, screenY]);
  
  // Animate zoom centered on click
  map.current.easeTo({
    center: clickLngLat,
    zoom: targetZoom,
    duration: 300,
  });
}, [activeTool, config]);
```

### 2. Add context menu handler for zoom tool

Modify existing `handleContextMenu` (line 945-954) to suppress menu when zoom tool active:
```typescript
const handleContextMenu = useCallback((e: React.MouseEvent) => {
  // Suppress context menu for zoom tool (right-click = zoom out)
  if (activeTool === 'zoom') {
    e.preventDefault();
    e.stopPropagation();
    handleZoomClick(e);
    return;
  }
  // ... existing placement mode handling
}, [activeTool, placementMode, handlePlacementCancel, handleZoomClick]);
```

### 3. Wire up mousedown handler

Update the container div's `onMouseDown` (line 960):
```typescript
onMouseDown={(e) => {
  if (placementMode) {
    handlePlacementClick(e);
  } else if (activeTool === 'zoom') {
    handleZoomClick(e);
  } else {
    handleBoxSelectStart(e);
  }
}}
```

### 4. Disable double-click zoom when zoom tool active

In the map initialization effect (around line 410-413), the `boxZoom` is already disabled. Add:
```typescript
// Disable double-click zoom (we handle zoom clicks manually)
map.current.doubleClickZoom.disable();
```

**Note:** Double-click zoom should be disabled globally, not just for zoom tool. The zoom tool behavior will use single clicks. If double-click is needed for other tools, we can re-enable selectively.

### 5. Prevent feature selection on zoom click

The zoom click should NOT select stations/shots. Since we handle the click in `handleZoomClick` before it reaches SurveyLayer, this is automatic. Just ensure `e.stopPropagation()` is called.

## Dependency

Requires fn-2-f4f.1 for `config.map.zoom_step` value.
## Acceptance
- [ ] Left-click capture handler calls e.stopPropagation()
- [ ] Right-click/contextmenu capture handler zooms out at click point
- [ ] Right-click cancels zoom box if zoomBox.start is set
- [ ] Uses config zoom_min with fallback 0
- [ ] Uses config zoom_step with fallback 1.0
- [ ] doubleClickZoom toggled per activeTool (disable when zoom, enable otherwise)
- [ ] Cursor forced to zoom-in when zoom tool active
- [ ] pnpm tsc --noEmit passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
