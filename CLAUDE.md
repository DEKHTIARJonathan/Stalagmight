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
├── SPEC.md                       # Full specification document
├── TODO.md                       # Unimplemented features
└── CLAUDE.md                     # This file
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

## Known Limitations (v1.0)

- Undo/redo stack not persisted across sessions
- No offline tile caching
- Loop closure error distribution not implemented
- Zero datum validation for connected stations not implemented

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
