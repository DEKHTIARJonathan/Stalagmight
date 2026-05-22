# Touch Support

Stalagmight runs on Android tablets. This document describes the touch event
handling added alongside the existing mouse/keyboard controls. Mouse and
keyboard behavior is unchanged.

## Strategy

- **Pointer Events** (superset of `MouseEvent`, same `clientX`/`clientY` API)
  replace mouse events wherever we control React handlers.
- **Raw touch listeners** are used where we hook into MapLibre's own event
  system (canvas-level hit-testing).
- Touch-only logic is gated on `pointerType === 'touch'`.

---

## `useLongPress` Hook

**File:** `src/hooks/useLongPress.ts`

Reusable hook for long-press detection on touch devices.

```ts
function useLongPress(
  callback: (position: { x: number; y: number }, target: HTMLElement) => void,
  options?: { delay?: number; moveThreshold?: number; enabled?: boolean }
): { onPointerDown; onPointerMove; onPointerUp; onPointerCancel }
```

- Only activates for `pointerType === 'touch'`.
- Fires after 500 ms hold; cancels if finger moves > 10 px.
- Prevents the synthetic click that follows a long-press.
- Mouse events pass through untouched.

Exported from `src/hooks/index.ts`.

---

## Panel Resizer (`Panel.tsx`)

The `ResizablePanel` handle uses **Pointer Events** with
`setPointerCapture()`. This routes all subsequent move/up events to the handle
element itself (no document-level listeners needed).

- `touch-action: none` on the handle prevents the browser from consuming the
  gesture for scroll.
- CSS classes `resize-handle-h` / `resize-handle-v` are widened on
  `@media (pointer: coarse)` via `src/index.css` for easier touch targeting.

---

## Map Canvas (`MapCanvas.tsx`)

### Pointer event migration

All `onMouse*` props on the outer `<div>` are replaced with `onPointer*`.
Internal handler type annotations changed from `React.MouseEvent` to
`React.PointerEvent`. Sub-handlers (`handleZoomBoxStart`, `handleBoxSelectStart`,
`handleMoveDragMove`, etc.) accept the new type.

### Dynamic `touch-action`

A `useMemo` computes `touch-action` based on the active tool:

| Active tool | `touch-action` | Reason |
|-------------|----------------|--------|
| `pan` | `manipulation` | Let MapLibre handle touch pan/pinch-zoom |
| All others (select, draw, zoom, move_*, etc.) | `none` | App handles the gesture |

### Pan tool guard

In `handlePointerDown`, an early return for `pointerType === 'touch'` when
`activeTool === 'pan'` lets MapLibre's built-in touch handling take over.

### Placement cancel button

`PlacementOverlay` accepts an optional `onCancel` prop. When
`navigator.maxTouchPoints > 0`, a visible "Cancel" button is rendered (since
right-click is unavailable on touch).

---

## Long-Press Context Menus

Touch devices lack right-click. A 500 ms long-press opens context menus
everywhere the app uses them.

### SectionsPanel

`openSectionContextMenu(sectionId, x, y)` is extracted from the existing
`handleSectionContextMenu`. Both `onContextMenu` (right-click) and
`useLongPress` (touch) call it. Long-press handlers are spread onto each
`<li>` via `SectionRow`.

### ShotTableEditor

`useLongPress` is attached at `<tbody>` level. Each `<tr>` carries a
`data-row-index` attribute. The long-press callback resolves the row via
`target.closest('tr')?.dataset.rowIndex`.

### SurveyLayer (map feature context menus)

Raw touch listeners (`touchstart`, `touchmove`, `touchend`, `touchcancel`) on
`map.getCanvas()`:

1. `touchstart` (single finger) starts a 500 ms timer, records position.
2. `touchmove` cancels if moved > 10 px.
3. When the timer fires, hit-test at touch position via
   `queryRenderedFeatures`, then call `this.callbacks.onContextMenu` with the
   result.

Listeners use `{ passive: false }`. Cleanup happens in `destroy()`.

### GlobalSurveyLayer

Same pattern as SurveyLayer. Hit-tests both station and shot hitbox layers,
calls `onSystemContextMenu`.

### GlobalViewMap markers

Per-marker `touchstart`/`touchmove`/`touchend`/`touchcancel` listeners with
a 500 ms timer. On fire, calls `onContextMenuRef.current(filePath, x, y)`.

---

## Toolbar Flyouts (`Toolbar.tsx`)

### Pointer type tracking

Both `ToolButton` and `ToolGroupButton` track the last pointer type via
`lastPointerTypeRef`, set in `onPointerDown` on the wrapper `<div>`.

### Touch tap opens flyout

`ToolGroupButton.handleClick`: when `lastPointerTypeRef.current === 'touch'`,
the click toggles the flyout open/closed instead of cycling tools. This lets
touch users see the full tool list and pick one.

### Informational flyout suppressed on touch

`ToolButton.handleMouseEnter` and `ToolGroupButton.handleMouseEnter`:
early-return when the last pointer was touch (no hover concept on touch).

### Outside-click handler

Changed from `document.addEventListener('mousedown', ...)` to `'pointerdown'`
so that both mouse clicks and touch taps outside the flyout close it.

---

## Files Changed

| File | Change |
|------|--------|
| `src/hooks/useLongPress.ts` | **New** |
| `src/hooks/index.ts` | Export `useLongPress` |
| `src/components/common/Panel.tsx` | Pointer events + capture, touch-action, handle classes |
| `src/components/Map/MapCanvas.tsx` | `onMouse*` -> `onPointer*`, touch-action, pan guard |
| `src/components/Map/PlacementOverlay.tsx` | Cancel button for touch |
| `src/components/SingleSystemView/SectionsPanel.tsx` | `useLongPress` on section items |
| `src/components/common/ShotTableEditor.tsx` | `useLongPress` on tbody |
| `src/components/Map/SurveyLayer.tsx` | Touch listeners for long-press context menu |
| `src/components/GlobalView/GlobalSurveyLayer.ts` | Touch listeners for long-press context menu |
| `src/components/GlobalView/GlobalViewMap.tsx` | Touch listeners on markers |
| `src/components/SingleSystemView/Toolbar.tsx` | pointerType tracking, tap-to-toggle flyout |
| `src/index.css` | `@media (pointer: coarse)` resize handle widening |

## Testing

Desktop: mouse click, right-click, hover flyouts, panel resize, and all map
tools should work identically to before.

Android tablet: verify panel resize via drag, long-press context menus,
tap-to-open toolbar flyouts, and map draw/move/select tools via touch.
