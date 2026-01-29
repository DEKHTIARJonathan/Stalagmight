# CaveChef TODO - v1.0 Completion Tasks

This document tracks functionality specified in `docs/SPEC.md` and implementation status based on codebase analysis (last updated: 2026-01-29).

## Summary

**DMP Import Refactoring**: 19/22 complete (86%)
- Core functionality ✅ COMPLETE
- Minor items remaining: file hash tracking (command exists but unused), validation thresholds (settings exist but not in DMP import), removing old dialog (exists but unused)

**v1.0 Completion Tasks**: 13/32 complete (41%)
- ✅ COMPLETE: Loop Closure (3/3), Settings/Configuration (4/4)
- 🟡 PARTIAL: Data Table (2/4 - inline editing ✅, but no add/delete row buttons)
- 🟡 PARTIAL: Accessibility (2/4 - screen reader/keyboard ✅, no focus management/theme)
- 🟡 PARTIAL: Performance (1/4 - loading states ✅, no virtual scrolling/auto-save)
- 🟡 PARTIAL: Error Handling (1/4 - basic network error tracking, no error boundaries)
- ❌ NOT STARTED: i18n (0/3), Final polish (1/6 - only tile caching done)

**Last Updated**: 2026-01-29

---

## ✅ COMPLETED FEATURES (Pre-Task 31)

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

| Task | Title | Status |
|------|-------|--------|
| 01 | Shared ShotTableEditor | ✅ |
| 02 | Shared SectionMetadataForm | ✅ |
| 03 | Enhanced SectionPreview | ✅ |
| 04 | DmpSelectionDialog Shell | ✅ |
| 15 | File Hash Tracking | 🟡 (Rust command exists but not used in DMP import) |

### Phase 2: Dialog Core (Sequential)

| Task | Title | Status |
|------|-------|--------|
| 05 | DmpSectionConfigDialog Shell | ✅ |
| 06 | Section Parameters Panel | ✅ |
| 07 | Placement Options Panel | ✅ |
| 08 | Shot Table Integration | ✅ |
| 11 | Import State Management | ✅ |
| 16 | Session Surveyor Memory | ✅ |
| 17 | Validation Thresholds in DMP Import | ❌ (ValidationSettings exists but not integrated into DmpSectionConfigDialog) |

### Phase 3: Placement Features

| Task | Title | Status |
|------|-------|--------|
| 09 | Merge Preview Visualization | ✅ |
| 10 | Manual Placement Mode | ✅ |
| 12 | Section Creation Logic | ✅ |

### Phase 4: Navigation & Integration

| Task | Title | Status |
|------|-------|--------|
| 13 | Navigation & Import Buttons | ✅ |
| 14 | Context-Aware Triggering | ✅ |
| 18 | Error Blocking Logic | ✅ |

### Phase 5: Cleanup & Testing

| Task | Title | Status |
|------|-------|--------|
| 19 | Update Edit Section Dialog | ✅ |
| 20 | Remove Old Dialog | ❌ (Old DmpImportDialog.tsx exists (1316 lines) but not imported anywhere) |
| 21 | App Close Confirmation | ✅ |
| 22 | Update Existing Tests | ✅ |

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Sections created on placement | Enables granular undo, immediate persistence |
| Exclusive placement modes | Simpler UX, clearer mental model |
| Warnings don't block, errors block | Warnings inform, don't impede workflow |
| Session-only surveyor memory | Respects privacy, not persisted to config |
| Azimuth as average column | Cleaner table, edit sets both in/out |

---

## 🚧 v1.0 COMPLETION TASKS (31-62) - STATUS UPDATE

Based on codebase analysis as of 2026-01-29.

### Phase A: Loop Closure Foundation

| Task | Title | Risk | Status |
|------|-------|------|--------|
| 31 | Loop Detection Algorithm | Medium-High | ✅ |
| 32 | Closure Error Calculation | Low-Medium | ✅ |
| 33 | Closure Strategy Selector | High | ✅ (ClosureDialog exists with strategy selection) |

### Phase B: Settings & Configuration

| Task | Title | Risk | Status |
|------|-------|------|--------|
| 34 | Settings Dialog Shell | Medium | ✅ |
| 35 | Display Settings Tab | Medium | ✅ (DisplaySettings.tsx exists) |
| 36 | Validation Thresholds Tab | Low-Medium | ✅ (ValidationSettings.tsx exists) |
| 37 | Export Defaults Tab | Low | ✅ (ExportSettings.tsx exists) |

### Phase C: Data Table Enhancements

| Task | Title | Risk | Status |
|------|-------|------|--------|
| 38 | Inline Editing | High | ✅ (EditableTable component with EditableCell) |
| 39 | Add Row | Medium | ❌ (createShot command exists but no "Add Row" button in DataTable UI) |
| 40 | Delete Row with Split | High | ❌ (deleteShot command exists but no "Delete Row" button in DataTable UI) |
| 41 | Row Highlighting Sync | Low-Medium | ✅ |

### Phase D: Accessibility

| Task | Title | Risk | Status |
|------|-------|------|--------|
| 42 | Focus Management | High | ❌ (No React ErrorBoundary components, only ErrorDialog) |
| 43 | Screen Reader Announcements | Medium-High | ✅ (aria-live regions, announceSelection(), 28 occurrences) |
| 44 | Theme Infrastructure | Medium | ❌ (Only dark mode hardcoded, no useTheme/ThemeProvider) |
| 45 | Keyboard Navigation | Medium | ✅ (useKeyboardShortcuts hook, ShortcutRecorder, ShortcutsSettings) |

### Phase E: i18n Foundation

| Task | Title | Risk | Status |
|------|-------|------|--------|
| 46 | i18n Infrastructure | Medium | ❌ (No i18n libraries detected) |
| 47 | Extract UI Strings | High (tedious) | ❌ |
| 48 | Number/Date Formatting | Low-Medium | ❌ (Only basic ID formatters, no locale support) |

### Phase F: Performance & Polish

| Task | Title | Risk | Status |
|------|-------|------|--------|
| 49 | Virtual Scrolling | Medium | ❌ (No VirtualList/virtualized libraries, despite deck.gl in package.json) |
| 50 | Map Rendering Optimization | Medium-High | ❌ (deck.gl in package.json but not used - only commented in SurveyLayer) |
| 51 | Debounced Auto-Save | Low-Medium | ❌ (Config exists but no useEffect setInterval timer implementation) |
| 52 | Loading States | Medium | ✅ (LoadingProgress component with aria-live) |

### Phase G: Error Handling

| Task | Title | Risk | Status |
|------|-------|------|--------|
| 53 | Error Boundary Wrapper | Medium | ❌ (No React ErrorBoundary class components, only ErrorDialog for displaying errors) |
| 54 | Network Error Handling | Medium | 🟡 (Basic tile fetch error stats in MapDevStats, no retry logic) |
| 55 | File Corruption Recovery | Medium | ❌ |
| 56 | Validation Error Recovery | Low-Medium | ❌ |

### Phase H: Final Polish

| Task | Title | Risk | Status |
|------|-------|------|--------|
| 57 | Splash Screen | Medium | ❌ |
| 58 | About Dialog | Low | ❌ |
| 59 | Keyboard Shortcuts Overlay | Low-Medium | ❌ |
| 60 | Release Automation | Medium | ❌ |
| 61 | Bug Reporter | Medium | ❌ |
| 62 | Tile Caching | Medium-High | ✅ (CacheSettings.tsx + Rust config) |

---

## 📊 TASK STATISTICS

### DMP Import Refactoring - COMPLETED (mostly)

| Phase | Tasks | Completed | Remaining |
|-------|-------|-----------|-----------|
| 1: Shared Components | 5 | 4 | 1 |
| 2: Dialog Core | 7 | 6 | 1 |
| 3: Placement Features | 3 | 3 | 0 |
| 4: Navigation & Integration | 3 | 3 | 0 |
| 5: Cleanup & Testing | 4 | 3 | 1 |
| **Import Total** | **22** | **19** | **3** |

**Note**: Main functionality is complete. Remaining items are minor (file hash tracking, validation thresholds, removing old dialog).

### v1.0 Completion Tasks (31-62) - Updated Status

| Phase | Tasks | Completed | Remaining |
|-------|-------|-----------|-----------|
| A: Loop Closure | 3 | 3 | 0 |
| B: Settings | 4 | 4 | 0 |
| C: Data Table | 4 | 2 | 2 |
| D: Accessibility | 4 | 2 | 2 |
| E: i18n | 3 | 0 | 3 |
| F: Performance | 4 | 1 | 3 |
| G: Error Handling | 4 | 0 | 4 |
| H: Polish | 6 | 1 | 5 |
| **v1.0 Total** | **32** | **13** | **19** |

### Grand Total

| Category | Tasks | Completed | Remaining |
|----------|-------|-----------|-----------|
| DMP Import Refactoring | 22 | 19 | 3 |
| v1.0 Completion | 32 | 13 | 19 |
| **Grand Total** | **54** | **32** | **22** |

---

## 🔮 DEFERRED TO v2.0+

### Loop Closure (v2.0)
- [ ] Error distribution algorithms (Bowditch, equal, keep raw)
- [ ] Least squares adjustment for complex loops

### Performance (v3.0)
- [ ] deck.gl integration for 100k+ line segments
- [ ] WebGL-based survey rendering

### Display Features (v2.0)
- [ ] Depth color gradient rendering
- [ ] LRUD passage wall visualization
- [ ] High-contrast theme (beyond infrastructure)

### Import/Export (v2.x)
- [ ] Ariane .ari import
- [ ] Additional export formats: Survex, Therion, KML/KMZ

### Platform (v3.0+)
- [ ] SpeleoDB integration
- [ ] 3D visualization
- [ ] Profile views
- [ ] Mobile/web versions
- [ ] Direct mNemo device communication

---

## 📝 DEPENDENCY NOTES

### DMP Import Refactoring Dependencies (fn-51-ctu)
```
Phase 1: Shared Components (parallel start)
├── 01-ShotTableEditor
├── 02-SectionMetadataForm
├── 03-SectionPreview
├── 04-DmpSelectionDialog ──> 16-SessionSurveyorMemory
└── 15-FileHashTracking

Phase 2: Dialog Core
└── 05-DmpSectionConfigDialog (depends: 01, 02, 03)
    ├── 06-ParametersPanel (depends: 02)
    ├── 07-PlacementOptionsPanel
    │   ├── 09-MergePreview (depends: 03)
    │   └── 10-ManualPlacement
    ├── 08-ShotTableIntegration (depends: 01)
    └── 11-ImportStateManagement
        ├── 12-SectionCreationLogic (depends: 07)
        └── 13-NavigationButtons
            └── 18-ErrorBlockingLogic

Phase 3: Integration
├── 14-ContextAwareTriggering (depends: 04, 05)
├── 17-ValidationThresholds (depends: 01)
└── 19-UpdateEditSectionDialog (depends: 01, 02)

Phase 4: Cleanup
└── 20-RemoveOldDialog (depends: 14, 18, 19)
    ├── 21-AppCloseConfirmation
    └── 22-UpdateExistingTests
```

### v1.0 Completion Task Dependencies (Updated)
```
31 (Loop Detection) ──┐
                       ├──> 33 (Closure Strategy) ✅ DONE
32 (Closure Error) ───┘

34 (Settings Shell) ──┬──> 35 (Display Tab) ✅ DONE
                       ├──> 36 (Validation Tab) ✅ DONE
                       └──> 37 (Export Tab) ✅ DONE

38 (Inline Edit) ✅ ──┬──> 39 (Add Row) ❌
                       └──> 40 (Delete Row) ❌

42 (Focus) ❌ ────────┬──> 43 (Screen Reader) ✅
                       └──> 45 (Keyboard Nav) ✅

46 (i18n Infra) ❌ ───┬──> 47 (Extract Strings) ❌
                       └──> 48 (Number Format) ❌

53 (Error Boundary) ❌─┬──> 54 (Network Errors) ❌ (not applicable)
                       └──> 55 (Corruption Recovery) ❌

58 (About Dialog) ❌ ───> 61 (Bug Reporter) ❌
```

### Critical Path (Updated)
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
- ❌ Old `DmpImportDialog.tsx` still exists (54KB file)
