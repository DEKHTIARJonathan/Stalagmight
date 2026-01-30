# CaveChef TODO - v1.0 Completion Tasks

This document tracks functionality specified in `docs/SPEC.md` and implementation status based on codebase analysis (last updated: 2026-01-29).

## Summary

**DMP Import Refactoring**: 20/22 complete (91%)
- Core functionality ✅ COMPLETE
- Minor items remaining: file hash tracking (command exists but unused), validation thresholds (settings exist but not in DMP import)

**v1.0 Completion Tasks**: 13/40 complete (33%)
- ✅ COMPLETE: Loop Closure (3/3), Settings/Configuration (4/4)
- 🟡 PARTIAL: Data Table (2/4 - inline editing ✅, but no add/delete row buttons)
- 🟡 PARTIAL: Accessibility (2/4 - screen reader/keyboard ✅, no focus management/theme)
- 🟡 PARTIAL: Performance (1/4 - loading states ✅, no virtual scrolling/auto-save)
- 🟡 PARTIAL: Error Handling (1/4 - basic network error tracking, no error boundaries)
- ❌ NOT STARTED: i18n (0/3), Final polish (1/6 - only tile caching done)

**Last Updated**: 2026-01-29

---

## ✅ Completed Features

### Core Functionality
- [x] DMP Parser (versions 2-5) with IntBuffer, LRUD, pitch, temperature, time
- [x] Undo/Redo hybrid system with inverse commands and snapshots
- [x] File Operations: New/Open/Save with overwrite warnings, recent projects, safe save
- [x] Dirty state indicator and prompt on close (but no auto-save)

### Map Interactions
- [x] All tools: Select, Pan, Zoom, Draw, Delete, Merge, Measure, Move Section/Station
- [x] Multi-select (Shift/Ctrl+click), box select, selection in DetailPanel
- [x] Context menu, snap-to-station, hover highlighting, drag preview
- [x] Scale bar (MapLibre ScaleControl)

### Dialogs
- [x] DialogWrapper with Escape handling and isDirty confirmation
- [x] All dialogs migrated: Confirm, Import, Export, Edit, Merge, NewProject, etc.
- [x] DMP Import refactored to two-step process (DmpSelectionDialog + DmpSectionConfigDialog)

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
- [x] Testing documentation (`docs/TESTING.md`)

---

## Feature Implementation Status (Based on Codebase Analysis)

| Feature | Status | Notes |
|---------|--------|-------|
| Satellite Map Tile Caching | ✅ Done | CacheSettings.tsx exists |
| Zoom Tool Click Behavior | ✅ Done | Implemented in MapCanvas |
| Display Toggle Visibility & Selection | ✅ Done | DisplayMenu component exists |
| Configurable Hitboxes | ✅ Done | MapSettings has station/shot hit_area options |
| Depth Gradient Display | ✅ Done | DepthLegend, depth gradient in SurveyLayer |
| Edit Dialogs Save | ✅ Done | EditSection/EditShot dialogs functional |
| Back Button Freeze | ✅ Done | Back button navigation works (tests pass) |
| Disable Interactions for Zoom/Pan | ✅ Done | Non-interactive tools implemented |
| Section Hover/Selection Highlighting | ✅ Done | Section highlighting on map |
| Loading Progress Indicator | ✅ Done | LoadingProgress component exists |
| Export System Enhancement | ✅ Done | ExportDialog, ExportPreview |
| Double-click Section Zoom | ✅ Done | Section zoom on double-click |
| Configurable Keyboard Shortcuts | ✅ Done | ShortcutsSettings with ShortcutRecorder |

---

## 🔥 DMP Import Refactoring (COMPLETED)

Refactored DMP import workflow from a single monolithic dialog into a two-step process.

**Step 1 (DmpSelectionDialog)**: User selects sections to import, sets default surveyor/date.
**Step 2 (DmpSectionConfigDialog)**: Per-section editing with placement options, shot table, and preview.

All components are implemented and working:

### Phase 1: Shared Components (Parallel)

| Title | Status |
|-------|--------|
| Shared ShotTableEditor | ✅ |
| Shared SectionMetadataForm | ✅ |
| Enhanced SectionPreview | ✅ |
| DmpSelectionDialog Shell | ✅ |
| File Hash Tracking | 🟡 WIP — Wire existing Rust commands into DMP import flow; duplicate warning banner in Step 1; track hash after successful import |

### Phase 2: Dialog Core (Sequential)

| Title | Status |
|-------|--------|
| DmpSectionConfigDialog Shell | ✅ |
| Section Parameters Panel | ✅ |
| Placement Options Panel | ✅ |
| Shot Table Integration | ✅ |
| Import State Management | ✅ |
| Session Surveyor Memory | ✅ |
| Validation Thresholds in DMP Import | 🟡 WIP — Wire config.validation into DmpSectionConfigDialog → ShotTableEditor; add warning count badges to section list |

### Phase 3: Placement Features

| Title | Status |
|-------|--------|
| Merge Preview Visualization | ✅ |
| Manual Placement Mode | ✅ |
| Section Creation Logic | ✅ |

### Phase 4: Navigation & Integration

| Title | Status |
|-------|--------|
| Navigation & Import Buttons | ✅ |
| Context-Aware Triggering | ✅ |
| Error Blocking Logic | ✅ |

### Phase 5: Cleanup & Testing

| Title | Status |
|-------|--------|
| Update Edit Section Dialog | ✅ |
| Remove Old Dialog | ✅ |
| App Close Confirmation | ✅ |
| Update Existing Tests | ✅ |

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Sections created on placement | Enables granular undo, immediate persistence |
| Exclusive placement modes | Simpler UX, clearer mental model |
| Warnings don't block, errors block | Warnings inform, don't impede workflow |
| Session-only surveyor memory | Respects privacy, not persisted to config |
| Azimuth as average column | Cleaner table, edit sets both in/out |

---

## 🚧 v1.0 Completion Tasks

Based on codebase analysis as of 2026-01-29.

### Phase A: Loop Closure Foundation

| Title | Status |
|-------|--------|
| Loop Detection Algorithm | ✅ |
| Closure Error Calculation | ✅ |
| Closure Strategy Selector | ✅ (ClosureDialog exists with strategy selection) |

### Phase B: Settings & Configuration

| Title | Status |
|-------|--------|
| Settings Dialog Shell | ✅ |
| Display Settings Tab | ✅ (DisplaySettings.tsx exists) |
| Validation Thresholds Tab | ✅ (ValidationSettings.tsx exists) |
| Export Defaults Tab | ✅ (ExportSettings.tsx exists) |

### Phase C: Data Table Enhancements

| Title | Status |
|-------|--------|
| Inline Editing | ✅ (EditableTable component with EditableCell) |
| Add Row | 🟡 WIP (fn-47-ok1) — Context menu on DataTable + map; DrawShotDialog; prepend mode |
| Delete Row with Split | 🟡 WIP (fn-47-ok1) — Position-aware delete: edge/mid-split/last-shot; section cleanup bug fix |
| Row Highlighting Sync | ✅ |

### Phase D: Accessibility

| Title | Status |
|-------|--------|
| Focus Management | 🟡 WIP — useFocusTrap hook in DialogWrapper; initial focus (first input for forms, primary action for confirms); return focus on close; --cc-focus-ring CSS variable |
| Screen Reader Announcements | ✅ (aria-live regions, announceSelection(), 28 occurrences) |
| Theme Infrastructure | 🟡 WIP — CSS variables (--cc-*), ThemeProvider, Appearance settings tab, dark+light themes, full migration of hardcoded colors |
| Keyboard Navigation | ✅ (useKeyboardShortcuts hook, ShortcutRecorder, ShortcutsSettings) |

### Phase E: i18n Foundation

| Title | Status |
|-------|--------|
| i18n Infrastructure | ❌ (No i18n libraries detected) |
| Extract UI Strings | ❌ |
| Number/Date Formatting | ❌ (Only basic ID formatters, no locale support) |

### Phase F: Performance & Polish

| Title | Status |
|-------|--------|
| Virtual Scrolling | ❌ (No VirtualList/virtualized libraries) |
| Debounced Auto-Save | ❌ (Config exists but no useEffect setInterval timer implementation) |
| Loading States | ✅ (LoadingProgress component with aria-live) |

### Phase G: Error Handling

| Title | Status |
|-------|--------|
| Error Boundary Wrapper | ❌ (No React ErrorBoundary class components, only ErrorDialog for displaying errors) |
| Network Error Handling | 🟡 (Basic tile fetch error stats in MapDevStats, no retry logic) |
| File Corruption Recovery | ❌ |
| Validation Error Recovery | ❌ |

### Phase H: Final Polish

| Title | Status |
|-------|--------|
| Splash Screen | ❌ |
| About Dialog | ❌ |
| Keyboard Shortcuts Overlay | ❌ |
| Release Automation | ❌ |
| Bug Reporter | ❌ |
| Tile Caching | ✅ (CacheSettings.tsx + Rust config) |

### Phase I: Tool Panel & Move Tool

| Title | Status |
|-------|--------|
| Tool Panel Redesign | 🟡 WIP (fn-46-37m) — Photoshop-style subtools via right-click; group Pan + Zoom |
| Move Segment Tool | 🟡 WIP (fn-46-37m) — Move whole segment: everything connected by shots/stations/merges/closures |
| Move Shot Subtool | 🟡 WIP (fn-46-37m) — Move a single shot |
| Move Station Subtool | 🟡 WIP (fn-46-37m) — Move a single station |

### Phase J: Closure Error Distribution

| Title | Status |
|-------|--------|
| Proportional by Length | ❌ (Distribute errors proportional to shot lengths; closure stations share new position) |
| Equal Distribution | ❌ (Distribute errors equally to shots; closure stations share new position) |

### Phase K: Import & Reporting

| Title | Status |
|-------|--------|
| Bug Report Dialog | ❌ (Button in Settings bottom bar, left-aligned next to Save/Cancel) |
| Ariane .ari Import | ❌ |

---

## 📊 Task Statistics

### DMP Import Refactoring - COMPLETED (mostly)

| Phase | Tasks | Completed | Remaining |
|-------|-------|-----------|-----------|
| Shared Components | 5 | 4 | 1 |
| Dialog Core | 7 | 6 | 1 |
| Placement Features | 3 | 3 | 0 |
| Navigation & Integration | 3 | 3 | 0 |
| Cleanup & Testing | 4 | 4 | 0 |
| **Import Total** | **22** | **20** | **2** |

**Note**: Main functionality is complete. Remaining items are minor (file hash tracking, validation thresholds).

### v1.0 Completion Tasks

| Phase | Tasks | Completed | Remaining |
|-------|-------|-----------|-----------|
| A: Loop Closure | 3 | 3 | 0 |
| B: Settings | 4 | 4 | 0 |
| C: Data Table | 4 | 2 | 2 |
| D: Accessibility | 4 | 2 | 2 |
| E: i18n | 3 | 0 | 3 |
| F: Performance | 3 | 1 | 2 |
| G: Error Handling | 4 | 0 | 4 |
| H: Polish | 6 | 1 | 5 |
| I: Tool Panel & Move | 4 | 0 | 4 |
| J: Closure Distribution | 2 | 0 | 2 |
| K: Import & Reporting | 2 | 0 | 2 |
| **v1.0 Total** | **39** | **13** | **26** |

### Grand Total

| Category | Tasks | Completed | Remaining |
|----------|-------|-----------|-----------|
| DMP Import Refactoring | 22 | 20 | 2 |
| v1.0 Completion | 39 | 13 | 26 |
| **Grand Total** | **61** | **33** | **28** |

---

## 🔮 Deferred to v2.0+

### Loop Closure (v2.0)
- [ ] Least squares adjustment for complex loops

### Display Features (v2.0)
- [ ] Depth color gradient rendering
- [ ] LRUD passage wall visualization
- [ ] High-contrast theme (beyond infrastructure)

### Import/Export (v2.x)
- [ ] Additional export formats: Survex, Therion, KML/KMZ

### Platform (v3.0+)
- [ ] SpeleoDB integration
- [ ] 3D visualization
- [ ] Profile views
- [ ] Mobile/web versions
- [ ] Direct mNemo device communication

---

## 📝 Dependency Notes

### DMP Import Refactoring Dependencies
```
Phase 1: Shared Components (parallel start)
├── ShotTableEditor
├── SectionMetadataForm
├── SectionPreview
├── DmpSelectionDialog ──> SessionSurveyorMemory
└── FileHashTracking

Phase 2: Dialog Core
└── DmpSectionConfigDialog (depends: ShotTableEditor, SectionMetadataForm, SectionPreview)
    ├── ParametersPanel (depends: SectionMetadataForm)
    ├── PlacementOptionsPanel
    │   ├── MergePreview (depends: SectionPreview)
    │   └── ManualPlacement
    ├── ShotTableIntegration (depends: ShotTableEditor)
    └── ImportStateManagement
        ├── SectionCreationLogic (depends: PlacementOptionsPanel)
        └── NavigationButtons
            └── ErrorBlockingLogic

Phase 3: Integration
├── ContextAwareTriggering (depends: DmpSelectionDialog, DmpSectionConfigDialog)
├── ValidationThresholds (depends: ShotTableEditor)
└── UpdateEditSectionDialog (depends: ShotTableEditor, SectionMetadataForm)

Phase 4: Cleanup
└── RemoveOldDialog (depends: ContextAwareTriggering, ErrorBlockingLogic, UpdateEditSectionDialog)
    ├── AppCloseConfirmation
    └── UpdateExistingTests
```

### v1.0 Completion Task Dependencies
```
Loop Detection ──┐
                  ├──> Closure Strategy ✅
Closure Error ───┘

Settings Shell ──┬──> Display Tab ✅
                  ├──> Validation Tab ✅
                  └──> Export Tab ✅

Inline Edit ✅ ──┬──> Add Row ❌
                  └──> Delete Row ❌

Focus ❌ ────────┬──> Screen Reader ✅
                  └──> Keyboard Nav ✅

i18n Infra ❌ ───┬──> Extract Strings ❌
                  └──> Number Format ❌

Error Boundary ❌─┬──> Network Errors ❌
                  └──> Corruption Recovery ❌

About Dialog ❌ ───> Bug Reporter ❌
```

### Critical Path
1. **DMP Import Refactoring**: Mostly complete, minor cleanup remaining
2. **Phase A** (Loop Closure): ✅ COMPLETE
3. **Phase B** (Settings): ✅ COMPLETE
4. **Phase C** (Data Table): Add Row/Delete Row features remaining
5. **Phase D** (Accessibility): Focus management and theme switching remaining
6. **Phase E** (i18n): Full infrastructure needed
7. **Phase G** (Error Handling): Error boundaries needed for stability
8. **Phase H** (Polish): About dialog, splash screen, shortcuts overlay

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

### CSS Variables
Use `--cc-` prefix for all custom CSS variables (e.g., `--cc-focus-ring`, `--cc-primary`).

### Error Boundaries
Wrap each major panel (map, sections, detail, data table) with its own error boundary.

---

## Codebase Analysis Methodology

This TODO was updated on 2026-01-29 by analyzing the actual codebase:

**Checklist for each feature:**
- Searched for component files in `src/components/`
- Checked imports and usage in `src/App.tsx`
- Verified test files in `e2e/` and `e2e-playwright/`
- Checked Rust commands in `src-tauri/src/commands/`
- Looked for related utilities in `src/utils/`

**Key findings:**
- ✅ Settings dialog fully implemented with 9 tabs (General, Units, Display, Map, Validation, Export, Shortcuts, Cache, Advanced)
- ✅ Loop closure strategy selector exists in `ClosureDialog.tsx` with 4 strategies
- ✅ Inline editing works in `EditableTable` component with `EditableCell`
- ✅ Screen reader announcements via `announceSelection()` and `aria-live` regions
- ✅ Keyboard shortcuts system with `ShortcutsSettings` and `ShortcutRecorder`
- ✅ Loading progress indicator with `LoadingProgress` component
- ✅ Depth gradient rendering in `SurveyLayer.tsx` and `DepthLegend.tsx`
- ✅ DMP import refactored into two dialogs: `DmpSelectionDialog` and `DmpSectionConfigDialog`
- ❌ No `ErrorBoundary` components found
- ❌ No `addShot` or `deleteShot` commands in Rust backend
- ❌ No theme switching infrastructure (only hardcoded dark mode)
- ❌ No i18n libraries detected
- ❌ No virtual scrolling implementation
- ❌ No auto-save functionality
- ❌ No About dialog, Splash screen, or Bug reporter components
- ✅ Old `DmpImportDialog.tsx` removed (was 1316 lines of dead code)
