# Debugging Protocol: macOS Pan/Zoom Lockup

## Symptom

On macOS only (Linux works fine):

1. Open a project — pan and zoom both work.
2. Trigger any zoom (on-screen +/- buttons, trackpad pinch, wheel, keyboard, double-click, zoom tool).
3. After that first zoom: **pan stops responding**, **only one zoom step ever succeeds**, no further zoom-in or zoom-out works.
4. Recovery requires closing and reopening the project. Full app restart is **not** needed.

Because project close/reopen alone resolves it, the broken state lives in **`MapCanvas`** — its React refs, its local closure state, or MapLibre's per-instance handler enable-flags. All three are torn down when `SingleSystemView` unmounts.

## Primary hypotheses, in priority order

1. **A MapLibre handler subsystem (`dragPan`, `scrollZoom`, …) gets `.disable()`'d on macOS and never re-enabled.** The instrumentation logs every enable/disable call, so this shows up directly.
2. **A React ref gets stuck.** `customPanActiveRef` or `ctrlPanActiveRef` (`MapCanvas.tsx:184-190`) staying `true` would make `handleClickCapture` and `handlePointerUpCapture` (`MapCanvas.tsx:1968-1991`) silently `stopPropagation()` on every subsequent map interaction. A macOS-specific trigger would be a pointerdown without a matching pointerup (e.g. a synthetic event during trackpad pinch).
3. **MapLibre's internal gesture state is stuck.** `map.isMoving()`, `isZooming()`, or `isRotating()` returning `true` while idle means MapLibre thinks a gesture is in progress and ignores further input. Usually caused by a missing `*end` event from WebKit.
4. **CSS or DOM gating.** Cursor stuck on `grabbing`, or `touch-action: none` on the wrong tool.

`window.__debugSnapshot()` tests all four in one call.

## How to run it

The instrumentation is already wired into the dev build. No DevTools setup beyond opening the Web Inspector.

### Step 1: Build and launch

```bash
./scripts/dev.sh   # or however you launch the macOS dev build
```

Open Web Inspector (right-click → Inspect Element). Switch to the **Console** tab.

### Step 2: Open a project and confirm baseline

You should see in console:

```
[pan-zoom-debug] install: map created, instrumentation active
[pan-zoom-debug] dragRotate.disable()  was=true  …
[pan-zoom-debug] touchPitch.disable()  was=true  …
[pan-zoom-debug] boxZoom.disable()     was=true  …
[pan-zoom-debug] install: call window.__debugSnapshot() when reproducing the bug
```

Those three initial `.disable()` lines come from `MapCanvas.tsx:1361-1365` and confirm the monkey-patching is in place.

### Step 3: Take a healthy baseline snapshot

In the console:

```js
__debugSnapshot()
```

Save the output. This is the "everything fine" reference.

### Step 4: Reproduce, then snapshot

1. Pan once (works).
2. Click the on-screen **+** button once. Map zooms.
3. Pan again — confirm it's broken.
4. Run `__debugSnapshot()` again.

### Step 5: Also capture the log

Between Step 3 and Step 4, the console will have logged every:

- `mapName.enable()` / `.disable()` call (with short stack trace),
- map lifecycle event (`zoomstart`, `zoomend`, `movestart`, `moveend`, etc., with the originating DOM event type),
- raw canvas event (`pointerdown`, `pointerup`, `wheel`, `gesturestart`, `gestureend`, …).

Right-click in the Console → **Save As…** (or select all and copy). Trim to the window starting just before you clicked **+**.

## What to look for

| In the log/snapshot | Means |
|---|---|
| Any `handlerName.disable()` between the **+** click and the broken state, with no matching `.enable()` | Hypothesis #1 confirmed. The stack trace in the log points at the caller. |
| `handlerEnabled.dragPan === false` (or `scrollZoom === false`) in the broken snapshot | Same — hypothesis #1. |
| `refs.customPanActive === true` or `refs.ctrlPanActive === true` in the broken snapshot, while no mouse button is down | Hypothesis #2. Look for a `pointerdown` in the log without a matching `pointerup`. |
| `isMoving`, `isZooming`, or `isRotating` `=== true` in the broken snapshot | Hypothesis #3. Look for a `zoomstart`/`movestart` in the log without its matching `*end`. |
| `gesturestart` logged with no `gestureend` | macOS WebKit pinch gesture left open. Strong macOS-specific signal. |
| Canvas events logged with `defaultPrevented: true` on `pointerdown`/`wheel` after the lockup | A capture-phase handler in `MapCanvas.tsx:1880-2041` is swallowing them. Cross-check refs in the snapshot. |
| Canvas events not logged at all when you try to pan after lockup | Input isn't reaching the canvas — some overlay or `pointer-events: none` issue. |
| `cursor === 'grabbing'` in the broken snapshot while idle | Custom pan state stuck — confirms #2. |

## Try the in-console fix

Once you have the snapshot+log, paste this:

```js
['dragPan','scrollZoom','boxZoom','dragRotate','touchZoomRotate','keyboard','doubleClickZoom','touchPitch']
  .forEach(n => __map[n]?.enable?.());
__panRefs.customPanActive.current = false;
__panRefs.ctrlPanActive.current = false;
__panRefs.placementJustConfirmed.current = false;
__debugSnapshot();
```

If pan/zoom now work, the bug is hypothesis #1 or #2 (and the fix is to find what disabled the handler / set the ref, and not do that). If still broken, it's #3 (MapLibre gesture state) or something else — note that in the report.

## Report template

Copy this back into the chat or a fix commit:

```
macOS pan/zoom lockup — protocol run

Baseline snapshot:
<paste output of __debugSnapshot() after open, before zoom>

Broken snapshot:
<paste output of __debugSnapshot() after the zoom click>

Log between baseline and broken (trimmed):
<paste console lines>

In-console fix attempt result:
<pan/zoom works again | still broken | partially>

My read: <hypothesis 1/2/3/4 + which log line was the smoking gun>
```

## Cleanup

When the bug is fixed:

1. Delete `src/components/Map/panZoomDebug.ts`.
2. Revert the two diffs in `src/components/Map/MapCanvas.tsx`: the `installPanZoomDebug` import and call.
3. Delete this doc.
