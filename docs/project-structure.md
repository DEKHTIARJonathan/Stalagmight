# CaveChef Project Structure

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

## Directory Tree

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
│   │   ├── cache/                # Tile caching (SQLite-based)
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
│   ├── import-dialog.spec.ts     # Import DMP dialog tests (Ctrl+I)
│   ├── project-crud.spec.ts      # Project operations tests
│   └── ui-components.spec.ts     # UI interaction tests
│
├── docs/                         # Documentation
│   ├── plans/                    # Implementation plans
│   ├── SPEC.md                   # Full specification document
│   ├── TESTING.md                # Testing guide
│   ├── architecture.md           # System design
│   ├── project-structure.md      # This file
│   ├── configuration.md          # Config options
│   └── roadmap.md                # v1.0 features
│
├── prd/                          # PRD markdown files for v1.0 tasks
│   ├── 01-lrud-fields.md
│   ├── 02-pitch-fields.md
│   └── ...
│
├── CLAUDE.md                     # Agent instructions (minimal)
└── TODO.md                       # Unimplemented features
```
