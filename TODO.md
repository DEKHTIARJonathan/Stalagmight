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

## Priority 2: Map Interactions

### Tool Implementations
- [ ] **Draw Tool**: Click station to start new shot, input azimuth/length/depth
- [ ] **Delete Tool**: Click to delete station/shot with confirmation
- [ ] **Merge Tool**: Select two stations, show MergeDialog
- [ ] **Measure Tool**: Click two points to measure distance
- [ ] **Move Section Tool**: Drag unanchored sections
- [ ] **Move Station Tool**: Drag unanchored stations

### Selection
- [ ] Multi-select with Shift+click (add) and Ctrl+click (toggle)
- [ ] Box select with drag
- [ ] Selection state reflected in DetailPanel

### Map Features
- [ ] Context menu on right-click (Edit, Delete, Mark Virtual, etc.)
- [ ] Snap to station when within threshold
- [ ] Hover highlighting
- [ ] Drag preview before release

## Priority 3: Dialogs

### MergeDialog
- [ ] Create `src/components/Dialogs/MergeDialog.tsx`
- [ ] Show station details and distance/depth difference
- [ ] Loop closure error calculation and display
- [ ] Closure strategy selection (proportional, equal, raw, manual)

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

## Priority 4: Loop Closure

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
- [ ] Implement all shortcuts from SPEC.md Appendix A
- [ ] Currently only basic tool shortcuts defined
- [ ] Add: Ctrl+I (Import), Ctrl+E (Export), Ctrl+0 (Fit to View)
- [ ] Delete/Backspace for selected items

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

### Map Tool Architecture
Tools should be implemented as a state machine in `uiStore.ts` with handlers in `MapCanvas.tsx`. Each tool needs:
- Click handler
- Drag start/move/end handlers
- Keyboard modifiers (Shift, Ctrl)
- Cursor style
- Cancel (Escape) handling
