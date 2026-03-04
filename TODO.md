# Stalagmight TODO

Tracks v1.0 spec completion and user testing feedback.

**Last Updated**: 2026-03-04

---

## Summary

| Category | Done | Total | Progress |
|----------|------|-------|----------|
| Import/Export | 19 | 19 | 100% |
| UI & Polish | 17 | 18 | 94% |
| Data & Editing | 5 | 5 | 100% |
| Loop Closure | 5 | 5 | 100% |
| Accessibility & i18n | 7 | 7 | 100% |
| Performance & Stability | 9 | 9 | 100% |
| Integrations | 0 | 3 | 0% |
| Testing | 0 | 1 | 0% |
| User Testing: Bugs | 0 | 7 | 0% |
| User Testing: UX | 0 | 5 | 0% |
| User Testing: Features | 0 | 5 | 0% |
| **Total** | **62** | **82** | **76%** |

---

## ✅ Completed Features

### Core Functionality
- [x] DMP Parser (versions 2-5) with IntBuffer, LRUD, pitch, temperature, time
- [x] Undo/Redo hybrid system with inverse commands and snapshots
- [x] File Operations: New/Open/Save with overwrite warnings, recent projects, safe save
- [x] Dirty state indicator and prompt on close

### Map Interactions
- [x] All tools: Select, Pan, Zoom, Draw, Delete, Merge, Measure, Move Station/Segment/Shot
- [x] Multi-select (Shift/Ctrl+click), box select, selection in DetailPanel
- [x] Context menu, snap-to-station, hover highlighting, drag preview
- [x] Scale bar (MapLibre ScaleControl)
- [x] Satellite map tile caching
- [x] Depth gradient display with legend

### Dialogs & Settings
- [x] DialogWrapper with Escape handling and isDirty confirmation
- [x] All dialogs migrated: Confirm, Import, Export, Edit, Merge, NewProject, etc.
- [x] Settings dialog with 9 tabs (General, Units, Display, Map, Validation, Export, Shortcuts, Cache, Advanced)
- [x] Configurable keyboard shortcuts

### Section & Station Management
- [x] Section position recalculation on merge (graph-based)
- [x] Visual indicators: merged connections (dashed cyan), loop closure lines
- [x] Loop closure error detection and percentage calculation

### Testing Infrastructure
- [x] Playwright E2E tests with mocked IPC
- [x] WebdriverIO E2E tests for full app
- [x] data-testid attributes on dialogs and key UI elements

---

## 🚧 v1.0 Remaining Tasks

### Import/Export (17/19 done)

| Task | Status | Notes |
|------|--------|-------|
| DMP Import (two-step workflow) | ✅ | DmpSelectionDialog + DmpSectionConfigDialog |
| Shared ShotTableEditor | ✅ | |
| Shared SectionMetadataForm | ✅ | |
| Enhanced SectionPreview | ✅ | |
| Session Surveyor Memory | ✅ | |
| Validation Thresholds in Import | ✅ | |
| Merge Preview Visualization | ✅ | |
| Manual Placement Mode | ✅ | |
| Section Creation Logic | ✅ | |
| Context-Aware Triggering | ✅ | |
| Error Blocking Logic | ✅ | |
| Export Dialog & Preview | ✅ | PNG, SVG, PDF, CSV, JSON |
| File Hash Tracking | ✅ | |
| Ariane .tml Import | ✅ | TML/TMLU parser, section linearization, excluded shot filtering |
| Ariane .tml Export | ✅ | TML (ZIP) and TMLU (plain XML) export |
| GPX Import | ✅ | Waypoints, tracks, routes; elevation→depth with slope distance; depth sign toggle |
| Manual Data Input | ✅ | Spreadsheet-style entry with validation, LRUD toggle, placement mode, decimal precision |
| Automatic Reference Shot Alignment | ✅ | Auto-align imported sections using reference shots |
| Import Dialog/Shot Placement Refactoring | ✅ | Improve shot placement UX in import workflow |

**Subtotals**: ✅ 19 done, ❌ 0 not started

### UI & Polish (16/18 done)

| Task | Status | Notes |
|------|--------|-------|
| Collapsible/resizable panels | ✅ | With persistence |
| Display toggles dropdown | ✅ | DisplayMenu component |
| Shot data labels (zoom density) | ✅ | |
| Statistics panel | ✅ | Project/section stats, penetration distance |
| Tool Panel Redesign | ✅ | |
| Tile Caching Settings | ✅ | CacheSettings.tsx + Rust config |
| Three-Level Settings Reset | ✅ | Per-setting, per-tab, full reset (SPEC 2.9) |
| Automatic Reference Shot Alignment Settings | ✅ | PlacementSuggestionConfig exposed in Advanced Settings with 19 tunable fields |
| Fix Undo Stack Section Modification Details | ✅ | Only shows changed fields; includes closure adjustment weight |
| Fix Section Hyperlink Highlighting Not Clearing | ✅ | Highlight persists after navigating away from section link |
| Splash Screen | ✅ | React overlay with branding; opt-in via Settings > General > Startup |
| About Dialog | ✅ | AlertDialog in Settings footer |
| Keyboard Shortcuts Overlay | ✅ | Help overlay showing all shortcuts |
| Custom Icons for All Tools/SVGs | ✅ | Custom icon set for toolbar and UI elements |
| Bug Reporter Dialog | ✅ | Debug log dialog with ring buffer, level filtering, colored output |
| Release Automation | ✅ | |
| Add Comment Tool | ✅ | Comment + Move Comment tools with atomic undo, swap dialog, visual pickup |
| Use Best Available Tile Resolution | ✅ | ArcGIS tilemap API + parent tile fallback with upscaling |

**Subtotals**: ✅ 17 done, ❌ 1 not started

### Data & Editing (5/5 done)

| Task | Status | Notes |
|------|--------|-------|
| Inline Editing | ✅ | EditableTable with EditableCell |
| Add Row | ✅ | Context menu, DrawShotDialog, prepend mode |
| Delete Row with Split | ✅ | |
| Row Highlighting Sync | ✅ | |
| Virtual Scrolling | ✅ | @tanstack/react-virtual in EditableTable |

**Subtotals**: ✅ 5 done, ❌ 0 not started

### Loop Closure (5/5 done)

| Task | Status | Notes |
|------|--------|-------|
| Loop Detection Algorithm | ✅ | |
| Closure Error Calculation | ✅ | |
| Closure Strategy Selector | ✅ | ClosureDialog with 4 strategies |
| Closure Alignment Locks Movement | ✅ | Unaligned closures move independently; aligned closures move together |
| Fix Quality Setting → Closure Weight | ✅ | Quality setting incorrectly sets properties; rename/refactor to closure weight |

**Subtotals**: ✅ 5 done, ❌ 0 not started

### Accessibility & i18n (7/7 done)

| Task | Status | Notes |
|------|--------|-------|
| Focus Management | ✅ | |
| Screen Reader Announcements | ✅ | aria-live regions, announceSelection() |
| Theme Infrastructure | ✅ | |
| Keyboard Navigation | ✅ | useKeyboardShortcuts, ShortcutRecorder |
| i18n Infrastructure | ✅ | |
| Extract UI Strings | ✅ | |
| Number/Date Locale Formatting | ✅ | |

**Subtotals**: ✅ 7 done, ❌ 0 not started

### Performance & Stability (9/9 done)

| Task | Status | Notes |
|------|--------|-------|
| Loading States | ✅ | LoadingProgress component with aria-live |
| Network Error Stats | ✅ | Real tile fetch stats via Rust atomic counters + IPC |
| Debounced Auto-Save | ✅ | 2-second debounce timer with status bar indicator |
| SQLite Integrity Checks | ✅ | PRAGMA quick_check on open + full integrity_check on-demand (SPEC 14.4) |
| Error Boundary Wrapper | ✅ | Wraps Sections, Map, Data Table, Details panels |
| Network Retry Logic | ✅ | Max 2 retries with 200ms/500ms backoff on transport errors |
| Improve Algorithm/Workflow Tracing | ✅ | Warnings on recoverable errors, debug prints in all major algorithms |
| File Corruption Recovery | ✅ | Recovery dialog with repair, backup restore, data salvage (SPEC 14.4) |
| Validation Error Recovery | ✅ | X dismiss per warning, Clear All bulk resolve, auto-clear on fix, persistent (SPEC 14.5) |

**Subtotals**: ✅ 9 done

### Integrations (0/1 done)

| Task | Status | Notes |
|------|--------|-------|
| SpeleoDB Integration | ❌ | Bidirectional sync, authentication, conflict resolution |
| SpeleoDB Lock/Unlock | ❌ | Acquire project lock from within Stalagmight so users don't need to visit SpeleoDB separately *(transcript ~line 1289)* |
| GeoJSON Export for SpeleoDB | ❌ | Write both Stalagmight + GeoJSON files on save/push, works without upstream changes *(~line 1371)* |

**Subtotals**: ❌ 3 not started

### Testing (0/1 done)

| Task | Status | Notes |
|------|--------|-------|
| 80% Code Coverage | ❌ | Target coverage for Playwright, WebdriverIO, Rust tests (SPEC 2.8) |

**Subtotals**: ❌ 1 not started

---

## 📊 Task Statistics

| Category | Tasks | Done | Partial | Remaining |
|----------|-------|------|---------|-----------|
| Import/Export | 19 | 19 | 0 | 0 |
| UI & Polish | 18 | 17 | 0 | 1 |
| Data & Editing | 5 | 5 | 0 | 0 |
| Loop Closure | 5 | 5 | 0 | 0 |
| Accessibility & i18n | 7 | 7 | 0 | 0 |
| Performance & Stability | 9 | 9 | 0 | 0 |
| Integrations | 3 | 0 | 0 | 3 |
| Testing | 1 | 0 | 0 | 1 |
| User Testing: Bugs | 7 | 0 | 0 | 7 |
| User Testing: UX | 5 | 0 | 0 | 5 |
| User Testing: Features | 5 | 0 | 0 | 5 |
| **Total** | **82** | **62** | **0** | **20** |

**Overall Progress**: 62/82 = ~76% complete

---

## 🐛 User Testing Feedback (Transcript 1, 2026-03-03)

Source: `docs/transcripts/1-summary.md` — usability session importing real Mnemo DMP data.

### Bugs (0/7 done)

| Task | Status | Notes |
|------|--------|-------|
| Fix segment merge orphaning section | ❌ | After merging, one section not placed with the rest; reference shots auto-deleted but section orphaned *(~line 359)* |
| Fix depth gradient colors overridden by theme | ❌ | Theming overrides depth gradient, making it a useless subtle color change instead of green→red *(~line 675)* |
| Add per-shot depth gradient | ❌ | Shot going shallow→deep renders as single flat color, not a gradient along its length *(~line 677)* |
| Fix Ariane export zero datum placement | ❌ | Zero datum placed incorrectly, nothing else exported; floating shots silently dropped *(~line 827)* |
| Fix double-click in data table | ❌ | Should jump map to element, but enters edit mode instead; only works on non-editable cells *(~line 1979)* |
| Fix question mark tooltip | ❌ | `?` icon clicked but gave no useful explanation *(~line 77)* |
| Fix duplicate save location on "Save now" | ❌ | File saves twice to two locations: default `Documents` path and user-selected location when "Save now" is selected |

### UX Improvements (0/5 done)

| Task | Status | Notes |
|------|--------|-------|
| Make "Place on map" button more visible | ❌ | Currently "really poorly visible" *(~line 147)* |
| Add unmerge capability | ❌ | No way to undo merge beyond undo stack; add right-click → Unmerge *(~line 569)* |
| Make move tool larger and more discoverable | ❌ | User couldn't locate it even with verbal guidance *(~line 413, 1707)* |
| Add middle-click panning | ❌ | Control-drag not intuitive; add middle-click drag as alternative *(~line 1865)* |
| Rename "reference shot" to "jump line" | ❌ | Rename throughout UI, context menus, tooltips *(~line 623)* |

### Feature Suggestions (0/5 done)

| Task | Status | Notes |
|------|--------|-------|
| Prioritize map-first workflow | ❌ | Everything possible should be doable from the map view *(~line 574)* |
| Auto-merge everything on import | ❌ | Leave unmerged sections floating with tooltips to drag into place *(~line 1679)* |
| Warn on export about floating/unconnected shots | ❌ | Ariane can't handle disconnected data; warn instead of silently dropping *(~line 1005)* |
| Remove legacy import workflow | ❌ | Auto-merge is strictly better; user confirmed *(~line 1748)* |
| Consider optional telemetry | ❌ | Understand what features people actually use *(~line 739)* |

---

## 🔮 Deferred to v2.0+

### Loop Closure (v2.0)
- [x] Least squares adjustment for complex loops

### Loop Closure (v3.0+)
- [ ] Proportional distribution (distribute errors proportional to shot lengths)
- [ ] Equal distribution (distribute errors equally to shots)

### Undo/Redo Optimization (v2.0)
- [ ] Diff-based undo (store diffs instead of full snapshots where possible)
- [ ] Binary serialization (replace JSON with a compact binary format)
- [ ] Reduce snapshot frequency (only snapshot on major operations)

### Data & Editing (v2.0)
- [ ] Raw Data Table dialog - Displays all raw data including closures and other relationships much closer to what it is stored as in SQLite for advanced user operations

### Display Features (v2.0)
- [ ] LRUD passage wall visualization
- [ ] High-contrast theme (full implementation)
- [ ] Marker Placement - Place markers on shots, before/after or on stations
- [ ] Marker placement - off the line with set distance eg fossils/bones/leads
- [ ] Dive Map Mode - Under Display dropdown, single toggle that styles the line better as a dive map rather than survey details
- [ ] E-ink theme - Optimized for color/BW e-ink displays

### Import/Export (v2.x)
- [ ] Additional export formats: Survex, Therion, KML/KMZ
- [ ] Compass format support
- [ ] GPX Export

### Platform (v3.0+)
- [ ] 3D visualization
- [ ] Profile views
- [ ] Mobile/web versions
- [ ] Direct mNemo device communication

---

## 📝 Architecture Notes

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

### CSS Variables
Use `--cc-` prefix for all custom CSS variables (e.g., `--cc-focus-ring`, `--cc-primary`).

### Error Boundaries
Wrap each major panel (map, sections, detail, data table) with its own error boundary.

---

## Codebase Analysis Notes

**Key findings from last analysis (2026-02-03):**
- ✅ Settings dialog fully implemented with 9 tabs
- ✅ Loop closure strategy selector in `ClosureDialog.tsx`
- ✅ Inline editing in `EditableTable` component
- ✅ Screen reader announcements via `announceSelection()` and `aria-live`
- ✅ Keyboard shortcuts system with `ShortcutsSettings`
- ✅ DMP import refactored into two dialogs
- ✅ Depth gradient rendering in `SurveyLayer.tsx`
- ✅ ErrorBoundary wraps all major panels
- ✅ i18n via react-i18next with locale-aware number/date formatting
- ✅ Virtual scrolling via @tanstack/react-virtual
- ✅ Auto-save with debounced 2-second timer and status bar indicator
- ✅ About dialog in Settings footer
- ✅ Splash screen with branding (opt-in via settings)
- ✅ Bug/debug log dialog with in-memory ring buffer
