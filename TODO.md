# CaveChef TODO - v1.0 Completion Tasks

This document tracks functionality specified in `docs/SPEC.md` and the Flow-Next tasks in `.flow/` (legacy checklists below are kept for reference).

**Last Updated**: 2026-01-22

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
- [x] Testing documentation (`docs/TESTING.md`)

---

## Flow-Next Epics (Source of Truth)

Tracked in `.flow/` (specs in `.flow/specs/`, tasks in `.flow/tasks/`). Use `.flow/bin/flowctl` for status.

| Epic | Title | Status | Tasks | Spec |
|------|-------|--------|-------|------|
| fn-1-0u5 | Satellite Map Tile Caching | done | 8/8 | `.flow/specs/fn-1-0u5.md` |
| fn-2-f4f | Zoom Tool Click Behavior | open | 8/8 | `.flow/specs/fn-2-f4f.md` |
| fn-3-e6v | Display Toggle Visibility & Selection Behavior | open | 9/9 | `.flow/specs/fn-3-e6v.md` |
| fn-4-7mg | Configurable interaction bounding boxes for shots and stations | open | 9/9 | `.flow/specs/fn-4-7mg.md` |
| fn-5-jef | Bugfix: Depth Gradient Display Not Working | open | 8/9 | `.flow/specs/fn-5-jef.md` |
| fn-6-yz5 | Bugfix: Edit Section/Shot Dialog Save Button Not Working | open | 3/3 | `.flow/specs/fn-6-yz5.md` |
| fn-7-gba | Bugfix: Back button causes app freeze with blank window | open | 3/3 | `.flow/specs/fn-7-gba.md` |
| fn-8-4v9 | Bugfix: Disable station/shot interactions for Zoom and Pan tools | open | 5/5 | `.flow/specs/fn-8-4v9.md` |
| fn-9-d6v | Section Hover/Selection Highlighting on Map | open | 11/11 | `.flow/specs/fn-9-d6v.md` |
| fn-10-i64 | Loading Progress Indicator | open | 9/9 | `.flow/specs/fn-10-i64.md` |
| fn-11-6w4 | Export System Enhancement | open | 12/12 | `.flow/specs/fn-11-6w4.md` |
| fn-12-szd | Double-click section to zoom and focus on map | open | 7/7 | `.flow/specs/fn-12-szd.md` |
| fn-13-e55 | Configurable Keyboard Shortcuts System | open | 10/10 | `.flow/specs/fn-13-e55.md` |

Flow summary (2026-01-22): 13 epics, 103 tasks, 102 done, 1 blocked.
Blocked: `fn-5-jef.7` Add depth gradient to keyboard shortcuts config.

---

## 🔥 URGENT: DMP Import Refactoring (fn-51-ctu)

Refactor the DMP import workflow from a single monolithic dialog into a two-step process.

**Step 1 (DmpSelectionDialog)**: User selects sections to import, sets default surveyor/date.
**Step 2 (DmpSectionConfigDialog)**: Per-section editing with placement options, shot table, and preview.

Legacy checklist: no matching `tasks/` docs or `.flow/specs/fn-51-ctu.md` in this repo. If reactivating, convert to Flow epics/tasks.

### Phase 1: Shared Components (Parallel)

| Task | Title | Flow ID | Status |
|------|-------|---------|--------|
| 01 | Shared ShotTableEditor | fn-51-ctu.1 | ✅ |
| 02 | Shared SectionMetadataForm | fn-51-ctu.2 | ✅ |
| 03 | Enhanced SectionPreview | fn-51-ctu.3 | ✅ |
| 04 | DmpSelectionDialog Shell | fn-51-ctu.4 | ✅ |
| 15 | File Hash Tracking | fn-51-ctu.15 | ❌ |

### Phase 2: Dialog Core (Sequential)

| Task | Title | Flow ID | Dependencies | Status |
|------|-------|---------|--------------|--------|
| 05 | DmpSectionConfigDialog Shell | fn-51-ctu.5 | 01, 02, 03 | ✅ |
| 06 | Section Parameters Panel | fn-51-ctu.6 | 02, 05 | ✅ |
| 07 | Placement Options Panel | fn-51-ctu.7 | 05 | ✅ |
| 08 | Shot Table Integration | fn-51-ctu.8 | 01, 05 | ✅ |
| 11 | Import State Management | fn-51-ctu.11 | 05 | ✅ |
| 16 | Session Surveyor Memory | fn-51-ctu.16 | 04 | ✅ |
| 17 | Validation Thresholds | fn-51-ctu.17 | 01 | ❌ |

### Phase 3: Placement Features

| Task | Title | Flow ID | Dependencies | Status |
|------|-------|---------|--------------|--------|
| 09 | Merge Preview Visualization | fn-51-ctu.9 | 03, 07 | ✅ |
| 10 | Manual Placement Mode | fn-51-ctu.10 | 07 | ✅ |
| 12 | Section Creation Logic | fn-51-ctu.12 | 07, 11 | ✅ |

### Phase 4: Navigation & Integration

| Task | Title | Flow ID | Dependencies | Status |
|------|-------|---------|--------------|--------|
| 13 | Navigation & Import Buttons | fn-51-ctu.13 | 05, 11 | ✅ |
| 14 | Context-Aware Triggering | fn-51-ctu.14 | 04, 05 | ✅ |
| 18 | Error Blocking Logic | fn-51-ctu.18 | 13 | ✅ |

### Phase 5: Cleanup & Testing

| Task | Title | Flow ID | Dependencies | Status |
|------|-------|---------|--------------|--------|
| 19 | Update Edit Section Dialog | fn-51-ctu.19 | 01, 02 | ✅ |
| 20 | Remove Old Dialog | fn-51-ctu.20 | 14, 18, 19 | ❌ |
| 21 | App Close Confirmation | fn-51-ctu.21 | 20 | ✅ |
| 22 | Update Existing Tests | fn-51-ctu.22 | 20 | ✅ |

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Sections created on placement | Enables granular undo, immediate persistence |
| Exclusive placement modes | Simpler UX, clearer mental model |
| Warnings don't block, errors block | Warnings inform, don't impede workflow |
| Session-only surveyor memory | Respects privacy, not persisted to config |
| Azimuth as average column | Cleaner table, edit sets both in/out |

### Flow Commands (Source of Truth)

```bash
# List epics + tasks
.flow/bin/flowctl list

# List epics only
.flow/bin/flowctl epics

# Show a specific epic/task
.flow/bin/flowctl show fn-<epic>

# Start/complete a task
.flow/bin/flowctl start fn-<epic>.<task>
.flow/bin/flowctl done fn-<epic>.<task> --summary-file s.md --evidence-json e.json
```

---

## 🚧 v1.0 COMPLETION TASKS (31-62)

Legacy checklist: no matching `tasks/` docs in this repo. If reactivating, convert to Flow epics/tasks.
- Detailed requirements
- Files to modify
- Acceptance criteria
- Test requirements (Rust, Playwright, WebdriverIO)

### Phase A: Loop Closure Foundation

| Task | Title | Risk | Status |
|------|-------|------|--------|
| 31 | Loop Detection Algorithm | Medium-High | ✅ |
| 32 | Closure Error Calculation | Low-Medium | ✅ |
| 33 | Closure Strategy Selector | High | ❌ |

### Phase B: Settings & Configuration

| Task | Title | Risk | Status |
|------|-------|------|--------|
| 34 | Settings Dialog Shell | Medium | ✅ |
| 35 | Display Settings Tab | Medium | ❌ |
| 36 | Validation Thresholds Tab | Low-Medium | ❌ |
| 37 | Export Defaults Tab | Low | ❌ |

### Phase C: Data Table Enhancements

| Task | Title | Risk | Status |
|------|-------|------|--------|
| 38 | Inline Editing | High | ✅ |
| 39 | Add Row | Medium | ❌ |
| 40 | Delete Row with Split | High | ❌ |
| 41 | Row Highlighting Sync | Low-Medium | ✅ |

### Phase D: Accessibility

| Task | Title | Risk | Status |
|------|-------|------|--------|
| 42 | Focus Management | High | ❌ |
| 43 | Screen Reader Announcements | Medium-High | ❌ |
| 44 | Theme Infrastructure | Medium | ❌ |
| 45 | Keyboard Navigation | Medium | ❌ |

### Phase E: i18n Foundation

| Task | Title | Risk | Status |
|------|-------|------|--------|
| 46 | i18n Infrastructure | Medium | ❌ |
| 47 | Extract UI Strings | High (tedious) | ❌ |
| 48 | Number/Date Formatting | Low-Medium | ❌ |

### Phase F: Performance & Polish

| Task | Title | Risk | Status |
|------|-------|------|--------|
| 49 | Virtual Scrolling | Medium | ❌ |
| 50 | Map Rendering Optimization | Medium-High | ❌ |
| 51 | Debounced Auto-Save | Low-Medium | ❌ |
| 52 | Loading States | Medium | ✅ |

### Phase G: Error Handling

| Task | Title | Risk | Status |
|------|-------|------|--------|
| 53 | Error Boundary Wrapper | Medium | ❌ |
| 54 | Network Error Handling | Medium | ❌ |
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
| 62 | Tile Caching | Medium-High | ✅ |

---

## 📊 TASK STATISTICS

### DMP Import Refactoring (fn-51-ctu) - URGENT

| Phase | Tasks | Completed | Remaining |
|-------|-------|-----------|-----------|
| 1: Shared Components | 5 | 4 | 1 |
| 2: Dialog Core | 7 | 6 | 1 |
| 3: Placement Features | 3 | 3 | 0 |
| 4: Navigation & Integration | 3 | 3 | 0 |
| 5: Cleanup & Testing | 4 | 3 | 1 |
| **Import Total** | **22** | **19** | **3** |

### v1.0 Completion Tasks (31-62)

| Phase | Tasks | Completed | Remaining |
|-------|-------|-----------|-----------|
| A: Loop Closure | 3 | 2 | 1 |
| B: Settings | 4 | 1 | 3 |
| C: Data Table | 4 | 2 | 2 |
| D: Accessibility | 4 | 0 | 4 |
| E: i18n | 3 | 0 | 3 |
| F: Performance | 4 | 1 | 3 |
| G: Error Handling | 4 | 0 | 4 |
| H: Polish | 6 | 1 | 5 |
| **v1.0 Total** | **32** | **7** | **25** |

### Grand Total

| Category | Tasks | Completed | Remaining |
|----------|-------|-----------|-----------|
| DMP Import Refactoring | 22 | 19 | 3 |
| v1.0 Completion | 32 | 7 | 25 |
| **Grand Total** | **54** | **26** | **28** |

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
