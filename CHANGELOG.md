# Changelog

All notable changes to Stalagmight are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).
Update this file every time a new version is tagged.

## [Unreleased]

### Added
- **Syntactic highlighting** — a consistent color language for which element of the cave each tool and operation acts on: object color encodes *what* (segment, section, shot, station, comment) and a shared modifier encodes *the action* (red delete, slate move). The toolbar gets redrawn duotone icons, and in the richest mode colored "blobs" mark ids in the shot/station tables and the shot/station/section links in the detail panel. A new **Settings → Highlighting** section controls the **level** (Off — monochrome toolbar, no entity coloring; Toolbar only; Icons — also action icons in menus; Full — default), a color **preset** (Default plus colorblind-safe Deuteranopia / Protanopia / Tritanopia palettes), and **per-element color overrides** with reset. The feature is on by default (opt-out).
- **Toggle between measured and closure-adjusted geometry** — the **Display** menu now has a *Geometry* switch with **Measured** (raw survey) and **Closure-adjusted** (loop-closure-corrected) views. Applying loop closures no longer rewrites your measured data: the corrected geometry is computed on top of the measured survey and shown only while the toggle is on, so your raw shots are always intact and adding more closures re-solves cleanly instead of compounding error. The chosen view is remembered across sessions, and the closure-adjusted view is read-only (switch to Measured to edit).
- **Recent projects show path and last-edited time** — each project in the global recent-projects list now shows its file path (elided to fit, full path on hover) and a relative "last edited" time such as "2 hours ago" (exact, locale-aware date and time on hover) ([#46](https://github.com/Stalagmight/Stalagmight/issues/46), [#48](https://github.com/Stalagmight/Stalagmight/issues/48))
- **Sort and search the recent-projects list** — a persisted **Sort by** control (last opened, last edited, name, section count, or total length, in either direction) and a **search box** that filters by name, location, or path, with a "showing X of Y" count and a no-results state ([#47](https://github.com/Stalagmight/Stalagmight/issues/47))
- **Compact table view for recent projects** — toggle between the card view and a dense table whose column headers click to sort
- **Missing recent files are surfaced, not hidden** — projects whose file was moved, deleted, or is unreadable now appear as "File not found" rows with one-click removal, instead of silently disappearing
- **Rename a project from the details panel** — inline-edit a recent project's name without opening it; any already-open copy stays in sync
- **Delete a project from the recents list** — a destructive **Delete project…** action (right-click menu and the details panel), kept separate from the existing **Remove from recent** (which only forgets the entry, leaving the file on disk). It permanently deletes the project's `.stalx` file and its Ariane `.tml` sibling — moved to the Trash/Recycle Bin where your OS provides one, otherwise removed outright ([#118](https://github.com/Stalagmight/Stalagmight/issues/118))
- **Structural-integrity safety net for survey data** ([#17](https://github.com/Stalagmight/Stalagmight/issues/17)) — Stalagmight now protects the relationships in a survey (station merges, loop closures, zero datums, and comments). Edits that would corrupt them are refused before they take effect, and opening a project re-checks it — when something is wrong, a banner offers a one-click **Repair** that drops the invalid data while leaving everything valid untouched. Cross-references are now tied to each shot's stable identity, so inserting or deleting shots can no longer silently re-point a merge, closure, datum, or comment onto the wrong station.

### Changed
- **Toolbar no longer has Draw and Delete tool buttons** — these two tools (and their `D` / `X` shortcuts) were removed from the toolbar to declutter it. Deleting still works: select an element and press <kbd>Delete</kbd>, or use the right-click context menu.
- **Loop-closure adjustment is now non-destructive** — the old "Adjust Closures" action that permanently baked the correction into your shots has been replaced by the measured/closure-adjusted display toggle described above. Existing projects open unchanged; geometry that a previous build already baked cannot be un-baked, but it is never rewritten again.

### Fixed
- **Inclination from a mNemo is no longer stored upside down** ([#296](https://github.com/Stalagmight/Stalagmight/issues/296)): the device reports inclination positive-up while depths are positive-down, and DMP import kept the device's sign. Every non-horizontal DMP shot therefore carried an inclination that contradicted its own depth change, and the validator applied a compensating flip to hide it. Import now converts once, so a descending shot reads as a descent everywhere: in the table, in the details panel, in validation, and in the resolve flow. Checked against every DMP on hand before changing anything. Two knock-on fixes come with it: **"Set length to depth change" no longer writes a reversed inclination** (it wrote the wrong sign, which immediately re-raised the very warning it was resolving), and **moving a station no longer leaves the shot flagged** (that action has always written the correct sign, so the validator disagreed with it).
  - **Existing projects are converted on open.** Nothing in a saved file records which importer a section came from, so the conversion works it out from each section's own geometry and only touches sections where the evidence is one-sided. Sections it cannot read confidently (no depth change to compare against, or no recorded inclination, as with Ariane imports) are left exactly as they are rather than guessed at. A shot whose inclination genuinely disagrees with its depths stays flagged; the conversion will not quietly make a survey blunder look correct.
  - **Inclination shown for DMP-sourced shots changes sign.** A shot descending at 17° now reads `+16.9` where it previously read `-16.9`, matching the sign convention depths already use. Walls- and Compass-sourced shots are unaffected; those were always stored correctly, and it was the reading of them that was wrong.
- **Merged sections move as a rigid group** — "Adjust Position" on a section that is merged (or joined by an aligned loop closure) now moves the whole connected group together, so the merge stays aligned and the move sticks, instead of snapping back or dragging its partner unpredictably
- **Undoing a station move keeps every shot field** — undo previously restored a moved station's azimuth, length, and depth but dropped pitch on the adjacent shots; it now restores all of them exactly
- **Deleting a shot on a loop no longer fabricates a false closure** — when the deleted shot's station was a loop-closure endpoint and the deletion breaks the loop, the closure is now converted to a plain station merge (and the delete-shot dialog lists any closures that will change) instead of being kept as a bogus loop that shifts the geometry ([#8](https://github.com/Stalagmight/Stalagmight/issues/8), related [#41](https://github.com/Stalagmight/Stalagmight/issues/41))
- **Merging two sections joined only by an unaligned loop closure is no longer wrongly blocked** — the "already connected, use a loop closure instead" guard no longer counts a not-yet-computed closure as a rigid connection, so a legitimate merge across one is allowed
- **Merging projects keeps per-station comments** — `Merge projects` now carries station comments across to the merged file instead of silently dropping them
- **Old undo/redo history survives an upgrade** — opening a project saved by an earlier build now loads its full undo/redo history instead of failing to read it and silently starting with an empty stack
- **Drifted (misaligned) station merges are detected and repairable** — merged stations could silently drift apart (one real project had a station 30 m from its merged counterpart) with no warning and no in-app fix; opening or saving a project now flags it and **Repair** pulls the sections back into alignment
- **Shot identity survives undo/redo and project merges** — a shot's stable identity (used for Ariane collaboration matching and internal cross-references) is now preserved when a *Create shot* is redone and when projects are merged; duplicate identities within a section are also detected and repaired
- **Non-finite (NaN/∞) geometry can no longer corrupt a survey** — invalid numbers are now rejected or neutralised at every entry point — Ariane `.tml` import, on-screen edits, and project load — instead of propagating through merged sections and breaking the whole survey

## [0.2.0] - 2026-06-02

### Added
- **SVG/PNG/PDF export rewritten as a black-on-white stick map** — exports now draw only non-reference shots in one of two stroke widths, chosen per segment by a user-controlled branching threshold (the export dialog's "Line-weight threshold" slider). Zero-datum stations render as filled 5-pointed stars, and trunk (thick) segments are annotated with `p. N` penetration-distance labels placed in the largest angular gap at the deepest reachable station. Reference shots are treated as survey-ordering artefacts: chains of them tie anchor segments together for branching-factor calculation without being drawn. The dialog preview renders the exact markup `export_image` writes via a new `preview_svg_export` IPC command, so preview and output can't drift. Penetration distance is unified on a single `Project::compute_penetration_distances` Dijkstra metric shared by the Survey overview stat and the map labels.
- **Collaboration mode (Ariane)** — opt-in, per-project mode that keeps a sibling Ariane `.tml` file next to the `.stalx`. Every save writes both files (with native `<UUID>`s embedded for Ariane 26+); when a collaborator edits the `.tml` in Ariane and you reopen the project, Stalagmight detects the external edit and shows a **Collaboration Review** dialog previewing added/edited/removed shots, new sections, and section-metadata changes before merging them in as a single undoable operation. Shots are matched by UUID → Ariane integer ID → geometry fingerprint → position, so reconciliation survives Ariane's ID renumbering. Stalagmight-only data (loop closures, station merges, section/station offsets, dual azimuth, markers, temperature) is preserved on surviving shots. Enable it per project from the open project's **Project details** panel, or from the **recent-projects details panel** in the global list/map (which toggles a recent project without opening it); opening a project that has a companion `.tml` while collaboration is off warns that the file won't be kept in sync. (`.stalx` SQLite schema bumped to v5; older projects load unchanged with collaboration off)
- **Station comments survive Ariane round-trips** — station comments are now folded into the `.tml` Comment field of the shot whose `to` station matches, using an invisible zero-width-space (`U+200B`) prefix to distinguish shot vs station lines. Reconcile splits them back out, and an Ariane user's bare (unmarked) edits route to the station — matching how Ariane visually centers Comment text on the station. The fresh-import dialog's *"comments on stations"* option now applies the same split (default on).

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
- macOS build support via remote Apple Silicon with build scripts and cross-platform test runners

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
