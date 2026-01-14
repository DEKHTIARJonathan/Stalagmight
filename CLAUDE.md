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
│   │   ├── parsers/              # File format parsers (DMP stub)
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
│   │   ├── Dialogs/              # Import, Export dialogs
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
- **Project**: Contains sections, station merges, zero datums
- **Section**: Group of shots with metadata (name, surveyor, date, color)
- **Shot**: Single measurement (azimuth, length, depth, LRUD)
- **Station**: Computed from shots, can be merged or set as zero datum

## Key Files

| File | Purpose |
|------|---------|
| `src-tauri/src/core/command.rs` | Command enum and result types |
| `src-tauri/src/core/state.rs` | AppState with command execution |
| `src-tauri/src/persistence/sqlite.rs` | Database schema and operations |
| `src/store/projectStore.ts` | Frontend state, Tauri IPC calls |
| `src/store/uiStore.ts` | UI state (selection, tools, panels) |
| `src/components/Map/MapCanvas.tsx` | MapLibre map initialization |
| `src/components/Map/SurveyLayer.tsx` | Survey rendering on map |

## Configuration

Config file location: `~/.config/cavechef/config.toml` (Linux)

Default config is defined in `src-tauri/src/config/defaults.rs`. See `SPEC.md` section 8 for full config options.

## Logging

Logs are written to `~/.local/share/cavechef/logs/` using the `tracing` crate. Log level is configurable in config.

## Known Limitations (v1.0)

See `TODO.md` for full list. Key items:
- Undo/redo stack not persisted across sessions
- No offline tile caching
- Loop closure error distribution not fully implemented

## Recent Changes

### Working Features
- **DMP Parser**: Full implementation supporting versions 2-5 (ported from pytool_mnemo_lib)
- **Auto-save**: Saves after each modifying operation when enabled in config
- **Recent Projects**: Persisted to config file, displayed on start page
- **Safe Save**: Uses temp file + atomic rename to prevent data loss
- **Station Merges**: Properly moves sections so merged stations share coordinates
- **File Operations**: New project dialog, overwrite warnings, error notifications

### Architecture Notes
- Config file at `~/.config/cavechef/config.toml` stores recent projects
- Auto-save triggers after modifying commands (create/update/delete section/shot, merge, etc.)
- Mutex lock ordering is important - avoid holding locks while calling other methods that acquire locks
