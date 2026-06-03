# Changelog

All notable changes to Stalagmight are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).
Update this file every time a new version is tagged.

## [Unreleased]

### Fixed
- **The JSON load/create IPC routes now send cross-references in the same shape as everything else** — `load_project_full` and `create_project_full` serialized merges/closures/datums in the internal stable-anchor (`StationKey`) form instead of the positional `{section, station_index}` form the frontend expects; only the live-state route (`get_project_state`) was correct. The single wire serializer is now shared by every Project-bearing IPC payload. No user-visible change today (the app loads via the binary route and new projects have no cross-references), but it removes a latent trap for any future consumer of those JSON routes.
- **Moving a merged section now moves its whole group instead of silently snapping back** — "Adjust Position" on a section that is merged (or aligned-closure connected) to others now shifts the entire rigid group together, so the merge stays aligned and the move sticks. Previously it moved only the one section: if it wasn't the group's anchor the post-move reconcile snapped it back (the move appeared to do nothing), and if it was, the partner was dragged along unpredictably. Undo/redo now restore every affected section, the datum guard covers the whole group, and the dialog notes how many sections will move. (Standalone sections are unchanged.)
- **Integrity *Repair* can now be undone** — Repair drops dangling references, re-mints duplicate UUIDs, and re-cascades section offsets; it now records a single undo entry (a before/after snapshot), so an unwanted or exploratory repair can be reverted with Undo (and re-applied with Redo) instead of being a one-way change.
- **Auto-save never persists a broken project** — auto-save, like a manual save, now refuses to write a project that has unresolvable cross-references (a reference whose station was deleted), and the save-status indicator persistently shows "Auto-save didn't run — not saved" so a blocked auto-save is never silent. The integrity banner stays shown and non-dismissable while saving is blocked, so the **Repair** entry point can't be hidden on a project that can't be saved (detect-only issues that don't block saving remain dismissable).
- **Collaborator-added sections no longer mis-anchor station comments** — when a returned `.tml` adds a whole new section whose shots repeat a UUID, the apply path now keeps each shot's identity unique (mirroring the per-shot guard the edit path already had), so a station comment attaches to the station it was written for instead of silently snapping to the first shot sharing that UUID.
- **Old undo history survives an upgrade** — cross-references embedded in persisted undo snapshots are now read back whether they were written in the old positional form or the new stable-anchor form, so opening a project saved by a previous build no longer fails to deserialize and silently drops the undo/redo stack.
- **Non-finite (NaN/∞) geometry can't drag its neighbours** — the section-offset solver now treats a section with non-finite coordinates as a dangling edge: it is left in place rather than being anchored and propagating a bogus position to the sections merged to it.
- **Merging projects keeps per-station comments** — `Merge projects` now carries station comments across to the merged file; previously they were the one cross-reference collection silently dropped while offsets, datums, merges, and closures were all copied.
- **Switching projects can't carry over a dismissed integrity banner** — the banner's dismissal is reset whenever a project is opened or closed, and the "did the issue set change?" check is order-independent, so dismissing one project's banner can no longer suppress a different project's real integrity warning (two projects can produce byte-identical messages).
- **Drifted (misaligned) station merges are detected and repairable** — a performance regression left a section's alignment offset stale after some edits, so two merged stations could silently end up far apart (one real project had a station 30 m from its merged counterpart) with no warning and no way to fix it in-app. Loading or saving a project now re-checks every cross-section merge; when merged stations are more than 5 cm apart the integrity banner flags it and its **Repair** re-cascades the section offsets to pull them back together (anchored at the group's zero datum). The command guard now blocks only *newly* introduced corruption, so a project that was already corrupt on disk can still be opened and repaired rather than freezing.
- **Deleting a shot on a loop no longer fabricates a false closure** — when a deleted shot's station was a loop-closure endpoint, the closure was rewired to a neighbouring station and kept even if the surviving segment was no longer connected through the survey, producing a bogus loop and a geometry shift. Deletion now checks survey connectivity (shots + merges, excluding the deleted shot) and, when the loop is genuinely broken, converts the closure into a plain station merge instead. The delete-shot impact dialog lists any closures that will become merges. The same sole-bridge-closure→merge conversion now also fires immediately when a **merge is deleted** (unmerge) or a section is split — previously these only self-healed on the next reload and were not flagged by the integrity detector. ([#8](https://github.com/Stalagmight/Stalagmight/issues/8), related [#41](https://github.com/Stalagmight/Stalagmight/issues/41))
- **Undo/redo of merges and unmerges no longer leaves the geometry shifted or corrupt** — both commands have structural side-effects beyond their own edit (unmerge can convert a stranded closure into a merge; a merge re-anchors any section reachable through an aligned loop closure, even one outside the two merge groups). The previous lightweight undo records captured only the directly-merged sections, so undoing could leave a converted closure stuck as a merge (a geometry-breaking cycle) or an aligned-closure section drifted out of place — and the offset-only self-heal couldn't recover it. Merge and unmerge now record full before/after snapshots, so undo restores the complete prior state — every section offset, the original closure, and the original merges — atomically, and redo re-applies it exactly.
- **Undoing a station move no longer corrupts the adjacent shots** — `Move station` rewrites the two adjacent shots' geometry (including pitch); its undo restored azimuth/length/depth but silently dropped pitch (and could leave a merge/closure-connected section drifted). It now records a full snapshot, so undo restores every field and offset exactly.
- **Collaboration apply and TML import now refuse corrupt data instead of importing it** — both paths bypassed the command-level integrity guard, so a collaborator's `.tml` (or an imported file) could write non-finite (NaN/∞) geometry or leave a sole-bridge loop closure straight into the project. They now run the same structural epilogue as ordinary edits — non-finite shots are skipped with a warning, sole-bridge closures become merges, and an import/apply that would introduce dangling references or invalid geometry is rolled back rather than committed.
- **Merging two sections joined only by a not-yet-computed loop closure is no longer wrongly blocked** — the "already connected, use a loop closure instead" check followed *inert* closures (ones whose loop hasn't been computed), so a legitimate merge across one was rejected, nudging users into the false-closure case above. The check now considers only rigid connections (merges and aligned closures) — the same graph the geometry solver uses.
- **Non-finite (NaN/∞) geometry can no longer enter from any source** — invalid numbers are rejected or sanitized at every ingest boundary: section/segment moves reject a non-finite offset, the Ariane `.tml` parser coerces `NaN`/`inf` fields to safe defaults, and a project that already has non-finite shot geometry on disk now opens with that geometry neutralized to finite values (it previously propagated through the offset solver and broke the whole survey).
- **A stale section offset under the 5 cm tolerance is now corrected when the project opens** — section offsets are derived data, but the load-time re-solve skipped any project whose merges were already within the 5 cm reporting tolerance, so a sub-tolerance wrong offset (and its slightly-off geometry) survived every reload. Opening or repairing a project now always re-derives section offsets from the survey constraints, trusting only the genuinely non-derivable anchors (zero-datum and free-placed floating sections).
- **Inserting or deleting a shot can no longer silently mis-point a merge, closure, datum, or comment onto the wrong station** — cross-references used to be stored positionally (`section : station-index`), so every insert/delete had to hand-renumber every reference; a missed renumber left a merge/closure/datum pointing at the *wrong but still-valid* station, with no warning. References are now anchored on the stable shot identity, so an upstream insert/delete shifts nothing — a reference always names the same physical station, and one whose station is genuinely deleted fails loudly as a dangling reference (flagged Critical by the integrity check) instead of pointing somewhere plausible-but-wrong. The on-disk format and the frontend are unchanged (references are still exchanged positionally and resolved internally). ([#17](https://github.com/Stalagmight/Stalagmight/issues/17))
- **Shot UUIDs now survive undo/redo and project merges** — the shot UUID is the stable identity that cross-references and Ariane matching anchor on, but redoing a *Create shot* (and the legacy restore-deleted-shot path) re-minted a fresh UUID, and `merge_projects` re-minted every shot's UUID — silently breaking that identity (a redone or merged shot looked like a delete+add to a collaborator, and dangling any reference that named it). Create-shot redo now restores the original UUID on all three insert modes, and a project merge preserves each source shot's UUID (de-duplicating across files so two merged sources can't collide).
- **Duplicate shot UUIDs within a section are now detected and repaired** — two shots sharing a UUID made anchor resolution silently pick the first (mis-pointing any reference to the second), with no signal. The integrity check now flags it Critical, repair re-mints the duplicate while keeping the first (so existing anchors stay valid), and the collaboration-apply path refuses to adopt a collaborator UUID that would collide.
- **A project with unresolvable cross-references can no longer be silently corrupted on save** — a reference whose anchoring shot was deleted used to be written to disk as a concrete relationship on *station 0* (a phantom merge/closure/datum), and two such dangling offsets/comments in one section collided on the database primary key and aborted the entire save. Saving now refuses while any cross-reference is unresolvable and directs the user to **Repair** (which drops them and unblocks the save); the wire/display path omits dangling references instead of rendering them at station 0; and the persistence layer skips rather than collapses them as a final guard.
- **The live project state sent to the UI now uses the correct cross-reference shape** — `get_project_state` serialized merges/datums/closures in the internal anchor shape rather than the positional `{section, station_index}` form the frontend expects, so dialogs reading those fields off the live state (e.g. orphan-section placement) saw `undefined`. The IPC payload now resolves them to the positional wire form (matching the file-load path), with the on-disk/undo serialization unchanged.
- **A blocked batch command can no longer be resurrected through undo/redo** — the batch path pushed its undo entry before the corruption guard ran, so a batch that left the project corrupt was rolled back but its undo entry survived, letting a later undo→redo reinstate the rejected state. The guard now runs inside the batch *before* the undo entry is recorded.
- **The integrity *Repair* now reports an honest count** — it returned a mix of internal counters that rarely matched the number of issues the banner showed and ignored detect-only problems, so a "successful" repair could still leave issues. It now reports *fixed* and *remaining* measured against the same set the banner counts, and the UI says how many still need manual attention (e.g. a drifted aligned loop closure to recompute/remove, or non-finite geometry to fix).

> Architecture: a full review of the survey data representation and a prioritized roadmap for preventing this class of bug live in [`docs/plans/survey-integrity-architecture.md`](docs/plans/survey-integrity-architecture.md). Stable station identity (anchoring cross-references on shot UUIDs) and zero-trust derived offsets are now implemented; remaining items (closure staleness) are tracked there with status notes.

### Added
- **Structural-integrity safety net for survey data** ([#17](https://github.com/Stalagmight/Stalagmight/issues/17)) — a new `Project::check_structural_integrity` audits every cross-reference (station merges, loop closures, zero datums, and the offset/comment maps) for dangling section references and out-of-range station indices. It is used two ways: (1) **corruption is blocked at the source** — any command whose result would leave dangling references is rolled back to a pre-command snapshot and rejected instead of being committed and later persisted; (2) **corruption already on disk is surfaced and repairable** — opening a project re-checks it, and when problems are found a dismissible banner offers a one-click repair that drops the invalid references while leaving valid data untouched.

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
