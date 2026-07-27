# Changelog

All notable changes to Stalagmight are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).
Update this file every time a new version is tagged.

## [Unreleased]

### Added
- **Survey, Plan and Export workspace modes** - the app now has three top-level modes, switched from a carousel in the middle of the top bar. **Survey** is the editing workspace; **Plan** is gas and route planning; **Export** is a what-you-see-is-what-you-get export surface. Plan and Export both show the read-only closure-adjusted map and drop the mutating tools, so the survey can't change under a plan or a preview ([#38](https://github.com/Stalagmight/Stalagmight/issues/38))
- **Gas-limited route planning** - Plan mode colors the survey by the gas it takes to reach each point, and marks the *turn frontier*: the stations where the dive has to turn around. Set the rig up in the gas panel - back-gas and stage cylinders (any of which can be disabled without deleting its row), RMV and swim speed (a jump RMV multiplier lives in Settings → Gas planning) - and pick a **Gas strategy**: *All thirds*, *Half Minus: 1 stage*, *Half Minus: 2 stages*, or *Free*, where you set each cylinder's penetration allowance yourself. A **safety margin** holds extra gas back from every cylinder. Every number the panel shows - usable gas per cylinder, back-gas turn pressure, stage drop pressures - is computed by the same engine that draws the map, so a readout can't drift from the reach it claims ([#38](https://github.com/Stalagmight/Stalagmight/issues/38))
- **Pick a route, and read it back** - left-click a red turn-frontier dot, or right-click a station, a shot line, or empty cave, to set the route endpoint; the plan re-solves for that destination instead of the deepest reachable point. Plan then reports the **distance to the turnaround** and the **maximum** and distance-weighted **average depth** along the route. Jump legs are faded in the route highlight, so a swum line reads differently from a shortcut ([#236](https://github.com/Stalagmight/Stalagmight/issues/236), [#243](https://github.com/Stalagmight/Stalagmight/issues/243))
- **Stage drops you can move** - every stage cylinder gets a drop marker on the route. Drag it, or nudge it with the arrow keys, to drop that tank somewhere else and the whole plan recomputes. Dropping **deeper** than the safe point is allowed but flagged red - you are breathing into that stage's reserve - and dropping **shallower** strands the surplus gas and honestly shortens the reach. Delete, or double-click the marker, to put it back ([#246](https://github.com/Stalagmight/Stalagmight/issues/246))
- **Ordered way points and marked points** - way points are stations the dive must visit, in order: the reach field, the turn frontier and the stage drops all pay for the detour instead of quietly planning the shortest line to the endpoint. A way point that can't be reached stalls the plan rather than being silently skipped, because it is a constraint, not a hint. Marked points are free annotation. A right-click menu on the route manages both ([#298](https://github.com/Stalagmight/Stalagmight/issues/298))
- **Named dive plans persist** - plans are saved in a sibling `.plnx` file next to the `.stalx` (never inside it, so SpeleoDB pushes and Ariane collaboration are untouched). A "Previous dive plans" bar loads, saves and deletes them, and unsaved edits are guarded when you close the app or load another plan. A plan stores stable station anchors, so it keeps pointing at the same physical stations across later survey edits ([#244](https://github.com/Stalagmight/Stalagmight/issues/244))
- **Export mode** - the Export workspace mode puts a large what-you-see-is-what-you-get preview over the map, driven by the same controls as the export dialog. The rendered image uses the closure-adjusted geometry the live map shows, instead of the raw measured coordinates. A **Color** dropdown matches the survey map - monochrome, by section, by depth, or by distance from the entrance (PNG and PDF; SVG export stays monochrome) - and a collapsible **Comments & Labels** section mirrors the Display tab: section names, station labels, station comments, shot comments and shot data, alongside the penetration-distance labels ([#239](https://github.com/Stalagmight/Stalagmight/issues/239), [#240](https://github.com/Stalagmight/Stalagmight/issues/240))
- **SpeleoDB integration** - open a project straight from SpeleoDB, edit it while holding the server's single-writer lock, and push it back, without leaving the app. A remote project is read-only until you take the lock; local edits are fenced against the server tip, and when the two have diverged a prompt offers keep-local, save-as-a-local-copy, or take-the-SpeleoDB-version (behind a second confirmation, since that one discards unpushed work). Lock holders are badged in the recent-projects and Global View lists, a lock a crashed session left behind can be resumed or released, and a project's revision history can be viewed and restored from. Remote projects you have access to but haven't opened appear in Global View, an Ariane-only remote project can be adopted as a native `.stalx`, and an opt-in force-edit lets you work while offline or while someone else holds the lock. Your token lives in the OS keychain and never crosses into the web view ([#182](https://github.com/Stalagmight/Stalagmight/issues/182))
- **Publish and manage SpeleoDB projects in-app** - publish a local project to SpeleoDB (name, description, country, visibility and map location, with collaborators queued from the create dialog), then edit those details, manage per-user and per-team collaborators, release your own lock or force-release someone else's as an admin, and delete a project - all from a **SpeleoDB** tab in Project Settings ([#182](https://github.com/Stalagmight/Stalagmight/issues/182))
- **Walls (`.wpj` / `.srv`) survey import** - imports David McKenzie's Walls format from the Import menu, drag-and-drop, or <kbd>Ctrl+I</kbd>. A `.wpj` project tree, or a standalone `.srv`, is parsed into linked, GPS-positioned sections with merges, loop closures, and one GPS anchor per connected part of the cave. The import dialog offers per-survey selection, a splay toggle, comments-on-stations, duplicate-file detection, and live shot / GPS-anchor / splay counts for the current selection.
- **Windows support** - the app builds, runs, saves and loads satellite tiles on Windows. Tile requests use the URL form WebView2 can actually navigate, and the project's database handle is closed before the atomic save rename so Windows can replace the file.
- **The data table is a spreadsheet** - shots and stations moved onto an in-house grid with a spreadsheet selection and keyboard model: copy/cut/paste, fill from a copied tile, column hide and reorder with position memory, a frozen gutter, per-column validation that flashes rejected input, and required cells that clear to a visible "missing" state instead of silently keeping or zeroing a value. Shots get draft rows for creating shots anywhere in a section (several at once, auto-committed once the required fields are filled), azimuth/inclination **Avg** and **In+Out** column families that swap in place, and visibly recessed cells on frozen shots. Stations get X/Y and GPS coordinate groups, a zero-datum cell that opens the station dialog, and connection cells that open a merges/closures picker. A full-screen table mode trades the map for room ([#61](https://github.com/Stalagmight/Stalagmight/issues/61))
- **Warnings tab: guided resolution, issue-severity coloring, per-project validation** - the Warnings tab is a workflow now: **Resolve** / **Resolve all** with a live on-map ghost preview of each proposed fix, a virtualized list, double-click a row to pan to it, and per-warning fixes for azimuth, length, depth, LRUD, and inclination-vs-depth-vs-length geometry (trust the depth and adjust the length or the inclination, or split the shot). Resolved and ignored warnings persist across saves, keyed to the shot's stable identity. A new **Survey Issues** color mode (Display → Color) tints shots and stations green/yellow/red across merge groups, and switches on when the tab is opened. Validation thresholds are per-project, stored in the `.stalx` and edited from **Project Settings** ([#22](https://github.com/Stalagmight/Stalagmight/issues/22), [#57](https://github.com/Stalagmight/Stalagmight/issues/57))
- **Dual-distance ruler** - the measure tool reports both distances between two picked points: the **direct** 3D straight line, and the **along-cave-line** distance following the surveyed passage. Endpoints snap to a station or to an exact point on a shot, and the chosen path's shots and stations are tinted. Endpoints in disconnected parts of the cave report no along-line distance rather than a wrong one ([#26](https://github.com/Stalagmight/Stalagmight/issues/26))
- **Distance gradient overlay** - **Display → Color → Distance** colors the survey gold to purple by along-cave distance from the entrance, greys out anything unreachable, and shows a legend with the range and the current origin. Click a station - or a shot, which uses its lower-numbered end, so it works with stations hidden - to re-root the gradient anywhere ([#34](https://github.com/Stalagmight/Stalagmight/issues/34))
- **Jump and Reference are separate kinds of virtual shot** - a **Jump** is a shortcut a diver actually swims; a **Reference** is a survey tie nobody can swim, such as a tape between two mainlines. References are now excluded from penetration distance, the distance gradient, the ruler and gas planning, where they used to act as free shortcuts; jumps still count. The data table gets a three-way Jump/Reference cell, the map draws each kind distinctly, and **Display** has separate **Jumps** and **References** toggles. Existing projects are classified once on open - a connected run of virtual shots that reaches real survey in two or more places is a jump, anything else a reference - and the import dialogs let you override the verdict per file ([#27](https://github.com/Stalagmight/Stalagmight/issues/27))
- **Insert a station in the middle of a shot** - right-click a shot on the map, or a row in the data table, and choose **Insert Station...** to split it at a distance (or a percentage) along its length into two collinear shots with a new station between them, ready to tie further exploration into. A right-click on the map prefills both fields at the exact spot clicked. The split is undoable and geometry-exact, and every station merge, loop closure, zero datum and comment anchored past it keeps pointing at the same physical station ([#59](https://github.com/Stalagmight/Stalagmight/issues/59))
- **Bulk shot deletion** - selecting a contiguous run of shots in the data table opens a **Delete Shots** dialog. An interior range asks whether to **split** the section in two (both ends stay put) or **close the gap** (the downstream survey shifts up); a range touching either end closes the gap; a whole-section range routes to the existing section delete ([#95](https://github.com/Stalagmight/Stalagmight/issues/95))
- **Section focus mode** - click the focus button on a section's sidebar row to focus it: both side panels collapse, the map refits to that section, and the data table opens editable (double-clicking the row zooms to the section without entering focus). Focusing out of the read-only closure-adjusted view returns to measured geometry, so the table really is editable ([#50](https://github.com/Stalagmight/Stalagmight/issues/50))
- **Hovering the map highlights the section in the sidebar** - the owning section's row lights up and scrolls into view, styled distinctly from a plain mouse-over and from the selection ([#42](https://github.com/Stalagmight/Stalagmight/issues/42))
- **The move-comment tool color-pairs comments with their owners** - while that tool is active, every comment label takes a color and the shot or station it belongs to is tinted to match, so it is obvious which note goes with which feature while you reposition them. Colors key off the feature's identity, so adding or moving one comment never recolors the others, and deselecting the tool restores the previous paint exactly ([#52](https://github.com/Stalagmight/Stalagmight/issues/52))
- **Syntactic highlighting** - a consistent color language for which element of the cave each tool and operation acts on: object color encodes *what* (segment, section, shot, station, comment) and a shared modifier encodes *the action* (red delete, slate move). The toolbar gets redrawn duotone icons, and in the richest mode colored "blobs" mark ids in the shot/station tables and the shot/station/section links in the detail panel. A new **Settings → Highlighting** section controls the **level** (Off - monochrome toolbar, no entity coloring; Toolbar only; Icons - also action icons in menus; Full - default), a color **preset** (Default plus colorblind-safe Deuteranopia / Protanopia / Tritanopia palettes), and **per-element color overrides** with reset. The feature is on by default (opt-out).
- **Toggle between measured and closure-adjusted geometry** - the **Display** menu now has a *Geometry* switch with **Measured** (raw survey) and **Closure-adjusted** (loop-closure-corrected) views. Applying loop closures no longer rewrites your measured data: the corrected geometry is computed on top of the measured survey and shown only while the toggle is on, so your raw shots are always intact and adding more closures re-solves cleanly instead of compounding error. The chosen view is remembered across sessions, and the closure-adjusted view is read-only (switch to Measured to edit).
- **Recent projects show path and last-edited time** - each project in the global recent-projects list now shows its file path (elided to fit, full path on hover) and a relative "last edited" time such as "2 hours ago" (exact, locale-aware date and time on hover) ([#46](https://github.com/Stalagmight/Stalagmight/issues/46), [#48](https://github.com/Stalagmight/Stalagmight/issues/48))
- **Sort and search the recent-projects list** - a persisted **Sort by** control (last opened, last edited, name, section count, or total length, in either direction) and a **search box** that filters by name, location, or path, with a "showing X of Y" count and a no-results state ([#47](https://github.com/Stalagmight/Stalagmight/issues/47))
- **Compact table view for recent projects** - toggle between the card view and a dense table whose column headers click to sort
- **Missing recent files are surfaced, not hidden** - projects whose file was moved, deleted, or is unreadable now appear as "File not found" rows with one-click removal, instead of silently disappearing
- **Rename a project from the details panel** - inline-edit a recent project's name without opening it; any already-open copy stays in sync
- **Delete a project from the recents list** - a destructive **Delete project…** action (right-click menu and the details panel), kept separate from the existing **Remove from recent** (which only forgets the entry, leaving the file on disk). It permanently deletes the project's `.stalx` file and its Ariane `.tml` sibling - moved to the Trash/Recycle Bin where your OS provides one, otherwise removed outright ([#118](https://github.com/Stalagmight/Stalagmight/issues/118))
- **Structural-integrity safety net for survey data** ([#17](https://github.com/Stalagmight/Stalagmight/issues/17)) - Stalagmight now protects the relationships in a survey (station merges, loop closures, zero datums, and comments). Edits that would corrupt them are refused before they take effect, and opening a project re-checks it - when something is wrong, a banner offers a one-click **Repair** that drops the invalid data while leaving everything valid untouched. Cross-references are now tied to each shot's stable identity, so inserting or deleting shots can no longer silently re-point a merge, closure, datum, or comment onto the wrong station.

### Changed
- **The survey map draws through a custom WebGL renderer** - both the single-system map and Global View now render on a purpose-built renderer instead of MapLibre's stock layers: passage lines, stations, every label and comment, the drag ghost, and the selection / dimming / overlay coloring passes. Very large surveys hold far less memory, hit-testing runs off the geometry index rather than querying rendered features, and edits, drags and undo update the picture in place instead of re-tiling it. There is no fallback: the old pipeline is gone, so if WebGL2 is unavailable or a layer fails, the app tells you which part failed rather than quietly drawing something else ([#80](https://github.com/Stalagmight/Stalagmight/issues/80))
- **In-app chrome reworked** - the Global View header and the in-project toolbar collapse into one hamburger **App menu** built from shared rows, so the two can't drift. Panels become a single dockable instance with hover and pin modes riding Sections / Details / Data opener tabs, with sizes and reveal modes persisted. The Display menu is rebuilt as element-colored pill categories, icons are redrawn as fills so they stay legible at any zoom, Open and Import route through one path, and a failed save now offers a one-click retry. Debug Logs confirm Copy and Refresh, the details panel resets to the project view whenever a project opens, and the scale bar is always shown (its setting is gone) ([#49](https://github.com/Stalagmight/Stalagmight/issues/49), [#53](https://github.com/Stalagmight/Stalagmight/issues/53), [#54](https://github.com/Stalagmight/Stalagmight/issues/54))
- **The top bar condenses instead of overflowing** - the in-project toolbar and the Global View header drop labels in a fixed priority order as horizontal space runs out, then tighten their padding, and restore everything when the space comes back
- **Loop-closure adjustment is faster on large surveys** - the least-squares solve now collapses degree-2 chains before solving, turning a per-component O(n^2) into O(n), and coordinate lookups during the solve are no longer linear scans ([#81](https://github.com/Stalagmight/Stalagmight/issues/81))
- **DMP placement suggestions rank better** - connection suggestions are reranked using survey timing and cave-traversal constraints, with tighter matching thresholds and crossing rejection; and the wizard's default suggestion is now the highest-confidence feasible one rather than whatever the backend ranked first, so accepting the default no longer wires up the wrong connection ([#96](https://github.com/Stalagmight/Stalagmight/issues/96), [#101](https://github.com/Stalagmight/Stalagmight/issues/101))
- **The DMP connection wizard opens near-fullscreen** - it was a cramped fixed-size modal; it now uses nearly the whole window, with a larger section preview and room for the shots table ([#21](https://github.com/Stalagmight/Stalagmight/issues/21))
- **Toolbar no longer has Draw and Delete tool buttons** - these two tools (and their `D` / `X` shortcuts) were removed from the toolbar to declutter it. Deleting still works: select an element and press <kbd>Delete</kbd>, or use the right-click context menu.
- **Loop-closure adjustment is now non-destructive** - the old "Adjust Closures" action that permanently baked the correction into your shots has been replaced by the measured/closure-adjusted display toggle described above. Existing projects open unchanged; geometry that a previous build already baked cannot be un-baked, but it is never rewritten again.

### Fixed
- **Inclination from a mNemo is no longer stored upside down** ([#296](https://github.com/Stalagmight/Stalagmight/issues/296)): the device reports inclination positive-up while depths are positive-down, and DMP import kept the device's sign. Every non-horizontal DMP shot therefore carried an inclination that contradicted its own depth change, and the validator applied a compensating flip to hide it. Import now converts once, so a descending shot reads as a descent everywhere: in the table, in the details panel, in validation, and in the resolve flow. Checked against every DMP on hand before changing anything. Two knock-on fixes come with it: **"Set length to depth change" no longer writes a reversed inclination** (it wrote the wrong sign, which immediately re-raised the very warning it was resolving), and **moving a station no longer leaves the shot flagged** (that action has always written the correct sign, so the validator disagreed with it).
  - **Existing projects are converted on open.** Nothing in a saved file records which importer a section came from, so the conversion works it out from each section's own geometry and only touches sections where the evidence is one-sided. Sections it cannot read confidently (no depth change to compare against, or no recorded inclination, as with Ariane imports) are left exactly as they are rather than guessed at. A shot whose inclination genuinely disagrees with its depths stays flagged; the conversion will not quietly make a survey blunder look correct.
  - **Undo history from before the conversion is cleared**, but only for projects the conversion actually changed. Those entries record the old inclination, so replaying one would have quietly put it back. Projects that needed no conversion keep their history.
  - **Inclination warnings you had dismissed are re-raised** on a converted project, since the number they were dismissed against has changed meaning. Anything still genuinely wrong shows up again rather than staying hidden.
  - **Ariane collaboration re-exports the sibling file** before comparing against it, so a `.tml` written by an older build does not show up as an inclination edit on every shot.
  - **Inclination shown for DMP-sourced shots changes sign.** A shot descending at 17° now reads `+16.9` where it previously read `-16.9`, matching the sign convention depths already use. Walls- and Compass-sourced shots are unaffected; those were always stored correctly, and it was the reading of them that was wrong.
- **Merged sections move as a rigid group** - "Adjust Position" on a section that is merged (or joined by an aligned loop closure) now moves the whole connected group together, so the merge stays aligned and the move sticks, instead of snapping back or dragging its partner unpredictably
- **Undoing a station move keeps every shot field** - undo previously restored a moved station's azimuth, length, and depth but dropped pitch on the adjacent shots; it now restores all of them exactly
- **Deleting a shot on a loop no longer fabricates a false closure** - when the deleted shot's station was a loop-closure endpoint and the deletion breaks the loop, the closure is now converted to a plain station merge (and the delete-shot dialog lists any closures that will change) instead of being kept as a bogus loop that shifts the geometry ([#8](https://github.com/Stalagmight/Stalagmight/issues/8), related [#41](https://github.com/Stalagmight/Stalagmight/issues/41))
- **Merging two sections joined only by an unaligned loop closure is no longer wrongly blocked** - the "already connected, use a loop closure instead" guard no longer counts a not-yet-computed closure as a rigid connection, so a legitimate merge across one is allowed
- **Merging projects keeps per-station comments** - `Merge projects` now carries station comments across to the merged file instead of silently dropping them
- **Old undo/redo history survives an upgrade** - opening a project saved by an earlier build now loads its full undo/redo history instead of failing to read it and silently starting with an empty stack
- **Drifted (misaligned) station merges are detected and repairable** - merged stations could silently drift apart (one real project had a station 30 m from its merged counterpart) with no warning and no in-app fix; opening or saving a project now flags it and **Repair** pulls the sections back into alignment
- **Shot identity survives undo/redo and project merges** - a shot's stable identity (used for Ariane collaboration matching and internal cross-references) is now preserved when a *Create shot* is redone and when projects are merged; duplicate identities within a section are also detected and repaired
- **Non-finite (NaN/∞) geometry can no longer corrupt a survey** - invalid numbers are now rejected or neutralised at every entry point - Ariane `.tml` import, on-screen edits, and project load - instead of propagating through merged sections and breaking the whole survey
- **Importing into a brand-new project no longer loses the import** - a DMP imported into a project whose first save was still deferred was never written to disk and never reached the recent-projects list, so quitting lost the whole import. The import now resolves that first save; a save that fails is reported as a warning on an otherwise successful import instead of being dropped; and closing the window mid-wizard warns about the sections still held in memory ([#92](https://github.com/Stalagmight/Stalagmight/issues/92), [#110](https://github.com/Stalagmight/Stalagmight/issues/110))
- **The grabbed point stays under the cursor while moving** - grabbing a segment, station or shot a few pixels off its attachment made the whole thing jump so that the click point, not the point you grabbed, ended up under the cursor - worst when zoomed out ([#20](https://github.com/Stalagmight/Stalagmight/issues/20), [#79](https://github.com/Stalagmight/Stalagmight/issues/79))
- **Two zero datums in one merged group no longer tear the merge apart silently** - a merge-connected group can hold at most one GPS anchor; two over-constrain it and the merge visibly pulls apart. Converting a sole-bridge loop closure into a merge no longer fuses two independently anchored groups, a project that already has the problem raises a warning on load, and removing the extra datum re-solves the geometry in place
- **Section Adjust accepts negative and partial offsets** - the dx/dy fields rejected a leading minus sign and pinned a zero that couldn't be deleted, making it impossible to nudge a section in the -X or -Y direction ([#161](https://github.com/Stalagmight/Stalagmight/issues/161))
- **Data-table sub-header dropdowns stay clickable when they flip upward** - in a short panel the section pill, raw-table pill and column menu were clipped by the dock; the clipped items still looked present but clicks fell through to the map behind them ([#162](https://github.com/Stalagmight/Stalagmight/issues/162))
- **Merging projects to a path with no extension no longer overwrites a file silently** - the `.stalx` extension was appended *after* the "output already exists" check, so merging to `foo` sailed past an existing `foo.stalx` and then overwrote it ([#169](https://github.com/Stalagmight/Stalagmight/issues/169))
- **Dropdowns no longer dismiss themselves as they open** - opening a select whose trigger sat at the edge of a scroll container scrolled the trigger into view, and that scroll immediately closed the list it had just opened ([#268](https://github.com/Stalagmight/Stalagmight/issues/268))
- **Tool state no longer carries across a project switch** - the active tool and its pending targets (merge station A/B, move-comment source, comment target) survived loading another project; because ids are small integers they resolve in the new project too, so the next click could act on the wrong station or shot
- **Shot and comment visibility are restored when a project loads** - the saved "show shots" and "show shot comments" display settings were written on save but never applied on load
- **Anchored sections dim correctly under the move tools** - the check deciding whether a feature belongs to an anchored section recovered the section from a shot's id incorrectly, so the wrong sections dimmed and hover highlights leaked onto sections that can't move ([#301](https://github.com/Stalagmight/Stalagmight/issues/301))
- **macOS: a save blocked by revoked folder access explains itself** - after an OS or app update macOS can forget a previously-granted folder, which surfaced as a misleading "corrupted database" failure even though the data was fine; it now names folder access as the cause and says how to restore it ([#39](https://github.com/Stalagmight/Stalagmight/issues/39))
- **macOS: scrolling over the map no longer drags the window** - wheel and trackpad events over the map chained up to the document and let the window rubber-band instead of zooming the map ([#43](https://github.com/Stalagmight/Stalagmight/issues/43))

## [0.2.0] - 2026-06-02

### Added
- **SVG/PNG/PDF export rewritten as a black-on-white stick map** - exports now draw only non-reference shots in one of two stroke widths, chosen per segment by a user-controlled branching threshold (the export dialog's "Line-weight threshold" slider). Zero-datum stations render as filled 5-pointed stars, and trunk (thick) segments are annotated with `p. N` penetration-distance labels placed in the largest angular gap at the deepest reachable station. Reference shots are treated as survey-ordering artefacts: chains of them tie anchor segments together for branching-factor calculation without being drawn. The dialog preview renders the exact markup `export_image` writes via a new `preview_svg_export` IPC command, so preview and output can't drift. Penetration distance is unified on a single `Project::compute_penetration_distances` Dijkstra metric shared by the Survey overview stat and the map labels.
- **Collaboration mode (Ariane)** - opt-in, per-project mode that keeps a sibling Ariane `.tml` file next to the `.stalx`. Every save writes both files (with native `<UUID>`s embedded for Ariane 26+); when a collaborator edits the `.tml` in Ariane and you reopen the project, Stalagmight detects the external edit and shows a **Collaboration Review** dialog previewing added/edited/removed shots, new sections, and section-metadata changes before merging them in as a single undoable operation. Shots are matched by UUID → Ariane integer ID → geometry fingerprint → position, so reconciliation survives Ariane's ID renumbering. Stalagmight-only data (loop closures, station merges, section/station offsets, dual azimuth, markers, temperature) is preserved on surviving shots. Enable it per project from the open project's **Project details** panel, or from the **recent-projects details panel** in the global list/map (which toggles a recent project without opening it); opening a project that has a companion `.tml` while collaboration is off warns that the file won't be kept in sync. (`.stalx` SQLite schema bumped to v5; older projects load unchanged with collaboration off)
- **Station comments survive Ariane round-trips** - station comments are now folded into the `.tml` Comment field of the shot whose `to` station matches, using an invisible zero-width-space (`U+200B`) prefix to distinguish shot vs station lines. Reconcile splits them back out, and an Ariane user's bare (unmarked) edits route to the station - matching how Ariane visually centers Comment text on the station. The fresh-import dialog's *"comments on stations"* option now applies the same split (default on).

## [0.1.4] - 2026-05-22

### Added
- **Android support** - native Android app target generated via Tauri mobile (`src-tauri/gen/android/`), with build (`scripts/build-android.sh`) and deploy (`scripts/deploy-android.sh`) scripts, network-state and storage permissions, and a verified debug APK build
- **Touch support for tablets** - pointer-event-based interactions across panels, map canvas, and toolbar; long-press context menus (sections panel, shot table, map features, global-view markers); tap-to-toggle toolbar flyouts and help tooltips; wider resize handles on coarse-pointer devices; and a visible Cancel button during placement. Mouse and keyboard behavior is unchanged
- **Kaleido e-ink theme** - high-contrast, pre-composited color theme with CSS transitions/animations disabled to prevent ghosting on e-ink displays
- Decimal on-screen keyboard for numeric inputs (`inputMode="decimal"` across all number fields)
- Per-provider offline tile caching toggle via TOML config (e.g. `[cache.providers.esri] offline_caching = false`); ESRI satellite tiles are now uncached by default (not exposed in the Settings UI)
- Cross-platform path resolution (`app_dirs`) routed through Tauri's path resolver, replacing the `directories` crate which returned `None` on Android

### Fixed
- Android: startup crash from logging initialization on a read-only filesystem
- Android: status bar overlapping the top toolbar
- Android: save dialog reliability - `singleTop` launch mode for SAF result callbacks, `content://` URI resolution, in-app directory-picker fallback, and 0-byte SAF placeholder handling
- Android: satellite tile loading and placement-mode tap handling
- Spurious i18n warnings from onboarding `descriptionItems`

## [0.1.3] - 2026-03-09

### Added
- **Opt-in anonymous usage telemetry** - privacy-preserving, consent-gated analytics. A first-launch opt-in dialog and a Settings privacy toggle; a Rust backend behind a `telemetry` Cargo feature (compiles to no-ops when disabled); tracking of IPC commands, tool selection, map navigation, dialogs, selections, and workflow dwell time; and a D1-backed Cloudflare Worker that ingests batched event counts. No data is collected until the user explicitly opts in

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
