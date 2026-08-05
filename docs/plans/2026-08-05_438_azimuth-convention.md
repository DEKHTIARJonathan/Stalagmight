# Azimuth convention: store what was measured, correct at compute time (#438)

Status: **decided by Nico, 2026-08-05**. This doc is the implementation brief.
Companion docs: `2026-08-05_431_entrance-elevation.md`,
`2026-08-05_423_foreign-shot-ids.md`. All three want the same schema bump - do
them together or the version churns three times.

## The decision

Adopt Ariane's model: **the stored azimuth is the measured azimuth**, the project
declares which north that measurement refers to, and any declination correction
is applied when geometry is computed, never written back into the shot.

Consequences, stated up front:

- The Ariane path becomes a straight copy - no per-shot arithmetic at import,
  which is the fast path both computationally and for the reader.
- **Compass and Walls do the extra work.** They are the edge case, and the work
  is theirs: keep the file's measured reading and carry its declared correction
  as metadata, instead of folding the correction into each shot.
- No migration. Pre-release `.stalx` files exist only for testing; that gets a
  line in the docs (see "Docs" below) and nothing else.

## Where we are today (verified)

| Importer | What lands in `Shot::azimuth_in/out` |
|---|---|
| Compass | `azimuth + declination - grid convergence` (`parsers/compass.rs:538`, backsight at `:627`) - corrected, baked in |
| Walls | same treatment (`parsers/walls/convert.rs:582`) |
| TML | the file's value verbatim - magnetic (every real file carries `useMagneticAzimuth=true`) |
| DMP | verbatim - magnetic; the parser has no declination code at all |

`Shot` carries one azimuth pair and no provenance (`models/shot.rs:218-222`), and
no project or section field records a north reference. So today the convention is
implicit in "which importer ran", it is not persisted, and on the Compass/Walls
path the measured reading is destroyed at import.

Export makes the mismatch visible: `export/tml.rs:327` writes
`<useMagneticAzimuth>true</useMagneticAzimuth>` as a hardcoded literal over
untransformed azimuths, so a Compass-sourced project handed to Ariane is declared
magnetic when it is already true north - and Ariane applies its own IGRF
correction on top of it. About 2.1 degrees in Quintana Roo; 5-10x that elsewhere.

## What Ariane does (the model being adopted)

- The file stores measured azimuths plus `useMagneticAzimuth`, which the schema
  documents as "magnetic azimuth is used (true) or true north (false)".
- The UI exposes it as a per-project toggle: menu action "CHANGE DECLINATION
  CORRECTION MODE", status line "CURRENT AZIMUTH MODE : mag|geo" (the label is
  built by reading `getUseMagneticAzimuth()`).
- Declination is computed, not stored: a bundled IGRF module derives it from
  lat/lon/date and caches the field components in `~/.ariane/cachedeclination.txt`
  (one row per lat;lon;elevation;year).
- A plain Save preserves azimuths semantically, so the correction is never baked
  back into the file.

Not verified (needs the GUI, and only affects how we present the setting):
whether flipping Ariane's toggle rewrites the stored numbers or only reinterprets
them.

## Model changes

1. **Section-level correction**, because a Compass file can declare a different
   declination per survey and can change mode mid-file:

   ```
   /// How this section's stored azimuths relate to true north.
   pub struct AzimuthReference {
       /// What the stored numbers are measured against.
       pub north: NorthReference,          // Magnetic | True | Grid
       /// Degrees to ADD to a stored azimuth to get true north. 0.0 when
       /// `north` is True. For Magnetic this is the declination; for Grid it
       /// also folds in the meridian convergence.
       pub correction: f64,
       /// Where `correction` came from, so the UI can explain it and a policy
       /// change knows what it may recompute.
       pub source: CorrectionSource,       // FileDeclared | IgrfAuto { epoch } | Manual | None
   }
   ```

   Store it on `Section` (`Option<AzimuthReference>`; `None` = inherit the
   project default). A project-level default carries the same shape.

2. **One accessor, not eight.** Today `average_azimuth().to_radians()` appears at
   roughly eight call sites (`models/project.rs:842,1179`,
   `core/state/command_move.rs:146,172`,
   `core/state/command_delete_split.rs:125,134,407`,
   `models/placement_suggest.rs:377,386`, `parsers/tml.rs:4299`). Every one of
   them is a place the correction must not be forgotten. Collapse them onto a
   single helper that takes the shot and its section's reference and returns the
   true-north bearing; make the raw accessor obviously raw
   (`average_azimuth_measured()`), so a bare call reads as a bug.

3. **Where the correction lands**: coordinate computation, the closure solver and
   the move/split geometry all consume the same helper, so they agree by
   construction. The correction is a per-section constant, so the cost is one
   addition per shot - the "fast path" property survives.

## Importer behaviour

- **TML**: copy azimuths verbatim; set the section reference from the file -
  `useMagneticAzimuth=true` gives `north: Magnetic` with `source: IgrfAuto` when
  the file is georeferenced (compute once at import from lat/lon and the shot
  date, store the value), or `source: None` with a receipt warning when it is
  not. `useMagneticAzimuth=false` gives `north: True, correction: 0.0`.
- **DMP**: same as TML's magnetic case - the device measures magnetic.
- **Compass**: stop applying the correction to shots. Store the measured azimuth
  and put the survey's declared declination (and the file's grid convergence, if
  applied) into the section's `AzimuthReference`, preserving the file's own mode
  (Ignore/Entered/Auto). Compass's per-survey granularity is exactly why the
  reference lives on the section.
- **Walls**: same treatment.
- Each importer's receipt states the correction it recorded, in degrees, per the
  no-silent-behaviour rule the rest of the arc established.

## Export

`export/tml.rs` stops hardcoding the flag:

- All sections `Magnetic` with one correction -> write azimuths as stored and
  `useMagneticAzimuth=true`.
- All sections `True` -> write as stored and `false`.
- **Mixed** (a project that imported both an Ariane and a Compass file) -> the
  only honest single-flag answer is to emit true-north bearings (apply each
  section's correction on the way out) and write `false`. Note it in the export
  summary.

## Schema

Bump `SCHEMA_VERSION` (currently 16, `persistence/sqlite.rs:74`) to 17 together
with #431 and #423. New columns default to "no reference recorded", which reads
as `north: Magnetic, correction: 0.0, source: None` - identical behaviour to
today for any file written before the bump.

## UI

A project setting that shows the reference and the applied correction, in
Ariane's spirit: the mode, the degrees, and where the number came from. Changing
the policy (auto/manual/none) recomputes `correction` for sections whose source
allows it; it never touches shot values.

## Docs

- `docs/SPEC.md:267` currently says azimuths are "degrees from magnetic north".
  Replace with the real contract: stored = as measured, section-declared,
  corrected at compute time.
- `docs/ariane-import.md` / `docs/ariane-export.md`: replace the "declination is
  never applied" limitation and the "`true` | `useMagneticAzimuth` | Default"
  row.
- One line, wherever the persistence format is described: **`.stalx` files
  written before the first release are test artifacts; no migration path is
  provided for them.** That is what makes this change cheap.

## Open questions for implementation

1. IGRF epoch: the correction varies with date, and our shots carry per-shot
   dates while the reference is per section. Recommend computing from the
   section's earliest shot date and recording it in `source: IgrfAuto { epoch }`,
   so the number is reproducible and explainable.
2. Adding a georeference later (import with no coordinates, GPS set afterwards)
   should offer to compute the correction then - otherwise `source: None`
   sections stay uncorrected forever and nothing says so.
3. The closure solver runs on corrected bearings; confirm no stored residuals or
   cached coordinates predate the correction when a policy change recomputes it.
