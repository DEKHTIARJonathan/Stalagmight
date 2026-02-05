# Move Tools

Developer reference for the three move tools: **Move Station**, **Move Shot**, and **Move Segment**.

## Overview

| Tool | Shortcut | Scope | What moves |
|------|----------|-------|------------|
| Move Station | T | Single station | Station + co-located stations (merged/aligned-closure) |
| Move Shot | Y | One shot | Both endpoints + all co-located stations |
| Move Segment | U | Entire branch | All sections connected via merges/aligned-closures |

All three share the same drag preview engine and Ctrl+drag panning. They differ in scope and hover behavior.

---

## Move Station

Click a station to begin dragging it. If the station shares coordinates with other stations (via merges or **aligned** loop closures), all co-located stations move together.

**Hover**: Only stations get hover highlight. Shot hover is suppressed.

**Drag flow**:
1. Click on station &rarr; `handleMoveDragStart` (MapCanvas) &rarr; immovable guard check
2. `beginStationDragPreview()` (SurveyLayer) &rarr; BFS to find co-located stations, create temp layers + dynamic sources for connected shots
3. Per-mousemove: `updateStationDragPreview(dx, dy)` updates *-translate and rebuilds connected shot geometry. Snap-to-merge detection runs each frame (see [Snap-to-Merge](#snap-to-merge)).
4. On mouseup: if snapped, opens merge/closure dialog. Otherwise if movement > 1mm, `commitDragPreview()` + `moveStation()` backend call (batched for co-located stations)

## Move Shot

Click a shot to begin dragging it. Both endpoints move rigidly together, along with any stations co-located at either endpoint (merges + aligned closures).

**Hover**: Only shots get hover highlight. Station hover is suppressed.

**Drag flow**: Same as Move Station but `beginStationDragPreview()` is seeded with both endpoint station refs. The drag preview includes all shots connected to either endpoint.

**Immovability**: If either endpoint station is immovable, the entire shot cannot be dragged.

## Move Segment

Click any station or shot in a section to drag the entire connected branch. Connected sections (via merges/aligned closures) move together as a rigid unit.

**Hover**: Both stations and shots get hover. Hovering highlights the full connected segment (all connected sections).

**Drag flow**:
1. Click on station/shot &rarr; `handleMoveDragStart` &rarr; anchored section guards
2. Async `getConnectedSectionIds(sectionId)` IPC call fetches connected sections
3. Connected sections filtered to exclude anchored ones
4. `beginDragPreview(connectedSet)` creates temp layers with section inclusion filters
5. Per-mousemove: `updateDragPreview(dx, dy)` updates *-translate on all temp layers (GPU uniform, no GeoJSON rebuild)
6. On mouseup: `commitDragPreview()` + `moveSection()` backend call for each connected section

### Anchored Sections

Sections that cannot be moved (e.g., externally constrained). Fetched from backend when Move Segment tool activates via `getAnchoredSectionIds()`. Drag is blocked until the fetch completes (`anchoredIdsLoaded` guard). Anchored sections appear dimmed (0.25 opacity via `feature-state: anchored`) and show no pointer cursor on hover.

### Snap-to-Merge

During station or segment drag, the user can drop onto another station to merge them:

1. **Detection**: Origin station's screen position is tracked + offset by drag amount. For station drag, co-located stations (being dragged together) are excluded from candidates. For segment drag, stations in the dragged segment are excluded.
2. **Preview**: When a snap target is found, drag preview offset is adjusted so origin station lands exactly on the target. A visual snap indicator is shown.
3. **Drop**: On mouseup with snap target, `promptSnapMerge()` checks connectivity via the backend (`checkMergeConnectivity`) and opens the appropriate merge or closure dialog (`snapMergeDialogPendingRef` set to block further interactions).
4. **Cancel**: Restores preview to raw offset; user can continue dragging.

### Segment Hover Resolution

When hovering in Move Segment mode, the connected section IDs are resolved asynchronously. A debounce (150ms) prevents flicker when transitioning between features. The `segmentDragTokenRef` system discards stale async results.

---

## Immovable Stations

A station is immovable if it is a zero-datum or transitively reachable from one via merges and **aligned** loop closures. Computed in `MapCanvas` via BFS when Move Station or Move Shot is active. Returns `Set<string>` of `"sectionId:stationIndex"` keys.

Visual feedback:
- Immovable stations and shots with immovable endpoints are dimmed (0.25 opacity via `feature-state: anchored`)
- Hover does not show pointer cursor
- Drag start is blocked

The `setImmovableFeatures()` method on SurveyLayer sets per-feature `anchored` state and dims associated labels and closure lines.

---

## Drag Preview Engine

### Two-Layer Architecture

| Approach | Used for | Performance |
|----------|----------|-------------|
| Temp layers with `*-translate` paint | Static geometry (segment drag, station/shot circles) | GPU uniform update, zero GeoJSON cost |
| Dynamic GeoJSON sources | Geometry that must rebuild (connected shots during station drag) | Per-frame GeoJSON rebuild |

### Temp Layer Definitions

For each main layer (shots, stations, labels), a corresponding temp drag layer is created with the same paint/layout but an inclusion filter for only the dragged features. The main layers get exclusion filters to hide the originals.

### Flow

```
beginDragPreview()    -- save filters, apply exclusions, create temp layers
updateDragPreview()   -- update *-translate (+ rebuild dynamic sources)
commitDragPreview()   -- remove temp layers, keep exclusions (prevents blink during React re-render)
endDragPreview()      -- remove everything, restore original filters
```

### Why Refs Instead of React State

Drag tracking uses refs (`moveDragLngLatRef`, `dragStartScreenRef`, etc.) instead of React state because mousemove fires 60+ times/sec and state updates would cause massive re-renders. SurveyLayer is updated via direct method calls.

---

## Ctrl+Drag Panning

All move tools support Ctrl+drag to pan the map (MapLibre's built-in dragPan is disabled for these tools because it doesn't work reliably with Ctrl in Tauri/WebKit).

### Event Capture Strategy

Capture-phase handlers on the map container intercept events **before** MapLibre's handlers on the canvas:

| Event | During Ctrl+drag | Purpose |
|-------|-----------------|---------|
| `pointerdown` | `stopPropagation` | Prevent MapLibre pointer tracking |
| `mousedown` | `stopPropagation`, `preventDefault` | Start pan, prevent MapLibre click tracking |
| `mousemove` | `stopPropagation` | Pan by delta, suppress MapLibre hover updates |
| `pointerup` | `stopPropagation` | Prevent MapLibre pointer tracking |
| `mouseup` | `stopPropagation`, `preventDefault` | End pan, restore cursor |
| `click` | `stopPropagation`, `preventDefault` | **Critical**: browser fires `click` as a separate DOM event after mouseup regardless of whether mousedown/mouseup were captured. Must be blocked to prevent MapLibre from processing a spurious click. |

The `click` capture uses `ctrlDragActiveRef` which stays true for 50ms after mouseup, covering the window in which the browser dispatches the click event.

### Spurious Keyup Filtering

Tauri/WebKit fires spurious Ctrl keyup events at the moment of mousedown/mouseup while Ctrl is held. These are filtered by timestamp: keyups within 50ms of a Ctrl+drag mouse event (`ctrlDragMouseEventTimeRef`) are suppressed. Genuine Ctrl releases (which occur later) go through immediately so the cursor resets without delay.

### Cursor During Ctrl+Pan

| State | Cursor |
|-------|--------|
| Ctrl held, not dragging | `grab` |
| Ctrl+drag in progress | `grabbing` |
| Drag ends, Ctrl still held | `grab` |
| Drag ends, Ctrl released | Tool default |

### Global Fallback

A window-level `mouseup` handler (`handleMouseUpGlobal`) clears pan state if the mouse is released outside the map container.

---

## Cursor Behavior Summary

### Base Cursors

| Tool | Default cursor |
|------|---------------|
| Move Station | `default` |
| Move Shot | `default` |
| Move Segment | `move` |

### Override Rules (highest priority first)

1. **Ctrl held**: `grab` (overrides everything except active drag)
2. **Ctrl+drag active**: `grabbing`
3. **Hovering interactive feature**: `pointer` (unless anchored/immovable)
4. **Hovering anchored/immovable feature**: `default` (no pointer)
5. **No hover**: Tool default cursor

Move Station and Move Shot use `default` as their base cursor (with `pointer` on hover) rather than `move`, so the user sees a clear distinction between "hovering a movable feature" and "not hovering anything".

---

## Guards & Edge Cases

| Guard | Location | Purpose |
|-------|----------|---------|
| `snapMergeDialogPendingRef` | `handleMoveDragStart` | Block drag start while merge dialog is open after snap-to-merge |
| `anchoredIdsLoaded` | `handleMoveDragStart` | Block segment drag until anchored IDs fetched from backend |
| `anchoredSectionIds.has()` | `handleMoveDragStart` | Silent no-op for clicks on anchored sections |
| `immovableStationKeys.has()` | `handleMoveDragStart` | Block station/shot drag on immovable stations |
| `segmentDragTokenRef` | Connected section fetch | Discard stale async results if drag cancelled or restarted |
| `ctrlDragActiveRef` | Click capture handler | Block DOM click events during Ctrl+drag cooldown |
| Movement threshold (1mm) | `handleMoveDragEnd` | Distinguish click from drag; skip backend call for sub-millimeter moves |

---

## Key Files

| File | Responsibility |
|------|---------------|
| `src/components/Map/MapCanvas.tsx` | Drag state management, Ctrl+drag panning, immovable/anchored computation, snap-to-merge detection |
| `src/components/Map/SurveyLayer.tsx` | Hover detection, visual state (feature-state), drag preview layers, cursor management |
| `src/hooks/useMapTools.ts` | Per-tool click/hover handlers, immovable guards, drag initiation callbacks |
| `src/components/Map/surveyLayer/features.ts` | GeoJSON feature construction, ghost section previews |
