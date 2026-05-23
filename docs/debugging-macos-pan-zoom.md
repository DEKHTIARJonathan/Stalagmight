# Debugging Protocol: macOS UI Lockup (Pan/Zoom + Tools)

## Symptom

On macOS only (Linux works fine):

1. Open a project. The first interactive action works:
   - First pan works.
   - First zoom works.
   - First tool-button click in the top-right toolbar (select/pan/zoom/edit/delete/merge/…) works.
2. **No subsequent interactive action works.** Pan, zoom, and every other tool become unresponsive.
3. Recovery requires closing and reopening the project. Full app restart is **not** needed.

Originally diagnosed as pan/zoom only; the toolbar exhibits the same one-shot lockup, so the bug is broader than `MapCanvas`.

## Hypotheses, in priority order

1. **Tauri IPC bridge saturating or hanging on macOS.** `installConsoleCapture` (`src/utils/consoleCapture.ts`, called from `src/main.tsx`) sends a fire-and-forget `invoke('push_frontend_log', …)` on every `console.*` call. If `push_frontend_log` (or any IPC command) hangs on macOS, every console-emitting code path piles up unresolved promises; once Tauri's bridge queue saturates, every subsequent invoke — including tool actions — silently fails. The lockup-snapshot helper exposes this directly: `__lockupSnapshot()` returns the in-flight IPC count.
2. **A `MapLibre` handler subsystem (`dragPan`, `scrollZoom`, …) gets `.disable()`'d and never re-enabled.** Covered by the panZoomDebug log lines and `__debugSnapshot().handlerEnabled`.
3. **A React ref or local closure variable in `MapCanvas` gets stuck.** `customPanActiveRef` / `ctrlPanActiveRef` staying `true` causes `handleClickCapture` (`MapCanvas.tsx:1968-1973`) to silently `stopPropagation()` every map click thereafter. macOS-specific trigger would be a `pointerdown` without a matching `pointerup`. Visible via `__debugSnapshot().refs`.
4. **An uncaught exception in an event handler** taking down React's event delegation for that tree. Visible via the `window.onerror` / `unhandledrejection` capture in the lockup logger.

`__lockupSnapshot()` and `__debugSnapshot()` together test all four in two calls.

## What the build now logs

Two instrumentation modules are wired up:

- **`src/utils/debugLockup.ts`** — imported first in `main.tsx`. Patches `window.__TAURI_INTERNALS__.invoke` at the lowest level, so every Tauri IPC (whether routed through `invokeIpc`, telemetry, tile-protocol, console-capture, or anything else) is logged with an id, duration, and an in-flight count. Logs a `IPC HANG` warning if any single call is still pending after 3 s. Also captures global errors, unhandled promise rejections, all document-level clicks (capture phase, non-intrusive), and `activeTool` store transitions.
- **`src/components/Map/panZoomDebug.ts`** — wraps every MapLibre handler's `enable`/`disable`, logs map lifecycle and raw canvas events, exposes `window.__map` and `window.__panRefs`.

DevTools helpers exposed on `window`:

| Function | Returns |
|---|---|
| `__lockupSnapshot()` | `{ tauriPatched, inFlightCount, inFlightByCommand, oldest[…10], activeTool }` |
| `__debugSnapshot()` | MapLibre handler enable-state, isMoving/isZooming/isRotating, custom-pan ref values |
| `__map` | the MapLibre Map instance |
| `__panRefs` | the four `useRef`s from `MapCanvas` |
| `__getActiveTool()` | current `useUIStore.activeTool` |

## How to run it on the Mac

### Step 1 — build and launch

```bash
pnpm install
pnpm tauri dev
```

Open Web Inspector (right-click → Inspect Element) → Console.

### Step 2 — confirm instrumentation loaded

Within a second or two of launch, you should see:

```
[debug-lockup] instrumentation loaded
[debug-lockup] Tauri IPC bridge patched
[debug-lockup] uiStore.activeTool subscription installed
```

If `Tauri IPC bridge patched` never appears, the patch couldn't find `window.__TAURI_INTERNALS__` — note that and stop; we'd need to fix the patch before continuing.

### Step 3 — baseline

Open a project. Run in console:

```js
__lockupSnapshot()
__debugSnapshot()
```

Save the output as "BASELINE".

### Step 4 — reproduce

The clearest single repro is the toolbar one, since it isolates the bug from MapLibre internals:

1. Click any tool button in the top-right toolbar (e.g. **draw**). Verify it activates (visual highlight, log shows `activeTool: select -> draw`).
2. Click a different tool button (e.g. **select**).
   - Does the visual highlight change?
   - Does the log show `activeTool: draw -> select`?
   - Does the log show `[debug-lockup] click <button> testid=… text="…"`?

Then run again:

```js
__lockupSnapshot()
__debugSnapshot()
```

Save the output as "BROKEN".

### Step 5 — save the log

In the Console, right-click → **Save As…** to dump all the log between baseline and broken. Trim to just the window around the first tool click → second tool click.

## What to look for

### IPC layer (hypothesis #1)

| Signal | Means |
|---|---|
| `__lockupSnapshot().inFlightCount` is high (>10) and growing | IPC bridge is saturated — confirms #1. |
| `inFlightByCommand` shows many `push_frontend_log` | Console-capture spam is what saturates. Workaround: temporarily disable `installConsoleCapture()` in `main.tsx` and retest. |
| `inFlightByCommand` shows a specific command stuck | That command is the hung one. Find its Rust handler. |
| `[debug-lockup] IPC HANG <cmd> > 3s` in the log | That command never resolved. |
| `tauriPatched: false` in the snapshot | Patch never installed (timing issue) — IPC numbers below are unreliable. |

### Click / state layer (hypothesis #2/3/4)

| Signal | Means |
|---|---|
| No `[debug-lockup] click …` log when you click the second tool | The click isn't reaching the document — overlay or `pointer-events:none` issue. |
| `click` logged with `defaultPrevented=true` | A capture-phase handler ate it. |
| Click logged but no `activeTool: X -> Y` log | The click reached the document but the React handler didn't fire OR didn't call `setActiveTool`. React tree may be in an error state. Look for `window.onerror` or `unhandledrejection` in the log. |
| `activeTool: X -> Y` logged but visual doesn't update | React re-render is broken (likely an exception during render). Check error logs. |
| `__debugSnapshot().handlerEnabled.dragPan === false` (or any other handler false) | MapLibre handler stuck disabled — hypothesis #2. |
| `__debugSnapshot().refs.customPanActive === true` (no mouse down) | Custom pan ref stuck — hypothesis #3. |

## Try the in-console recovery

If state inspection points at the MapLibre layer:

```js
['dragPan','scrollZoom','boxZoom','dragRotate','touchZoomRotate','keyboard','doubleClickZoom','touchPitch']
  .forEach(n => __map[n]?.enable?.());
__panRefs.customPanActive.current = false;
__panRefs.ctrlPanActive.current = false;
__panRefs.placementJustConfirmed.current = false;
```

If state inspection points at IPC saturation, the only in-console recovery is to drain in-flight by reopening the project. That itself is diagnostic — it confirms the bridge state resets on project unmount.

## Report template

```
macOS UI lockup — protocol run

Repro: <which action triggered it — toolbar click / on-screen zoom / wheel / pinch>

BASELINE __lockupSnapshot:
<paste>
BASELINE __debugSnapshot:
<paste>

BROKEN __lockupSnapshot:
<paste>
BROKEN __debugSnapshot:
<paste>

Log between baseline and broken (trimmed to ~50 lines around the trigger):
<paste>

Click test result:
  - second toolbar click logged at document level: <yes/no>
  - activeTool transition logged: <yes/no>
  - window.onerror or unhandledrejection logged: <yes/no, paste if yes>

My read: <hypothesis 1/2/3/4 + smoking-gun log line>
```

## Cleanup

When the bug is fixed:

1. Delete `src/utils/debugLockup.ts`.
2. Delete `src/components/Map/panZoomDebug.ts`.
3. Revert the diffs in `src/main.tsx` (the debug import) and `src/components/Map/MapCanvas.tsx` (the panZoomDebug import + install call).
4. Delete this doc.
