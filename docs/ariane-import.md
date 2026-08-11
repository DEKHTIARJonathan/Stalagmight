# Ariane TML/TMLU Import

Stalagmight can import cave survey data from Ariane's TML and TMLU file formats.

## File Formats

| Extension | Structure | Description |
|-----------|-----------|-------------|
| `.tml` | ZIP archive containing `Data.xml` | Standard Ariane export |
| `.tmlu` | Plain XML | Uncompressed variant |

Both formats use the same XML schema. TML files use long element names (`Azimut`, `Length`, `DepthIn`, `FromID`, `ClosureToID`) while TMLU files use short abbreviations (`AZ`, `LG`, `DPI`, `FRID`, `CID`).

## Supported Data

"Supported" here means "parsed". What the import then DOES with each field is the workflow below; the fields that are parsed and go nowhere are listed under [Limitations](#limitations).

### Per-file metadata
- Cave name
- Measurement unit (metric / imperial)
- Magnetic azimuth flag (parsed, unused)
- Entrance elevation (parsed, used - see [Limitations](#limitations))
- GPS reference (latitude, longitude, altitude) - extracted from the first shot with non-zero coordinates

### Per-section
- Section name (with `SectionDescription` suffix stripped)
- Surveyor / explorer, taken from the section's first shot. Ariane's `Explorer`
  is ONE element holding two roles, in two encodings: a plain compound string
  (`"nh / ds"`) or an entity-escaped element pair
  (`<Explorer>nh</Explorer><Surveyor>ds</Surveyor>`). Both halves are kept and
  rejoined with `" / "` - the form real files already use, and the form export
  writes back - so the round trip is idempotent. Splitting the compound into
  people is [#329](https://github.com/Stalagmight/Stalagmight/issues/329) and is
  not done here. A half spelled `unknown`, `None` or empty is dropped on its
  own, so an unfilled explorer no longer takes the surveyor with it (#427).
- Survey date, taken from the section's first shot
- Section color (converted from Ariane's integer RGB format), taken from the section's first shot

Those three are the section's **trip**, and Ariane records them on EVERY shot
row - see [The trip cut](#the-trip-cut) for what happens when they change
mid-chain.

### Per-shot
- Azimuth (normalized to 0-360; Ariane stores a single forward azimuth, not a backsight pair)
- Length
- Depth in / depth out
- Inclination
- LRUD (left, right, up, down)
- Comment
- Shot type (Real, Virtual, Start, Closure) - Ariane's "Virtual" type maps to a virtual `ShotKind`
- Excluded flag
- `UUID` / `UU` - Ariane 26+'s stable per-row id, kept verbatim as the shot's
  identity so a file that leaves Ariane and comes back is not re-identified
  (#423). Absent or empty means "no identity" and gets a fresh v4. The value is
  never validated or coerced; see
  [Ariane export](ariane-export.md) for the uniqueness scope and the SpeleoDB
  sidecar consequence.

### Loop closures
CLOSURE-type shots in Ariane encode loop closure metadata. During import these are resolved into Stalagmight loop closures linking two stations across sections.

## Import Workflow

Unlike the DMP wizard, the Ariane import is a single dialog with no map preview, no per-section toggles and no placement step. It always creates a NEW project - importing a `.tml` into an open project is not supported (the unified router offers to close the current project first).

1. **Pick the file** - the unified-picker entry points (the hamburger's Open / Import row, Ctrl+O, drag-drop, and Ctrl+I with no project open) route through `routeOpenedFile`, which parses the file (`parse_tml`) and marks the flow as a new-project import. The in-project Import affordances (toolbar button, hamburger Import row, Ctrl+I) offer `.dmp` only, since a `.tml` cannot be imported into an open project (#508) - drag-drop still accepts one and offers to close the project first.
2. **Name the project** - `NewProjectForImportDialog` creates the project BEFORE the import is confirmed. For a project created without an explicit save path the initial save is deferred, so nothing is on disk yet.
3. **Confirm the import** - `TmlImportDialog` shows the file's cave name, the sections table and the counts that will actually import under the current toggles (excluded shots, comment placement, virtual-shot classification), then runs `execute_tml_import`.
4. **Receipt** - a successful import opens the import receipt (sections, shots, loops, unit conversion, any converter warnings).
5. **Orphan placement (optional)** - if the newly imported sections suggest connections to existing ones, the orphan-placement dialog opens INSTEAD of the receipt handoff, and the receipt follows it.

Cancelling the dialog - or a terminal failure - leaves the project created in step 2 behind, so the dialog asks whether to keep that empty project or discard it (discard closes a deferred project, or deletes the `.stalx` if one was written).

### Placement

There is no manual placement step and no map to place on. Placement is decided by the parser (`determine_placement`):

- The first section anchors to a zero datum when its first shot carries non-zero latitude/longitude, and otherwise falls back **silently** to the project origin - nothing in the UI reports which of the two happened.
- Every other section attaches to the station its `FromID` chain resolves to in an already-imported section; a section whose parent cannot be resolved falls back to the origin with a converter warning that reaches the receipt.

### Excluded shots

Ariane marks some shots as "excluded" (e.g. survey errors). By default these are filtered out during import. The import dialog provides a toggle to include them if desired, and the preview counts move with it.

When excluded shots are filtered:
- Sections that lose all shots are dropped entirely
- Branch names like "Main Line (branch 1)" are simplified back to "Main Line" when only one branch survives
- Sections are topologically sorted so parent sections are always created before dependents

## Shot Types

| Type | Handling |
|------|----------|
| **Real** | Imported as regular survey shots |
| **Virtual** | Imported as a virtual shot, then classified Jump or Reference by the #27 chain rule at import finalize (a run bounded by real survey on both ends is a Jump). Faded display, hidden by the "Jumps" / "References" toggles. The TML type string remains "VIRTUAL" for Ariane compatibility. |
| **Start** | Marks the first station; not imported as a shot |
| **Closure** | Not imported as a shot - used to create loop closures between sections |

## Topology Reconstruction

Ariane stores survey data as a flat list of shots with `FromID` linkage. The parser reconstructs section topology by:

1. Building a graph of shot connectivity from `FromID` references
2. Detecting branch points where multiple shots share the same `FromID`
3. Splitting branches into separate sections with parent-child placement relationships
4. Resolving cross-section connections via a shot ID → (section index, station index) mapping

### The trip cut

A `Section` holds ONE surveyor, one date and one colour; a `Shot` holds none of
the three. Ariane writes all three on every shot row, so a chain surveyed by two
teams over three days used to import entirely under its FIRST shot's values,
with the rest discarded silently (#427).

Each linearized run is therefore **cut where the trip changes between two
adjacent stations**, and each part keeps its own surveyor, date and colour. The
parts after the first are named `"<name> (trip N)"` - backend-owned English, the
same as the `(branch N)` suffix beside it (`linearize.rs`, `format!("{section_name}
(branch {branch_number})")`); the only translated string in this area is the
wizard's `(branch)` BADGE, which is driven by `is_branch_split` and not by a
name. Each part hangs off the station it was cut at (`FromImporting`), so the
geometry is byte-for-byte what the uncut run produced. This is the same
(surveyor, date, colour) triple `join_contiguous_chains` refuses to merge
across, applied to the cut side.

A run takes those three values from its first shot that could be a STATION of it
(non-CLOSURE, non-excluded), not simply its first shot: a run headed by an
excluded shot was otherwise named after a shot the default import does not keep,
and every shot it did keep then read as a collapsed trip that never happened.

Three rules bound it, the first two mirroring the join:

- **A cut needs a station on both sides.** A trip that changes across a CLOSURE
  or excluded shot is not cut, because that shot is not in the import's station
  index and the part after it would resolve to no parent - and whether it does
  would depend on the include-excluded toggle, which sectioning must be
  invariant to. What cannot be cut is counted and named on the receipt instead
  ("N shots in M sections recorded a different surveyor/date/colour...").
- **The cut runs AFTER the join.** A cut end is not a chain end - it has an
  in-section successor by construction - and offering it to the join let an
  unrelated branch at that junction splice onto the mainline's head. The cost,
  pinned by `a_chain_continuing_a_cut_tail_stays_its_own_section`, is that a
  chain continuing a cut tail under its own name is not absorbed into it.
- **At most `MAX_TRIP_CUTS_PER_RUN` (256) cuts per run.** The trip is
  file-controlled and written on every row, so a file carrying a per-ROW date -
  a data-entry timestamp, or a crafted file - would otherwise mint one section
  per shot from a single declared name. 256 sits far above real multi-trip
  surveys (about five years of WEEKLY survey days under one declared name; the
  largest real file measured cuts none at all) and far below degeneracy. Past
  the cap the remaining trips stay on the last part and are named on the
  receipt, so the bound costs reporting, not data.

The suffix can collide with a name the file itself declares (a file with both
`A` and `A (trip 2)`). That is accepted, not disambiguated: nothing in the
import resolves a section by name - grouping keys on the file's own `<Section>`
text before any suffix exists, placement and closures key on Ariane ids, and
`simplify_lone_branch_names` only rewrites `(branch N)` names - so the result is
two sections sharing a label, exactly as a file declaring one name twice has
always produced (`a_declared_name_that_collides_with_a_cut_suffix_is_accepted`).

Measured on a large real-world survey (14 declared names): 17 configs, median 14
shots - identical to the pre-cut numbers, because no declared section in it
changes trip mid-chain.

## Unit Conversion

When the file specifies imperial units, lengths, LRUD values, depths, section start depths and the file's entrance elevation are converted from feet to meters during parsing. All data enters Stalagmight in metric.

An absent or recognised `<unit>` (empty, `m`, `metric`, `ft`, `imperial`) is handled silently. Anything else falls back to metric AND raises an import warning naming the unrecognised string, so a silent mis-scaling is visible on the receipt.

### Entrance elevation's zero-is-absent convention

Ariane encodes "no entrance elevation recorded" as `firstStartAbsoluteElevation = 0.0` rather than an absent field, so import treats an exact `0.0` as "not recorded" and anything else, however small, as a real value. This is format-forced, not a Stalagmight choice: a genuine entrance at exactly 0.0 m above mean sea level is not representable and will read back as unset. The convention lives in `crate::models::ariane_elevation_or_absent`, called by import and SpeleoDB pull-adoption; export mirrors it independently (it writes `0.0` back out for an unset `Project::surface_elevation` via its own `unwrap_or(0.0)`, rather than calling the helper), so the round trip is consistent.

## Azimuth Semantics

Ariane has one azimuth field per shot (`Azimut` / `AZ`). Stalagmight duplicates that value into internal `azimuth_in` and `azimuth_out` on import for model compatibility, but `azimuth_out` must not be interpreted as an Ariane backsight measurement.

## Implementation

| Component | File | Role |
|-----------|------|------|
| Parser | `src-tauri/crates/parsers/src/parsers/tml/` | XML parsing, section linearization, unit conversion |
| Import command | `src-tauri/src/commands/import.rs` | IPC handler, deduplication, undo support |
| Import dialog | `src/components/Dialogs/TmlImportDialog.tsx` | Preview, import options, progress, failure/cancel handling |

## Azimuth convention (#438)

Azimuths are copied **verbatim** - no per-shot arithmetic at import - and the
file's `useMagneticAzimuth` becomes the section's declared north reference:

| File says | Section records | Correction |
|-----------|-----------------|------------|
| `useMagneticAzimuth=false` | `north: true`, `source: file` | 0 |
| `true` + `<GeoCoding>`, date in the IGRF range | `north: magnetic`, `source: igrf` with the epoch | the modelled declination at the file's lat/lon on its earliest survey date |
| `true`, no georeference, or no survey date | `north: magnetic`, `source: unknown` | 0. No receipt line: nothing was degraded and there is nothing to act on. An UNDATED file asks the model nothing rather than substituting today, so the same file imports the same way on any two days |
| `true`, georeferenced AND dated, but the model cannot serve that date | `north: magnetic`, `source: unknown` | 0, with a receipt line naming the date it could not serve |

The correction is applied when geometry is computed, never written into a shot,
so a re-export hands Ariane back the numbers the file carried.

**Compass and Walls: the grid convergence is reported, not applied.** Both
formats subtract a meridian convergence because their own output is
grid-relative. Stalagmight's world frame is TRUE north - `gps_to_local` returns
true-north ENU (`models/geo.rs:79-81`) and every georeferencing path places
datums against it - so a survey walked in grid bearings would sit at an angle to
its own GPS. The section correction is therefore the declination alone, and a
file that declares a convergence gets a receipt line saying it was dropped.
Bearings then differ from that app's grid-relative display by the convergence
angle, typically well under a degree.

## Limitations

**Entrance elevation round-trips, subject to the zero-is-absent convention above.** `firstStartAbsoluteElevation` is imported into `Project::surface_elevation` (+up from mean sea level, project-level rather than per-entrance) and read back by TML export; it does not feed the geometry - the zero datum's `depth_reference` (+down from the surface) is what positions stations ([#431](https://github.com/Stalagmight/Stalagmight/issues/431)).

Parsed but dropped:

- **Ariane shot UUIDs are PRESERVED**, and have been since [#423](https://github.com/Stalagmight/Stalagmight/issues/423)
  - this entry used to say the opposite and was stale. `foreign_shot_uuid`
  (`parsers/tml/mod.rs:525`) validates the SHAPE of a `UUID`/`UU` element (non-empty, at most 128
  characters, no XML-unexportable character) and never coerces the value; `Shot::with_uuid`
  (`models/shot.rs:614`) lets the file's value win over the caller's fresh mint. So re-importing
  a file this app exported round-trips by ID, and importing the SAME file twice hands two shots
  the same foreign uuid - which is why the export path re-mints document-level duplicates
  (`export/tml.rs::remint_duplicate_uuids`). A uuid whose shape is rejected costs THAT SHOT its
  foreign identity and nothing else.
- **A `0.0` LRUD field is read as UNMEASURED, per field.** `lrud_opt`
  (`parsers/tml/mod.rs:1908-1914`) maps any of `Left`/`Right`/`Up`/`Down` whose
  `abs()` is under `f64::EPSILON` to `None`, independently of the other three - so
  `left=0, right=3` imports as `null/3`. This is the read half of an INTENDED
  sentinel collision, not a loss of information the file had: the export writes
  `unwrap_or(0.0)` because Ariane's format has no null, so an unmeasured dimension
  and one measured as zero arrive identical. The consequence is that a MEASURED
  zero does not survive a round trip through this app's own `.tml`/`.tmlu`; an
  unmeasured one does. The full argument, and the measured scale of it, is in
  [ariane-export.md](ariane-export.md#the-lrud-zeronull-collision).

- **The Inclination zero/null collision.** `Inclination`/`INC` has the same
  format-forced ambiguity as LRUD (above): Ariane has no null, so
  `pitch_to_inclination` (`export/tml.rs:153-158`) writes both `None` (never
  sighted) and `Some(0.0)` (genuinely level) as the same wire `0.0`. Unlike
  LRUD, though, a plain "0.0 means absent" read would fabricate data:
  `Validator::validate_shot`'s inclination/depth cross-check treats an absent
  pitch as nothing to check, but a `Some(0.0)` as a claim to verify against the
  shot's depth change, so reading every wire `0.0` back as `Some(0.0)` turned a
  clean round trip of a depth-only survey into a wall of fabricated
  `INCLINATION_DEPTH_MISMATCH` warnings ([#482](https://github.com/Stalagmight/Stalagmight/issues/482)).

  The importer (`parsers::tml::tml_pitch_in`) gates on the REAL condition
  rather than a proxy: it computes what the shot's own length and depth
  change imply the inclination should have been
  (`stalagmight_models::shot::implied_pitch_deg` - the SAME computation
  `core::validation` uses for its cross-check, extracted to one shared
  helper so the two cannot drift) and compares that against
  `DEFAULT_INCLINATION_DEPTH_DIFF_THRESHOLD`, the `ValidationConfig` default
  (not the user's live, editable config - the import mapping must be
  deterministic). A wire `0.0` whose implied pitch would have exceeded the
  threshold imports as `None`; one whose implied pitch is under the
  threshold - a near-level shot, where a recorded `Some(0.0)` would not have
  been flagged anyway - keeps `Some(0.0)`.

  Two losses are the deliberate, accepted cost of this rule, not bugs:
  - A GENUINELY recorded `Some(0.0)` pitch on a STEEP shot is erased to
    `None` by one round trip. The wire cannot tell it apart from an absent
    reading, and the mismatch warning it would have produced was never
    earnable back from a lossy `0.0` in the first place (pinned by
    `a_genuinely_recorded_zero_pitch_on_a_steep_shot_is_erased_by_one_round_trip`
    in `core/state/import_pipeline_tests.rs`).
  - Corrupt geometry - a wire `0.0` paired with a genuinely wrong depth or
    length that implies a steep pitch - imports silently, with no warning.
    No import-side rule can recover that warning without re-fabricating
    #482's false positives for every ordinary depth-only survey.

- **Leading and trailing whitespace is trimmed off every text field.** The reader does
  `e.unescape()?.trim()` on every shot element's text (`parsers/tml/mod.rs:398`), which is what
  makes a pretty-printed `<Comment>\n  text\n</Comment>` from another tool read as `text` rather
  than as `text` with its indentation. The cost is that a comment which BEGINS or ENDS with
  whitespace does not round-trip: `"\tleading tab"` comes back as `"leading tab"`. A literal CR is
  lost twice over - XML 1.0 line-end handling normalises it to LF before the reader sees it, and
  then the trim removes it - so writing `&#13;` would not help either. Interior whitespace, and the
  U+200B station-comment separator (not whitespace in Unicode terms), are unaffected. CSV export is
  lossless here by contrast; this is a property of the XML text format, not of the comment.
- **Per-shot surveyor / date / color survive as far as the section model allows.**
  A run is cut per trip ([The trip cut](#the-trip-cut)), so several teams over
  several days arrive as several sections rather than one. What a cut cannot
  express - a trip that changes across a CLOSURE or excluded shot, with no
  station seam to cut at - still collapses to the run head, and is counted on
  the receipt rather than dropped in silence ([#427](https://github.com/Stalagmight/Stalagmight/issues/427)).
- **Ariane 26.3's separate `XMLExplorer` / `XMLSurveyor` elements are not read.**
  The survey behind #427 found them synthesized EMPTY on a resave of our own
  export, with the legacy combined `Explorer` still carrying the data, so
  reading them would change nothing on any file seen so far; preferring them
  when non-empty belongs with [#329](https://github.com/Stalagmight/Stalagmight/issues/329),
  which is where the element names can be confirmed against a file that fills
  them.
- **Dates parse strictly as `%Y-%m-%d`.** Any other spelling reads as no date at
  all, with nothing said (#427 records this; it is not yet fixed).

Structural:

- **The mainline fragments at branch points.** Which branch continues the section is decided by file order, not by which branch is the mainline, so a long trunk can arrive split into "(branch N)" sections ([#412](https://github.com/Stalagmight/Stalagmight/issues/412)).
- Ariane's shape/cross-section geometry (`Shape`/`SH` elements) is not imported.
- The `Inclination` field is parsed and normalised to Stalagmight's positive-down pitch on import (`parsers::tml::inclination_to_pitch`), but station coordinates stay depth-based, so pitch never feeds the geometry - see [docs/inclination.md](inclination.md), which is canonical for the sign convention.
- Only the first GPS coordinate found in the file is used as the project origin.
