# Stalagmight TODO - v1.0 Completion Tasks

This document tracks functionality specified in `docs/SPEC.md` and implementation status based on codebase analysis.

**Last Updated**: 2026-02-04

---

## Summary

| Category | Done | Total | Progress |
|----------|------|-------|----------|
| Import/Export | 12 | 19 | 63% |
| UI & Polish | 6 | 16 | 38% |
| Data & Editing | 4 | 5 | 80% |
| Loop Closure | 3 | 6 | 50% |
| Accessibility & i18n | 4 | 7 | 57% |
| Performance & Stability | 1 | 10 | 10% |
| Integrations | 0 | 1 | 0% |
| Testing | 0 | 1 | 0% |
| **Total** | **30** | **65** | **46%** |

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

### Import/Export (22/28 done)

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
| File Hash Tracking | 🟡 | Command exists but unused |
| Ariane .ari Import | ❌ | |
| Ariane .ari Export | ❌ | |
| GPX Import | ❌ | Waypoints and tracks |
| Manual Data Input | ❌ | Full spreadsheet-style entry without device import |
| Automatic Reference Shot Alignment | ❌ | Auto-align imported sections using reference shots |
| Import Dialog/Shot Placement Refactoring | ❌ | Improve shot placement UX in import workflow |

**Subtotals**: ✅ 12 done, 🟡 1 partial, ❌ 6 not started

### UI & Polish (6/16 done)

| Task | Status | Notes |
|------|--------|-------|
| Collapsible/resizable panels | ✅ | With persistence |
| Display toggles dropdown | ✅ | DisplayMenu component |
| Shot data labels (zoom density) | ✅ | |
| Statistics panel | ✅ | Project/section stats, penetration distance |
| Tool Panel Redesign | ✅ | |
| Tile Caching Settings | ✅ | CacheSettings.tsx + Rust config |
| Three-Level Settings Reset | ❌ | Per-setting, per-tab, full reset (SPEC 2.9) |
| Automatic Reference Shot Alignment Settings | ❌ | Configure auto-alignment behavior in Settings |
| Fix Undo Stack Section Modification Details | ❌ | Unchanged date shows as detail instead of relevant changes |
| Fix Section Hyperlink Highlighting Not Clearing | ❌ | Highlight persists after navigating away from section link |
| Splash Screen | ❌ | |
| About Dialog | ❌ | |
| Keyboard Shortcuts Overlay | ❌ | Help overlay showing all shortcuts |
| Bug Reporter Dialog | ❌ | Button in Settings bottom bar |
| Release Automation | ❌ | |
| Add Comment Tool | ❌ | Text annotations on stations/map |

**Subtotals**: ✅ 6 done, ❌ 10 not started

### Data & Editing (4/5 done)

| Task | Status | Notes |
|------|--------|-------|
| Inline Editing | ✅ | EditableTable with EditableCell |
| Add Row | ✅ | Context menu, DrawShotDialog, prepend mode |
| Delete Row with Split | ✅ | |
| Row Highlighting Sync | ✅ | |
| Virtual Scrolling | ❌ | For large data tables |

**Subtotals**: ✅ 4 done, ❌ 1 not started

### Loop Closure (3/6 done)

| Task | Status | Notes |
|------|--------|-------|
| Loop Detection Algorithm | ✅ | |
| Closure Error Calculation | ✅ | |
| Closure Strategy Selector | ✅ | ClosureDialog with 4 strategies |
| Fix Quality Setting → Closure Weight | ❌ | Quality setting incorrectly sets properties; rename/refactor to closure weight |
| Proportional Distribution | ❌ | Distribute errors proportional to shot lengths |
| Equal Distribution | ❌ | Distribute errors equally to shots |

**Subtotals**: ✅ 3 done, ❌ 3 not started

### Accessibility & i18n (4/7 done)

| Task | Status | Notes |
|------|--------|-------|
| Focus Management | ✅ | |
| Screen Reader Announcements | ✅ | aria-live regions, announceSelection() |
| Theme Infrastructure | ✅ | |
| Keyboard Navigation | ✅ | useKeyboardShortcuts, ShortcutRecorder |
| i18n Infrastructure | ❌ | No i18n libraries detected |
| Extract UI Strings | ❌ | |
| Number/Date Locale Formatting | ❌ | |

**Subtotals**: ✅ 4 done, ❌ 3 not started

### Performance & Stability (2/10 done)

| Task | Status | Notes |
|------|--------|-------|
| Loading States | ✅ | LoadingProgress component with aria-live |
| Network Error Stats | 🟡 | Basic tile fetch stats in MapDevStats, no retry |
| Debounced Auto-Save | ❌ | Backend config exists, needs frontend 2-second debounce timer (SPEC 2.11) |
| SQLite Integrity Checks | ❌ | PRAGMA integrity_check on project open (SPEC 2.11) |
| Error Boundary Wrapper | ❌ | No React ErrorBoundary components |
| Network Retry Logic | ❌ | |
| Improve Algorithm/Workflow Tracing | ❌ | Warnings on recoverable errors, debug prints in all major algorithms |
| File Corruption Recovery | ❌ | |
| Validation Error Recovery | ❌ | |

**Subtotals**: ✅ 1 done, 🟡 1 partial, ❌ 7 not started

### Integrations (0/1 done)

| Task | Status | Notes |
|------|--------|-------|
| SpeleoDB Integration | ❌ | Bidirectional sync, authentication, conflict resolution |

**Subtotals**: ❌ 1 not started

### Testing (0/1 done)

| Task | Status | Notes |
|------|--------|-------|
| 80% Code Coverage | ❌ | Target coverage for Playwright, WebdriverIO, Rust tests (SPEC 2.8) |

**Subtotals**: ❌ 1 not started

---

## 📊 Task Statistics

| Category | Tasks | Done | Partial | Remaining |
|----------|-------|------|---------|-----------|
| Import/Export | 19 | 12 | 1 | 6 |
| UI & Polish | 16 | 6 | 0 | 10 |
| Data & Editing | 5 | 4 | 0 | 1 |
| Loop Closure | 6 | 3 | 0 | 3 |
| Accessibility & i18n | 7 | 4 | 0 | 3 |
| Performance & Stability | 10 | 1 | 1 | 8 |
| Integrations | 1 | 0 | 0 | 1 |
| Testing | 1 | 0 | 0 | 1 |
| **Total** | **65** | **30** | **2** | **33** |

**Overall Progress**: 30 done + 2 partial = ~49% complete

---

## 🔮 Deferred to v2.0+

### Loop Closure (v2.0)
- [ ] Least squares adjustment for complex loops

### Display Features (v2.0)
- [ ] LRUD passage wall visualization
- [ ] High-contrast theme (full implementation)

### Import/Export (v2.x)
- [ ] Additional export formats: Survex, Therion, KML/KMZ

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
- ❌ No `ErrorBoundary` components
- ❌ No i18n libraries
- ❌ No virtual scrolling
- ❌ No auto-save implementation
- ❌ No About dialog, Splash screen, or Bug reporter
