# Stalagmight Project Structure

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
stalagmight/
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
│   │   │   ├── GlobalView.tsx        # Container component
│   │   │   ├── GlobalViewMap.tsx     # MapLibre map integration
│   │   │   ├── GlobalSurveyLayer.ts  # Multi-system geometry rendering
│   │   │   ├── ViewModeToggle.tsx    # Survey/markers toggle
│   │   │   ├── MetadataPanel.tsx     # System metadata display
│   │   │   └── SystemCard.tsx        # System list item
│   │   ├── SingleSystemView/     # Main editing view
│   │   ├── Map/                  # MapLibre integration
│   │   │   ├── MapCanvas.tsx         # MapLibre map initialization
│   │   │   ├── SurveyLayer.tsx       # Survey rendering on map
│   │   │   └── GridOverlay.tsx       # Theme-aware coordinate grid overlay
│   │   ├── Dialogs/              # All dialog components
│   │   │   ├── KeyboardShortcutsDialog.tsx  # Shortcuts overlay (? key)
│   │   │   └── settings/        # Settings dialog tabs
│   │   │       ├── AppearanceSettings.tsx   # Theme mode & color theme selection
│   │   │       ├── ThemePreviewCard.tsx     # Mini app mockup preview cards
│   │   │       ├── AdvancedSettings.tsx     # Placement suggestion constants
│   │   │       └── ...
│   │   └── common/               # Button, Panel, Table
│   ├── theme/                    # Color theme system
│   │   └── tokens.ts                 # 9 color theme token definitions
│   ├── store/                    # Zustand stores
│   │   ├── projectStore.ts           # Project state
│   │   ├── uiStore.ts                # UI state (incl. resolvedTheme)
│   │   └── globalViewStore.ts        # Global View state
│   ├── hooks/                    # Custom React hooks
│   │   ├── useFocusTrap.ts           # Focus trap for modal dialogs
│   │   ├── useFpsMonitor.ts          # FPS monitoring for throttle
│   │   └── ...
│   ├── utils/                    # Coordinate/color utilities
│   │   ├── dialogStack.ts            # Nested dialog stack manager
│   └── types/                    # TypeScript type definitions
│
├── e2e/                          # WebdriverIO E2E tests (full Tauri app)
│   ├── specs/                    # Test specifications
│   ├── fixtures/                 # Test data (DMP files)
│   └── helpers/                  # Test utilities
│
├── e2e-playwright/               # Playwright E2E tests (mocked IPC, 67 spec files)
│   ├── mocks/                    # Tauri IPC mocks
│   │   └── tauri-ipc.ts          # Mock command handlers
│   ├── fixtures/                 # Test data
│   ├── dmp-import.spec.ts        # Import DMP dialog tests
│   ├── project-crud.spec.ts      # Project operations tests
│   ├── theme.spec.ts             # Color theme switching tests
│   ├── settings-shortcuts.spec.ts # Shortcut configuration tests
│   ├── ui-components.spec.ts     # UI interaction tests
│   └── ...                       # 60+ additional spec files
│
├── docs/                         # Documentation
│   ├── SPEC.md                   # Full specification document
│   ├── TESTING.md                # Testing guide
│   ├── architecture.md           # System design
│   ├── project-structure.md      # This file
│   ├── configuration.md          # Config options
│   ├── roadmap.md                # v1.0 features
│   ├── saving.md                 # Save pipeline & auto-save
│   ├── undo-redo.md              # Undo/redo system details
│   ├── performance.md            # Algorithm choices & profiling
│   ├── ipc-typegen.md            # IPC type generation
│   ├── dmp-import.md             # DMP import format details
│   ├── ariane-import.md          # Ariane import format
│   ├── ariane-export.md          # Ariane export format
│   ├── closures.md               # Loop closure system
│   ├── move-tools.md             # Move station/segment tools
│   ├── releasing.md              # Release process
│   └── style-guide.md            # UI style guide
│
├── CLAUDE.md                     # Agent instructions (minimal)
└── TODO.md                       # Unimplemented features
```
