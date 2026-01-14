# CaveChef TODO - Unimplemented Features

This document tracks functionality specified in SPEC.md but not yet implemented.

## Priority 1: Core Functionality ✅ COMPLETE

### DMP Parser ✅
- [x] Implement actual DMP file parsing in `src-tauri/src/parsers/dmp.rs`
- [x] Ported logic from `pytool_mnemo_lib` Python library
- [x] Support DMP versions 2-5
- [x] IntBuffer for binary reading, section/shot parsing
- [x] Integration tests with real v2 and v5 test files

### Undo/Redo System ✅
- [x] Implement hybrid undo with state snapshots and inverse commands
- [x] `UndoData` variants: `InverseCommand`, `PreviousValues`, `SectionSnapshot`, `ShotSnapshot`, `MergeInfo`, `ZeroDatumInfo`, `ProjectSnapshot`
- [x] Full undo/redo execution with proper state restoration
- [ ] Persist undo stack to SQLite `undo_stack` table (deferred)

### File Operations ✅
- [x] NewProjectDialog for creating projects
- [x] DmpImportDialog for importing mNemo DMP files with section selection
- [x] Save/Open dialogs wired to actual file operations
- [ ] Add file path to window title (minor, deferred)
- [ ] Recent projects list in GlobalView (minor, deferred)

## Priority 2: Map Interactions ✅ COMPLETE

### Tool Implementations ✅
- [x] **Draw Tool**: Click station to start new shot, input azimuth/length/depth
- [x] **Delete Tool**: Click to delete station/shot with confirmation
- [x] **Merge Tool**: Select two stations, show MergeDialog
- [x] **Measure Tool**: Click two points to measure distance
- [x] **Move Section Tool**: Drag unanchored sections
- [x] **Move Station Tool**: Drag unanchored stations

### Selection ✅
- [x] Multi-select with Shift+click (add) and Ctrl+click (toggle)
- [x] Box select with drag
- [x] Selection state reflected in DetailPanel

### Map Features ✅
- [x] Context menu on right-click (Edit, Delete, Mark Virtual, etc.)
- [ ] Snap to station when within threshold (deferred)
- [x] Hover highlighting
- [x] Drag preview before release

## Priority 3: Dialogs ✅ PARTIAL

### MergeDialog ✅
- [x] Create `src/components/Dialogs/MergeDialog.tsx`
- [x] Show station details and distance/depth difference
- [x] Loop closure error calculation and display
- [x] Closure strategy selection (proportional, equal, raw, manual)

### ImportDialog Enhancements
- [ ] Live preview rendering as data is edited
- [ ] GPS coordinates input for zero datum
- [ ] "From Existing Station" placement option
- [ ] Manual map placement (click to position)
- [x] DMP file loading (implemented in DmpImportDialog)

### ExportDialog Enhancements
- [ ] PDF export (currently only SVG implemented)
- [ ] Resolution/DPI options for PNG
- [ ] Preview of export

## Priority 4: Loop Closure & Section Positioning

### Section Position Recalculation (Bug 9)
- [ ] When stations are merged, recalculate section positions
  - Build a graph of section connections through merges
  - Pick an anchor section (first section or one with zero datum)
  - Calculate offsets for connected sections so merged stations share coordinates
  - Apply offsets to section station coordinates
- [ ] Visual indicator for merged station connections

### Loop Closure Error Handling
- [ ] Detect when merge creates a loop
- [ ] Calculate closure error percentage
- [ ] Implement error distribution strategies:
  - [ ] Proportional by shot length (Bowditch method)
  - [ ] Equal across all shots
  - [ ] Keep raw data
- [ ] Visual indicator for loop closure lines

## Priority 5: UI Polish

### Panels
- [ ] Collapsible Data Table panel (currently always visible area)
- [ ] Resizable panel persistence (save sizes to config)
- [ ] Panel keyboard shortcuts (Ctrl+1, Ctrl+2, Ctrl+3)

### GlobalView
- [ ] Display cave systems positioned by GPS on map
- [ ] Click system to show metadata in side panel
- [ ] Double-click to open in SingleSystemView
- [ ] Multi-select for merging systems
- [ ] Empty state message with prominent action buttons

### Keyboard Shortcuts
- [x] Tool shortcuts (S, P, Z, D, X, M, R, V, T)
- [x] Delete/Backspace for selected items
- [x] Escape to clear selection and tool state
- [x] Ctrl+Z/Y for undo/redo
- [x] Ctrl+S to save
- [x] Ctrl+1/2/3 to toggle panels
- [ ] Add: Ctrl+I (Import), Ctrl+E (Export), Ctrl+0 (Fit to View)
- [ ] Ctrl+A (Select All)

### Validation Warnings
- [ ] Display validation warnings in UI (currently only logged)
- [ ] Warning icon (⚠) in data table rows
- [ ] "Mark as resolved" option
- [ ] Warning panel/list

## Priority 6: Performance & Offline

### Tile Caching
- [ ] Cache satellite tiles on first use for offline access
- [ ] Configurable cache size limit
- [ ] Cache management UI

### Large Dataset Optimization
- [ ] Consider deck.gl for rendering large surveys (100k+ segments)
- [ ] Virtual scrolling in data table
- [ ] Incremental rendering

## Priority 7: Additional Features

### Auto-save
- [ ] Implement auto-save timer (config exists, not wired up)
- [ ] Dirty state indicator in UI
- [ ] Prompt to save on close

### Statistics
- [ ] Project statistics panel
- [ ] Section statistics in DetailPanel
- [ ] Penetration distance calculation

### Display Options
- [ ] Depth color gradient toggle
- [ ] LRUD passage wall visualization
- [ ] Shot data labels (azimuth, length, depth)
- [ ] Configurable display toggles menu

## Out of Scope (Future Versions)

These are explicitly deferred per SPEC.md:
- SpeleoDB integration (v2.0)
- 3D visualization (v2.x)
- Profile views (v2.0)
- Ariane .ari import (v2.x)
- Mobile/web versions (v3.0+)
- Direct mNemo device communication (v3.0+)

---

## Implementation Notes

### DMP Parser ✅ IMPLEMENTED
Ported from `pytool_mnemo_lib` Python library to Rust. Supports versions 2-5 with:
- `IntBuffer` struct for sequential binary reading
- Section splitting by end-of-section markers
- Version-specific shot parsing (core fields, LRUD, temperature, time)
- `DmpImportDialog` for file selection and section import

### Undo System ✅ IMPLEMENTED
Hybrid approach using:
- **Inverse commands** for create/toggle operations (CreateSection→DeleteSection)
- **Previous values** (JSON) for update operations
- **Snapshots** for delete operations (full section/shot data for restoration)
- **Project snapshots** for batch operations

### Map Tool Architecture ✅ IMPLEMENTED
Tools implemented as a state machine in `uiStore.ts` with `useMapTools` hook for handlers:
- `SurveyLayer.tsx` handles map click/hover events and calls callbacks
- `useMapTools.ts` dispatches actions based on active tool
- `MapCanvas.tsx` handles drag operations (box select, move tools)
- Tool state: `mergeStationA/B`, `measureStart/End`, `drawFromStation`
- Dialogs: `ConfirmDialog`, `MergeDialog`, `DrawShotDialog`
- `ContextMenu` for right-click actions on stations/shots
