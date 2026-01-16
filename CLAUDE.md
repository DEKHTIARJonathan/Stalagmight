# CaveChef Development Guide

## Project Overview

CaveChef is a Tauri desktop application for processing underwater cave survey data. It uses a Rust backend with SQLite persistence and a React/TypeScript frontend with MapLibre GL for map rendering.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Tauri 2.x |
| Backend | Rust (stable) |
| Frontend | React 18 + TypeScript (strict mode) |
| State | Zustand |
| Map | MapLibre GL JS |
| Database | SQLite (rusqlite) |
| Styling | Tailwind CSS |
| Logging | tracing + tracing-appender |
| E2E Testing | Playwright (mocked IPC), WebdriverIO (full app) |
| Backend Testing | Rust built-in tests (`cargo test`) |

## Project Structure

```
cavechef/
├── src-tauri/                    # Rust backend
│   ├── src/
│   │   ├── main.rs               # Tauri entry point
│   │   ├── lib.rs                # Library root, Tauri setup
│   │   ├── commands/             # Tauri IPC command handlers
│   │   ├── core/                 # Business logic (command, state, undo)
│   │   ├── models/               # Data structures
│   │   ├── parsers/              # DMP file parser (versions 2-5)
│   │   ├── persistence/          # SQLite operations
│   │   ├── export/               # CSV, JSON, image export
│   │   ├── config/               # Configuration with defaults
│   │   └── logging/              # Tracing setup
│   ├── capabilities/             # Tauri 2.x permissions
│   └── icons/                    # App icons
│
├── src/                          # TypeScript frontend
│   ├── main.tsx                  # React entry point
│   ├── App.tsx                   # Root component
│   ├── components/
│   │   ├── GlobalView/           # Landing/overview view
│   │   ├── SingleSystemView/     # Main editing view
│   │   ├── Map/                  # MapLibre integration
│   │   ├── Dialogs/              # All dialog components
│   │   └── common/               # Button, Panel, Table
│   ├── store/                    # Zustand stores
│   ├── hooks/                    # Custom React hooks
│   ├── utils/                    # Coordinate/color utilities
│   └── types/                    # TypeScript type definitions
│
├── e2e/                          # WebdriverIO E2E tests (full Tauri app)
│   ├── specs/                    # Test specifications
│   ├── fixtures/                 # Test data (DMP files)
│   └── helpers/                  # Test utilities
│
├── e2e-playwright/               # Playwright E2E tests (mocked IPC)
│   ├── mocks/                    # Tauri IPC mocks
│   │   └── tauri-ipc.ts          # Mock command handlers
│   ├── fixtures/                 # Test data
│   ├── import-dialog.spec.ts     # Import dialog tests
│   ├── project-crud.spec.ts      # Project operations tests
│   └── ui-components.spec.ts     # UI interaction tests
│
├── SPEC.md                       # Full specification document
├── TODO.md                       # Unimplemented features
├── TESTING.md                    # Testing documentation
├── CLAUDE.md                     # This file
└── prd/                          # PRD markdown files for v1.0 tasks
    ├── 01-lrud-fields.md
    ├── 02-pitch-fields.md
    ├── ...
    └── 17-export-preview.md
```

## Build Commands

```bash
# Install dependencies
pnpm install

# Development mode
pnpm tauri dev

# Production build
pnpm tauri build

# Type check only
pnpm tsc --noEmit

# Frontend build only
pnpm build
```

## Test Commands

```bash
# Run all tests (backend + E2E)
pnpm test:all

# Playwright E2E tests (fast, mocked IPC)
pnpm test:ui              # Headless
pnpm test:ui:headed       # With visible browser

# Backend Rust tests
cd src-tauri && cargo test

# WebdriverIO E2E tests (full Tauri app, Linux/Windows only)
pnpm test:e2e
```

## Testing Requirements (MANDATORY)

**Every feature addition MUST include tests to be considered complete.** This is non-negotiable.

### Required Tests by Feature Type

| Feature Type | Required Tests |
|--------------|----------------|
| New UI component/dialog | Playwright E2E tests |
| New Tauri IPC command | Rust unit tests + Playwright E2E tests |
| Backend logic (parsers, models) | Rust unit tests |
| User workflow (multi-step) | Playwright E2E tests |
| Bug fix | Regression test covering the fix |

### Pre-Push Checklist

Before pushing any code to remote, ALL of the following must pass:

```bash
# 1. TypeScript type check
pnpm tsc --noEmit

# 2. Playwright E2E tests
pnpm test:ui

# 3. Backend Rust tests
cd src-tauri && cargo test
```

**Do NOT push code with failing tests.** Fix the tests first.

### Test Coverage Guidelines

1. **Playwright tests** (`e2e-playwright/`):
   - Test all user-facing UI interactions
   - Test dialog open/close/submit flows
   - Test keyboard shortcuts
   - Test error states and edge cases
   - Update `mocks/tauri-ipc.ts` when adding new IPC commands

2. **Rust tests** (`src-tauri/src/`):
   - Test all public functions in modules
   - Test edge cases and error handling
   - Test parsers with valid and invalid input
   - Test database operations with in-memory SQLite

3. **WebdriverIO tests** (`e2e/`) - for full integration:
   - Test complete workflows with real backend
   - Test file I/O operations
   - Test persistence across sessions

### Adding Tests for New Features

When implementing a new feature:

1. **Start with tests**: Write failing tests that define expected behavior
2. **Implement feature**: Make tests pass
3. **Add edge cases**: Test error handling and boundary conditions
4. **Update mocks**: If adding new IPC commands, update `e2e-playwright/mocks/tauri-ipc.ts`

See `TESTING.md` for detailed testing documentation and examples.

## Architecture

### State Flow
```
User Action → Zustand Store → Tauri IPC → Rust Command Executor
     ↑                                              │
     └──────────── State Update ←──────── Command Result
```

### Command Pattern
All persistent operations go through the Rust `Command` enum in `src-tauri/src/core/command.rs`. The `AppState` in `state.rs` executes commands and manages undo/redo.

### Data Model
- **Project**: Contains sections, station merges, zero datums, section offsets
- **Section**: Group of shots with metadata (name, surveyor, date, color)
- **Shot**: Single measurement (azimuth, length, depth, LRUD)
- **Station**: Computed from shots, can be merged or set as zero datum

## Key Files

| File | Purpose |
|------|---------|
| `src-tauri/src/core/command.rs` | Command enum and result types |
| `src-tauri/src/core/state.rs` | AppState with command execution, auto-save |
| `src-tauri/src/persistence/sqlite.rs` | Database schema and operations |
| `src-tauri/src/parsers/dmp.rs` | mNemo DMP file parser |
| `src-tauri/src/models/project.rs` | Project model with merge/offset logic |
| `src/store/projectStore.ts` | Frontend state, Tauri IPC calls |
| `src/store/uiStore.ts` | UI state (selection, tools, panels) |
| `src/components/Map/MapCanvas.tsx` | MapLibre map initialization |
| `src/components/Map/SurveyLayer.tsx` | Survey rendering on map |
| `src/hooks/useProject.ts` | Project file operations hook |
| `src/hooks/useMapTools.ts` | Map tool handlers |
| `src/hooks/useKeyboardShortcuts.ts` | Global keyboard shortcut handler |

## Configuration

Config file location: `~/.config/cavechef/config.toml` (Linux)

Key config options:
- `general.auto_save` - Enable auto-save after modifications
- `general.recent_projects` - List of recently opened project paths
- `general.recent_projects_max` - Maximum recent projects to track

Default config is defined in `src-tauri/src/config/defaults.rs`. See `SPEC.md` section 8 for full config options.

## Logging

Logs are written to `~/.local/share/cavechef/logs/` using the `tracing` crate. Log level is configurable in config.

## Working Features (v1.0)

- **DMP Import**: Full parser supporting versions 2-5 (ported from pytool_mnemo_lib)
- **Auto-save**: Saves after each modifying operation when enabled
- **Recent Projects**: Persisted to config, displayed on start page
- **Safe Save**: Uses temp file + atomic rename to prevent data loss
- **Station Merges**: Moves sections so merged stations share coordinates
- **File Operations**: New project dialog, overwrite warnings, error notifications
- **Map Tools**: Select, pan, draw, delete, merge, measure, move section/station
- **Undo/Redo**: Hybrid system with inverse commands and state snapshots
- **Window Title**: Shows filename and dirty state (e.g., "CaveChef - survey.cvproj *")

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| S, P, Z, D, X, M, R, V, T | Tool shortcuts (select, pan, zoom, draw, delete, merge, measure, move section, move station) |
| Ctrl+Z | Undo |
| Ctrl+Y / Ctrl+Shift+Z | Redo |
| Ctrl+S | Save project |
| Ctrl+A | Select all stations |
| Ctrl+I | Import DMP file |
| Ctrl+E | Export (requires open project) |
| Ctrl+0 | Fit map to view all stations |
| Ctrl+1/2/3 | Toggle panels (sections, detail, data table) |
| Delete/Backspace | Delete selected item |
| Escape | Clear selection and tool state |

## Known Limitations (v1.0)

- Undo/redo stack not persisted across sessions
- No offline tile caching
- Loop closure error distribution not implemented
- Zero datum validation for connected stations not implemented

## v1.0 Roadmap (PRDs in Plane)

The remaining v1.0 features are tracked as PRD files in `prd/` and corresponding Plane projects. Each PRD contains detailed specifications, UI mockups, acceptance criteria, and test cases.

### Phase 1: Import Dialog Enhancements
| Task | PRD | Plane ID | Description |
|------|-----|----------|-------------|
| 01 | 01-lrud-fields.md | LRUD | Add L/R/U/D fields to Import Dialog |
| 02 | 02-pitch-fields.md | PITCH | Add pitch_in/pitch_out fields |
| 03 | 03-comment-field.md | CMNT | Add comment field per shot |
| 04 | 04-section-statistics.md | STAT | Live stats in Import Dialog footer |
| 05 | 05-validation-warnings.md | VALD | Inline validation warnings |

### Phase 2: Map Display Features
| Task | PRD | Plane ID | Description |
|------|-----|----------|-------------|
| 06 | 06-scale-bar.md | SCAL | Wire scale bar toggle to MapLibre |
| 07 | 07-section-names.md | SECN | Section name labels at midpoints |
| 08 | 08-station-labels.md | STAL | Station index labels on map |

### Phase 3: GPS & Placement
| Task | PRD | Plane ID | Description |
|------|-----|----------|-------------|
| 09 | 09-gps-coordinates.md | GPS | GPS input with all format support |
| 10 | 10-per-section-dialog.md | SADJ | Per-section adjustment dialog |
| 11 | 11-manual-placement.md | MPLC | Interactive map placement mode |
| 12 | 12-section-preview.md | SPRV | Live SVG preview in Import Dialog |

### Phase 4: GlobalView Enhancements
| Task | PRD | Plane ID | Description |
|------|-----|----------|-------------|
| 13 | 13-globalview-map.md | GMAP | GPS-based map view with tabs |
| 14 | 14-metadata-panel.md | META | Side panel with project details |
| 15 | 15-multi-select-merge.md | MRGE | Multi-select and merge projects |

### Phase 5: Polish
| Task | PRD | Plane ID | Description |
|------|-----|----------|-------------|
| 16 | 16-direction-field.md | DIRN | IN/OUT direction in DMP import |
| 17 | 17-export-preview.md | EXPV | Export preview thumbnail |

### Backend Changes Required
- `create_section` must return new section ID (Tasks 10-11)
- `ProjectMetadata` needs GPS fields from zero datums (Task 13)
- New `merge_projects` command (Task 15)
- `Section` model needs `direction` field (Task 16)

### Global Design Decisions
- Settings only changeable in dedicated Settings window (tabbed layout)
- Validation on blur (field exit)
- Auto-save debounced by default (2s delay, configurable)
- Dark theme only for v1
- i18n keys for all strings (English only initially)

## Architecture Notes

### Mutex Lock Ordering
**Critical**: Never hold a Mutex lock while calling methods that acquire other locks. This caused a deadlock bug where auto-save held the `config` lock while calling `save_project`, which tried to lock `config` again.

**Pattern to avoid**:
```rust
// BAD - holds lock while calling other method
if let Ok(config) = self.config.lock() {
    if config.auto_save {
        self.save_project(None); // save_project also locks config!
    }
}

// GOOD - release lock before calling
let should_save = self.config.lock().map(|c| c.auto_save).unwrap_or(false);
if should_save {
    self.save_project(None);
}
```

### Safe File Save
Always use temp file + atomic rename pattern for saves:
1. Write to `file.cvproj.tmp`
2. On success, rename to `file.cvproj`
3. On failure, delete temp file

This prevents data loss if save fails mid-write.

### Section Offset Tracking
When stations are merged, section positions are recalculated:
1. Build graph of section connections through merges
2. Anchor section (first or with zero datum) stays fixed
3. Calculate offsets for connected sections
4. Store in `Project.section_offsets: HashMap<SectionId, (f64, f64)>`

### Database Operations
- Use `Database::open_existing()` for reading (doesn't create files)
- Use `Database::open()` for writing (creates if needed)
- Shot IDs are generated on load: `section_id * 100000 + sequence`

## Ralph Integration

PRDs are tracked in Plane and configured for autonomous implementation with Ralph. Each Plane project has:
- Branch name in description: `Branch: ralph/<feature-name>`
- Work items ordered by dependencies
- Priority mapping: 1st=urgent, 2nd=high, 3rd=medium, 4th+=low
- Acceptance criteria with "Typecheck passes" and "Verify in browser"

To start Ralph on a task:
```bash
./ralph.sh [max_iterations]
```

The `.ralph-project` file in the repo root contains the current Plane project configuration.
