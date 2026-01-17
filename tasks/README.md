# CaveChef v1.0 Tasks (Post-Ingested)

These 32 tasks advance CaveChef toward v1.0, assuming all tasks in `ingested/` are complete.

## Task Index

### Phase A: Loop Closure (31-33)
| Task | Title | Risk | Description |
|------|-------|------|-------------|
| [31](task-31-loop-detection.md) | Loop Detection Algorithm | Medium-High | BFS path detection when merging stations |
| [32](task-32-closure-error.md) | Closure Error Calculation | Low-Medium | Calculate and display error % and meters |
| [33](task-33-closure-strategy.md) | Closure Strategy Selector | High | Keep-raw vs mark-for-distribution UI |

### Phase B: Settings (34-37)
| Task | Title | Risk | Description |
|------|-------|------|-------------|
| [34](task-34-settings-dialog.md) | Settings Dialog Shell | Medium | Tabbed modal dialog for all settings |
| [35](task-35-display-settings.md) | Display Settings Tab | Medium | Colors, fonts, station/line sizes |
| [36](task-36-validation-settings.md) | Validation Thresholds Tab | Low-Medium | Configure warning thresholds |
| [37](task-37-export-settings.md) | Export Defaults Tab | Low | Default format, DPI, presets |

### Phase C: Data Table (38-41)
| Task | Title | Risk | Description |
|------|-------|------|-------------|
| [38](task-38-inline-editing.md) | Inline Editing | High | Edit shot values directly in table cells |
| [39](task-39-add-row.md) | Add Row | Medium | Add new shots via data table |
| [40](task-40-delete-row.md) | Delete Row | High | Delete with split warnings |
| [41](task-41-row-highlighting.md) | Row Highlighting | Low-Medium | Sync selection between map and table |

### Phase D: Accessibility (42-45)
| Task | Title | Risk | Description |
|------|-------|------|-------------|
| [42](task-42-focus-management.md) | Focus Management | High | Focus trap, return focus, tab order |
| [43](task-43-screen-reader.md) | Screen Reader Announcements | Medium-High | ARIA live regions for status updates |
| [44](task-44-theme-infrastructure.md) | Theme Infrastructure | Medium | CSS variables with --cc- prefix |
| [45](task-45-keyboard-navigation.md) | Keyboard Navigation | Medium | Arrow keys, Home/End, tool shortcuts |

### Phase E: i18n (46-48)
| Task | Title | Risk | Description |
|------|-------|------|-------------|
| [46](task-46-i18n-infrastructure.md) | i18n Infrastructure | Medium | react-i18next setup |
| [47](task-47-extract-strings.md) | Extract UI Strings | High (tedious) | Replace hardcoded strings with t() |
| [48](task-48-number-date-formatting.md) | Number/Date Formatting | Low-Medium | Locale-aware Intl formatting |

### Phase F: Performance (49-52)
| Task | Title | Risk | Description |
|------|-------|------|-------------|
| [49](task-49-virtual-scrolling.md) | Virtual Scrolling | Medium | TanStack Virtual for data table |
| [50](task-50-map-optimization.md) | Map Rendering Optimization | Medium-High | LOD, geometry simplification |
| [51](task-51-debounced-autosave.md) | Debounced Auto-Save | Low-Medium | 2-second debounce, pending indicator |
| [52](task-52-loading-states.md) | Loading States | Medium | Spinners and progress indicators |

### Phase G: Error Handling (53-56)
| Task | Title | Risk | Description |
|------|-------|------|-------------|
| [53](task-53-error-boundary.md) | Error Boundary Wrapper | Medium | Per-panel React error boundaries |
| [54](task-54-network-errors.md) | Network Error Handling | Medium | Offline detection and cached tiles |
| [55](task-55-corruption-recovery.md) | File Corruption Recovery | Medium | SQLite integrity checks and repair |
| [56](task-56-validation-recovery.md) | Validation Error Recovery | Low-Medium | Clear errors and retry |

### Phase H: Polish (57-62)
| Task | Title | Risk | Description |
|------|-------|------|-------------|
| [57](task-57-splash-screen.md) | Splash Screen | Medium | Tauri-native loading screen |
| [58](task-58-about-dialog.md) | About Dialog | Low | Version, credits, diagnostics |
| [59](task-59-shortcuts-overlay.md) | Shortcuts Overlay | Low-Medium | Searchable keyboard shortcut help |
| [60](task-60-release-automation.md) | Release Automation | Medium | GitHub Actions CI/CD pipeline |
| [61](task-61-bug-reporter.md) | Bug Reporter | Medium | Guided bug report with log export |
| [62](task-62-tile-caching.md) | Tile Caching | Medium-High | Offline satellite tile cache |

## Key Requirements Summary

- **Audience**: Beta testers only
- **Survey Size**: 10,000 shots max, <100 per section
- **Accessibility**: WCAG 2.1 AA
- **i18n**: Infrastructure only (English)
- **Platforms**: Linux, Windows, macOS (equal priority)
- **Test Coverage**: 80% minimum
- **Performance**: 30 FPS minimum, <3s startup

## Dependencies

```
31 ────┬──── 32 ──── 33
       │
34 ────┼──── 35
       ├──── 36
       ├──── 37
       └──── 58

38 ──── 39
   ──── 40
   ──── 41

42 ──── 43
   ──── 45

46 ──── 47
   ──── 48

54 ──── 62
```

## Getting Started

1. Start with Phase A (Loop Closure) if implementing survey features
2. Start with Phase B (Settings) if improving configuration
3. Start with Phase D (Accessibility) for WCAG compliance
4. Phases can be worked in parallel by different developers

Each task file includes:
- Overview and priority
- Files to modify
- Detailed specifications
- Acceptance criteria
- Test requirements
- Edge cases
