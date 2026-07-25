# Ariane TML/TMLU Import

Stalagmight can import cave survey data from Ariane's TML and TMLU file formats.

## File Formats

| Extension | Structure | Description |
|-----------|-----------|-------------|
| `.tml` | ZIP archive containing `Data.xml` | Standard Ariane export |
| `.tmlu` | Plain XML | Uncompressed variant |

Both formats use the same XML schema. TML files use long element names (`Azimut`, `Length`, `DepthIn`, `FromID`, `ClosureToID`) while TMLU files use short abbreviations (`AZ`, `LG`, `DPI`, `FRID`, `CID`).

## Supported Data

### Per-file metadata
- Cave name
- Measurement unit (metric / imperial)
- Magnetic azimuth flag
- GPS reference (latitude, longitude, altitude) - extracted from the first shot with non-zero coordinates

### Per-section
- Section name (with `SectionDescription` suffix stripped)
- Surveyor / explorer
- Survey date
- Section color (converted from Ariane's integer RGB format)

### Per-shot
- Azimuth (normalized to 0-360; Ariane stores a single forward azimuth, not a backsight pair)
- Length
- Depth in / depth out
- Inclination
- LRUD (left, right, up, down)
- Comment
- Shot type (Real, Virtual, Start, Closure) - Ariane's "Virtual" type maps to internal `is_reference`
- Excluded flag

### Loop closures
CLOSURE-type shots in Ariane encode loop closure metadata. During import these are resolved into Stalagmight loop closures linking two stations across sections.

## Import Workflow

The import follows the same two-step flow as DMP imports:

1. **Parse & preview** - The file is parsed and the import dialog shows all sections with a map preview. Users can toggle individual sections on/off.
2. **Placement** - Each section is placed in the coordinate system. The first section uses GPS coordinates (if available) or manual placement; subsequent sections attach to their parent section's endpoint via topology linking.

### Excluded shots

Ariane marks some shots as "excluded" (e.g. survey errors). By default these are filtered out during import. The import dialog provides a toggle to include them if desired.

When excluded shots are filtered:
- Sections that lose all shots are dropped entirely
- Branch names like "Main Line (branch 1)" are simplified back to "Main Line" when only one branch survives
- Sections are topologically sorted so parent sections are always created before dependents

## Shot Types

| Type | Handling |
|------|----------|
| **Real** | Imported as regular survey shots |
| **Virtual** | Imported as reference shots (`is_reference = true`; dashed display, hidden by "Reference shots" toggle). The TML type string remains "VIRTUAL" for Ariane compatibility. |
| **Start** | Marks the first station; not imported as a shot |
| **Closure** | Not imported as a shot - used to create loop closures between sections |

## Topology Reconstruction

Ariane stores survey data as a flat list of shots with `FromID` linkage. The parser reconstructs section topology by:

1. Building a graph of shot connectivity from `FromID` references
2. Detecting branch points where multiple shots share the same `FromID`
3. Splitting branches into separate sections with parent-child placement relationships
4. Resolving cross-section connections via a shot ID → (section index, station index) mapping

## Unit Conversion

When the file specifies imperial units, lengths and LRUD values are converted from feet to meters and depths from feet to meters during parsing. All data enters Stalagmight in metric.

## Azimuth Semantics

Ariane has one azimuth field per shot (`Azimut` / `AZ`). Stalagmight duplicates that value into internal `azimuth_in` and `azimuth_out` on import for model compatibility, but `azimuth_out` must not be interpreted as an Ariane backsight measurement.

## Implementation

| Component | File | Role |
|-----------|------|------|
| Parser | `src-tauri/src/parsers/tml.rs` | XML parsing, section linearization, unit conversion |
| Import command | `src-tauri/src/commands/import.rs` | IPC handler, deduplication, undo support |
| Import dialog | `src/components/ImportDialog/` | UI for section selection and placement |

## Limitations

- Ariane's shape/cross-section geometry (`Shape`/`SH` elements) is not imported
- The `Inclination` field is parsed but not currently used in survey computation (Stalagmight uses depth-based geometry)
- Only the first GPS coordinate found in the file is used as the project origin
