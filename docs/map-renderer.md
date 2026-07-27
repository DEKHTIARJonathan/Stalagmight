# The survey map renderer

The survey is not drawn by MapLibre style layers. It is drawn by custom WebGL2
layers that own their own shaders and vertex buffers, straight from the
struct-of-arrays `SurveyData` the store holds. There are no vector-tile sources
for shots, stations, shot gradients, or labels, and there is **no stock
fallback**. `surveyLayer/customRender/gate.ts` says so outright, and the name
"gate" is a fossil: the flag it held is gone, only a dev re-sync hook survives.

That one fact explains most of this subsystem's shape: everything MapLibre used to
give away - `queryRenderedFeatures` hit-testing, `setFeatureState` hover,
data-driven paint, a glyph endpoint - had to be rebuilt, so each now has a named
home in this tree.

## The layers

Five custom layers exist, each pairing a *controller* (lifecycle, buffer
building, cheap update paths) with a *GL layer* (`CustomLayerInterface`: compile,
upload, draw).

| Layer id | Controller | GL layer | Draws |
|---|---|---|---|
| `survey-custom-render` | `customRender/controller.ts` | `surveyCustomLayer.ts` | shots as screen-width lines, stations as fragment circles |
| `survey-custom-labels` | `customRender/labelController.ts` | `surveyCustomLabelLayer.ts` | all five label kinds (`labelShaders.LABEL_KIND`) |
| `survey-measure-path-custom` | `customRender/measurePathController.ts` | `surveyMeasurePathLayer.ts` | the ruler's along-cave-line tint |
| `survey-drag-ghost` | `surveyLayer/dragGhostController.ts` | `customRender/surveyGhostLayer.ts` | the moving-geometry preview during a move drag |
| (global map) | `GlobalView/customRender/globalController.ts` | `globalCustomLayer.ts` | the multi-system Global View |

The Global View is a **parallel implementation**, not a reuse: its own
tessellator, shaders, and hit index live under
`src/components/GlobalView/customRender/`, sharing the small pure helpers -
`colorPack.ts`, the `SHOT_ALPHA_*` constants, and the anchor-matrix math in
`mercator.ts`. A fix in the tessellator, shaders, or hit index of one is not a
fix in the other.

Still ordinary MapLibre, on small GeoJSON sources built in
`SurveyLayer.initializeSources`: loop closures, the gas route highlight, merge
ghosts, and the **interact overlay** - a handful of features holding only the
currently hovered / selected / snapped items, redrawn above the custom geometry
so per-item highlight survives without feature-state. Z-order is explicit: the
geometry layer inserts before `survey-interact-shots` (`controller.ts:328`), so
it sits above closures and ghosts and below every overlay, and the label layer
is added with no `beforeId`, so labels are on top.

## Anchor-relative coordinates, and the matrix trap

Two things in `customRender/mercator.ts` are load-bearing and easy to break.
First: float32 vertex positions cannot hold absolute mercator coordinates. A
cave a few km across occupies a mercator span of ~1e-5 while the coordinates
themselves sit near 0.5, where float32 spacing is coarse enough to make geometry
visibly snap. Every vertex is therefore stored as `mercator - anchor` (anchor =
the survey's mercator bbox center) and the large translation is folded back into
the per-frame matrix in float64 (`composeAnchorMatrix`). Consequence worth
knowing: an edit that moves the bbox extent shifts the anchor, moving every
vertex, which forces a full rebuild. Second: the frame matrix must be
`options.defaultProjectionData.mainMatrix`, not
`options.modelViewProjectionMatrix`. The latter maps world-pixel space in
MapLibre 5.16 and flings the survey millions of pixels off-screen - clean GL
state, no errors, blank layer. That failure has already been paid for once.

## From store state to GPU

`SurveyLayer.flushUpdate` picks the active geometry (measured or
closure-adjusted, via `store/geometrySelectors.selectActiveSurveyData`), rebuilds
the hit index, and calls `syncCustomRender`, which assembles a
`DisplayColorContext` and syncs the geometry and label controllers. All of it is
synchronous - no worker, no tile cut - which is why an edit repaints in the same
frame. `SurveyCustomController.sync` then picks one of three tiers, cheapest
first:

1. **Incremental** (`incremental.ts::planIncrementalUpdate`): the SoA layout is
   unchanged (same section sequence, same shot ids per slot, same station
   mapping), color globals are unchanged, and the anchor and GPS origin held, so
   only the dirty sections' vertex ranges are re-emitted and `bufferSubData`'d.
   Bails if more than half the sections are dirty.
2. **Color-only** (`planColorOnlyUpdate`): geometry byte-stable but the color
   globals changed - overlay enter/exit, theme swap, depth or severity toggle.
   Recomputes the four color arrays through the same resolvers, re-uploads only
   those buffers.
3. **Full build** (`controller.build`): reproject, tessellate, pack, swap.

Both fast paths refuse to run when a build-time exclusion is active, because
compaction breaks the global-station-index to vertex-slot mapping they rely on.
Beside them, three side channels rewrite only a per-vertex **flag** array and
re-upload it, never touching positions or colors:

- `setDimming` - anchored sections and immovable features during move tools.
- `setDragHide` - the moving features during a drag; they stay in the buffers
  and the shader collapses the marked vertices to a clipped point.
- `setHighlight` / `setSectionHover` / `setSectionSelect` - three setters over one
  array, merged into one emphasis level per section (hover beats selection) that
  the shader turns into a width or radius bump.

Show/hide toggles for shots, stations, reference legs, and jumps are shader
uniforms - a flag flip plus `triggerRepaint`, no rebuild at all. Tessellation
itself (`tessellate.ts`) is deliberately simpler than MapLibre's: each shot is an
independent quad, extended past its endpoints in the vertex shader so the
fragment shader's capsule SDF can round the caps, no miter joins,
and the station discs cover the junctions. The extrusion and edge-feather math is
adapted from MapLibre's `line.{vertex,fragment}.glsl`; the `shaders.ts` header
records what was reused and what was dropped.

## Color

Every vertex carries a packed RGBA8 color attribute, so all the decisions MapLibre
would have made in a paint expression happen at build time in
`colorResolvers.ts::makeColorResolvers`. Precedence: an active **analytical
overlay** (distance gradient, gas reach) owns the shot color and station fill
outright; otherwise the **move-comment tint** if that tool is active; otherwise
`surveyLayer/displayColor.ts` - severity, then depth ramp, then section color.

Two details are worth respecting. `overlayColor.ts` reproduces MapLibre's
data-driven ramp *byte for byte* - it floors where `colorPack.packCssColor`
rounds, because `packUint8ToFloat` floors. And the depth gradient is not
resampled per sub-segment: each shot carries a from- and a to-endpoint color and
the GPU interpolates by the clamped along-fraction, which also holds the
endpoint color across each rounded cap.

Selection, hover, dimming, and drag-hide are **not** color - they are separate
per-vertex float flags, which is why they have their own cheap re-upload paths
and why changing a color mode does not disturb them. Per-kind line alphas
(`SHOT_ALPHA_DIMMED` / `_REFERENCE` / `_JUMP` / `_NORMAL`, `shaders.ts`) are
interpolated into the GLSL source at module evaluation *and* imported by
`SurveyLayer` for the interact overlay, so a hovered reference leg cannot pop
brighter than its own base rendering.

## Labels

The label pass is an independent sibling - its own controller, its own GL layer,
its own failure - and the only part of this renderer with a texture.
`glyphAtlas.ts` rasterizes glyphs on demand with TinySDF into a shelf-packed R8
atlas from an Open Sans TTF bundled under `src/assets/fonts/`; that is what
made the remote glyph endpoint unused (no `symbol` layers remain - the vestigial
`glyphs:` key is still declared in `MapCanvas.tsx`'s style but nothing fetches
from it). `labelLayout.ts` shapes each string left-to-right into per-glyph quads
whose offsets are in **em**, so one shaping pass is correct at every zoom.
`labelDecimation.ts` and `labelReveal.ts` are the interesting pair: instead of a
per-frame modulus test, every label gets one baked `a_reveal_zoom` - the minimum
live zoom at which it draws - computed by a zoom-ladder greedy declutter that
also folds in the decimation band, and the shader just compares
`u_zoom >= a_reveal_zoom`. Two choices make the visible set **monotone in zoom**
(a label that appeared can never vanish on zooming further in): the decimation
moduli are the nested chain `4 -> 2 -> 1`, each admitted set a subset of the
next, and the reveal ladder re-seeds already-revealed winners at every step so a
finer-tier label cannot evict a coarser one. `labelTessellate.ts` stamps the
quads; `labelController.ts` scopes the build to a padded viewport, emits a slack
window above the build zoom so a modest zoom-in needs no rebuild at all, and
defers the first build until the font promise resolves.

## Hit-testing

MapLibre returns nothing from a custom layer, so `queryRenderedFeatures` is not
available for survey geometry at all. `SurveyLayer.hitCandidateSections` replaces
it:

1. pad the probe point or box by the type's hit reach (`surveyLayer/hitProbe.ts`;
   shot and station reaches differ, and the padding preserves the historical
   tolerance exactly);
2. ask `surveyLayer/geometryIndex.ts::sectionsIntersectingBox` for sections
   whose projected world-space AABB overlaps that box - a deliberate superset;
3. trim to the exact pick with `nearestStation` / `nearestShot` /
   `stationsInBox`, using true endpoints rather than tile-clipped geometry.

The index caches its projected AABBs against a camera snapshot
(`SurveyLayer.cameraSnapshot`), so a static hover reprojects the sections once per
camera, not once per probe. That snapshot key keeps the map center at full
precision on purpose: quantizing it let features near the tolerance boundary drop
out of hover until the camera moved far enough. Candidate discovery is gated by
the **user** visibility flags, not by layer visibility - the renderer hiding
things must never make the survey non-interactive, but a user "hide stations"
toggle must.

## When it fails

There is nothing behind these layers, so failure has to be surfaced rather than
absorbed. Three paths reach it:

- **`onAdd`**: no WebGL2 context (`webgl2-unavailable`) or a program that will
  not link (`program-link-failed`). The controller sees `isDisabled()` right
  after `addLayer`, removes the dead layer, and latches fatal.
- **Mid-render**: each layer calls `gl.getError()` after its draws for the first
  5 frames only (a `getError` is a pipeline stall, and WebKitGTK can drop a
  layer silently), self-disabling with a `gl-error-0x<code>` reason. This fires
  inside MapLibre's render pass, so the teardown is deferred off the render
  stack before touching the style.
- **Labels only**: the bundled font failing to load, or a webview without
  `FontFace`/canvas, emits `label-font-unavailable`. No inert atlas is built -
  that would enable a layer drawing zero glyphs.

All converge on `SurveyLayer.handleRenderFatal`, which logs ungated and calls
`onRenderFatal`; `MapCanvas` turns that into a toast whose wording comes from
`surveyLayer/mapErrors.ts::renderFatalMessage` - specific per subsystem, so a font
failure does not claim the GPU is gone. A fatal controller is dead for the
session: every later `sync()` bails, so the area stays blank rather than
flip-flopping through an enable that would fail again. The **drag ghost is the one
exception**: if its custom layer cannot start or dies mid-drag,
`dragGhostController.ts` spins up the historical GeoJSON preview at the live
offset, so a drag is never left without a preview.

## Debug and dev hooks

Turn on **Display > Dev stats** for `MapDevStats`, which wraps `drawArrays` /
`drawElements` on the context to count draw calls and triangles per frame - the
only view of custom-layer cost, since MapLibre's own instrumentation cannot see
inside one. Both controllers register a runtime re-sync on `window`:
`__stalagmightSyncCustomRender` and `__stalagmightSyncCustomLabels` (names in
`gate.ts` / `labelsGate.ts`). Both rebuild from **current store geometry** via
`SurveyLayer.resyncCustomRenderFromStore`, not from the controller's cached
snapshot, so calling one after a project switch converges on the loaded project.
Drive them through the agent console bridge in
[`debug-gates.md`](debug-gates.md), which also covers the config-gated
hit-detection log.

Lifecycle logs (`[customRender] enabled`, `first frame drawn OK`, the failure
warnings) are ungated `console.info` / `console.warn` on purpose - they must be
diagnosable in a production build; per-build timing goes through `debugLog`, so
it is dev-only. For E2E, `src/dev/mapE2eHooks.ts` exposes
`__stalagmight_geometry__`, `__stalagmight_measured__`, and
`__stalagmight_drag_ghost__`, reading the same authoritative state the renderer
draws from - a spec reaching for `queryRenderedFeatures` on survey geometry is
querying something that no longer exists.

## Relationship to `performance.md`

The frontend section of [`performance.md`](performance.md) predates this renderer.
Two of its patterns are **superseded** for survey geometry: `queryRenderedFeatures`
for spatial queries (now the geometry index above) and `setFeatureState` for
visual updates (now per-vertex flag attributes plus re-upload). The rest still
hold: zero-duration paint transitions on the surviving stock overlay layers,
rAF-batching of pointer moves, and updating `SurveyLayer` directly while deferring
the Zustand write.

## Where to look when X breaks

| Symptom | Start here |
|---|---|
| Survey blank, console shows a `[customRender]` warn | `controller.ts` enable / `handleSelfDisable`, then `mapErrors.ts` for what the user saw |
| Geometry visibly jitters or snaps at high zoom | `mercator.ts` (anchor drift, float32 positions) |
| Geometry drawn far off-screen with no GL error | the `mainMatrix` vs `modelViewProjectionMatrix` note in `surveyCustomLayer.render` |
| Edit does not repaint, or repaints stale | the three-tier gate in `controller.sync` plus `incremental.ts` |
| Wrong color in one mode only | `colorResolvers.ts` precedence, then `displayColor.ts`; for a one-byte overlay drift, `overlayColor.ts` (floor vs round) |
| Hover / selection emphasis stuck or missing | `controller.refreshHighlight` and the highlight flag in `tessellate.ts` |
| Originals still visible under a drag preview | `controller.setDragHide` and `CustomRenderExclusion` |
| Click or hover misses a feature | `hitProbe.ts` padding, then `geometryIndex.sectionsIntersectingBox`, then the camera snapshot key |
| Labels missing entirely | font readiness in `labelController` (the `label-font-unavailable` path) |
| Labels vanish or flash while zooming | `labelReveal.ts` / `labelDecimation.ts` |
| Label text or placement wrong | `labelLayout.ts` (shaping, em offsets), `labelStyle.ts` (per-kind style) |
| Sizes wrong after dragging the window to another monitor | the DPR watcher in `SurveyLayer` - device-pixel sizes are baked into the buffers |
| Global View wrong but the survey map fine | `GlobalView/customRender/` - a separate implementation |

Tests live in `surveyLayer/customRender/__tests__/` and `surveyLayer/__tests__/`.
Almost every module here is deliberately pure - no GL, no DOM - so tessellation,
color packing, incremental planning, label layout, and the reveal math are all
testable in the `node` vitest environment.
