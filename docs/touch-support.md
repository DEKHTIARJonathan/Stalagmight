# Touch support

Stalagmight is a desktop app that also has an Android tablet build. Touch
support is partial: a handful of surfaces were adapted for it, the rest inherit
whatever the browser's compatibility mouse events give them. Automated coverage
reaches the map and nothing else - one Playwright spec dispatches real touch
gestures at it. Read the gaps section before assuming a gesture works.

The Android target is sideload-only (`scripts/build-android.sh`,
`scripts/deploy-android.sh`, `src-tauri/gen/android/`, `tauri.android.conf.json`).
It is not built, run, or tested in CI.

## Where the touch-specific code lives

| File | Symbol | What it does |
|------|--------|--------------|
| `src/hooks/useLongPress.ts` | `useLongPress` | Long-press detection for React surfaces; no-op unless `pointerType === 'touch'` |
| `src/components/SingleSystemView/SectionsPanel.tsx` | `handleLongPress` (~:699) | Long-press a section row -> section context menu |
| `src/components/common/ShotTableEditor.tsx` | `handleLongPress` (~:326) | Long-press a shot row -> row context menu (see Gaps: this does not fire) |
| `src/components/Map/SurveyLayer.tsx` | `boundTouchStart` / `boundTouchMove` / `boundTouchEnd` / `boundTouchCancel` (~:1016) | Raw canvas touch listeners -> survey context menu |
| `src/components/GlobalView/GlobalSurveyLayer.ts` | same quartet (~:267) | Raw canvas touch listeners -> system context menu |
| `src/components/GlobalView/GlobalViewMap.tsx` | per-marker listeners (~:979) | Long-press a project marker -> marker context menu |
| `src/utils/mapGestures.ts` | `mapGestureMode` | The one predicate deciding which gestures the map keeps for itself |
| `src/components/Map/MapCanvas.tsx` | `dragPan` effect (~:2549), `touchAction` memo (~:3604) | Both consumers of that predicate |
| `src/components/SingleSystemView/useResizeHandle.ts` | `useResizeHandle` | Pointer-capture drag for every resize handle |
| `src/components/common/Panel.tsx`, `src/components/SingleSystemView/Dock.tsx` | `touchAction: 'none'` on the handle (`Panel.tsx:134`, `Dock.tsx:404`) | Stops the browser claiming the drag as a scroll. Without it the pointer-capture drag above never gets move events on touch |
| `src/components/Map/PlacementOverlay.tsx` | ~:229 | Renders a Cancel button when `navigator.maxTouchPoints > 0` |
| `src/components/SingleSystemView/Toolbar.tsx` | `lastPointerTypeRef` (~:593, ~:708) | Tap-vs-hover behavior for tool buttons and flyouts |
| `src/index.css` | `@media (pointer: coarse)` (~:1333) | Widens `.resize-handle-h` / `.resize-handle-v` by 12px |

## Pointer events vs mouse events

There is no single rule. Three patterns coexist:

- **Unified via Pointer Events.** `MapCanvas`'s outer container uses
  `onPointerDown/Move/Up/Leave`; resize handles use pointer events plus
  `setPointerCapture` (`useResizeHandle.ts:56`). One code path serves mouse and
  touch, with `e.pointerType` consulted only where the behavior must differ.
- **Mouse-only, deliberately.** The custom Ctrl+drag / middle-drag map pan uses
  raw `mousedown`/`mousemove`/`mouseup` capture listeners on the map container
  (`MapCanvas.tsx:2751-2833`) and its pointer-capture guard explicitly requires
  `e.pointerType === 'mouse'` (`MapCanvas.tsx:2849`). There is no modifier key on
  touch, so this is intentional - and since #409 no loss either, because plain
  one-finger drag pans.
- **Mouse-only, by omission.** Most of the app was never converted. The
  in-house data grid (`src/components/common/SpreadsheetGrid/`) is entirely
  `onMouseDown` / `onContextMenu`, with drag operations (fill handle, column
  resize, range select) driven by `window` `mousemove`/`mouseup`
  (`SpreadsheetGrid.tsx:1776`). Popover dismissal (`src/hooks/useDismissableLayer.ts:57`)
  listens on `mousedown`. These work on touch only to the extent that the browser
  synthesizes compatibility mouse events from a tap; drags do not.

Touch-only behavior is always gated on `pointerType === 'touch'` (React
surfaces) or lives in a separate raw `touch*` listener (canvas surfaces).

`src/utils/inputModality.ts` listens on `pointerdown`, `mousedown` and
`touchstart` to tag `<html data-input-modality>`, which suppresses focus rings
for pointer input. Touch counts as pointer input there.

## Long press

Long press is how touch reaches the context menus that right-click opens on
desktop. Two independent implementations, same constants, no shared source:

| | `useLongPress` | Canvas listeners |
|---|---|---|
| Delay | `delay` option, default 500 ms (`useLongPress.ts:28`) | 500 ms, inline literal |
| Move cancel | `moveThreshold` option, default 10 px | 10 px, inline as `dx*dx + dy*dy > 100` |
| Multi-touch | not checked | ignored unless `e.touches.length === 1` |

The thresholds are duplicated at `SurveyLayer.tsx:1041`/`:1049`,
`GlobalSurveyLayer.ts:292`/`:300` and `GlobalViewMap.tsx:994`/`:1002`. Changing
the feel means editing all four sites.

`useLongPress` returns `{ onPointerDown, onPointerMove, onPointerUp,
onPointerCancel }` to spread onto an element, and hands the callback the press
position plus `e.currentTarget`. On fire it sets a flag and the next
`onPointerUp` calls `preventDefault()` + `stopPropagation()` on the React
synthetic event. The Pointer Events spec suppresses compatibility
mouse events via `preventDefault()` on `pointerdown`, not `pointerup`, so
whether the trailing tap is actually swallowed is unverified.

The canvas implementations synthesize a `MouseEvent('contextmenu')` at the touch
position and feed it to the same handler the real right-click uses
(`SurveyLayer.handleContextMenu`, `GlobalSurveyLayer.callbacks.onSystemContextMenu`),
so the resulting menu is identical.

The `touchend` listener's `{ passive: false }` registration is load-bearing. A
long-press that fires sets `touchLongPressFired`, and the `touchend` ending that
press calls `preventDefault()` on it (`SurveyLayer.tsx:1056`,
`GlobalSurveyLayer.ts:307`), which is what suppresses the compatibility mouse
events the browser would otherwise synthesize - so lifting the finger cannot also
run the active tool's click underneath the open menu (#338). Deliberately no
`stopPropagation`: MapLibre's own `touchend` still has to run or pan and pinch
break. `touchcancel` has its own handler (`boundTouchCancel`), which clears the
flag without preventing anything.

## Map and renderer

**Gesture ownership.** One pure predicate decides it: `mapGestureMode`
(`src/utils/mapGestures.ts`) takes the active tool, whether placement mode is on,
and whether a move ghost is in flight, and returns `{ dragPan, touchAction }`.
The default answer is `dragPan: true` / `touchAction: 'manipulation'`, so
MapLibre's own one-finger pan and pinch-zoom run under **every** tool (#409).
Three modes take the gesture back, because in each the drag itself is the
interaction: the zoom tool, whose drag draws the zoom box; placement mode, which
confirms on `pointerdown`; and a move ghost in flight, which drops on
`pointerup`. Those three get `touchAction: 'none'` and `dragPan.disable()`.

Both consumers call the same function - the `dragPan` effect
(`MapCanvas.tsx:2549`) and the `touchAction` memo (`MapCanvas.tsx:3604`) - so
they cannot disagree. This replaced three hand-kept copies of one tool list plus
a `pointerType === 'touch' && activeTool === 'pan'` early return in
`handlePointerDown`, which is why **adding a `ToolType` no longer means updating
any list.**

**MapLibre handlers.** `dragRotate`, `touchPitch` and `boxZoom` are disabled at
map construction (`MapCanvas.tsx:1674-1680`), and so is the rotation half of the
pinch: `touchZoomRotate.disableRotation()` (`MapCanvas.tsx:1678`) leaves a
two-finger twist zooming only. The survey is a top-down plan, so a bearing means
nothing here, and a non-zero one would drop the `axisAligned` fast path in the
hit-test/geometry index (`SurveyLayer.cameraSnapshot`, ~:1315) with no way to
reset it from the touch UI.

**Custom WebGL renderer.** Touch needs nothing renderer-specific. The survey is
drawn by the custom WebGL layer, and the stock bulk layers were deleted rather
than hidden, so hit-testing does not use `queryRenderedFeatures`; it goes through the SoA
geometry index (`SurveyLayer.hitCandidateSections`, `resolveStationAt` /
`resolveShotAt`, documented at `SurveyLayer.tsx:1263`). Long-press hit-testing
calls the same `handleContextMenu` as right-click, so it inherits that path for
free. `GlobalSurveyLayer` likewise resolves via its own `pickSystemAt` index.

**Placement mode** is the one map interaction explicitly written for touch:
`handlePlacementClick` recomputes the cursor position from the event because
`pointerdown` precedes any `pointermove` on touch (`MapCanvas.tsx:3690`), and
`PlacementOverlay` shows a Cancel button when `navigator.maxTouchPoints > 0`
because right-click-to-cancel is unavailable.

## Toolbar

`ToolButton` and `ToolGroupButton` record `e.pointerType` into
`lastPointerTypeRef` on `onPointerDown` (`Toolbar.tsx:650`, `:880`) and branch on
it:

- A tap on a tool group toggles its flyout open instead of cycling through the
  group's tools (`Toolbar.tsx:733`), so touch users can see and pick a subtool.
- `handleMouseEnter` returns early after a touch (`Toolbar.tsx:602`, `:762`), so
  the hover-open flyout and the informational flyout do not appear.

## Form input

Numeric fields carry `inputMode="decimal"` so tablets raise a numeric soft
keyboard. Applied across `ShotTableEditor`, `EditShotDialog`,
`SectionMetadataForm` and the other shot/geometry entry dialogs; grep
`inputMode="decimal"` for the full set. `HelpTooltip` toggles on `onClick`
(`HelpTooltip.tsx:116`) rather than hover-only, so its text is reachable by tap.

## Gaps and known-broken cases

- **Test coverage stops at the map.** `e2e-playwright/map-touch-gestures.spec.ts`
  opts into `test.use({ hasTouch: true })` and dispatches gestures through CDP
  `Input.dispatchTouchEvent` (Playwright's own API expresses neither a touch drag
  nor a pinch), covering one-finger pan, the long-press menu and its swallowed
  lift, and a two-finger twist that zooms without rotating. Nothing else: no unit
  test for `useLongPress`, no mobile device profile in the Playwright projects
  (`playwright.config.ts:112` runs Desktop Chrome only), and no touch cases in
  the legacy WebdriverIO suite. Outside that one spec, every claim on this page
  about *behavior on a device* is untested; the claims about code are what was
  read from source.
- **`ShotTableEditor`'s long-press context menu cannot fire.** `useLongPress`
  passes `e.currentTarget` (`useLongPress.ts:50`), the handlers are spread on
  `<tbody>` (`ShotTableEditor.tsx:472`), and the callback does
  `target.closest('tr')` (`ShotTableEditor.tsx:329`), which returns `null` from a
  `<tbody>`. It needs `e.target` - the rows already carry the `data-row-index`
  the callback reads (`ShotTableEditor.tsx:494`). `SectionsPanel` is unaffected
  because it attaches per-row and ignores the target argument. Filed as #338.
- **The main data table is mouse-only.** `SpreadsheetGrid` - the shot table in
  the dock - has no pointer or touch handling. Range drag, fill-handle drag,
  column resize and the move-edge drags all listen for `mousemove`/`mouseup`,
  which a touch drag does not produce.
- **Move tools are untested on touch and structurally awkward.** A move drag is
  started by MapLibre's `click` (`useMapTools.ts:457`, `:469`), previews on
  `pointermove` over the container, and commits on `pointerup`
  (`MapCanvas.tsx:3660`). With a mouse the pointer keeps moving between grab and
  drop; with a finger it does not, so the gesture becomes tap-to-grab followed by
  a separate touch-drag-release. Nobody has confirmed this on hardware.
- **Popover dismissal depends on compatibility mouse events.**
  `useDismissableLayer` listens on `mousedown` only, so an outside tap dismisses
  a flyout or menu only if the browser synthesizes the compatibility event.
- **Enlarged touch targets stop at the resize handles.** The only
  `@media (pointer: coarse)` rule in the stylesheet widens the two resize-handle
  classes. Buttons, toolbar items, table cells and menu rows keep their desktop
  sizes.
