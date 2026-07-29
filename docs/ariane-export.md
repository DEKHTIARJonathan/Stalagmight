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
rendered as a sidecar so the server can regenerate GeoJSON, and the UUID gives
each feature a stable top-level `id`. `Project::ensure_shot_uuids` settles the
UUIDs before every save and before that render, so nothing is minted per-export
(a project loaded but never saved is the one case where a UUID is minted on the
fly, and it is persisted by the next save).

The importer does **not** read the element back: a fresh import mints its own
shot identities, so `<UUID>` is write-only as far as Stalagmight is concerned.
It exists for the SpeleoDB render and for any consumer that wants a stable
per-shot key. Ariane 26+ round-trips it; Ariane 25 and older drop it silently,
which is harmless here.

## Topology

Ariane represents survey data as a directed graph rooted at a single START shot.

### Single START shot

Only the **root section** (the first section, or the one with no parent) gets a synthesized START shot with `FromID = -1`. All other sections connect to their parent via `FromID` on their first real/reference shot.

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

- Station 0 of the root section (the START shot's station) has no shot whose
  `to` station matches, so its comment is dropped from the `.tml` export. Add
  the note one shot downstream if you need it to survive.
- When a child section's station 0 is merged into a parent's station, both
  StationRefs alias the same Ariane shot id, so both station comments are
  concatenated into the exported Comment (sorted by `(section_id,
  station_index)` for reproducibility).

START shots keep their hardcoded `"START"` content untouched (no
station-comment fold), and CLOSURE shots have no `to` station in the
create-station sense.

The same split logic is applied in reverse on `.tml` import
(`core::comment_split::split`) when the import dialog's "comments on
stations" option is on (the default). Text typed in Ariane carries no marker
and therefore routes to the **station** on import - matching how Ariane
visually centers Comment text on the station, not along the shot. A bare
Ariane file has no markers at all, so every Comment line routes to the
station.

## Implementation

| Component | File | Role |
|-----------|------|------|
| Export logic | `src-tauri/src/export/tml.rs` | XML generation, ZIP packaging, topology resolution |
| Export command | `src-tauri/src/commands/export.rs` | `export_tml` IPC handler |
| Store method | `src/store/projectStore.ts` | `exportTml()` frontend binding |
| Export dialog | `src/components/Dialogs/ExportDialog.tsx` | UI with TML format option |

## Limitations

- Shape/cross-section geometry (`Shape`/`SH` elements) is not exported (not stored in the internal model)
- GPS coordinates are not written per-shot (only the project-level elevation reference is set)
- Latitude and longitude are written as `0.0` on every shot
