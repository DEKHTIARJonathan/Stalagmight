# Ariane TML/TMLU Export

Stalagmight can export cave survey data back to Ariane's TML and TMLU file formats, enabling round-trip interoperability with Ariane software.

## File Formats

| Extension | Structure | Element names | Description |
|-----------|-----------|---------------|-------------|
| `.tml` | ZIP archive containing `Data.xml` | Long (`SurveyData`, `Azimut`, `Length`, …) | Standard Ariane format |
| `.tmlu` | Plain XML | Short (`SRVD`, `AZ`, `LG`, …) | Uncompressed variant |

The user chooses between the two formats in the save dialog's file-type filter.

## Export Workflow

1. Open the **Export** dialog and select **Survey Data** → **TML (Ariane)**.
2. Click **Export** - the save dialog offers two filters: "TML (ZIP)" and "TMLU (XML)".
3. The file extension chosen by the user determines the output format.

## Data Mapping

### Project-level fields

| Internal field | TML element | Notes |
|----------------|-------------|-------|
| `project.name` | `caveName` | |
| Always `"m"` | `unit` | Export is always metric (internal model is metric) |
| `true` | `useMagneticAzimuth` | Default |
| First zero datum GPS altitude | `firstStartAbsoluteElevation` | 0.0 if no GPS data |

### Section-level fields

These are written per-shot since Ariane stores section metadata on every shot row:

| Internal field | TML element | Notes |
|----------------|-------------|-------|
| `section.name` | `Section` / `SC` | Falls back to `"Section {id}"` if unnamed |
| `section.surveyor` | `Explorer` / `EX` | `"unknown"` if unset |
| `section.date` | `Date` / `DT` | `"2000-01-01"` if unset |
| `section.color` (`#RRGGBB`) | `Color` / `CL` | Converted to Ariane format `0xRRGGBBff` |

### Shot-level fields

| Internal field | TML element | Notes |
|----------------|-------------|-------|
| Sequential integer | `ID` | Assigned starting from 0, incrementing across all sections |
| Previous shot ID | `FromID` / `FRID` | Chains shots linearly within a section; START has -1 |
| `shot.azimuth_in` | `Azimut` / `AZ` | Front-sight azimuth |
| `shot.azimuth_out` | - | Not exported. Ariane does not encode backsight azimuth. |
| `shot.length` | `Length` / `LG` | |
| `shot.depth_out` | `Depth` / `DP` | Absolute station depth |
| `shot.depth_in` | `DepthIn` / `DPI` | -1.0 sentinel when equal to previous `depth_out` |
| `shot.pitch_in` | `Inclination` / `INC` | 0.0 if unset |
| LRUD | `Left`/`Right`/`Up`/`Down` | 0.0 for `None` |
| `shot.comment` | `Comment` / `CM` | Empty string if unset. Also carries the **to-station's** `project.station_comments` entry, joined with the shot comment via the ZWSP marker - see [Station-comment co-encoding](#station-comment-co-encoding). |
| `shot.kind` | `Type` / `TY` | Both `Jump` and `Reference` export as `VIRTUAL`; `Normal` as `REAL`. Ariane has a single virtual category, so the #27 distinction is lossy on export by design (q9) and is preserved locally instead. |
| `shot.uuid` | `UUID` / `UU` | Emitted for every REAL/VIRTUAL forward shot; omitted on the synthesized shots (START, CLOSURE, reversed and pre-zero-datum legs), which have no 1:1 Stalagmight shot behind them. See [Shot UUIDs](#shot-uuids). |
| - | `Locked` / `LCK` | `false` for normal shots, `true` for START |
| - | `Name` / `NM` | `"START"` for START shot, empty otherwise |
| - | `Profiletype` / `PT` | Always `VERTICAL` |
| - | `Excluded` / `EXC` | Always `false` |

## Shot UUIDs

Every real forward shot carries its persistent `shot.uuid` into the export as
`<UUID>` (`<UU>` in `.tmlu`). This is what makes a re-export of an unchanged
project **byte-identical**, which the SpeleoDB push depends on: the `.tml` is
rendered as a sidecar so the server can regenerate GeoJSON.
`Project::ensure_shot_uuids` settles the UUIDs before every save and before that
render, so nothing is minted per-export (a project loaded but never saved is the
one case where a UUID is minted on the fly, and it is persisted by the next
save).

What the value guarantees is **stability across re-exports, not uniqueness
within the file**. Shot-UUID uniqueness in the model is **per-section only**, and
deliberately so: `Project::ensure_unique_shot_uuids` resets its dedup set inside
the section loop, and the companion `duplicate_shot_uuid` integrity check is
section-scoped for the same reason - `resolve_key` is section-local, so a
cross-section repeat cannot mis-resolve a station anchor and is not treated as a
violation. Nothing in the model, the integrity pass or the exporter therefore
makes `<UUID>` unique across the exported document.

The consequence for the SpeleoDB render is that a consumer keying features by
`<UUID>` alone - as a GeoJSON feature `id`, say - would alias the colliding shots
if such a repeat ever appeared, and neither the export nor our integrity pass
would flag it. No current edit path is known to mint a cross-section duplicate
(there is no section split/duplicate command, and the importer mints fresh
identities), so this is a documented property of the guarantee rather than a live
bug. What it means in practice: do not build a consumer that assumes
project-wide uniqueness, and do not describe `<UUID>` as one.

The importer does **not** read the element back: a fresh import mints its own
shot identities, so `<UUID>` is write-only as far as Stalagmight is concerned.

Ariane 26.3.0's own Save fills any row missing `<UUID>` with a fresh v4
(verified 2026-07-31), so the synthesized-shot gaps above do not survive a
round-trip through Ariane itself. Every consumer of the file *as we export
it* - SpeleoDB, the GeoJSON feature ids - still sees the omissions.
It exists for the SpeleoDB render and for any consumer that wants a stable
per-shot key. Ariane 26+ round-trips it; Ariane 25 and older drop it silently,
which is harmless here.

## Topology

Ariane represents survey data as a directed graph rooted at START shots - one
per entrance, matching what Ariane itself writes for multi-entrance caves.

### START shots - one per entrance

The **root section** and any section left parentless after link resolution (a
genuinely detached component) each get a synthesized START shot with
`FromID = -1`, anchored at the project coordinates (every START repeats them -
an unanchored START lands at lat/lon 0 and the view opens on the Atlantic).
All other sections connect to their parent via `FromID` on their first
real/reference shot.

A parentless shot whose type is **not** START is an orphan root. Ariane
tolerates it in isolation, but a file containing both an orphan root and any
CLOSURE row makes Ariane abandon the loop solve and draw a completely blank
map with a fully populated data table (#379). Two hard facts keep this
invariant on the exporter alone:

- **Ariane never repairs it.** Re-saving such a file in Ariane 26.3.0
  preserves every orphan root untouched (verified 2026-07-31, 17/17 on a
  pre-fix export), and every Ariane-authored file examined in the #379
  investigation typed all of its parentless roots START. Nothing downstream
  compensates.
- `ensure_rooted_chain` in `src-tauri/src/export/tml.rs` therefore refuses to
  write an orphan root alongside closures (user profile), and warns when a
  file carries orphans without closures.

### Section connectivity

Parent-child relationships are derived from `station_merges`. When section B's entry station merges with a station in section A, section B's first shot has its `FromID` set to the Ariane ID of the corresponding station in section A.

When a root section is split at a non-zero zero datum, the generated pre-zero segment is exported in reverse direction. Its azimuth is always synthesized as `azimuth_in + 180°` (normalized), not from `azimuth_out`.

### Loop closures

`loop_closures` are exported as CLOSURE-type shots with `ClosureToID` / `CID` pointing to the target station's Ariane ID. These encode the same loop-closure metadata that Ariane uses internally.

### ID assignment

IDs are assigned sequentially starting from 0:
- Root section: START (ID 0), then shots (ID 1, 2, …)
- Subsequent sections: shots continue the global counter
- CLOSURE shots are appended at the end

## Color Format Conversion

Internal `#RRGGBB` hex colors are converted to Ariane's `0xRRGGBBff` format (8-digit hex with alpha suffix). On import, the reverse conversion strips the alpha channel.

## Station-comment co-encoding

Ariane's `.tml` format has one `<Comment>` field per shot and no per-station
comment field, so a Stalagmight station comment otherwise has nowhere to live
in `.tml`. To round-trip both `shot.comment` and `project.station_comments`
through Ariane, the exporter packs both into the shot's `<Comment>`:

- Each station comment is attached to the shot whose **`to` station** matches
  it - the shot that "creates" that station, i.e. the one at `shot_index + 1`.
- Shot vs station lines inside the resulting Comment are distinguished by a
  zero-width-space (`U+200B`) prefix: lines prefixed with `ZWSP` are shot
  comments; lines without the prefix are station comments.
- The marker is invisible in any editor, including Ariane's, so a reader sees
  a single readable Comment block.

Caveats:

The fold walks the emitted REAL/VIRTUAL shots and skips START (its `"START"`
content is hardcoded) and CLOSURE (no `to` station in the create-station sense).
Every station whose Ariane id **is** the START shot's therefore loses its comment
on export. Three ways a station ends up there:

- **Root station 0.** In an unsplit root section, station 0 *is* the START shot,
  so a comment on it is dropped. Add the note one shot downstream if you need it
  to survive.
- **The primary zero datum's station.** When the root section is split at a
  non-zero zero datum, the datum's own station is aliased onto the synthesized
  START shot, so a comment on that station is dropped too - even though a real
  shot of the project sits at that index.
- **A station merged onto either of the above.** The parent-link pass maps a
  merged child station to the *parent's* Ariane id, so a child station merged
  into root station 0 (or into the aliased datum station) inherits the START id
  and is dropped with it.

Comments that survive but move:

- **Stations before the zero-datum split index.** Those stations are emitted on
  the reverse `"<Section> (pre-zero-datum)"` leg, so their comments are folded
  onto that synthetic leg's shots. The text survives, but it re-imports onto a
  *fabricated* section that never existed in the project - not onto the section
  the surveyor wrote it in.
- **Two StationRefs on one Ariane shot.** When a child section's station 0 is
  merged into a parent station that *is* a real shot, both refs alias that shot
  id, so both station comments are concatenated into its exported Comment
  (sorted by `(section_id, station_index)` for reproducibility).

A fourth, rarer drop: a station the Ariane topology does not represent at all
(nothing in the exporter's station-to-node map), which is what happens when the
shape of a merge leaves a station with no node of its own.

Every one of these drops emits a `tracing::debug!` naming the section id and
station index (plus the Ariane node id where there is one), so a lost comment is
diagnosable from a debug-level log rather than silent. Which comments get dropped
is deliberately unchanged - the logging exists so the loss is observable, not to
change the behaviour.

The same split logic is applied in reverse on `.tml` import
(`core::comment_split::split`) when the import dialog's "comments on
stations" option is on (the default). Text typed in Ariane carries no marker
and therefore routes to the **station** on import - matching how Ariane
visually centers Comment text on the station, not along the shot. A bare
Ariane file has no markers at all, so every Comment line routes to the
station.

## The SpeleoDB sidecar profile

Two things read our `.tml`: Ariane, and the `ariane.tml` sidecar SpeleoDB
converts to GeoJSON for its map preview (see [SpeleoDB dev testing](speleodb-dev-testing.md)).
The converter (`openspeleo_lib`) enforces rules Ariane never looks at, and when
one is broken it either fails the whole file or silently skips the map - the
upload still returns 200, so nothing surfaces to the user.

`export_tml` and `export_tml_for_speleodb` therefore build the same document
under different profiles. The **user** profile is what it has always been, down
to the byte. The **sidecar** profile additionally:

| Concession | Why |
|------------|-----|
| Rounds a repaired `Length` up to the next micrometre | The server re-derives `abs(Depth - parent.Depth) <= Length` from the DECIMAL STRINGS, and the six-decimal write can round a repaired tape back below the drop it was minted to cover |
| Never emits exactly one `<SurveyData>` (pads with a VIRTUAL root) | A lone element parses as a dict in the server's decoder and crashes the conversion; zero is handled cleanly, two or more is the normal path |
| Re-emits every `<Date>` as an ISO calendar date (`YYYY-MM-DD`), year clamped to `[1900, 2035]` | A missing, empty or non-ISO date fails the whole file; outside IGRF's range the declination silently becomes 0.0. Only `YYYY-MM-DD` is parsed - anything else, including a full ISO 8601 datetime, falls back to the placeholder and loses its real survey date |
| Emits `<UUID>` only for a v4 not already used in the file | The field is typed `UUID4`; a repeat aliases two shots onto one GeoJSON feature (shot UUIDs are unique per SECTION only) |
| Nudges a zero latitude or longitude by a micro-degree, and clamps out-of-range ones | Both components must exceed `1e-7` or the map is skipped, so a survey on the equator or the prime meridian gets none. No datum still means no anchor |
| Replaces U+220E in section and explorer names with a space | The server hashes the section-identity fields joined with that character |
| Normalises `Azimut` for every shot type | Only REAL shots are normalised server-side |

None of this touches the project: the transformations run on the export
representation, and only for the throwaway sidecar. Past 25,000 shots the
sidecar render warns that the server may fail to build the preview - nothing is
dropped or capped.

## Implementation

| Component | File | Role |
|-----------|------|------|
| Export logic | `src-tauri/src/export/tml.rs` | XML generation, ZIP packaging, topology resolution, the two profiles |
| Export command | `src-tauri/src/commands/export.rs` | `export_tml` IPC handler |
| SpeleoDB sidecar | `src-tauri/src/core/state/speleodb.rs` | `speleodb_render_tml` renders the co-push sidecar via `export_tml_for_speleodb` |
| Store method | `src/store/projectStore.ts` | `exportTml()` frontend binding |
| Export dialog | `src/components/Dialogs/ExportDialog.tsx` | UI with TML format option |

## Limitations

- Shape/cross-section geometry (`Shape`/`SH` elements) is not exported (not stored in the internal model)
- GPS coordinates are not written per-shot: latitude and longitude are `0.0`
  everywhere except the START shots, which repeat the primary datum's anchor
  (see Topology); without a primary datum they are `0.0` there too. Only the
  project-level elevation reference is otherwise set
