# CaveChef TODO - Unimplemented Features

This document tracks functionality specified in SPEC.md but not yet implemented.

## Priority 1: Core Functionality

### DMP Parser
- [ ] Implement actual DMP file parsing in `src-tauri/src/parsers/dmp.rs`
- [ ] Currently returns empty sections (stub implementation)
- [ ] Need to port logic from `pytool_mnemo_lib` Python library
- [ ] Support DMP versions 2-5

### Undo/Redo System
- [ ] Implement proper state snapshots for undo
- [ ] Current implementation only tracks command history, doesn't restore state
- [ ] Add `UndoData` variants: `InverseCommand`, `StateDelta`, `Snapshot`
- [ ] Persist undo stack to SQLite `undo_stack` table

### File Operations
- [ ] Wire up Save/Open dialogs to actual file operations
- [ ] Implement "Save As" functionality
- [ ] Add file path to window title
- [ ] Recent projects list in GlobalView

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
- [ ] DMP file loading (once parser implemented)

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

### DMP Parser Priority
The DMP parser is the highest priority item as it's required for the primary use case (importing survey data from mNemo devices). Reference implementation exists in Python (`pytool_mnemo_lib`).

### Undo System Complexity
Full undo requires either:
1. State snapshots (memory intensive for large projects)
2. Inverse commands (complex for some operations)
3. State deltas (balanced approach)

Recommend starting with inverse commands for simple operations and snapshots for complex ones.

### Map Tool Architecture
Tools should be implemented as a state machine in `uiStore.ts` with handlers in `MapCanvas.tsx`. Each tool needs:
- Click handler
- Drag start/move/end handlers
- Keyboard modifiers (Shift, Ctrl)
- Cursor style
- Cancel (Escape) handling
