# DMP Import Wizard

The DMP import wizard (`DmpNewImportDialog`) is the primary UI for importing cave survey data from DistoX DMP files. It uses a connection-wizard pattern: the backend pre-computes placement suggestions, the user confirms or adjusts each one, and a batch import executes at the end.

## Wizard Phases

| Phase | What happens |
|-------|-------------|
| `init` | Import the zero-datum section (if provided), then call `suggest_all_import_placements` for all remaining sections |
| `suggesting` | Present suggestions one at a time; user confirms, edits, or skips each |
| `placing` | Build batch `ImportSectionConfig[]` from virtual connections and call `import_sections` |
| `done` | All sections placed, or hand off unreachable sections to legacy dialog |

## Virtual Connections

During the `suggesting` phase, confirmed placements are recorded as **virtual connections** — lightweight client-side records that describe how two sections should be joined. No backend call happens until the `placing` phase.

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

- `importSectionIndex` / `existingStationIndex` — which stations to merge
- `matchedShots` / `direction` — how many shots overlapped and in which direction
- `confidence` — `high` / `medium` / `low` tier
- `targetType` — `existing` or `importing`
- `score` — aggregate match score (higher is better)

The wizard picks the top suggestion for each unplaced section and shows alternatives for the same section.

## Overlap Handling

When a suggestion has `matchedShots > 0`, the wizard shows an overlap mode picker:

| Mode | Behavior |
|------|----------|
| `interpolate` | Average import + target shot data for overlap region |
| `import_data` | Keep import values, mark as reference |
| `existing_data` | Replace with target values |
| `keep_both` | Keep both sets of shots (no deletion) |

The overlap mode is persisted to the project config. For all modes except `keep_both`, overlap shots are deleted from the import section at confirm time — only the non-overlapping shots survive in the final import.

### Merge Station Picker

When multiple overlap offsets are possible, a dropdown lets the user choose which station pair to merge at. This controls which shots are "actionable" (subject to the overlap mode) versus past-merge (deleted at import).

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

1. **Import-side BFS** — `computeDmpBfsContext(importIdx, ...)` walks `importing`-type virtual connections from the current import section, collecting:
   - DMP neighbor geometry (positioned relative to the import section)
   - Existing anchors (positions where DMP sections connect to project sections)

2. **Target-side handling**:
   - `existing` target: Fetch `get_segment_geometry(existingSectionId)` from backend. This returns all sections in that segment with shot-line geometry in a coordinate frame centered on the queried section.
   - `importing` target: Run a second BFS from the target DMP section to gather its neighbors and existing anchors.

3. **Existing anchor resolution** — For each `ExistingAnchor` discovered by BFS (either side), fetch `get_segment_geometry` and position the result relative to the anchor point.

4. **Bridge discovery** — `discoverBridgedDmpSections()` finds DMP sections that are connected to existing sections we already have geometry for, but weren't reached by either BFS. This handles the case where DMP sections A and B both connect to existing section X through separate `existing`-type connections but have no direct `importing`-type edge.

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

When all suggestions are exhausted (or skipped), `buildBatchImport()` constructs the final `ImportSectionConfig[]`:

1. Build adjacency from `importing`-type connections
2. Find anchored sections (zero datum + `existing`-type connections)
3. BFS from anchors to determine import order
4. For disconnected components, search the full suggestion pool for fallback `existing`-type anchors
5. Multi-pass emit: retry sections whose `from_importing` target hasn't been emitted yet
6. Adjust station indices for deleted overlap shots

Sections unreachable after all passes are handed off to the legacy import dialog.

## Key Types

| Type | Location | Purpose |
|------|----------|---------|
| `VirtualConnection` | `src/utils/segmentContext.ts` | Client-side connection record |
| `ExistingAnchor` | `src/utils/segmentContext.ts` | Position where a DMP section meets an existing section |
| `ExistingSectionGeoEntry` | `src/utils/segmentContext.ts` | Cached segment geometry with frame offset |
| `CrossSectionSuggestion` | `src-tauri/src/models/placement_suggest.rs` | Backend suggestion with score/confidence |
| `SegmentGeometry` | `src-tauri/src/commands/section.rs` | Backend segment shot-line data |
| `ContextSectionGeometry` | `src/components/Dialogs/SectionPreview.tsx` | Shot pairs for preview rendering |
| `SectionEditState` | `src/components/Dialogs/DmpNewImportDialog.tsx` | Per-section editable metadata + shots |

## Key Functions

| Function | Location | Purpose |
|----------|----------|---------|
| `buildAdjacency` | `src/utils/segmentContext.ts` | Adjacency map from `importing`-type connections |
| `computeDmpBfsContext` | `src/utils/segmentContext.ts` | BFS collecting DMP neighbor geometry + existing anchors |
| `stationPositionFromShotLines` | `src/utils/segmentContext.ts` | Extract XY from backend `shot_lines` (station 0 = `[0][0]`, station N = `[N-1][1]`) |
| `discoverBridgedDmpSections` | `src/utils/segmentContext.ts` | Find DMP sections connected through shared existing sections |
| `computeStationsFromDmpShots` | `src/components/Dialogs/SectionPreview.tsx` | XY station positions from DMP shot headings + lengths |
| `buildBatchImport` | `src/components/Dialogs/DmpNewImportDialog.tsx` | Construct ordered `ImportSectionConfig[]` for backend |

## Backend Commands

| Command | Input | Output | Notes |
|---------|-------|--------|-------|
| `suggest_all_import_placements` | `ImportSectionForSuggestion[]` | `CrossSectionSuggestion[]` | Compares against existing + other imports |
| `get_segment_geometry` | `sectionId` | `SegmentGeometry` | All connected sections' shot-lines, centered on queried section |
| `import_sections` | `ImportSectionConfig[], fileHash` | `CommandResult` | Batch import with undo support |

## Tests

Unit tests for the pure context-geometry functions live in `src/utils/__tests__/segmentContext.test.ts` (28 tests). Run with:

```bash
pnpm vitest run src/utils/__tests__/segmentContext.test.ts
```
