# DMP Import Wizard

The DMP import wizard (`DmpNewImportDialog`) is the primary UI for importing cave survey data from DistoX DMP files. It uses a connection-wizard pattern: the backend pre-computes placement suggestions, the user confirms or adjusts each one, and a batch import executes at the end.

## Wizard Phases

| Phase | What happens |
|-------|-------------|
| `init` | Import the zero-datum section (if provided), then call `suggest_all_import_placements` for all remaining sections |
| `suggesting` | Present suggestions one at a time; user confirms, edits, or skips each |
| `placing` | Apply all overlap treatments in a single pass, build batch `ImportSectionConfig[]`, and call `import_sections` |
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

### Duplicate Suggestions

A single import section can appear in the suggestion pool **multiple times** with different targets. For example, section 004 might have:
1. A front overlap with import section 001 (`targetType: 'importing'`)
2. A back overlap with existing section 002 (`targetType: 'existing'`)
3. A back overlap with import section 001 (`targetType: 'importing'`) — because import 001 shares shots with existing 002

The wizard only presents **one** suggestion per section (the highest-scoring one). However, the full pool is used by `applyAllOverlapTreatments` to treat ALL overlaps, not just the one the user confirmed.

## Overlap Handling

When a suggestion has `matchedShots > 0`, the wizard shows an overlap mode picker:

| Mode | Import side | Target side (import-to-import only) |
|------|------------|--------------------------------------|
| `interpolate` | Delete overlap shots | Interpolate target shots with import values (circular mean for azimuths) |
| `import_data` | Delete overlap shots | Replace target overlap shots with import values |
| `existing_data` | Delete overlap shots | Target keeps its own values (no change) |
| `keep_both` | Mark overlap shots as `is_reference` (dotted lines in UI) | No change |

The overlap mode is persisted to the project config and applies globally to all overlaps in a single import session.

### Import-to-Existing vs Import-to-Import

For all modes except `keep_both`, the import section's overlap shots are **always deleted** — regardless of whether the target is an existing project section or another import section. The existing/importing section already has the overlap data, so keeping it on the import side would create duplicate shots.

The difference between the two target types is on the **target side**:

- **Import-to-existing**: The existing section is already in the project and cannot be modified. The overlap mode only affects which shots survive on the import side (deleted for non-keep_both, reference for keep_both).
- **Import-to-import**: Both sections are being imported. The target section's overlap shots are treated according to the overlap mode (interpolated, replaced with import values, or left unchanged).

### Merge Station Picker

When multiple overlap offsets are possible, a dropdown lets the user choose which station pair to merge at. This controls which shots are "actionable" (subject to the overlap mode) versus past-merge (deleted at import).

The merge station choice is recorded in `ConfirmedOverlapInfo` and used during the centralized overlap treatment pass.

### `is_reference` Semantics

The `is_reference` flag on shots has a single, well-defined meaning: **the shot is a reference copy kept for context in `keep_both` mode**. Reference shots are rendered as dotted lines in the survey view.

`is_reference` is NOT used in `interpolate`, `import_data`, or `existing_data` modes. It is NOT used as an internal guard against double-treatment (the `treatedShots` mechanism handles that — see below).

## Centralized Overlap Treatment

### Architecture

All overlap mutation happens in a single function, `applyAllOverlapTreatments`, which runs **once** in the `placing` phase before `buildBatchImport`. The `handleConfirm` callback (suggesting phase) does NOT mutate overlap shots — it only records virtual connections and merge station choices.

```
suggesting phase:
  handleConfirm → records VirtualConnection + ConfirmedOverlapInfo
                → saves raw user edits to sectionEditsRef (NO overlap treatment)

placing phase:
  applyAllOverlapTreatments → processes ALL pool suggestions in one pass
                            → uses merge station from ConfirmedOverlapInfo
                            → writes to sectionEditsRef
  buildBatchImport → reads sectionEditsRef
```

This replaces an earlier design where overlap mutations were spread across three call sites (`handleConfirm` import-side, `handleConfirm` target-side, and a `finalizeOverlapTreatments` catch-all), which was fragile and led to untreated overlaps.

### `ConfirmedOverlapInfo`

When the user confirms a suggestion, `handleConfirm` records merge station details in `confirmedOverlapsRef` (a `Map<number, ConfirmedOverlapInfo>` keyed by import section index):

```typescript
interface ConfirmedOverlapInfo {
  importStationIndex: number;
  matchedShots: number;
  direction: 'forward' | 'reverse';
  existingStationIndex: number;
  targetType: 'existing' | 'importing';
  existingSectionId: number | null;
  targetImportIndex: number | null;
  mergeImportStation: number;  // user-selected merge station
}
```

Matching against pool suggestions uses field comparison (not reference equality) via `matchesConfirmed()`, which survives save/restore across manual placement handoffs.

**Caveat**: The map is keyed by `importSectionIndex`, so if a section has overlaps at both ends (front and back), only the last-confirmed suggestion's merge station is recorded. Unconfirmed suggestions use the full overlap range, which is the correct default.

### `treatedShots` Guard

A `Set<string>` with keys formatted as `"sectionIndex:shotId"` tracks which shots have already been processed. This prevents double-treatment when a section appears in multiple pool suggestions (see "Duplicate Suggestions" above).

The `treatedShots` guard replaced an earlier approach that used the `is_reference` flag as a double-treatment guard. That approach broke when `is_reference` was correctly limited to `keep_both` mode only.

### Processing Order

`applyAllOverlapTreatments` iterates through the full suggestion pool in pool order (highest score first). For each suggestion with `matchedShots > 0`:

1. **Determine actionable IDs**: If the suggestion matches a confirmed overlap entry, use `computeActionableIds` with the recorded merge station. Otherwise, use all overlap IDs (`computeOverlapIds`).

2. **Import-side treatment**: For each actionable shot ID on the import section:
   - Skip if already in `treatedShots`
   - `keep_both`: Set `is_reference: true`
   - All other modes: Set `isDeleted: true` (regardless of target type)
   - Add to `treatedShots`

3. **Target-side treatment** (import-to-import only, non-keep_both):
   - Uses **raw** (pre-treatment) import shots to avoid asymmetric averaging
   - For each actionable shot mapped to a target shot:
     - Skip if target shot is deleted or already in `treatedShots`
     - `interpolate`: Average target with raw import values
     - `existing_data`: No change (target keeps its own values)
     - `import_data`: Replace target with import values
     - Add to `treatedShots`

### Raw Import Shots for Target-Side Treatment

The target-side treatment uses `rawImportShots` — a snapshot taken **before** import-side treatment runs. This is necessary because import-side treatment marks overlap shots as `isDeleted`, and the target side needs the original import values for interpolation. Without the snapshot, `find(s => !s.isDeleted && s.id === overlapId)` would return `null` for every overlap shot.

### Direction Reversal

When the import and target sections run in opposite directions, target shot values must be reversed before comparison. The `needsDirectionReversal` function determines this from the combination of import station index (front vs back) and match direction (forward vs reverse):

| importStationIndex | direction | needsReversal |
|--------------------|-----------|---------------|
| 0 (Front)          | forward   | false         |
| 0 (Front)          | reverse   | true          |
| >0 (Back)          | forward   | true          |
| >0 (Back)          | reverse   | false         |

Reversal swaps azimuth_in/out (+180°), depth_in/out, pitch_in/out (negated), and left/right.

### Post-Pass Safety Net

After processing all suggestions, the function checks for sections where ALL shots are deleted. This can happen when a short section has overlaps at both ends — it's the "import" side for both, and each overlap deletes its range:

```
Section 004: 4 shots total
  Front overlap with 001 → shots 0,1 deleted
  Back overlap with 002  → shots 2,3 deleted
  Result: 0 alive shots → section would disappear
```

The safety net converts all deletions to `is_reference` instead, preserving the section with reference-only shots. Adjacent target sections retain the overlap shots with treated values, so no data is lost.

## `effectiveShots` Preview

The `effectiveShots` useMemo provides a **preview** of how shots will look after overlap treatment. It runs during the `suggesting` phase for visual feedback and does NOT mutate `sectionEditsRef`. It applies the same logic as `applyAllOverlapTreatments` but only for the current suggestion being shown.

## Section Editing

Each DMP section can be edited before import:
- **Metadata**: name, surveyor, date, color, direction, quality
- **Shots**: add, delete, insert before/after, modify values

Edit state is stored in `sectionEditsRef` (a `Map<number, SectionEditState>`) and restored when the user revisits a section. Overlap shots within the "frozen" range cannot be manually deleted (controlled by `frozenShotIndices`).

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
2. Find anchored sections (zero datum + `existing`-type connections + direct placements)
3. BFS from anchors to determine import order
4. For disconnected components, search the full suggestion pool for fallback `existing`-type anchors
5. Multi-pass emit: retry sections whose `from_importing` target hasn't been emitted yet
6. Adjust station indices for deleted overlap shots via `adjustStationForDeletedShots`

Sections unreachable after all passes are handed off to the legacy import dialog.

### Station Index Adjustment

When overlap shots are deleted (import-to-import, non-keep_both modes), station indices shift. The `adjustStationForDeletedShots` function counts non-deleted shots before the original station position to compute the adjusted index in the filtered shot array. This ensures merge stations in the `ImportSectionConfig` point to the correct position after overlap shots are removed.

## Diagnostic Logging

In development mode (`import.meta.env.DEV`), both `applyAllOverlapTreatments` and `buildBatchImport` emit detailed console warnings:

- `[applyAllOverlaps] processing suggestion:` — logs each suggestion with its parameters and whether it matches a confirmed overlap
- `[applyAllOverlaps] import N RESULT:` — logs treatment counts (deleted, already-treated)
- `[applyAllOverlaps] import N AFTER:` — logs total/alive/deleted/reference shot counts after treatment
- `[applyAllOverlaps] target N RESULT:` — logs target-side treatment counts
- `[applyAllOverlaps] Section N would have 0 shots` — logs safety net activation
- `[buildBatchImport]` — logs skip reasons (0 shots, no connection, deferred target, reachable-but-not-emitted)

## Key Types

| Type | Location | Purpose |
|------|----------|---------|
| `VirtualConnection` | `src/utils/segmentContext.ts` | Client-side connection record |
| `ConfirmedOverlapInfo` | `src/components/Dialogs/DmpNewImportDialog.tsx` | Merge station + suggestion fields for confirmed overlaps |
| `ExistingAnchor` | `src/utils/segmentContext.ts` | Position where a DMP section meets an existing section |
| `ExistingSectionGeoEntry` | `src/utils/segmentContext.ts` | Cached segment geometry with frame offset |
| `CrossSectionSuggestion` | `src-tauri/src/models/placement_suggest.rs` | Backend suggestion with score/confidence |
| `SegmentGeometry` | `src-tauri/src/commands/section.rs` | Backend segment shot-line data |
| `ContextSectionGeometry` | `src/components/Dialogs/SectionPreview.tsx` | Shot pairs for preview rendering |
| `SectionEditState` | `src/components/Dialogs/DmpNewImportDialog.tsx` | Per-section editable metadata + shots |
| `SavedManualPlacingState` | `src/components/Dialogs/DmpNewImportDialog.tsx` | State snapshot for manual placement handoff |

## Key Functions

| Function | Location | Purpose |
|----------|----------|---------|
| `applyAllOverlapTreatments` | `src/components/Dialogs/DmpNewImportDialog.tsx` | Single-pass overlap treatment for all pool suggestions |
| `matchesConfirmed` | `src/components/Dialogs/DmpNewImportDialog.tsx` | Field-compare a pool suggestion against confirmed overlap info |
| `adjustStationForDeletedShots` | `src/components/Dialogs/DmpNewImportDialog.tsx` | Recompute station index after overlap deletions |
| `buildBatchImport` | `src/components/Dialogs/DmpNewImportDialog.tsx` | Construct ordered `ImportSectionConfig[]` for backend |
| `buildAdjacency` | `src/utils/segmentContext.ts` | Adjacency map from `importing`-type connections |
| `computeDmpBfsContext` | `src/utils/segmentContext.ts` | BFS collecting DMP neighbor geometry + existing anchors |
| `stationPositionFromShotLines` | `src/utils/segmentContext.ts` | Extract XY from backend `shot_lines` (station 0 = `[0][0]`, station N = `[N-1][1]`) |
| `discoverBridgedDmpSections` | `src/utils/segmentContext.ts` | Find DMP sections connected through shared existing sections |
| `computeStationsFromDmpShots` | `src/components/Dialogs/SectionPreview.tsx` | XY station positions from DMP shot headings + lengths |
| `computeOverlapIds` | `src/utils/overlapHelpers.ts` | Compute import shot IDs in the overlap region |
| `computeActionableIds` | `src/utils/overlapHelpers.ts` | Subset of overlap IDs up to merge station |
| `computeTargetShotIndex` | `src/utils/overlapHelpers.ts` | Map overlap shot ID to target section shot index |
| `needsDirectionReversal` | `src/utils/overlapHelpers.ts` | Whether target shots need reversal for direction match |
| `interpolateShots` | `src/utils/overlapHelpers.ts` | Average two shots (circular mean for azimuths) |

## Backend Commands

| Command | Input | Output | Notes |
|---------|-------|--------|-------|
| `suggest_all_import_placements` | `ImportSectionForSuggestion[]` | `CrossSectionSuggestion[]` | Compares against existing + other imports |
| `get_segment_geometry` | `sectionId` | `SegmentGeometry` | All connected sections' shot-lines, centered on queried section |
| `import_sections` | `ImportSectionConfig[], fileHash` | `CommandResult` | Batch import with undo support |

## Tests

- **Context geometry**: `src/utils/__tests__/segmentContext.test.ts` (28 tests) — pure context-geometry functions
- **DMP parse regression**: `src-tauri/src/parsers/dmp.rs` (`kb5_parse_regression`, `#[ignore]`) — validates section structure, shot counts, and key shot data for kb5.dmp
- **Suggestion regression**: `src-tauri/src/parsers/dmp.rs` (`kb5_suggestions_regression`, `#[ignore]`) — validates cross-section suggestions including the duplicate-suggestion topology that triggered the double-treatment bug

```bash
pnpm vitest run src/utils/__tests__/segmentContext.test.ts
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored kb5_parse_regression
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored kb5_suggestions_regression
```
