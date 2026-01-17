# CaveChef TODO - Unimplemented Features

This document tracks functionality specified in SPEC.md but not yet implemented.

**Last Updated**: 2026-01-17

---

## ✅ COMPLETED FEATURES

### Core Functionality
- [x] DMP Parser (versions 2-5) with IntBuffer, LRUD, pitch, temperature, time
- [x] Undo/Redo hybrid system with inverse commands and snapshots
- [x] File Operations: New/Open/Save with overwrite warnings, recent projects, safe save
- [x] Auto-save with dirty state indicator and prompt on close

### Map Interactions
- [x] All tools: Select, Pan, Zoom, Draw, Delete, Merge, Measure, Move Section/Station
- [x] Multi-select (Shift/Ctrl+click), box select, selection in DetailPanel
- [x] Context menu, snap-to-station, hover highlighting, drag preview
- [x] Scale bar (MapLibre ScaleControl)

### Dialogs
- [x] DialogWrapper with Escape handling and isDirty confirmation
- [x] All dialogs migrated: Confirm, Import, Export, Edit, Merge, NewProject, etc.
- [x] DmpImportDialog with section selection, direction display, date parsing

### Section & Station Management
- [x] Section position recalculation on merge (graph-based)
- [x] Visual indicators: merged connections (dashed cyan), loop closure lines
- [x] Loop closure error detection and percentage calculation

### UI Polish
- [x] Collapsible/resizable panels with persistence
- [x] All keyboard shortcuts (tools, panels, file ops, selection)
- [x] Validation warnings with mark-as-resolved
- [x] Statistics panel (project/section stats, penetration distance)
- [x] Display toggles dropdown menu
- [x] Shot data labels with progressive zoom density

### Testing Infrastructure
- [x] Playwright E2E tests with mocked IPC
- [x] WebdriverIO E2E tests for full app
- [x] data-testid attributes on dialogs and key UI elements
- [x] TESTING.md documentation

---

## 🚧 REMAINING v1.0 FEATURES

### Phase 1: Import Dialog Enhancements

| Feature | Status | Notes |
|---------|--------|-------|
| LRUD fields visible/editable | ❌ | Data imported but not shown in table |
| Pitch fields visible | ❌ | Data imported but not shown in table |
| Comment field per shot | ❌ | Not in import dialog |
| Live statistics in footer | ❌ | Total length, depth range, shot count |
| Inline validation warnings | ❌ | Show warnings during import |
| Section preview (live SVG) | ❌ | Visual preview as data is edited |

### Phase 2: Map Display Features

| Feature | Status | Notes |
|---------|--------|-------|
| Scale bar toggle | ✅ | Implemented via MapLibre ScaleControl |
| Section name labels | ❌ | Toggle exists, rendering at midpoints needed |
| Station index labels | ❌ | Show station numbers on map |

### Phase 3: GPS & Placement

| Feature | Status | Notes |
|---------|--------|-------|
| GPS coordinates input | ❌ | For zero datum in import dialog |
| Per-section adjustment dialog | ❌ | Offset/rotation per section |
| Manual map placement | ❌ | Click to position imported section |
| "From Existing Station" option | ❌ | Connect to existing station on import |

### Phase 4: GlobalView Enhancements

| Feature | Status | Notes |
|---------|--------|-------|
| GPS-based map view | ❌ | Show cave systems by GPS on map |
| Metadata side panel | ❌ | Click system to show details |
| Multi-select merge | ❌ | Select multiple systems, merge into one |

### Phase 5: Polish

| Feature | Status | Notes |
|---------|--------|-------|
| Direction field stored | ❌ | IN/OUT from DMP saved with section |
| Export preview thumbnail | ❌ | Preview before exporting |

---

## 🔮 DEFERRED TO v2.0+

### Loop Closure (v2.0)
- [ ] Error distribution strategies (Bowditch, equal, keep raw)
- [ ] Advanced loop closure algorithms (least squares)

### Performance & Offline
- [ ] Tile caching for offline satellite imagery
- [ ] Virtual scrolling in data table (for large surveys)
- [ ] deck.gl integration for 100k+ segments

### Display Features
- [ ] Depth color gradient rendering (UI toggle exists)
- [ ] LRUD passage wall visualization

### Future Versions
- SpeleoDB integration (v2.0)
- 3D visualization (v2.x)
- Profile views (v2.0)
- Ariane .ari import (v2.x)
- Mobile/web versions (v3.0+)
- Direct mNemo device communication (v3.0+)

---

## Architecture Notes

### Mutex Lock Ordering
Never hold a Mutex lock while calling methods that acquire other locks. Extract values first, then call methods.

### Safe File Save
Always use temp file + atomic rename pattern to prevent data loss on failed saves.

### Section Offset Tracking
When stations are merged, section offsets are stored in `Project.section_offsets: HashMap<SectionId, (f64, f64)>`.

### Database Operations
- `Database::open_existing()` for reading (doesn't create files)
- `Database::open()` for writing (creates if needed)
- Shot IDs: `section_id * 100000 + sequence`
