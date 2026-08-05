# Where entrance elevation lives (#431)

Status: proposal, awaiting maintainer decision. No code changed.

## Problem

Ariane's `firstStartAbsoluteElevation` is metres **above sea level, +up**. We have
no field for it. Import parses it and drops it; export invents one out of a field
that means something else.

## What the code actually does

| Fact | Evidence |
|---|---|
| `depth_reference` is documented as metres BELOW surface (+down) | `src-tauri/src/models/station.rs:148` `/// Depth reference (meters below surface)` |
| It is the datum STATION's own depth, set from its z, round-tripped as z | `src/components/Dialogs/EditStationDialog.tsx:113`; `src/utils/coordinates.ts:174` `z: gps.depth_reference` |
| It is deliberately excluded from geodesy | `src-tauri/src/models/geo.rs:88` `// Always use alt=0 - depth_reference is not ellipsoid height` |
| Export writes it as the elevation anyway | `src-tauri/src/export/tml.rs:310` `.map(\|zd\| zd.gps.depth_reference)` |
| Import parses the elevation and carries it | `parsers/tml.rs:347-349`, `:1131`, `:1145` |
| ...and nothing consumes it | `parsers/tml.rs:1642` `_geo_coding: Option<&TmlGeoCoding>`; the datum is built with `depth_reference: 0.0` at `parsers/tml.rs:1655` and `:1699`. No frontend file references `geo_coding` outside the generated `src/types/ipc/TmlFile.ts:7`. |

So `depth_reference` has exactly one non-test consumer outside persistence and the
edit dialog: the export at `export/tml.rs:310`. That export is wrong twice - wrong
sign frame, and wrong quantity. A datum set on a station 35 m down writes
`firstStartAbsoluteElevation = 35`, i.e. "35 m above sea level"
(the 35 m datum shape is exercised at `src-tauri/src/core/state/tests.rs:6453`).

## Where the issue text does not match the tree

1. **PR #432 is not merged.** `git branch --contains 4fbff799` lists only `fix/411-*`;
   master's `parsers/tml.rs:347-349` parses the raw text with no ft->m pass, so an
   Imperial file's elevation is carried in **feet**.
2. **`docs/ariane-export.md:29` documents a field that does not exist**: "First zero
   datum GPS altitude". There is no altitude on `GpsCoordinates`
   (`models/station.rs:145-150`). The doc needs correcting either way.

## Constraints

- `.stalx` is at `SCHEMA_VERSION = 16` (`src-tauri/src/persistence/sqlite.rs:74`).
  `zero_datums` has no elevation column (`persistence/sqlite/schema.rs:1325-1334`);
  reads and writes both use explicit column lists (`read.rs:493`, `write.rs:172`).
- Two additive-DDL precedents exist: the idempotent conditional ALTER
  (`schema.rs:428-441`, shots.uuid) and whole-table CREATE IF NOT EXISTS
  (`schema.rs:299-318`). Bumping `SCHEMA_VERSION` is one-way: `schema.rs:1136`
  refuses a file whose version exceeds the build's.
- A project-level scalar has a ready home: `project_settings` key/value
  (`schema.rs:46-51`), already used for `validation` (`write.rs:320`, `read.rs:1150`).
- The datum travels as a bare `GpsCoordinates` through both mutation carriers:
  `Command::SetZeroDatum { coordinates: GpsCoordinates }` (`src-tauri/src/core/command.rs:147`)
  and `UndoData::ZeroDatumInfo { previous_gps: Option<GpsCoordinates> }`
  (`src-tauri/src/core/undo.rs:250`). Undo payloads are persisted.
- The v12 sign-convention migration (`docs/inclination.md:72-113`) is **not** the
  pattern here. That one reinterpreted an existing stored number and had to infer
  provenance per section. Nothing is being reinterpreted: old `depth_reference`
  values are depths and stay depths. This is a pure addition.

## Candidates

### A. `GpsCoordinates.surface_elevation: Option<f64>` (+up, m MSL)

Rides every existing carrier for free: `SetZeroDatum`, `ZeroDatumInfo`,
`ImportPlacement::ZeroDatum`, `ZeroDatumWire` (`models/station.rs:384-387`). One
nullable column on `zero_datums`. `#[serde(default)]` keeps old `.stalx` blobs and
old persisted undo payloads readable; `Option<f64>` keeps the struct `Copy`.

Cost: a second non-coordinate field on a type `geo.rs:88` already has to defend
itself against, meaningless for the uses of `GpsCoordinates` that are not datums.
About six non-test literal sites plus fixtures must add it - a compile error at
each, which is the desirable failure mode.

### B. `ZeroDatum.surface_elevation: Option<f64>`

Semantically the right owner - it is a property of the surveyed entrance, not of a
lat/lon pair, and it leaves `GpsCoordinates` clean.

Cost, and it is the deciding one: `command.rs:147` and `undo.rs:250` both carry
`GpsCoordinates`, not `ZeroDatum`. B needs a parallel field beside
`previous_gps: Option<GpsCoordinates>`, i.e. a second optional that can disagree
with the first, restored atomically by undo. That is a new invariant with no
enforcement. A cannot desynchronise, by construction.

### C. Project-level scalar in `project_settings`

Cheapest: no DDL, no IPC churn, no undo shape change. But one number per project
cannot say which entrance it belongs to, and the model is explicitly multi-entrance:
export picks `zero_datums.first()` as the graph root (`export/tml.rs:307-311`,
`:578-583`) and writes one START per entrance (`docs/ariane-export.md:108`). Moving
C -> A later needs a migration; A degrades to C for free by reading the first datum.

## Recommendation: A, in one change with the export fix

1. Add `surface_elevation: Option<f64>` to `GpsCoordinates` (`models/station.rs:145`),
   documented as "+up, metres above mean sea level; `None` = unknown". Validate
   finiteness alongside the existing checks (`models/station.rs:167-186`).
2. `export/tml.rs:303-313` reads `zero_datums.first().and_then(|zd| zd.gps.surface_elevation).unwrap_or(0.0)`.
   The `depth_reference` read is deleted. 0.0 is already the documented no-data
   value (`docs/ariane-export.md:29`).
3. `parsers/tml.rs:1636-1706` sets it from `TmlFile.first_start_absolute_elevation`
   on both `ZeroDatum` placements, replacing the `_geo_coding` parameter's
   underscore with a real read.
4. Fix `docs/ariane-export.md:29` and extend the `geo.rs:88` comment to name both
   fields the conversion ignores.

Do not touch `depth_reference`. It keeps its meaning and its one honest consumer
(the edit dialog's z round-trip).

## Migration and compatibility

- **`.stalx`**: `ALTER TABLE zero_datums ADD COLUMN surface_elevation REAL` behind
  a `pragma_table_info` guard, mirroring `schema.rs:428-441`. **No `SCHEMA_VERSION`
  bump**: the column is nullable and additive, both statements name their columns
  explicitly, and a bump would make every new file unopenable by an older build
  (`schema.rs:1136`) for no invariant gained. The accepted cost of not bumping: an
  older build that saves the file drops the elevation silently, because its INSERT
  (`write.rs:172`) does not name the column. That is the correct trade for a
  round-trip-only value.
- **Undo**: `Option<f64>` with `#[serde(default)]` deserialises from every
  persisted payload written before the change; `UNDO_FORMAT_SAFE_VERSION`
  (`persistence/sqlite.rs:87`) needs no change.
- **IPC**: `GpsCoordinates.ts` regenerates (`pnpm gen:ipc-types`); mark the field
  `#[ts(optional)]` so existing TS literals (`src/utils/gps.ts:147,298,378`) still
  compile.
- **SpeleoDB sidecar**: nothing to do. The hardening list
  (`docs/ariane-export.md:229-237`) has no elevation rule and the sidecar shares
  `build_xml`, so it picks the fix up automatically.
- **Ordering**: land #432's ft->m conversion first, or an Imperial import stores
  feet in a metres field.

## UI and map: nothing, deliberately

No renderer or geometry path reads `depth_reference` today and none should read
elevation: `gps_to_local` must keep `alt=0` (`geo.rs:88-90`) or every station moves.
The value is import/export round-trip only. The honest risk: a persisted field with
no UI is unverifiable by the user and will rot. The one place to surface it later is
the datum block at `EditStationDialog.tsx:110-114` - a single optional numeric input,
no map change. Name that the completion criterion for #431 rather than shipping it here.

## Test strategy

Injection-first - each test names what turns it red.

1. **Round-trip, Rust** (`parsers/tml.rs` + `export/tml.rs` tests): synthetic
   `.tmlu` with `<firstStartAbsoluteElevation>123.5</firstStartAbsoluteElevation>`
   and a GPS-bearing first shot -> import -> export -> the element reads `123.5`.
   Red today (import drops it); red if the export reverts to `depth_reference`.
2. **The bug, pinned directly**: a datum with `depth_reference = 35.0` and
   `surface_elevation = None` exports `0.0`, not `35.0`. Red on today's
   `export/tml.rs:310`. This is the test that must exist even if A is rejected.
3. **Sign**: elevation `-5.0` (a sump below sea level) survives as `-5.0`, not `5.0`.
4. **Persistence** (`persistence/sqlite/tests.rs`): save/load preserves `Some(123.5)`
   and `None` distinctly; a hand-built pre-change `zero_datums` table (no column)
   loads as `None`, not an error.
5. **Undo**: set datum -> change elevation -> undo restores elevation together with
   lat/lon. Red if the field is ever split out of `GpsCoordinates` (B's failure mode).
6. **Units**: an Imperial `.tmlu` with elevation `328.084` imports as `100.0 +/- 1e-3`.
   Depends on #432; skip with a comment naming it if #432 has not landed.

No fixture files. Every case is synthetic XML built in-test.
