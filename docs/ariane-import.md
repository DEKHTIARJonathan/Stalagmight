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
- Entrance elevation (parsed, unused)
- GPS reference (latitude, longitude, altitude) - extracted from the first shot with non-zero coordinates

### Per-section
- Section name (with `SectionDescription` suffix stripped)
- Surveyor / explorer, taken from the section's first shot
- Survey date, taken from the section's first shot
- Section color (converted from Ariane's integer RGB format), taken from the section's first shot

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

1. **Pick the file** - any open/import entry point (toolbar, hamburger, Ctrl+O / Ctrl+I, drag-drop) routes through the unified picker (`routeOpenedFile`), which parses the file (`parse_tml`) and marks the flow as a new-project import.
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

## Unit Conversion

When the file specifies imperial units, lengths, LRUD values, depths, section start depths and the file's entrance elevation are converted from feet to meters during parsing. All data enters Stalagmight in metric.

An absent or recognised `<unit>` (empty, `m`, `metric`, `ft`, `imperial`) is handled silently. Anything else falls back to metric AND raises an import warning naming the unrecognised string, so a silent mis-scaling is visible on the receipt.

## Azimuth Semantics

Ariane has one azimuth field per shot (`Azimut` / `AZ`). Stalagmight duplicates that value into internal `azimuth_in` and `azimuth_out` on import for model compatibility, but `azimuth_out` must not be interpreted as an Ariane backsight measurement.

## Implementation

| Component | File | Role |
|-----------|------|------|
| Parser | `src-tauri/src/parsers/tml.rs` | XML parsing, section linearization, unit conversion |
| Import command | `src-tauri/src/commands/import.rs` | IPC handler, deduplication, undo support |
| Import dialog | `src/components/Dialogs/TmlImportDialog.tsx` | Preview, import options, progress, failure/cancel handling |

## Limitations

Parsed but dropped:

- **Declination is never applied.** The `useMagneticAzimuth` flag is parsed onto `TmlFile` and read by nobody: a magnetic file's azimuths are imported as-is, with no declination correction and no warning that one may be needed.
- **Entrance elevation is not wired.** `firstStartAbsoluteElevation` reaches `TmlFile` (and the geo-coding altitude) but has no home in the project model, so it is dropped - Ariane's elevation is +up from sea level while the zero datum's `depth_reference` is +down from the surface ([#431](https://github.com/Stalagmight/Stalagmight/issues/431)).
- **Ariane shot UUIDs are dropped.** Stalagmight mints its own; re-importing the same file produces new identities, so nothing round-trips by ID.
- **Per-shot surveyor / date / color collapse to the chain head.** A section takes those three fields from its FIRST shot, so a chain surveyed by several people over several days lands under one surveyor, one date and one color ([#427](https://github.com/Stalagmight/Stalagmight/issues/427)).

Structural:

- **The mainline fragments at branch points.** Which branch continues the section is decided by file order, not by which branch is the mainline, so a long trunk can arrive split into "(branch N)" sections ([#412](https://github.com/Stalagmight/Stalagmight/issues/412)).
- Ariane's shape/cross-section geometry (`Shape`/`SH` elements) is not imported.
- The `Inclination` field is parsed and normalised to Stalagmight's positive-down pitch on import (`parsers::tml::inclination_to_pitch`), but station coordinates stay depth-based, so pitch never feeds the geometry - see [docs/inclination.md](inclination.md), which is canonical for the sign convention.
- Only the first GPS coordinate found in the file is used as the project origin.
