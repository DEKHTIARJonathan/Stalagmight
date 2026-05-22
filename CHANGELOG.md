# Changelog

All notable changes to Stalagmight are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).
Update this file every time a new version is tagged.

## [Unreleased]

### Added
- **Collaboration mode (Ariane)** — opt-in, per-project mode that keeps a sibling Ariane `.tml` file next to the `.stalx`. Every save writes both files (with native `<UUID>`s embedded for Ariane 26+); when a collaborator edits the `.tml` in Ariane and you reopen the project, Stalagmight detects the external edit and shows a **Collaboration Review** dialog previewing added/edited/removed shots, new sections, and section-metadata changes before merging them in as a single undoable operation. Shots are matched by UUID → Ariane integer ID → geometry fingerprint → position, so reconciliation survives Ariane's ID renumbering. Stalagmight-only data (loop closures, station merges, section/station offsets, comments, dual azimuth, markers, temperature) is preserved on surviving shots. Enable it under **Settings → Collaboration**. (`.stalx` SQLite schema bumped to v5; older projects load unchanged with collaboration off)

## [0.1.4] - 2026-05-22

### Added
- **Android support** — native Android app target generated via Tauri mobile (`src-tauri/gen/android/`), with build (`scripts/build-android.sh`) and deploy (`scripts/deploy-android.sh`) scripts, network-state and storage permissions, and a verified debug APK build
- **Touch support for tablets** — pointer-event-based interactions across panels, map canvas, and toolbar; long-press context menus (sections panel, shot table, map features, global-view markers); tap-to-toggle toolbar flyouts and help tooltips; wider resize handles on coarse-pointer devices; and a visible Cancel button during placement. Mouse and keyboard behavior is unchanged
- **Kaleido e-ink theme** — high-contrast, pre-composited color theme with CSS transitions/animations disabled to prevent ghosting on e-ink displays
- Decimal on-screen keyboard for numeric inputs (`inputMode="decimal"` across all number fields)
- Per-provider offline tile caching toggle via TOML config (e.g. `[cache.providers.esri] offline_caching = false`); ESRI satellite tiles are now uncached by default (not exposed in the Settings UI)
- Cross-platform path resolution (`app_dirs`) routed through Tauri's path resolver, replacing the `directories` crate which returned `None` on Android

### Fixed
- Android: startup crash from logging initialization on a read-only filesystem
- Android: status bar overlapping the top toolbar
- Android: save dialog reliability — `singleTop` launch mode for SAF result callbacks, `content://` URI resolution, in-app directory-picker fallback, and 0-byte SAF placeholder handling
- Android: satellite tile loading and placement-mode tap handling
- Spurious i18n warnings from onboarding `descriptionItems`

## [0.1.3] - 2026-03-09

### Added
- **Opt-in anonymous usage telemetry** — privacy-preserving, consent-gated analytics. A first-launch opt-in dialog and a Settings privacy toggle; a Rust backend behind a `telemetry` Cargo feature (compiles to no-ops when disabled); tracking of IPC commands, tool selection, map navigation, dialogs, selections, and workflow dwell time; and a D1-backed Cloudflare Worker that ingests batched event counts. No data is collected until the user explicitly opts in

### Changed
- Reactive, tile-driven network status: connectivity is inferred from satellite tile fetch outcomes (ESRI is polled only while offline, and stale tiles reload automatically on recovery) instead of unconditional polling
- Telemetry opt-in dialog is deferred while onboarding is active, and its "Yes, share data" action is now the primary button

### Fixed
- Telemetry is disabled immediately in the current session when the user declines
- Workflow dwell time now reaches the Rust backend while the app is idle
- False dialog-cancel telemetry event during DMP placement transitions

## [0.1.2] - 2026-03-07

### Added
- Middle-click panning everywhere Ctrl+drag pan is supported
- Targeted station unmerge and loop-closure removal from map context menu and detail panel
- TML/TMLU export warning when sections are not connected to a zero datum
- Guided onboarding overlays for DMP import, zero-datum setup, and survey workspace
- Thin collapse bars for workspace panels
- DMP manual placement metadata editing

### Fixed
- Ariane export: round-trip topology, closure parity, pre-zero-datum azimuth reversal, azimuth_out semantics, and child sections with non-zero merge station
- DMP import: segment detachment during overlap/skip, stale merge-station defaults, skipped-suggestion placement mismatch, and duplicate sections after manual placement
- Per-shot depth gradient rendering with consistent dark-theme colors across all themes
- Themed hover tooltip for closure-adjustment help icon (no longer clipped)
- Save-now flow performs a single write to the selected path
- Default project autosave path moved to Documents/stalagmight
- Non-map controls locked during segment placement to prevent stale state

### Changed
- Renamed "reference shot" to "jump line" in user-facing labels
- Removed legacy DMP section-config import workflow
- Redesigned onboarding guided flows with visual tool references
- Import dialog "Place on Map" promoted to primary CTA
- Suppressed ts-rs serde attribute warnings in build output

## [0.1.1] - 2026-03-03

### Fixed
- Ad-hoc code signing for macOS app bundle to allow distribution without Gatekeeper issues

## [0.1.0] - 2026-03-03

### Added
- 9 color themes with preview cards and theme-aware map background
- Keyboard shortcuts overlay triggered by the `?` key
- Section-level duplicate detection for DMP import
- Section/station selector for manual placement mode in DMP import
- Post-import orphan placement dialog with station pair selection and overlap mode
- Dual-segment preview in fromExisting import mode with auto-close orphan dialog
- 23 custom tool icons with hover flyout labels
- Placement suggestion heuristic constants exposed in Advanced Settings
- macOS build support via Scaleway Apple Silicon with build scripts and cross-platform test runners

### Fixed
- DMP parser now correctly sign-extends int16 values for negative pitch readings
- Grid overlay uses correct coordinate space and theme colors
- Maintain merge alignment when inserting shots mid-section
- Undo/redo stacks now written synchronously during save to prevent data loss
- Snap camera instantly on first zero datum creation
- GPS extraction from Google Maps place URLs
- Overlap treatment for doubly-anchored target sections
- Section offset compensation to keep zero datum fixed after overlap interpolation
- Warm-start PCG solver and skip same-group shots in LSQ closure adjustment
- Numerous overlap import edge cases (import-to-import cycles, double-treatment, direction reversal)
- Spur (branch) shots skipped correctly in LSQ closure adjustment

### Changed
- Hardened state management, error handling, and input validation across backend and frontend
- Eliminated duplicate code and fragile patterns across backend and frontend
- Unified GPS input fields across all dialogs

## [0.0.9] - 2026-02-06

### Added
- Splash screen with opt-in setting
- Validation error recovery dialog (SPEC 14.5)
- Strict clippy and rustc lint configuration

### Fixed
- Widened DMP import year range to accept dates from 2000
- Realigned merge group offsets after shot geometry edits

## [0.0.4] through [0.0.8] - 2026-02-06

Rapid iterations fixing CI/CD release automation. No user-visible changes.

### Fixed
- Release pipeline packaging (replaced tauri-action with direct build and Gitea API)
- Changelog extraction for release body and artifact upload
- Tauri bundle configuration for release packaging
- AppImage bundling dependency (`xdg-utils`)
- SIGPIPE avoidance in CI artifact collection

## [0.0.3] - 2026-02-06

Initial packaged release. This version represents the full v1.0 feature set built from
January 12 to February 6, 2026.

### Added
- **DMP import**: Full Ariane DMP file parser with two-step import wizard, section selection, shot editing, placement modes (GPS, manual map, connect-to-existing), validation warnings, file hash duplicate detection, and connection wizard with automatic placement suggestions from overlap detection
- **Ariane TML/TMLU import and export**: Import and export Ariane survey files with loop closure support, excluded shot filtering, and depth interpretation
- **GPX import**: Import waypoints, tracks, and routes with elevation-to-depth conversion
- **Map rendering**: MapLibre-based survey visualization with stations, shots, section/station labels, shot data labels, depth gradient coloring, section highlighting, and satellite imagery toggle
- **Map tools**: Selection, merge, measure, draw, move station/segment/shot, zoom (click, box, spring-loaded Z key), and right-click context menu
- **Loop closures**: Detection, error calculation, visual indicators with error colors, and least-squares closure adjustment
- **Station merging**: Snap-to-station merge with closure strategy tracking, zero datum merge validation, and full undo support
- **Move tools**: Move station with snap-to-merge, move segment with drag preview, move shot, and Ctrl+drag panning
- **Display controls**: Toggles for shots, stations, labels, depth gradient, scale bar, satellite imagery, and grid overlay
- **Data table**: Editable shot table with virtual scrolling, section dropdown, stations view, right-click context menu, keyboard navigation, LRUD columns, and decimal precision formatting
- **Detail panel**: Station, shot, and section detail views with hyperlinks, center-on-map buttons, loop closure section, and project/section statistics
- **Global view**: Multi-system overview with GPS satellite map, marker visibility toggling, multi-select with aggregate stats, context menu, search filter, keyboard shortcuts, and persistent map state
- **Export**: SVG and PNG export with depth coloring, color presets, depth legend, progress feedback, and PDF support
- **Settings**: Sidebar layout with General, Display, Validation, Shortcuts, and Appearance tabs; per-setting reset-to-default; configurable keyboard shortcuts with recorder UI; theme selector; decimal precision and number/date format settings
- **Undo/redo**: Full undo/redo with SQLite persistence, gzip compression, rich preview, multi-step undo/redo, history dropdown with hover details, and error recovery
- **Persistence**: SQLite project storage with integrity checks, debounced auto-save with status bar indicator, atomic undo for imports, and file corruption recovery dialog
- **Accessibility**: Focus trap and Escape handling in dialogs, React portal with inert management, roving tabindex, ARIA listbox roles, screen reader announcements, and focus ring CSS variables
- **Theming**: Light/dark theme infrastructure with CSS variables, theme-aware color palettes, and appearance settings
- **Tile caching**: SQLite-backed satellite tile cache with LRU eviction, ArcGIS tilemap API, retry logic, and network status monitoring
- **Performance**: Tile overzoom LRU cache, Tarjan's bridge detection for frozen shots, spatial index for snap-to-station, RAF-batched mousemove, `setFeatureState` for hover/selection, sparse PCG solver for loop closures, and optimized save pipeline
- **Comments**: Station and shot comments with comment tool, move comment sub-tool, and visibility toggle
- **Other**: Frozen shots (read-only geometry for positioned shots), section zoom, configurable hover/selection radius, locale-aware number formatting, file path in window title, resizable panel persistence, GPS coordinate parsing (7 formats), and project merge in global view
