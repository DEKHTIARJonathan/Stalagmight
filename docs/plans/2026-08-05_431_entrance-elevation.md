# Where entrance elevation lives (#431)

Status: **decided by Nico, 2026-08-05 - option C, a project-level scalar.** This
doc is the implementation brief. An earlier revision recommended option A
(a field on `GpsCoordinates`); that recommendation was withdrawn under review -
see "Considered and rejected".

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
| Master already documents this decision as pending | `parsers/tml.rs:1706-1718` `TODO(#411)` |

So `depth_reference` has exactly one non-test consumer outside persistence and the
edit dialog: the export at `export/tml.rs:310`. That export is wrong twice - wrong
sign frame, and wrong quantity. A datum set on a station 35 m down writes
`firstStartAbsoluteElevation = 35`, i.e. "35 m above sea level" (the 35 m datum
shape is exercised at `core/state/tests.rs:6453`).

`docs/ariane-export.md:29` documents a field that does not exist ("First zero datum
GPS altitude"); there is no altitude on `GpsCoordinates`. That line needs correcting
either way.

## Why the value is project-level, not per-entrance

This is the reasoning that picked C, and it is worth keeping because it also says
when to revisit.

1. **The format is project-level.** `firstStartAbsoluteElevation` is one top-level
   number per file no matter how many `START` rows the file carries. Extra
   entrances are extra START shots; they do not carry extra elevations.
2. **Depths are gauge readings against one surface.** Z is +down "below surface"
   (`docs/SPEC.md:268`) and geodesy pins altitude to 0 (`SPEC.md:276`,
   `models/geo.rs:88`). In a flooded system the water table is a single surface
   across the aquifer, so every entrance is 0 by construction - which is exactly
   why the model is coherent today.
3. **Per-entrance elevations would be over-determined.** If two entrances are
   joined through the cave, their relative elevation is *derived* from the survey
   geometry. Storing an elevation on each entrance creates a second source of
   truth that can contradict the shots, with nothing to reconcile them. One anchor
   plus the surveyed chain is the correct model.

The cases that could ever need more than one number are project-scale anyway: a
water table that is not sea level (one number for the system), altitude
decompression (absent today - no altitude anywhere in `dive_plan.rs`, and still one
number per project), or a surface/terrain overlay (needs a terrain model, not
per-entrance scalars). The only defensible multi-anchor shape is one anchor per
*connected component*, for a project holding two unconnected systems - and that is
a different design from attaching elevation to entrances.

## The decision: C, a project-level scalar

1. Add `surface_elevation: Option<f64>` to `Project` (beside `validation`,
   `models/project.rs:292-297`), documented as "+up, metres above mean sea level;
   `None` = unknown". Include it in the manual `Serialize`/`Deserialize` impls
   (`project.rs:517`, `:554`) with a default of `None`.
2. Persist it through the existing `project_settings` key/value table - the same
   mechanism `validation` uses (`persistence/sqlite/write.rs:320`,
   `read.rs:1150`). **No DDL, no `SCHEMA_VERSION` bump, no migration**: a missing
   key reads as `None`, which is what every existing project should say. Note the
   read path already tolerates the table being absent entirely
   (`read.rs:986`).
3. Import sets it: `determine_placement` (`parsers/tml.rs:1719-1790`) already
   receives the parsed, unit-converted `geo_coding` - stop underscore-ignoring it
   and carry `altitude` up to the project. Delete the `TODO(#411)` block at
   `:1706-1718`.
4. Export reads it: `export/tml.rs:303-313` writes
   `project.surface_elevation.unwrap_or(0.0)`; the `depth_reference` read is
   deleted. 0.0 is already the documented no-data value.
5. Docs: fix `docs/ariane-export.md:29`, and extend the `geo.rs:88` comment so it
   names elevation as a value the geodesy conversion deliberately ignores. Do not
   touch `depth_reference` - it keeps its meaning and its one honest consumer.

Cost profile, for the record: no schema bump, no `GpsCoordinates` churn, no IPC
literal fixes, no undo payload change, and none of the downgrade-drops-the-column
problem that a new SQL column would carry. #431 is therefore independent of the
schema bump that #423 and #438 need, and can land on its own.

## Considered and rejected

### A. `GpsCoordinates.surface_elevation: Option<f64>`

Rides the existing carriers (`SetZeroDatum`, `ZeroDatumInfo`,
`ImportPlacement::ZeroDatum`, `ZeroDatumWire`) and cannot desynchronise from the
datum. **Rejected**: it buys per-entrance fidelity that the format cannot express,
that no consumer reads, and that would be over-determined for a connected system
(see above). It also costs a `SCHEMA_VERSION` bump with a `pragma_table_info`
-guarded ALTER (`migrate_schema` is skipped for a file already at the current
version, `sqlite/schema.rs:1149-1151`), an IPC regeneration, and ~6 literal sites -
all to model something the domain says is one number.

### B. `ZeroDatum.surface_elevation`

Semantically the right owner *if* the value were per-entrance. **Rejected** for the
same domain reason as A, and additionally because `Command::SetZeroDatum`
(`core/command.rs:147`) and `UndoData::ZeroDatumInfo` (`core/undo.rs:250`) both
carry a bare `GpsCoordinates`, so B needs a parallel optional beside `previous_gps`
that undo must restore atomically - a new invariant with no enforcement.

### Revisit when

The model grows a surface/terrain representation, or starts supporting several
unconnected systems in one project. At that point the unit is a per-connected-
component anchor, and the migration from C is small: read the scalar, seed the
first component, drop the key.

## Test strategy

Injection-first - each test names what turns it red. No fixture files; synthetic
XML and test-built databases only.

1. **Round trip**: synthetic `.tmlu` carrying
   `<firstStartAbsoluteElevation>123.5</firstStartAbsoluteElevation>` -> import ->
   export -> the element reads `123.5`. Red today (import drops it), red again if
   the export reverts.
2. **The bug, pinned directly**: a project with a datum at
   `depth_reference = 35.0` and no elevation exports `0.0`, not `35.0`. Red on
   today's `export/tml.rs:310`. This test must exist regardless of which option
   had won.
3. **Sign**: elevation `-5.0` (below sea level) survives as `-5.0`, not `5.0`.
4. **Persistence**: save/load preserves `Some(123.5)` and `None` distinctly, and
   **opening a project written before this change reads `None` and saves without
   error** - the case that proves no migration is needed.
5. **Units**: an Imperial `.tmlu` with elevation `328.084` lands as `100.0 +/- 1e-3`,
   extending the coverage at `parsers/tml.rs:2547`.
6. **Not clobbered by other settings**: writing `validation` and
   `surface_elevation` in the same save keeps both (the key/value table is shared).

## UI: nothing, deliberately

No renderer or geometry path reads `depth_reference` today and none should read
elevation: `gps_to_local` must keep `alt=0` (`geo.rs:88-90`) or every station moves.
The value is import/export round-trip only. The honest risk is that a persisted
field with no UI is unverifiable and will rot; the place to surface it later is
project settings (not the station dialog, now that it is project-level). Name that
the completion criterion for #431 rather than shipping it here.
