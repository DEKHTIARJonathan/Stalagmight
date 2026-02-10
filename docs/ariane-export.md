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
2. Click **Export** — the save dialog offers two filters: "TML (ZIP)" and "TMLU (XML)".
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
| `shot.length` | `Length` / `LG` | |
| `shot.depth_out` | `Depth` / `DP` | Absolute station depth |
| `shot.depth_in` | `DepthIn` / `DPI` | -1.0 sentinel when equal to previous `depth_out` |
| `shot.pitch_in` | `Inclination` / `INC` | 0.0 if unset |
| LRUD | `Left`/`Right`/`Up`/`Down` | 0.0 for `None` |
| `shot.comment` | `Comment` / `CM` | Empty string if unset |
| `shot.is_reference` | `Type` / `TY` | `VIRTUAL` vs `REAL` (TML keeps Ariane's naming for compatibility) |
| — | `Locked` / `LCK` | `false` for normal shots, `true` for START |
| — | `Name` / `NM` | `"START"` for START shot, empty otherwise |
| — | `Profiletype` / `PT` | Always `VERTICAL` |
| — | `Excluded` / `EXC` | Always `false` |

## Topology

Ariane represents survey data as a directed graph rooted at a single START shot.

### Single START shot

Only the **root section** (the first section, or the one with no parent) gets a synthesized START shot with `FromID = -1`. All other sections connect to their parent via `FromID` on their first real/reference shot.

### Section connectivity

Parent–child relationships are derived from `station_merges`. When section B's entry station merges with a station in section A, section B's first shot has its `FromID` set to the Ariane ID of the corresponding station in section A.

### Loop closures

`loop_closures` are exported as CLOSURE-type shots with `ClosureToID` / `CID` pointing to the target station's Ariane ID. These encode the same loop-closure metadata that Ariane uses internally.

### ID assignment

IDs are assigned sequentially starting from 0:
- Root section: START (ID 0), then shots (ID 1, 2, …)
- Subsequent sections: shots continue the global counter
- CLOSURE shots are appended at the end

## Color Format Conversion

Internal `#RRGGBB` hex colors are converted to Ariane's `0xRRGGBBff` format (8-digit hex with alpha suffix). On import, the reverse conversion strips the alpha channel.

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
