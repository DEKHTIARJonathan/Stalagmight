# DMP Import Wizard

The DMP import wizard (`DmpNewImportDialog`) is the primary UI for importing cave survey data from DistoX DMP files. It uses a connection-wizard pattern: the backend pre-computes placement suggestions, the user confirms or adjusts each one, and a batch import executes at the end.

## Wizard Phases

| Phase | What happens |
|-------|-------------|
| `init` | Import the zero-datum section (if provided), then call `suggest_all_import_placements` for all remaining sections |
| `suggesting` | Present suggestions one at a time; user confirms, edits, or skips each |
| `placing` | Run `applyAllOverlapTreatments`, build batch `ImportSectionConfig[]` + `ExistingShotUpdate[]`, and call `import_sections` |
| `done` | All sections placed, or hand off unreachable sections to legacy dialog |

## Virtual Connections

During the `suggesting` phase, confirmed placements are recorded as **virtual connections** - lightweight client-side records that describe how two sections should be joined. No backend call happens until the `placing` phase.

```typescript
type VirtualConnection = {
  importSectionIndex: number;     // DMP section being placed
  importStationIndex: number;     // Station in that section
  targetType: 'existing' | 'importing';
  existingSectionId?: number;     // For existing targets
  existingStationIndex?: number;
  targetImportIndex?: number;     // For import-to-import targets
  targetImportStationIndex?: number;
};
```

**`existing`** connections attach a DMP section to an already-imported project section.
**`importing`** connections attach a DMP section to another DMP section that hasn't been imported yet.

## Suggestion Scoring

The backend command `suggest_all_import_placements` compares every import section against both existing project sections and other import sections. It produces a flat list of `CrossSectionSuggestion` objects sorted by score, each carrying:

- `importSectionIndex` / `existingStationIndex` - which stations to merge
- `matchedShots` / `direction` - how many shots overlapped and in which direction
- `confidence` - `high` / `medium` / `low` tier
- `targetType` - `existing` or `importing`
- `score` - aggregate match score (higher is better)

The wizard picks the top suggestion for each unplaced section and shows alternatives for the same section.

## Overlap Handling

When a suggestion has `matchedShots > 0`, the wizard shows an overlap mode picker:

| Mode | Import side | Target side (import-to-import) | Target side (import-to-existing) |
|------|-------------|-------------------------------|----------------------------------|
| `interpolate` | Delete actionable overlap shots | Replace overlap shots with interpolated values | Send `ExistingShotUpdate` with interpolated values |
| `import_data` | Delete actionable overlap shots | Replace overlap shots with import values | Send `ExistingShotUpdate` with import values |
| `existing_data` | Delete actionable overlap shots | No change | No change |
| `keep_both` | Mark overlap shots as reference (no deletion) | No change | No change |

The overlap mode is persisted to the project config.

### Centralized Overlap Treatment

All overlap mutation is handled by a single function - `applyAllOverlapTreatments` - which runs once during the `placing` phase, before `buildBatchImport`. The `handleConfirm` callback does **not** mutate overlap shots; it only records:

1. The virtual connection (placement info)
2. A `ConfirmedOverlapInfo` entry (which merge station the user chose)

```
handleConfirm → records VirtualConnection + ConfirmedOverlapInfo
              → saves raw user edits to sectionEditsRef (NO overlap mutation)

applyAllOverlapTreatments → processes ALL pool suggestions in one pass
                          → mutates sectionEditsRef (import-to-import targets)
                          → returns ExistingShotUpdateLocal[] (import-to-existing targets)

buildBatchImport → reads sectionEditsRef → ImportSectionConfig[]

import_sections IPC → sections + existingShotUpdates
```

`applyAllOverlapTreatments` walks the full suggestion pool. For each suggestion:

- **Confirmed suggestions** (matched by field comparison to `confirmedOverlapsRef`): use `computeActionableIds` with the user's merge station to determine which overlap shots to process.
- **Unconfirmed suggestions**: use the full `computeOverlapIds` result.

The function handles two target paths:

- **Import-to-import**: Modifies the target import section's edits in `sectionEditsRef` directly (interpolation, import data replacement, or reference marking).
- **Import-to-existing**: Collects `ExistingShotUpdateLocal[]` entries that are sent to the backend alongside the batch import.

### Interpolation

`interpolateShots` averages each numeric field between the import shot and the target shot. Azimuths use circular mean (`atan2((sin(a)+sin(b))/2, (cos(a)+cos(b))/2)`) to handle wraparound correctly. When the suggestion direction is `reverse`, the target shot is direction-reversed (`reverseTargetShot`) before interpolation so that in/out values align.

### Merge Station Picker

When multiple overlap offsets are possible, a dropdown lets the user choose which station pair to merge at. This controls which shots are "actionable" (subject to the overlap mode) versus past-merge (deleted at import).

### Doubly-Anchored Guard

When the target existing section has positional constraints on **both sides** of the overlap shot range, `interpolate` and `import_data` are disabled:

- The overlap mode dropdown greys out those options (`isTargetDoublyAnchored` useMemo)
- The current mode auto-switches to `existing_data` if it was set to a blocked mode
- The backend independently skips `ExistingShotUpdate` entries for doubly-anchored sections as a safety net

**Anchor types** checked on each side of the modified range:
- Zero datum stations
- Station merge endpoints
- Aligned loop closure endpoints (`is_aligned === true`)

**Rationale**: Modifying shots between two positional anchors changes the geometry between them. The backend can compensate for a single anchor via section offset adjustment, but with two anchors on opposite sides of the modification, one constraint will inevitably break (e.g., shifting the offset to keep a zero datum fixed would misalign an aligned closure on the other side).

## Existing Shot Updates (Backend)

The `import_sections` backend command accepts an optional `existing_shot_updates: Vec<ExistingShotUpdate>` parameter. Each entry specifies a `(section_id, shot_id, ShotUpdates)` triple for modifying shots on existing project sections atomically within the same undo transaction as the batch import.

### Application Order

```
1. Snapshot project state (for undo)
2. Filter out doubly-anchored sections (backend safety net)
3. Record zero datum anchor positions BEFORE updates
4. Apply ExistingShotUpdates to existing section shots
5. Compensate section offsets to keep zero datums fixed
6. Create new sections + apply placements (FromExisting uses updated geometry)
7. Snapshot project state (for redo)
8. Push undo entry
```

### Zero Datum Stability

After applying shot updates, the backend checks whether any affected section has a zero datum. If so:

1. The datum station's absolute position was recorded before updates
2. The new position is computed after updates
3. The delta is applied (inverted) to the section offset - and to all sections in the same rigid group (`get_merged_section_ids`) - so the datum stays pinned

This ensures that modifying overlap shots at indices lower than the zero datum station doesn't shift the section's GPS-anchored position.

## Section Editing

Each DMP section can be edited before import:
- **Metadata**: name, surveyor, date, color, direction, quality
- **Shots**: add, delete, insert before/after, modify values

Edit state is stored in `sectionEditsRef` (a `Map<number, SectionEditState>`) and restored when the user revisits a section. The `effectiveShots` derived view applies overlap transformations without mutating the raw edit state.

## Preview & Segment Context

The `SectionPreview` component shows a 2D plan-view rendering of the import section, the target section, and surrounding context. Context sections appear dimmed behind the main preview.

### Coordinate Frames

The preview has two coordinate frames:

- **Target frame**: The target section's station 0 is at origin. Target-side context is positioned in this frame directly.
- **Import frame**: The import section's station 0 is at origin. Import-side context uses this frame and gets an offset applied by `mergedContextSections` to align with the target.

### Context Gathering

A single `useEffect` computes `segmentContext: { importSide, targetSide }`:

1. **Import-side BFS** - `computeDmpBfsContext(importIdx, ...)` walks `importing`-type virtual connections from the current import section, collecting:
   - DMP neighbor geometry (positioned relative to the import section)
   - Existing anchors (positions where DMP sections connect to project sections)

2. **Target-side handling**:
   - `existing` target: Fetch `get_segment_geometry(existingSectionId)` from backend. This returns all sections in that segment with shot-line geometry in a coordinate frame centered on the queried section.
   - `importing` target: Run a second BFS from the target DMP section to gather its neighbors and existing anchors.

3. **Existing anchor resolution** - For each `ExistingAnchor` discovered by BFS (either side), fetch `get_segment_geometry` and position the result relative to the anchor point.

4. **Bridge discovery** - `discoverBridgedDmpSections()` finds DMP sections that are connected to existing sections we already have geometry for, but weren't reached by either BFS. This handles the case where DMP sections A and B both connect to existing section X through separate `existing`-type connections but have no direct `importing`-type edge.

### Bridge Discovery Algorithm

```
For each existing-type connection where the DMP section isn't already shown:
  1. Look up the existing section's geometry in the geo map
  2. Find the merge station's position in that geometry
  3. Compute the DMP section's offset from the merge alignment
  4. Render the DMP section at that offset
  5. BFS from the bridged section to find its importing-type neighbors
  6. Offset all BFS results into the correct frame
```

### Deduplication

A `coveredExistingSectionIds` set tracks which existing section IDs have already been included. The direct target segment is processed first (most natural positioning), then import-side anchors, then bridged sections.

## Batch Import

When all suggestions are exhausted (or skipped), the placing phase proceeds:

1. `applyAllOverlapTreatments` processes all overlap suggestions → mutates `sectionEditsRef` + returns `ExistingShotUpdateLocal[]`
2. `buildBatchImport()` constructs the final `ImportSectionConfig[]`:
   1. Build adjacency from `importing`-type connections
   2. Find anchored sections (zero datum + `existing`-type connections)
   3. BFS from anchors to determine import order
   4. For disconnected components, search the full suggestion pool for fallback `existing`-type anchors
   5. Multi-pass emit: retry sections whose `from_importing` target hasn't been emitted yet
   6. Adjust station indices for deleted overlap shots
3. IPC call: `import_sections(sections, fileHash, existingShotUpdates)`

Sections unreachable after all passes remain in the wizard's manual segment-placement flow until the user places or discards them.

## Key Types

| Type | Location | Purpose |
|------|----------|---------|
| `VirtualConnection` | `src/utils/segmentContext.ts` | Client-side connection record |
| `ConfirmedOverlapInfo` | `src/components/Dialogs/DmpNewImportDialog.tsx` | Merge station choice per confirmed suggestion |
| `ExistingShotUpdateLocal` | `src/components/Dialogs/DmpNewImportDialog.tsx` | Frontend representation of existing shot modifications |
| `ExistingShotUpdate` | `src-tauri/src/models/section.rs` | Backend type for atomic existing shot modifications |
| `ExistingAnchor` | `src/utils/segmentContext.ts` | Position where a DMP section meets an existing section |
| `ExistingSectionGeoEntry` | `src/utils/segmentContext.ts` | Cached segment geometry with frame offset |
| `CrossSectionSuggestion` | `src-tauri/src/models/placement_suggest.rs` | Backend suggestion with score/confidence |
| `SegmentGeometry` | `src-tauri/src/commands/section.rs` | Backend segment shot-line data |
| `ContextSectionGeometry` | `src/components/Dialogs/SectionPreview.tsx` | Shot pairs for preview rendering |
| `SectionEditState` | `src/components/Dialogs/DmpNewImportDialog.tsx` | Per-section editable metadata + shots |

## Key Functions

| Function | Location | Purpose |
|----------|----------|---------|
| `applyAllOverlapTreatments` | `src/components/Dialogs/DmpNewImportDialog.tsx` | Single-pass overlap mutation for all suggestions |
| `buildBatchImport` | `src/components/Dialogs/DmpNewImportDialog.tsx` | Construct ordered `ImportSectionConfig[]` for backend |
| `buildAdjacency` | `src/utils/segmentContext.ts` | Adjacency map from `importing`-type connections |
| `computeDmpBfsContext` | `src/utils/segmentContext.ts` | BFS collecting DMP neighbor geometry + existing anchors |
| `stationPositionFromShotLines` | `src/utils/segmentContext.ts` | Extract XY from backend `shot_lines` (station 0 = `[0][0]`, station N = `[N-1][1]`) |
| `discoverBridgedDmpSections` | `src/utils/segmentContext.ts` | Find DMP sections connected through shared existing sections |
| `computeStationsFromDmpShots` | `src/components/Dialogs/SectionPreview.tsx` | XY station positions from DMP shot headings + lengths |
| `computeOverlapIds` | `src/utils/overlapHelpers.ts` | Set of import shot IDs in the overlap region |
| `computeActionableIds` | `src/utils/overlapHelpers.ts` | Subset of overlap IDs based on merge station choice |
| `computeTargetShotIndex` | `src/utils/overlapHelpers.ts` | Map import overlap ID → target section shot index |
| `interpolateShots` | `src/utils/overlapHelpers.ts` | Average two shots (circular mean for azimuths) |
| `reverseTargetShot` | `src/utils/overlapHelpers.ts` | Swap in/out and reverse azimuth by 180° |

## Backend Commands

| Command | Input | Output | Notes |
|---------|-------|--------|-------|
| `suggest_all_import_placements` | `ImportSectionForSuggestion[]` | `CrossSectionSuggestion[]` | Compares against existing + other imports |
| `get_segment_geometry` | `sectionId` | `SegmentGeometry` | All connected sections' shot-lines, centered on queried section |
| `import_sections` | `sections, fileHash, existingShotUpdates` | `CommandResult` | Batch import with atomic existing shot updates and undo support |

## Backend Safety Guards

The `execute_import_sections` function in `src-tauri/src/core/state/commands.rs` applies two guards before modifying existing section shots:

1. **Doubly-anchored filter**: For each affected section, if the modified shot range is straddled by positional constraints (zero datums, station merges, aligned closures) on both sides, updates for that section are silently skipped.

2. **Zero datum offset compensation**: For sections with a zero datum above the modified shots, the section offset (and all sections in the same rigid group) is adjusted after updates to keep the datum station at its original absolute position.

## Tests

Unit tests for the pure context-geometry functions live in `src/utils/__tests__/segmentContext.test.ts` (28 tests). Run with:

```bash
pnpm vitest run src/utils/__tests__/segmentContext.test.ts
```

Overlap helper tests: `src/utils/__tests__/overlapHelpers.test.ts`

Backend integration test for overlap interpolation: `src-tauri/src/core/state/tests.rs` (`kb5_import_overlap_interpolation_integration`, currently `#[ignore]`).
