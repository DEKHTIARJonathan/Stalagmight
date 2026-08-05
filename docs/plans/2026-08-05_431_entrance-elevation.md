# Where entrance elevation lives (#431)

Status: proposal, awaiting maintainer decision. No code changed. Anchors verified
against `origin/master` @ `7b390768`.

## Problem

Ariane's `firstStartAbsoluteElevation` is metres **above sea level, +up**. We have
no field for it. Import parses and converts it, then drops it on the floor; export
invents one out of a field that means something else.

## What the code actually does

| Fact | Evidence |
|---|---|
| `depth_reference` is documented as metres BELOW surface (+down) | `models/station.rs:148` `/// Depth reference (meters below surface)` |
| It is the datum STATION's own depth, set from its z, round-tripped as z | `src/components/Dialogs/EditStationDialog.tsx:113`; `src/utils/coordinates.ts:174` `z: gps.depth_reference` |
| It is deliberately excluded from geodesy | `models/geo.rs:88` `// Always use alt=0 - depth_reference is not ellipsoid height` |
| Export writes it as the elevation anyway | `export/tml.rs:310` `.map(\|zd\| zd.gps.depth_reference)` |
| Import parses it, converts ft->m, and carries it on both `TmlFile` and `TmlGeoCoding.altitude` | `parsers/tml.rs:354`, `:1105`, `:1157`, `:1171` |
| ...and nothing consumes it | `parsers/tml.rs:1725` `_geo_coding: Option<&TmlGeoCoding>`; the datum is built with `depth_reference: 0.0` at `:1738` and `:1782` |
| Master already documents this decision as pending | `parsers/tml.rs:1706-1718` `TODO(#411)`: "Fixing this needs a decision about which convention the datum stores (and matching changes on the export side), not a cast here." |

So `depth_reference` has exactly one non-test consumer outside persistence and the
edit dialog: the export at `export/tml.rs:310`. That export is wrong twice - wrong
sign frame, and wrong quantity. A datum set on a station 35 m down writes
`firstStartAbsoluteElevation = 35`, i.e. "35 m above sea level" (the 35 m datum
shape is exercised at `core/state/tests.rs:6453`).

This doc is the decision that `TODO(#411)` asks for.

## Where the issue text does not match the tree

`docs/ariane-export.md:29` documents a field that does not exist: "First zero datum
GPS altitude". There is no altitude on `GpsCoordinates` (`models/station.rs:145-150`);
what is written is `depth_reference`. The doc needs correcting either way.

The issue's ordering worry is already resolved: #432 is merged (`4fbff799` is an
ancestor of `origin/master`), so `apply_unit_conversion` converts the elevation
(`parsers/tml.rs:1105`) and `TmlGeoCoding.altitude` carries **metres** even for an
Imperial file (`:1157`). Nothing blocks this work.

## Constraints

- `.stalx` is at `SCHEMA_VERSION = 16` (`persistence/sqlite.rs:74`). `zero_datums` has
  no elevation column (`sqlite/schema.rs:1325-1334`); reads and writes both use
  explicit column lists (`read.rs:493`, `write.rs:172`).
- **The forward-compat gate is warn-only.** `ensure_schema_version` logs
  "Database schema version is newer than this app" and then `return Ok(())`
  (`sqlite/schema.rs:1136-1143`). An older build does **not** refuse a newer file.
- **A same-version file never runs migrations.** The fast path at
  `sqlite/schema.rs:1149-1151` returns before `migrate_schema()` whenever
  `current == SCHEMA_VERSION`. Every conditional ALTER lives inside `migrate_schema`
  (`sqlite/schema.rs:33-491`, e.g. the shots.uuid add at `:428-441`), so an ALTER
  added without a version bump would never reach an existing v16 project.
- A project-level scalar has a ready home: `project_settings` key/value
  (`sqlite/schema.rs:46-51`), already used for `validation` (`write.rs:320`, `read.rs:1150`).
- The datum travels as a bare `GpsCoordinates` through both mutation carriers:
  `Command::SetZeroDatum { coordinates: GpsCoordinates }` (`core/command.rs:147`) and
  `UndoData::ZeroDatumInfo { previous_gps: Option<GpsCoordinates> }` (`core/undo.rs:250`).
  Undo payloads are persisted.
- The v12 sign-convention migration (`docs/inclination.md:72-113`) is **not** the
  pattern here: that one reinterpreted an existing stored number and had to infer
  provenance per section. Nothing is reinterpreted here - old `depth_reference` values
  are depths and stay depths. This is a pure addition.

## Candidates

### A. `GpsCoordinates.surface_elevation: Option<f64>` (+up, m MSL)

Rides every existing carrier for free: `SetZeroDatum`, `ZeroDatumInfo`,
`ImportPlacement::ZeroDatum`, `ZeroDatumWire` (`models/station.rs:384-387`). One
nullable column on `zero_datums`. `#[serde(default)]` keeps old `.stalx` blobs and
old persisted undo payloads readable; `Option<f64>` keeps the struct `Copy`.

Cost: a second non-coordinate field on a type `geo.rs:88` already has to defend itself
against, meaningless for the uses of `GpsCoordinates` that are not datums. About six
non-test literal sites plus fixtures must add it - a compile error at each, which is
the desirable failure mode.

### B. `ZeroDatum.surface_elevation: Option<f64>`

Semantically the right owner - a property of the surveyed entrance, not of a lat/lon
pair - and it leaves `GpsCoordinates` clean.

Cost, and it is the deciding one: `core/command.rs:147` and `core/undo.rs:250` both
carry `GpsCoordinates`, not `ZeroDatum`. B needs a parallel field beside
`previous_gps: Option<GpsCoordinates>`, i.e. a second optional that can disagree with
the first, restored atomically by undo. That is a new invariant with no enforcement.
A cannot desynchronise, by construction.

### C. Project-level scalar in `project_settings`

Cheapest: no DDL, no version bump, no IPC churn, no undo shape change. But one number
per project cannot say which entrance it belongs to, and the model is explicitly
multi-entrance: export picks `zero_datums.first()` as the graph root
(`export/tml.rs:307-311`, `:578-583`) and writes one START per entrance. Moving C -> A
later needs a migration; A degrades to C for free by reading the first datum.

## Recommendation: A, in one change with the export fix

1. Add `surface_elevation: Option<f64>` to `GpsCoordinates` (`models/station.rs:145`),
   documented as "+up, metres above mean sea level; `None` = unknown". Validate
   finiteness alongside the existing checks (`models/station.rs:167-186`).
2. `export/tml.rs:303-313` reads
   `zero_datums.first().and_then(|zd| zd.gps.surface_elevation).unwrap_or(0.0)`.
   The `depth_reference` read is deleted. 0.0 is already the documented no-data value.
3. `determine_placement` (`parsers/tml.rs:1719-1790`) sets it from the
   `geo_coding.altitude` it is already handed - parsed, converted and in scope, so it
   is a one-line read per `ZeroDatum` arm plus dropping the `_` prefix. Delete the
   `TODO(#411)` block at `:1706-1718`.
4. Fix `docs/ariane-export.md:29`; extend the `geo.rs:88` comment to name both fields
   the conversion ignores. Do not touch `depth_reference` - it keeps its meaning and
   its one honest consumer.

## Migration and compatibility

- **`.stalx`: bump `SCHEMA_VERSION` to 17.** This is not optional. The column has to
  be added by a `pragma_table_info`-guarded ALTER inside `migrate_schema`, mirroring
  `sqlite/schema.rs:428-441` - and `migrate_schema` is skipped entirely for a file
  already at the current version (`sqlite/schema.rs:1149-1151`). Without the bump the
  ALTER never runs on any existing project and the first save fails with
  "no such column: surface_elevation". The bump is cheap precisely because the
  forward gate is warn-only (`sqlite/schema.rs:1136-1143`): an older build still opens
  a v17 file.
- **An older build's re-save drops the value, bump or no bump.** Its INSERT
  (`write.rs:172`) does not name the column, so the elevation is lost silently. That
  follows from the warn-only gate, not from this change, and is the accepted cost for
  a round-trip-only value.
- **Undo**: `Option<f64>` with `#[serde(default)]` deserialises from every persisted
  payload written before the change; `UNDO_FORMAT_SAFE_VERSION`
  (`persistence/sqlite.rs:87`) needs no change.
- **IPC**: `GpsCoordinates.ts` regenerates (`pnpm gen:ipc-types`); mark the field
  `#[ts(optional)]` so existing TS literals (`src/utils/gps.ts:147,298,378`) compile.
- **SpeleoDB sidecar**: nothing to do. The hardening list
  (`docs/ariane-export.md:229-237`) has no elevation rule and the sidecar shares
  `build_xml`, so it picks the fix up automatically.

### Question for the maintainer

Should the warn-only forward-compat gate itself be revisited? Silent-drop-on-resave
is not specific to this column - it is the standing behaviour for **every** future
additive column, and the loss is invisible to the user who downgraded. Out of scope
for #431; worth its own issue if the answer is yes.

## UI and map: nothing, deliberately

No renderer or geometry path reads `depth_reference` today and none should read
elevation: `gps_to_local` must keep `alt=0` (`geo.rs:88-90`) or every station moves.
The value is import/export round-trip only. The honest risk: a persisted field with no
UI is unverifiable and will rot. The one place to surface it later is the datum block
at `EditStationDialog.tsx:110-114` - a single optional numeric input, no map change.
Name that the completion criterion for #431 rather than shipping it here.

## Test strategy

Injection-first - each test names what turns it red.

1. **Round trip**: synthetic `.tmlu` with
   `<firstStartAbsoluteElevation>123.5</firstStartAbsoluteElevation>` and a GPS-bearing
   first shot -> import -> export -> the element reads `123.5`. Red today (the datum is
   built with `depth_reference: 0.0`); red again if the export reverts.
2. **The bug, pinned directly**: a datum with `depth_reference = 35.0` and
   `surface_elevation = None` exports `0.0`, not `35.0`. Red on today's
   `export/tml.rs:310`. This test must exist even if A is rejected.
3. **Sign**: elevation `-5.0` (a sump below sea level) survives as `-5.0`, not `5.0`.
4. **Migration, the case that catches the fast path**: open a v16 `.stalx` written
   before the change, then SAVE it. Red without the version bump ("no such column").
   A fresh-project save passes either way, which is why this case is needed.
5. **Persistence**: save/load preserves `Some(123.5)` and `None` distinctly.
6. **Undo**: set datum -> change elevation -> undo restores elevation together with
   lat/lon. Red if the field is ever split out of `GpsCoordinates` (B's failure mode).
7. **Units**: an Imperial `.tmlu` with elevation `328.084` lands as `100.0 +/- 1e-3` on
   the datum, extending the coverage at `parsers/tml.rs:2547`.

No fixture files. Every case is synthetic XML or a test-built database.
