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
| E2E Testing | Playwright (mocked IPC, the CI tier), WebdriverIO (full app: the quarantined `e2e/legacy` suite + the `e2e/agent` harness) |
| Unit / Component Testing | Vitest (+ Testing Library) |
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
│   │   ├── parsers/              # Import parsers: dmp (mNemo, versions 2-5),
│   │   │                         #   tml (Ariane), compass, gpx, walls/
│   │   ├── persistence/          # SQLite operations
│   │   ├── cache/                # Tile caching (SQLite-based)
│   │   ├── export/               # CSV, JSON, image export
│   │   ├── speleodb/             # SpeleoDB integration (auth, dump, sync)
│   │   ├── telemetry/            # Anonymous counters + event registry
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
│   │   └── common/               # Button, Panel, Select, SpreadsheetGrid
│   ├── theme/                    # Color theme system
│   │   └── tokens.ts                 # 10 color theme token definitions
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
├── e2e/                          # Full-app tests + harnesses (real Tauri app)
│   ├── agent/                    # LLM-agent harness (MCP + WebdriverIO)
│   ├── fixtures/                 # Test data (DMP files)
│   ├── legacy/                   # Quarantined WebdriverIO suite (on-demand)
│   └── lib/                      # Shared helpers
│
├── e2e-playwright/               # Playwright E2E tests (mocked IPC, 100+ spec files)
│   ├── mocks/                    # Tauri IPC mocks
│   │   └── tauri-ipc.ts          # Mock command handlers
│   ├── fixtures/                 # Test data
│   ├── dmp-import.spec.ts        # Import DMP dialog tests
│   ├── project-crud.spec.ts      # Project operations tests
│   ├── theme.spec.ts             # Color theme switching tests
│   ├── settings-shortcuts.spec.ts # Shortcut configuration tests
│   ├── ui-components.spec.ts     # UI interaction tests
│   └── ...                       # the rest of the spec files
│
├── scripts/                      # Dev + CI scripts: the lint gates, dev.sh,
│                                 #   release.sh, mac build, replay generators
│
├── docs/                         # Documentation
│   ├── SPEC.md                   # Full specification document
│   ├── TESTING.md                # Testing guide
│   ├── architecture.md           # System design
│   ├── project-structure.md      # This file
│   └── ...                       # every page indexed in docs/README.md
│
└── CLAUDE.md                     # Agent instructions (AGENTS.md symlinks to it)
```
