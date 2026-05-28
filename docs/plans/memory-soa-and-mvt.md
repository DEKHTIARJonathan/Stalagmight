# Plan: Struct-of-Arrays projectStore + Custom MVT protocol for MapLibre

## Goal

Drive the WebProcess footprint for a 75 k-shot survey from the current
**5.5 GB peak / 2.18 GB residue** down to **~1.2 GB peak / ~500 MB residue**
without touching MapLibre's rendering code.

Two pieces, sequenced so the first makes the second cheaper.

## Background — what's left to attack

After the existing optimizations (Tier 1 + binary IPC + lazy labels +
features-worker offload + worker-terminate-on-close), the dominant
remaining holders, measured against a fresh 92.stalx load:

| Holder | Approx memory while loaded |
|---|---|
| `projectStore.project.sections[].shots[]` — 75 k `Shot` JS objects with 16 named fields, JSC IsoHeap committing slabs per class | ~600-800 MB |
| `projectStore.stations[]` — 89 k `Station` objects (3-field coordinates, nested refs, optional GPS) | ~400-500 MB |
| MapLibre source data for shots + stations (75 k LineString features + 89 k Point features, plus the worker structured-clone) | ~240 MB (main + worker copy) |
| Misc fragmentation overhead carried across class slabs | ~600-800 MB |
| WebKit baseline + JIT + shared libs | ~300 MB |
| **Total** | **~5.5 GB** |

The first two rows are the leverage. They're large not because the
underlying data is large (~50 MB of pure numeric data) but because each
`Shot` and `Station` is a separate JS object with named fields, and JSC's
IsoHeap commits per-class slabs that don't decommit on a `close`. The MapLibre
sources are smaller but easier to eliminate because MapLibre already supports
the right plugin surface.

## Architecture

### After the refactor

```
   ┌──────────────────────────────────────────────────────────────┐
   │  projectStore                                                 │
   │                                                               │
   │    surveyData: SurveyData {                                   │
   │       sections:   SectionMetadata[]      // 14 k small objs   │
   │       shotIds, shotSectionIds: Uint32Array                    │
   │       shotAzimuthIn/Out, shotLength, shotDepthIn/Out,         │
   │       shotPitchIn/Out, shotLeft/Right/Up/Down: Float32Array  │
   │       shotFlags: Uint8Array  (is_reference + present bits)    │
   │       shotMarkerIndex: Int32Array (-1 = null)                 │
   │       shotComments: Map<number, string>  (sparse)             │
   │                                                               │
   │       stationSectionIds, stationIndices: Uint32Array          │
   │       stationCoords: Float64Array  (x,y,z stride 3)           │
   │       stationFlags, stationGps, stationMerges, stationClosures│
   │       stationComments                                         │
   │                                                               │
   │       loopClosures, zeroDatums, … (small, keep as objects)    │
   │    }                                                          │
   │                                                               │
   │    spatialIndex: flatbush  (built lazily over shot midpoints) │
   └──────────────────┬───────────────────────────────────────────┘
                      │
        ┌─────────────┼─────────────────────────────────┐
        │             │                                  │
        ▼             ▼                                  ▼
  ┌──────────┐  ┌──────────────┐                ┌──────────────────────┐
  │DataTable │  │ DetailPanel  │                │  SurveyLayer         │
  │SectionsP.│  │              │                │  (MapCanvas's layer) │
  └────┬─────┘  └──────┬───────┘                └──────────┬───────────┘
       │ Lazy Shot                                          │
       │ views                                              │ Custom MVT
       │ (one per visible row)                              │ protocol
       ▼                                                    ▼
  Shot proxy reads from typed arrays           survey://shots/{z}/{x}/{y}
                                               survey://stations/{z}/{x}/{y}
                                                         │
                                                         ▼
                                     MVT generator queries flatbush
                                     index for visible features
                                     and emits protobuf bytes
                                                         │
                                                         ▼
                                     MapLibre's vector-tile worker
                                     parses MVT, tessellates,
                                     uploads to GPU (unchanged)
```

### Compatibility shim

To keep the migration mechanical and reviewable, the old `Shot` /
`Station` shape stays available as a *view* projected on demand:

```ts
export function getShot(data: SurveyData, globalIndex: number): Shot {
  return {
    id: data.shotIds[globalIndex],
    azimuth_in: data.shotAzimuthIn[globalIndex],
    azimuth_out: data.shotAzimuthOut[globalIndex],
    length: data.shotLength[globalIndex],
    depth_in: data.shotDepthIn[globalIndex],
    depth_out: data.shotDepthOut[globalIndex],
    pitch_in:  nanToNull(data.shotPitchIn[globalIndex]),
    /* ... */
    comment: data.shotComments.get(globalIndex) ?? null,
    is_reference: (data.shotFlags[globalIndex] & 1) !== 0,
    marker_index: data.shotMarkerIndex[globalIndex] === -1 ? null : data.shotMarkerIndex[globalIndex],
    temperature: nanToNull(data.shotTemperature[globalIndex]),
  };
}
```

Consumers that currently iterate `section.shots` rewrite to iterate by
index range from `sectionShotOffsets` / `sectionShotCounts`. Consumers
that need a single editable `Shot` (DetailPanel, edit dialogs) call
`getShot()` to materialize only that one. Total `Shot` objects in flight
at any moment: < 200.

## Feature A — Struct-of-Arrays projectStore

### Why

Each shot/station object has 5+ named fields. JSC's IsoHeap allocates a
separate slab per object class, and once a class has had 75 k instances
created the slab stays committed for the session. By replacing the
75 k+89 k JS objects with ~6 typed arrays plus a small `Map` for sparse
fields, we shift the data into one allocation per array — typed arrays
live in a single bmalloc large-block, are *transferable* between threads,
and never trip the per-class slab logic.

Expected memory drop on 92.stalx peak: **~1.2 GB** (the inflated cost of
the two object arrays plus the worker copy).

Expected memory drop on residue: **~500 MB** (the slabs that previously
stayed committed disappear because they were never created).

### Files to change

**New**
- `src/types/survey-data.ts` — `SurveyData` interface and `getShot()` /
  `getStation()` view helpers.

**Rewrite of the IPC ingest**
- `src/utils/loadProjectBinary.ts` — instead of materializing
  `Section[]` / `Shot[]` / `Station[]`, build the `SurveyData` directly.
  Most of the work is already typed-array based on the wire format;
  this just drops the intermediate object materialization.

**Store**
- `src/store/projectStore.ts` — replace `project.sections` (the part
  with the shots) + `stations` with `surveyData`. Keep the small
  project metadata (`name`, `zero_datums`, `loop_closures`,
  `station_merges`, etc.) as objects.

**Renderer**
- `src/components/Map/surveyLayer/features.ts` — rewrite
  `buildSurveyFeatures()` to iterate the SoA rather than sections /
  shots. (When Feature B lands, this file disappears entirely for
  shots/stations.)
- `src/components/Map/SurveyLayer.tsx` — pass SoA to the worker /
  build path.
- `src/components/Map/surveyLayer/featuresWorker.ts` — accept SoA;
  worker iterates typed arrays directly.

**UI consumers** (mechanical sed-style change but needs care)
- `src/components/SingleSystemView/DataTable.tsx` — virtualized rows
  already, just swap `section.shots[i]` for `getShot(surveyData, ...)`.
- `src/components/SingleSystemView/DetailPanel.tsx` — single shot view.
- `src/components/SingleSystemView/SectionsPanel.tsx` — section list +
  shot counts (already SoA-friendly via metadata).
- `src/components/Map/CommentOverlay.tsx`
- `src/components/Map/MapCanvas.tsx` (`depthRange` useMemo, drag/move
  paths)
- Any place that iterates `project.sections[*].shots` — grep
  `\.shots\[`

**Editing path**
- IPC commands stay the same (`update_shot`, `create_shot`, etc.). On
  success today we re-fetch the whole project. With SoA we can either:
  - Keep full re-fetch — simpler, the IPC payload is already small with
    binary; with SoA, re-fetch is faster too.
  - Add `apply_shot_update_to_surveydata(updates)` for in-place edits —
    nicer UX (no flash) but bigger surface.
  Start with full re-fetch; optimize later if needed.

### Risk

- Easy to miss a `.shots[` site. Mitigation: keep both shapes in store
  during migration with a debug assertion that fires if any consumer
  reads the deprecated shape. Strip the old shape only after one
  release.
- TS type story: `Shot` becomes "type generated by `getShot()`" rather
  than "type stored in store". Rename internally to `ShotView` to make
  the lifetime clearer; `Shot` stays as the IPC type.

### Effort

~1 week, broken into:
1. Day 1 — define `SurveyData`, add `getShot()`/`getStation()`, write
   converters from current shape. Tests for view round-trip.
2. Day 2 — switch `loadProjectFullBinary` to produce SoA. Keep the
   convert-back path so the rest of the app still works.
3. Day 3-4 — migrate `buildSurveyFeatures` + SurveyLayer + worker.
4. Day 5 — migrate UI consumers (table, panels, overlays).
5. Day 6 — remove the convert-back path; verify against e2e + Playwright.

### Tests

- New: `src/types/__tests__/survey-data.test.ts` — round-trip equality
  between `Shot[]` form and `SurveyData` form for a synthetic project.
- New: `src/utils/__tests__/loadProjectBinary.soa.test.ts` — binary IPC
  produces correct SoA.
- Update: `buildSurveyFeatures` tests if any (currently sparse, will
  need new ones for the SoA reader).
- Playwright: opening a project and seeing 100% of shots in
  `data-testid` table cells must keep working.

### Expected after Feature A

Peak with 92.stalx: ~5.5 GB → **~2.5 GB**
Residue post-close: ~2.18 GB → **~700 MB**

## Feature B — Custom MVT protocol for shots + stations

### Why

After Feature A, the largest remaining MapLibre-side cost is the ~120 MB
of `Feature` objects we hand to `setData()`, plus another ~120 MB the
worker structured-clones. Replacing that with a custom protocol that
emits MVT bytes per tile eliminates both copies — the wire to the worker
is just the tile bytes, and the worker tessellates them into the same
buckets `GeoJSONWorkerSource` would have.

This requires Feature A to be valuable enough to do — without SoA we'd
have to walk Section[].shots[] in the tile handler, which is slow and
defeats the point.

### How MapLibre's plugin API works for this

```ts
maplibregl.addProtocol('survey', async (params, abortController) => {
  // params.url = 'survey://shots/12/123/456'
  const { kind, z, x, y } = parseUrl(params.url);
  const surveyData = useProjectStore.getState().surveyData;
  if (!surveyData) return { data: new Uint8Array(0) };

  const bounds = tileBounds(z, x, y);  // [minLng, minLat, maxLng, maxLat]
  // flatbush query over shot midpoints; returns shot indices
  const visibleIndices = surveyData.spatialIndex.search(...bounds);

  const mvt = encodeMvtTile({
    z, x, y,
    layers: {
      [kind]: kind === 'shots'
        ? buildShotMvtLayer(surveyData, visibleIndices)
        : buildStationMvtLayer(surveyData, visibleIndices),
    },
  });
  return { data: mvt };
});

map.addSource('survey-shots', {
  type: 'vector',
  tiles: ['survey://shots/{z}/{x}/{y}'],
  minzoom: 0, maxzoom: 22,
});
```

MapLibre's existing line/circle layers consume vector tiles the same way
they consume GeoJSON-vt's output, so the paint expressions, hover
feature-state, click resolution, and label collision logic all keep
working with no SurveyLayer changes beyond the source declarations.

### Pieces to build

**Spatial index**
- `flatbush` (8 KB, mature, zero-dep). Build once per project load
  with shot midpoints (or for stations, the station coords). Lives in
  `surveyData.spatialIndex`. Rebuild on any mutation. Memory: 64 bytes
  per point + a small header → 4.8 MB for 75 k shots, 5.7 MB for 89 k
  stations. Total ~10 MB.

**MVT encoder**
- `@mapbox/vt-pbf` (or hand-rolled with `pbf`). Encodes a single tile's
  layers into protobuf bytes. ~150 lines of glue around it.
- Coordinates need conversion to tile-local fixed-point (MVT uses an
  extent, typically 4096 per tile edge).

**Tile slicing**
- For each visible shot, determine which tiles it lives in. A long
  shot spanning multiple tiles requires the geometry to be clipped per
  tile. MVT spec supports unclipped lines (consumer clips at render);
  MapLibre handles this correctly. Simplest impl: emit each line in
  every tile it intersects, full coordinates; MapLibre clips.

**Protocol handler**
- `src/components/Map/surveyLayer/surveyTileProtocol.ts` — registers
  with `maplibregl.addProtocol('survey', handler)`. Disposes the
  spatial index when surveyData becomes `null`.

**Hover / click**
- MapLibre needs a feature ID to map clicks back to a domain object.
  We assign synthetic IDs: shot ID = `sectionId * 100000 + shotId`,
  station ID = `sectionId * 100000 + stationIndex`. The existing
  feature-state machinery (`map.setFeatureState({source, id}, …)`)
  works directly.

**Layer config**
- `SurveyLayer.initialize…()` swaps the `survey-shots` and
  `survey-stations` source declarations from `geojson` to `vector` with
  the `tiles` URL. Paint properties stay; only `'source-layer': 'shots'`
  / `'source-layer': 'stations'` gets added.

### Files

**New**
- `src/components/Map/surveyLayer/surveyTileProtocol.ts` — protocol
  handler + registration helper.
- `src/components/Map/surveyLayer/mvtEncoder.ts` — typed-array → MVT
  conversion.
- `src/components/Map/surveyLayer/spatialIndex.ts` — flatbush wrappers.

**Changed**
- `src/components/Map/SurveyLayer.tsx` — source defs for shots /
  stations switch to vector type; per-tile data flows through the
  protocol instead of `setData()`.
- `src/components/Map/surveyLayer/features.ts` — keeps building
  labels + section labels + loop closures + ghost features (those stay
  GeoJSON because they're small or zoom-gated already).
- `src/components/Map/MapCanvas.tsx` — register/unregister the protocol
  on mount/unmount.

### Risk

- **Tile boundary geometry**: a long shot crossing tile borders needs
  to be emitted in both tiles. We can either clip in the encoder or
  rely on MapLibre to clip at render time. Tested approach: emit the
  full line in every tile it intersects, let MapLibre clip — wastes a
  tiny amount of GPU vertex bandwidth but keeps the encoder simple.
- **Hover/click ID space**: synthetic ID has to fit in u32. Project
  with > 42 949 sections or > 100 000 shots per section would overflow.
  We're nowhere near that today; add an assertion.
- **Picking precision at low zoom**: very short shots may collapse to
  sub-pixel at low zoom and never get hit-tested. Mitigated by
  MapLibre's hover radius config; should work the same as today.
- **Tile cache invalidation on edit**: when a shot moves, we need
  MapLibre to re-fetch affected tiles. MapLibre exposes
  `map.getSource('survey-shots').reload()` and tile-specific eviction;
  we'd just reload after each commit. Cheap because most tiles return
  empty.

### Effort

~5-7 days, broken into:
1. Day 1 — flatbush wrappers + tests.
2. Day 2 — MVT encoder for line + point layers. Unit tests against a
   known small fixture.
3. Day 3 — protocol handler + tile bounds math.
4. Day 4 — switch `SurveyLayer` source defs; verify paint expressions
   render the same.
5. Day 5 — hover/click + feature-state mapping.
6. Day 6 — edit-path tile invalidation; performance verification.
7. Day 7 — Playwright + manual QA on small + large projects.

### Expected after Feature B

Peak with 92.stalx: ~2.5 GB → **~1.2 GB**
Residue post-close: ~700 MB → **~400-500 MB**

## Sequencing & combined outcome

| Phase | Description | Peak (75k) | Residue | Cumulative effort |
|---|---|---|---|---|
| baseline (today) | post-T1/T2/T3 + worker-terminate | 5.5 GB | 2.18 GB | — |
| **A** | SoA projectStore (shots) | ~3.5 GB | ~1.4 GB | 4-5 days |
| **A** | + SoA projectStore (stations) | ~2.5 GB | ~700 MB | 6-7 days |
| **B** | Custom MVT protocol for shots+stations | **~1.2 GB** | **~400-500 MB** | +5-7 days |

Total: **~2-3 weeks of focused work** to drop peak memory by ~4 GB and
residue by ~1.7 GB.

Sequencing rationale:

- **A before B**. Without SoA, the MVT protocol handler would have to
  walk the existing object tree per tile request, which is both slow
  (string-key field accesses on 75 k objects) and defeats the memory
  point. With SoA, the tile handler does a flatbush query + typed-array
  slicing, microseconds per tile.
- **Shots SoA before stations SoA**. Same pattern; shots are slightly
  more complex (16 fields incl. nullables) so we de-risk on shots
  first and the station migration becomes a quick repeat.
- **B last because compounding**. Feature B is only valuable on top of
  A; doing it earlier means the wins overlap with code we'd then have
  to migrate anyway.

## Safety / rollback

Each phase is built behind a config flag:

```ts
// src/types/config.ts
debug: {
  use_soa_projectstore: true,    // gate Feature A
  use_mvt_survey_tiles: true,    // gate Feature B (requires use_soa)
  ...
}
```

The pre-refactor code path stays in place, behind `if (!use_soa)`, for
two weeks of release cycles. If a regression shows up we flip the
flag in `config.toml` and have time to fix. Once stable, the flags and
the pre-refactor code path get removed in a follow-up cleanup PR.

## What we explicitly are NOT doing

- **Forking maplibre-gl**. The `addProtocol` API + custom vector source
  gives us everything we need without vendoring. We stay on the normal
  release track.
- **Writing custom WebGL**. The line/circle shaders, depth-gradient
  expressions, label collision, hover styling all keep working unchanged
  because we feed MVT tiles into MapLibre's existing bucket pipeline.
- **Replacing the editable Project tree in Rust**. The Rust side stays
  exactly as-is — the SoA-ness is purely a frontend representation
  choice. The IPC payload (already binary post-T2) shrinks slightly
  because the JS side no longer needs `Section.shots[]` arrays to be
  materialized post-decode.

## Open questions for later

- Should the spatial index live in the projectStore or in the SurveyLayer?
  Argument for store: shared with hover-lookups in DataTable / non-map
  consumers. Argument for layer: only needed for tile generation.
  Default: store, with a getter.
- Edit path: on a shot move, do we just call
  `map.getSource('survey-shots').reload()` (clears all tiles) or do we
  bound-query the affected tiles and reload only those? Start with the
  blunt reload; optimize if it shows up in profiles.
- We may want to also push label features through MVT. Currently
  labels are zoom-gated to >= 14 (T3a), so the materialization cost
  is small in practice. Defer.
