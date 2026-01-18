# CaveChef TODO - v1.0 Completion Tasks

This document tracks functionality specified in SPEC.md and the task files in `tasks/`.

**Last Updated**: 2026-01-18

---

## ✅ COMPLETED FEATURES (Pre-Task 31)

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

## 🔥 URGENT: DMP Import Refactoring (fn-51-ctu)

Refactor the DMP import workflow from a single monolithic dialog into a two-step process.

**Step 1 (DmpSelectionDialog)**: User selects sections to import, sets default surveyor/date.
**Step 2 (DmpSectionConfigDialog)**: Per-section editing with placement options, shot table, and preview.

Full specifications in `tasks/urgent/task-NN-*.md` and Flow epic `.flow/specs/fn-51-ctu.md`.

### Phase 1: Shared Components (Parallel)

| Task | Title | Flow ID | Status |
|------|-------|---------|--------|
| 01 | [Shared ShotTableEditor](tasks/urgent/task-01-shared-shot-table-editor.md) | fn-51-ctu.1 | ❌ |
| 02 | [Shared SectionMetadataForm](tasks/urgent/task-02-shared-section-metadata-form.md) | fn-51-ctu.2 | ❌ |
| 03 | [Enhanced SectionPreview](tasks/urgent/task-03-enhanced-section-preview.md) | fn-51-ctu.3 | ❌ |
| 04 | [DmpSelectionDialog Shell](tasks/urgent/task-04-dmp-selection-dialog-shell.md) | fn-51-ctu.4 | ❌ |
| 15 | [File Hash Tracking](tasks/urgent/task-15-file-hash-tracking.md) | fn-51-ctu.15 | ❌ |

### Phase 2: Dialog Core (Sequential)

| Task | Title | Flow ID | Dependencies | Status |
|------|-------|---------|--------------|--------|
| 05 | [DmpSectionConfigDialog Shell](tasks/urgent/task-05-dmp-section-config-dialog-shell.md) | fn-51-ctu.5 | 01, 02, 03 | ❌ |
| 06 | [Section Parameters Panel](tasks/urgent/task-06-section-parameters-panel.md) | fn-51-ctu.6 | 02, 05 | ❌ |
| 07 | [Placement Options Panel](tasks/urgent/task-07-placement-options-panel.md) | fn-51-ctu.7 | 05 | ❌ |
| 08 | [Shot Table Integration](tasks/urgent/task-08-shot-table-integration.md) | fn-51-ctu.8 | 01, 05 | ❌ |
| 11 | [Import State Management](tasks/urgent/task-11-import-state-management.md) | fn-51-ctu.11 | 05 | ❌ |
| 16 | [Session Surveyor Memory](tasks/urgent/task-16-session-surveyor-memory.md) | fn-51-ctu.16 | 04 | ❌ |
| 17 | [Validation Thresholds](tasks/urgent/task-17-validation-thresholds.md) | fn-51-ctu.17 | 01 | ❌ |

### Phase 3: Placement Features

| Task | Title | Flow ID | Dependencies | Status |
|------|-------|---------|--------------|--------|
| 09 | [Merge Preview Visualization](tasks/urgent/task-09-merge-preview-visualization.md) | fn-51-ctu.9 | 03, 07 | ❌ |
| 10 | [Manual Placement Mode](tasks/urgent/task-10-manual-placement-mode.md) | fn-51-ctu.10 | 07 | ❌ |
| 12 | [Section Creation Logic](tasks/urgent/task-12-section-creation-logic.md) | fn-51-ctu.12 | 07, 11 | ❌ |

### Phase 4: Navigation & Integration

| Task | Title | Flow ID | Dependencies | Status |
|------|-------|---------|--------------|--------|
| 13 | [Navigation & Import Buttons](tasks/urgent/task-13-navigation-and-import-buttons.md) | fn-51-ctu.13 | 05, 11 | ❌ |
| 14 | [Context-Aware Triggering](tasks/urgent/task-14-context-aware-dialog-triggering.md) | fn-51-ctu.14 | 04, 05 | ❌ |
| 18 | [Error Blocking Logic](tasks/urgent/task-18-error-blocking-logic.md) | fn-51-ctu.18 | 13 | ❌ |

### Phase 5: Cleanup & Testing

| Task | Title | Flow ID | Dependencies | Status |
|------|-------|---------|--------------|--------|
| 19 | [Update Edit Section Dialog](tasks/urgent/task-19-update-edit-section-dialog.md) | fn-51-ctu.19 | 01, 02 | ❌ |
| 20 | [Remove Old Dialog](tasks/urgent/task-20-remove-old-dmp-import-dialog.md) | fn-51-ctu.20 | 14, 18, 19 | ❌ |
| 21 | [App Close Confirmation](tasks/urgent/task-21-app-close-confirmation.md) | fn-51-ctu.21 | 20 | ❌ |
| 22 | [Update Existing Tests](tasks/urgent/task-22-update-existing-tests.md) | fn-51-ctu.22 | 20 | ❌ |

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Sections created on placement | Enables granular undo, immediate persistence |
| Exclusive placement modes | Simpler UX, clearer mental model |
| Warnings don't block, errors block | Warnings inform, don't impede workflow |
| Session-only surveyor memory | Respects privacy, not persisted to config |
| Azimuth as average column | Cleaner table, edit sets both in/out |

### Flow Commands

```bash
# View epic
.flow/bin/flowctl show fn-51-ctu

# See ready tasks
.flow/bin/flowctl ready --epic fn-51-ctu

# Start working on a task
.flow/bin/flowctl start fn-51-ctu.1

# Mark task complete
.flow/bin/flowctl done fn-51-ctu.1 --summary-file s.md --evidence-json e.json
```

---

## 🚧 v1.0 COMPLETION TASKS (31-62)

Full specifications in `tasks/task-NN-*.md`. Each task includes:
- Detailed requirements
- Files to modify
- Acceptance criteria
- Test requirements (Rust, Playwright, WebdriverIO)

### Phase A: Loop Closure Foundation

| Task | Title | Risk | Status |
|------|-------|------|--------|
| 31 | [Loop Detection Algorithm](tasks/task-31-loop-detection.md) | Medium-High | ❌ |
| 32 | [Closure Error Calculation](tasks/task-32-closure-error.md) | Low-Medium | ❌ |
| 33 | [Closure Strategy Selector](tasks/task-33-closure-strategy.md) | High | ❌ |

### Phase B: Settings & Configuration

| Task | Title | Risk | Status |
|------|-------|------|--------|
| 34 | [Settings Dialog Shell](tasks/task-34-settings-dialog.md) | Medium | ❌ |
| 35 | [Display Settings Tab](tasks/task-35-display-settings.md) | Medium | ❌ |
| 36 | [Validation Thresholds Tab](tasks/task-36-validation-settings.md) | Low-Medium | ❌ |
| 37 | [Export Defaults Tab](tasks/task-37-export-settings.md) | Low | ❌ |

### Phase C: Data Table Enhancements

| Task | Title | Risk | Status |
|------|-------|------|--------|
| 38 | [Inline Editing](tasks/task-38-inline-editing.md) | High | ❌ |
| 39 | [Add Row](tasks/task-39-add-row.md) | Medium | ❌ |
| 40 | [Delete Row with Split](tasks/task-40-delete-row.md) | High | ❌ |
| 41 | [Row Highlighting Sync](tasks/task-41-row-highlighting.md) | Low-Medium | ❌ |

### Phase D: Accessibility

| Task | Title | Risk | Status |
|------|-------|------|--------|
| 42 | [Focus Management](tasks/task-42-focus-management.md) | High | ❌ |
| 43 | [Screen Reader Announcements](tasks/task-43-screen-reader.md) | Medium-High | ❌ |
| 44 | [Theme Infrastructure](tasks/task-44-theme-infrastructure.md) | Medium | ❌ |
| 45 | [Keyboard Navigation](tasks/task-45-keyboard-navigation.md) | Medium | ❌ |

### Phase E: i18n Foundation

| Task | Title | Risk | Status |
|------|-------|------|--------|
| 46 | [i18n Infrastructure](tasks/task-46-i18n-infrastructure.md) | Medium | ❌ |
| 47 | [Extract UI Strings](tasks/task-47-extract-strings.md) | High (tedious) | ❌ |
| 48 | [Number/Date Formatting](tasks/task-48-number-formatting.md) | Low-Medium | ❌ |

### Phase F: Performance & Polish

| Task | Title | Risk | Status |
|------|-------|------|--------|
| 49 | [Virtual Scrolling](tasks/task-49-virtual-scrolling.md) | Medium | ❌ |
| 50 | [Map Rendering Optimization](tasks/task-50-map-optimization.md) | Medium-High | ❌ |
| 51 | [Debounced Auto-Save](tasks/task-51-debounced-autosave.md) | Low-Medium | ❌ |
| 52 | [Loading States](tasks/task-52-loading-states.md) | Medium | ❌ |

### Phase G: Error Handling

| Task | Title | Risk | Status |
|------|-------|------|--------|
| 53 | [Error Boundary Wrapper](tasks/task-53-error-boundary.md) | Medium | ❌ |
| 54 | [Network Error Handling](tasks/task-54-network-errors.md) | Medium | ❌ |
| 55 | [File Corruption Recovery](tasks/task-55-corruption-recovery.md) | Medium | ❌ |
| 56 | [Validation Error Recovery](tasks/task-56-validation-recovery.md) | Low-Medium | ❌ |

### Phase H: Final Polish

| Task | Title | Risk | Status |
|------|-------|------|--------|
| 57 | [Splash Screen](tasks/task-57-splash-screen.md) | Medium | ❌ |
| 58 | [About Dialog](tasks/task-58-about-dialog.md) | Low | ❌ |
| 59 | [Keyboard Shortcuts Overlay](tasks/task-59-shortcuts-overlay.md) | Low-Medium | ❌ |
| 60 | [Release Automation](tasks/task-60-release-automation.md) | Medium | ❌ |
| 61 | [Bug Reporter](tasks/task-61-bug-reporter.md) | Medium | ❌ |
| 62 | [Tile Caching](tasks/task-62-tile-caching.md) | Medium-High | ❌ |

---

## 📊 TASK STATISTICS

### DMP Import Refactoring (fn-51-ctu) - URGENT

| Phase | Tasks | Completed | Remaining |
|-------|-------|-----------|-----------|
| 1: Shared Components | 5 | 0 | 5 |
| 2: Dialog Core | 7 | 0 | 7 |
| 3: Placement Features | 3 | 0 | 3 |
| 4: Navigation & Integration | 3 | 0 | 3 |
| 5: Cleanup & Testing | 4 | 0 | 4 |
| **Import Total** | **22** | **0** | **22** |

### v1.0 Completion Tasks (31-62)

| Phase | Tasks | Completed | Remaining |
|-------|-------|-----------|-----------|
| A: Loop Closure | 3 | 0 | 3 |
| B: Settings | 4 | 0 | 4 |
| C: Data Table | 4 | 0 | 4 |
| D: Accessibility | 4 | 0 | 4 |
| E: i18n | 3 | 0 | 3 |
| F: Performance | 4 | 0 | 4 |
| G: Error Handling | 4 | 0 | 4 |
| H: Polish | 6 | 0 | 6 |
| **v1.0 Total** | **32** | **0** | **32** |

### Grand Total

| Category | Tasks | Completed | Remaining |
|----------|-------|-----------|-----------|
| DMP Import Refactoring | 22 | 0 | 22 |
| v1.0 Completion | 32 | 0 | 32 |
| **Grand Total** | **54** | **0** | **54** |

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

### v1.0 Completion Task Dependencies
```
31 (Loop Detection) ──┐
                      ├──> 33 (Closure Strategy)
32 (Closure Error) ───┘

34 (Settings Shell) ──┬──> 35 (Display Tab)
                      ├──> 36 (Validation Tab)
                      └──> 37 (Export Tab)

38 (Inline Edit) ─────┬──> 39 (Add Row)
                      └──> 40 (Delete Row)

42 (Focus) ───────────┬──> 43 (Screen Reader)
                      └──> 45 (Keyboard Nav)

46 (i18n Infra) ──────┬──> 47 (Extract Strings)
                      └──> 48 (Number Format)

53 (Error Boundary) ──┬──> 54 (Network Errors)
                      └──> 55 (Corruption Recovery)

58 (About Dialog) ────────> 61 (Bug Reporter)
```

### Critical Path
1. **DMP Import Refactoring** (fn-51-ctu): URGENT - blocks user workflow improvements
2. **Phase A** (Loop Closure): Foundation for merge improvements
3. **Phase B** (Settings): Required for configurability throughout
4. **Phase D** (Accessibility): WCAG 2.1 AA compliance required
5. **Phase E** (i18n): Infrastructure needed before UI freeze

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
