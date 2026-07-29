# Changelog

All notable changes to Stalagmight are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).
Update this file every time a new version is tagged.

## [Unreleased]

### Changed

- CI: GitHub Actions bumped to versions that run on Node.js 24, ahead of the Node.js 20 runtime deprecation ([#351](https://github.com/Stalagmight/Stalagmight/issues/351))
- `scripts/release.sh` now bumps `src-tauri/Cargo.lock` alongside the other three version files, so a release no longer leaves the lock a version behind. It rewrites only this crate's stanza, refuses to start if the lock is already out of step (including under `--dry-run`), tolerates a CRLF checkout, and reverts the version files if `$EDITOR` exits non-zero instead of stranding a half-finished release. `scripts/test-release.sh` covers all of it and now runs in CI, which it never did before - that is why the drift went unnoticed for three releases ([#352](https://github.com/Stalagmight/Stalagmight/issues/352))
- The pinned toolchain moved to **Node.js 24** (`.nvmrc` plus advisory `engines`), so builds and tests now run on the current LTS line. `scripts/mac-setup.sh` and `scripts/mac-build.sh` read the major from `.nvmrc` instead of hardcoding it, so they can no longer drift behind a bump. pnpm stays pinned at `9.15.9` ([#109](https://github.com/Stalagmight/Stalagmight/issues/109))
- The agent harness moved to Node 24 with everything else, so there is no second toolchain. Its "Node 22 only" rule blamed a webdriverio undici-versus-built-in-fetch mismatch that the code does not actually do; session creation works identically on Node 22 and 24, and `pnpm agent:http-probe` now checks that in one command after a webdriverio or Node bump

### Removed

- **Ariane collaboration mode** - the opt-in per-project mode that kept a sibling `.tml` next to the `.stalx`, saved both on every save, and reconciled external Ariane edits back in on the next open has been removed entirely. Plain Ariane `.tml`/`.tmlu` import and export are unaffected. `.stalx` schema v15 drops the now-unused `collab_state` table. **Persisted undo/redo history is cleared on first open of a pre-upgrade project** - a saved entry can name a collaboration operation this build no longer understands, and replaying the entries around it would corrupt the survey, so the stored history is dropped once and rebuilds as you work.

## [0.5.0] - 2026-07-29

The first release with builds for all three platforms. The headline additions are
**Plan mode**, a gas- and range-aware dive planner built on the survey graph, and
**SpeleoDB integration**, which lets a project live on a server and be handed
between divers.

### Highlights

- **Plan mode** - plan a dive against the actual survey: gas-limited reach, a turn frontier, ordered way points, movable stage drops, DPV support, and a depth profile you can export ([#38](https://github.com/Stalagmight/Stalagmight/issues/38))
- **SpeleoDB integration** - open a project from SpeleoDB, edit it under the server's single-writer lock, and push it back without leaving the app ([#182](https://github.com/Stalagmight/Stalagmight/issues/182))
- **Export mode** - a what-you-see-is-what-you-get export surface over the map, sharing the survey map's coloring ([#239](https://github.com/Stalagmight/Stalagmight/issues/239))
- **The data table is a spreadsheet** - an in-house grid with real copy/paste, draft rows, column families and per-column validation ([#61](https://github.com/Stalagmight/Stalagmight/issues/61))
- **Loop closures are non-destructive** - a Display toggle between measured and closure-adjusted geometry; your raw shots are never rewritten
- **A custom WebGL map renderer** - large surveys hold far less memory and edits update the picture in place ([#80](https://github.com/Stalagmight/Stalagmight/issues/80))
- **Walls import and Windows support** - `.wpj` / `.srv` surveys import, and the app builds and runs on Windows
- **Downloads for macOS and Windows** - releases now ship `.dmg`, `.msi` and `-setup.exe` alongside the Linux packages ([#324](https://github.com/Stalagmight/Stalagmight/issues/324))

### Added

#### Plan mode

- **Gas-limited reach** - Plan mode colors the survey by the gas it takes to reach each point and marks the *turn frontier*, the stations where the dive has to turn around. Set up back-gas and stage cylinders (any can be disabled without deleting the row), RMV and swim speed, then pick a **Gas strategy**: *All thirds*, *Half Minus: 1 stage*, *Half Minus: 2 stages*, or *Free*, where you set each cylinder's allowance yourself. A **safety margin** holds gas back from every cylinder. Every number shown - usable gas, turn pressure, drop pressures - comes from the same engine that draws the map, so a readout cannot drift from the reach it claims ([#38](https://github.com/Stalagmight/Stalagmight/issues/38), [#228](https://github.com/Stalagmight/Stalagmight/issues/228), [#245](https://github.com/Stalagmight/Stalagmight/issues/245))
- **Routes you steer** - click a turn-frontier dot, or right-click anywhere, to set the endpoint and re-solve for it. **Way points** are stations the dive must visit in order, paid for by the whole solve rather than silently skipped; an unreachable one stalls the plan, because it is a constraint, not a hint. **Marked points** are free annotation. Every stage cylinder gets a drop marker you can drag or nudge: dropping deeper than the safe point is allowed but flagged red, dropping shallower honestly shortens the reach. Plan reports distance to the turnaround and the maximum and average depth along the route, with jump legs faded so a swum line reads differently from a shortcut ([#236](https://github.com/Stalagmight/Stalagmight/issues/236), [#243](https://github.com/Stalagmight/Stalagmight/issues/243), [#246](https://github.com/Stalagmight/Stalagmight/issues/246), [#298](https://github.com/Stalagmight/Stalagmight/issues/298))
- **DPV planning with per-segment speeds** - model a scooter rig (a primary plus a mandatory backup) in the **Equipment** tab. Way points divide the route into **segments**, and the **Segments** tab gives each one a speed and an on-DPV flag, with its own color on the route. A scootered span spends the rig's usable one-way range by the *battery clock*, so riding slower than cruise costs more range than line, and the panel says when it is range rather than gas that turns the dive. The park point is derived from the segments and marked on the map ([#317](https://github.com/Stalagmight/Stalagmight/issues/317))
- **The planned dive as a profile** - a **Profile** tab charts depth across the round trip against distance or runtime, marking the turnaround, stage drops and way points. Every number is the one the gas engine already solved, so the chart cannot drift from the plan beside it. Exports as Subsurface-shaped dive XML or a fixed-width text table for a slate. Both carry a header saying what the file is not: Stalagmight has **no decompression model** - no ascent schedule, no stops, no tissue loading - and a profile must never be read as one ([#299](https://github.com/Stalagmight/Stalagmight/issues/299))
- **Named dive plans persist** - saved in a sibling `.plnx` file next to the `.stalx`, never inside it, so SpeleoDB pushes and Ariane collaboration are untouched. Plans store stable station anchors, so they keep pointing at the same physical stations across later survey edits ([#244](https://github.com/Stalagmight/Stalagmight/issues/244))
- **Survey, Plan and Export workspace modes** - three top-level modes from a carousel in the top bar. Plan and Export show the read-only closure-adjusted map and drop the mutating tools, so the survey cannot change under a plan or a preview ([#38](https://github.com/Stalagmight/Stalagmight/issues/38))

#### SpeleoDB

- **Open, lock, edit and push** - a remote project is read-only until you take the write lock; local edits are fenced against the server tip, and when the two diverge a prompt offers keep-local, save-as-a-local-copy, or take-the-server-version behind a second confirmation. Lock holders are badged in the project lists, a lock left by a crashed session can be resumed or released, and revision history can be viewed and restored from. Remote projects you have access to appear in Global View, an Ariane-only remote project can be adopted as a native `.stalx`, and an opt-in force-edit lets you work offline or while someone else holds the lock. Your token lives in the OS keychain and never crosses into the web view ([#182](https://github.com/Stalagmight/Stalagmight/issues/182))
- **Publish and manage projects in-app** - publish a local project (name, description, country, visibility, map location, collaborators), then manage details, per-user and per-team collaborators, lock release and deletion from a dedicated dialog with **General**, **Collaborators**, **History** and **Admin** tabs. Admin holds force-release of another user's lock, because that is stuck-lock recovery rather than part of editing. Links go straight to the same project on your server, and the toolbar's status mark right-clicks to the full menu ([#182](https://github.com/Stalagmight/Stalagmight/issues/182))
- **Revert without taking the lock first** - the revision history offers **Revert** on a read-only project: it takes the lock, puts the revision back, uploads it as a new revision, and releases the lock, ending exactly as read-only as it started. History is never rewritten. Offered even when the local copy has changes the server has never seen, behind a two-step confirmation naming what it replaces - a state that previously offered nothing at all
- **Credential storage you can see** - Settings reports whether your API key is in the OS keychain, a plaintext file, or held for the session, without interrogating the keyring (on Linux that is itself what raises the unlock prompt). If the keychain refuses the key at sign-in, it asks then and there whether to keep it for the session or write a file, rather than leaving you to discover later that you were signed out

#### Survey and data

- **Structural-integrity safety net** - Stalagmight now protects the relationships in a survey (station merges, loop closures, zero datums, comments). Edits that would corrupt them are refused before they take effect, and opening a project re-checks it; a banner offers **Review & Repair**, which lists what is wrong and repairs it in one click, dropping only invalid data. Cross-references are tied to each shot's stable identity, so inserting or deleting shots can no longer silently re-point a merge, closure, datum or comment onto the wrong station ([#17](https://github.com/Stalagmight/Stalagmight/issues/17))
- **The data table is a spreadsheet** - shots and stations moved onto an in-house grid with a spreadsheet selection and keyboard model: copy/cut/paste, fill from a copied tile, column hide and reorder with position memory, a frozen gutter, per-column validation that flashes rejected input, and required cells that clear to a visible "missing" state rather than silently keeping or zeroing a value. Shots get draft rows for creating shots anywhere in a section, and azimuth/inclination **Avg** and **In+Out** column families that swap in place. Stations get coordinate groups, a zero-datum cell, and connection cells that open a merges/closures picker. A full-screen mode trades the map for room ([#61](https://github.com/Stalagmight/Stalagmight/issues/61))
- **Warnings tab is a workflow** - **Resolve** / **Resolve all** with a live on-map ghost preview of each proposed fix, a virtualized list, double-click to pan, and per-warning fixes for azimuth, length, depth, LRUD and inclination-vs-depth-vs-length geometry. Resolved and ignored warnings persist across saves, keyed to the shot's stable identity. A **Survey Issues** color mode tints shots and stations green/yellow/red across merge groups. Validation thresholds are per-project, stored in the `.stalx` ([#22](https://github.com/Stalagmight/Stalagmight/issues/22), [#57](https://github.com/Stalagmight/Stalagmight/issues/57))
- **Jump and Reference are separate kinds of virtual shot** - a **Jump** is a shortcut a diver actually swims; a **Reference** is a survey tie nobody can swim, such as a tape between two mainlines. References are now excluded from penetration distance, the distance gradient, the ruler and gas planning, where they used to act as free shortcuts; jumps still count. Existing projects are classified once on open, and the import dialogs let you override per file ([#27](https://github.com/Stalagmight/Stalagmight/issues/27))
- **Insert a station in the middle of a shot** - right-click a shot and choose **Insert Station...** to split it at a distance or percentage along its length into two collinear shots with a new station between them. Undoable and geometry-exact, and every merge, closure, datum and comment anchored past it keeps pointing at the same physical station ([#59](https://github.com/Stalagmight/Stalagmight/issues/59))
- **Bulk shot deletion** - selecting a contiguous run of shots opens a **Delete Shots** dialog. An interior range asks whether to **split** the section in two or **close the gap**; a range touching either end closes the gap ([#95](https://github.com/Stalagmight/Stalagmight/issues/95))
- **Toggle between measured and closure-adjusted geometry** - a *Geometry* switch in the **Display** menu. Applying loop closures no longer rewrites your measured data: the corrected geometry is computed on top of the measured survey and shown only while the toggle is on, so raw shots stay intact and adding closures re-solves cleanly instead of compounding error. The closure-adjusted view is read-only
- **Dual-distance ruler** - the measure tool reports both the **direct** 3D straight line and the **along-cave-line** distance following the surveyed passage. Endpoints snap to a station or an exact point on a shot. Endpoints in disconnected parts of the cave report no along-line distance rather than a wrong one ([#26](https://github.com/Stalagmight/Stalagmight/issues/26))
- **Distance gradient overlay** - **Display -> Color -> Distance** colors the survey gold to purple by along-cave distance from the entrance, greys out anything unreachable, and shows a legend. Click a station or shot to re-root the gradient anywhere ([#34](https://github.com/Stalagmight/Stalagmight/issues/34))

#### Import, export and platforms

- **Walls (`.wpj` / `.srv`) survey import** - imports David McKenzie's Walls format from the Import menu, drag-and-drop, or <kbd>Ctrl+I</kbd>. A `.wpj` project tree, or a standalone `.srv`, is parsed into linked, GPS-positioned sections with merges, loop closures and one GPS anchor per connected part of the cave. The dialog offers per-survey selection, a splay toggle, comments-on-stations, duplicate-file detection and live counts
- **Export mode** - a large what-you-see-is-what-you-get preview over the map, driven by the same controls as the export dialog, rendering the closure-adjusted geometry the live map shows. A **Color** dropdown matches the survey map (PNG and PDF; SVG stays monochrome), and a **Comments & Labels** section mirrors the Display tab ([#239](https://github.com/Stalagmight/Stalagmight/issues/239), [#240](https://github.com/Stalagmight/Stalagmight/issues/240))
- **Windows support** - the app builds, runs, saves and loads satellite tiles on Windows
- **Downloads for macOS and Windows, not just Linux** - releases attach `.dmg` (macOS, Apple Silicon only), `.msi` and `-setup.exe` (Windows) alongside `.deb`, `.rpm` and `.AppImage`. There is no Intel Mac build: no maintainer has Intel hardware, so an architecture-specific bug there could not be reproduced or fixed. Nothing is notarized, and only macOS is signed at all (ad-hoc, which is what keeps it launchable), so each release explains how to get past Gatekeeper and SmartScreen, and ships a `SHA256SUMS` generated on the machine that built the binaries ([#324](https://github.com/Stalagmight/Stalagmight/issues/324), [#323](https://github.com/Stalagmight/Stalagmight/issues/323))

#### Interface

- **Syntactic highlighting** - a consistent color language for which element of the cave each tool acts on: object color encodes *what* (segment, section, shot, station, comment) and a shared modifier encodes *the action* (red delete, slate move). **Settings -> Appearance -> Syntactic Highlighting** controls the level, a color preset (including colorblind-safe Deuteranopia / Protanopia / Tritanopia palettes) and per-element overrides. On by default
- **Section focus mode** - focus a section from its sidebar row: both panels collapse, the map refits, and the data table opens editable. Focusing out of the read-only closure-adjusted view returns to measured geometry, so the table really is editable ([#50](https://github.com/Stalagmight/Stalagmight/issues/50))
- **Hovering the map highlights the section in the sidebar** ([#42](https://github.com/Stalagmight/Stalagmight/issues/42)), and **the move-comment tool color-pairs comments with their owners**, so it is obvious which note goes with which feature while repositioning them ([#52](https://github.com/Stalagmight/Stalagmight/issues/52))
- **Recent projects, reworked** - each entry shows its file path and a relative "last edited" time; a persisted **Sort by** control and a **search box** filter the list; a compact table view toggles against the cards; missing files appear as "File not found" rows with one-click removal instead of vanishing; projects can be renamed inline; and a **Delete project...** action permanently deletes the `.stalx` (to the Trash where the OS provides one), kept separate from **Remove from recent** ([#46](https://github.com/Stalagmight/Stalagmight/issues/46), [#47](https://github.com/Stalagmight/Stalagmight/issues/47), [#48](https://github.com/Stalagmight/Stalagmight/issues/48), [#118](https://github.com/Stalagmight/Stalagmight/issues/118))

### Changed

- **The survey map draws through a custom WebGL renderer** - both the single-system map and Global View render on a purpose-built renderer instead of MapLibre's stock layers. Very large surveys hold far less memory, hit-testing runs off the geometry index, and edits, drags and undo update the picture in place instead of re-tiling it. There is no fallback: if WebGL2 is unavailable the app tells you which part failed rather than quietly drawing something else ([#80](https://github.com/Stalagmight/Stalagmight/issues/80))
- **In-app chrome reworked** - the Global View header and in-project toolbar collapse into one hamburger **App menu** built from shared rows. Panels become a single dockable instance with hover and pin modes, sizes and reveal modes persisted. The Display menu is rebuilt as element-colored pill categories, Open and Import route through one path, and a failed save offers a one-click retry ([#49](https://github.com/Stalagmight/Stalagmight/issues/49), [#53](https://github.com/Stalagmight/Stalagmight/issues/53), [#54](https://github.com/Stalagmight/Stalagmight/issues/54))
- **The top bar condenses instead of overflowing** - labels drop in a fixed priority order as space runs out, then padding tightens, and everything returns when the space does
- **Loop-closure adjustment is faster on large surveys** - the least-squares solve collapses degree-2 chains before solving, turning a per-component O(n^2) into O(n) ([#81](https://github.com/Stalagmight/Stalagmight/issues/81))
- **Loop-closure adjustment is now non-destructive** - the old "Adjust Closures" action that baked the correction into your shots is replaced by the measured/closure-adjusted toggle. Existing projects open unchanged; geometry a previous build already baked cannot be un-baked, but is never rewritten again
- **DMP placement suggestions rank better** - reranked using survey timing and cave-traversal constraints, with tighter thresholds and crossing rejection. The wizard's default is now the highest-confidence feasible suggestion, so accepting it no longer wires up the wrong connection ([#96](https://github.com/Stalagmight/Stalagmight/issues/96), [#101](https://github.com/Stalagmight/Stalagmight/issues/101)). The connection wizard also opens near-fullscreen instead of in a cramped modal ([#21](https://github.com/Stalagmight/Stalagmight/issues/21))
- **SpeleoDB says "write lock", not "lock"** - so it reads as exclusive write access rather than the file being shut. The status mark shows a green pen while you hold it, not a padlock, which reads as "shut" to anyone who has not learned that holding the lock is the permissive state. The token-storage setting is gone: where the key is kept is decided when the keychain actually fails, and reported in Settings
- **A released build reports its release version** - a build of a tagged commit shows the bare version, since the tag already pins the commit; development and untagged CI builds keep a commit suffix, because there the commit is the only thing identifying them. The commit is shown on its own line either way
- **Persisted undo/redo history is cleared on first open of a pre-upgrade project** - entries saved by earlier builds speak the old reference flag and the old inclination sign convention; replaying one would silently undo those conversions
- **Toolbar no longer has Draw and Delete tool buttons** - deleting still works: select an element and press <kbd>Delete</kbd>, or use the right-click menu
- **Licensed under AGPL-3.0-or-later** - with contribution guidelines ([CONTRIBUTING.md](CONTRIBUTING.md)) and a security policy ([SECURITY.md](SECURITY.md)), in preparation for a public release

### Fixed

#### Packaging

- **macOS: the `.app` in the DMG could not be opened at all**, with macOS reporting it as "damaged". The download was intact; the bundle was never signed. Without a signing identity Tauri skips code signing entirely, leaving only the Rust linker's ad-hoc signature on the inner binary, with no sealed resources and no `_CodeSignature` - a state macOS rejects as *invalid* rather than merely unsigned, and an invalid signature is refused outright. The app is now ad-hoc signed before the DMG is built, and the release workflow verifies the app inside the DMG, since that is the file people download. The build is still not notarized, so first launch is still blocked and has to be allowed once (see the Installing notes on the release) ([#350](https://github.com/Stalagmight/Stalagmight/issues/350))

#### Survey correctness

- **Inclination from a mNemo is no longer stored upside down** - the device reports inclination positive-up while depths are positive-down, and DMP import kept the device's sign, so every non-horizontal DMP shot carried an inclination that contradicted its own depth change. Import now converts once, so a descending shot reads as a descent everywhere. **Existing projects are converted on open**, worked out from each section's own geometry, touching only sections where the evidence is one-sided; a shot whose inclination genuinely disagrees with its depths stays flagged. Dismissed inclination warnings are re-raised, since the number they were dismissed against has changed meaning. **Inclination shown for DMP-sourced shots changes sign**: a shot descending at 17 degrees now reads `+16.9` where it read `-16.9`. Walls and Compass shots are unaffected ([#296](https://github.com/Stalagmight/Stalagmight/issues/296))
- **Exporting to Ariane no longer reverses a shot below a branch junction** - where a branch met the main line at a different depth, the shot hanging off that junction was written as starting where its parent ended while its own depth was left untouched, so a measured 0.5 m descent could come out as a 4.3 m ascent. Affects **Export to Ariane** and the copy uploaded to SpeleoDB; your `.stalx` was never wrong
- **Non-finite (NaN/infinity) geometry can no longer corrupt a survey** - rejected or neutralised at every entry point rather than propagating through merged sections
- **Deleting a shot on a loop no longer fabricates a false closure** - the closure is converted to a plain station merge instead of being kept as a bogus loop that shifts the geometry ([#8](https://github.com/Stalagmight/Stalagmight/issues/8), related [#41](https://github.com/Stalagmight/Stalagmight/issues/41))
- **Drifted station merges are detected and repairable** - merged stations could silently drift apart (one real project had a station 30 m from its counterpart) with no warning and no in-app fix
- **Two zero datums in one merged group no longer tear the merge apart silently** - a merge-connected group can hold at most one GPS anchor; a project that already has the problem now raises a warning on load
- **Merged sections move as a rigid group**, **merging across an unaligned loop closure is no longer wrongly blocked**, **merging projects keeps per-station comments**, and **shot identity survives undo/redo and project merges**
- **Importing into a brand-new project no longer loses the import** - a DMP imported into a project whose first save was deferred was never written to disk, so quitting lost the whole import ([#92](https://github.com/Stalagmight/Stalagmight/issues/92), [#110](https://github.com/Stalagmight/Stalagmight/issues/110))
- **A loaded plan's route points survive survey edits** - deleting or inserting stations could silently rebind a plan's origin, endpoint, way points and stage drops to whichever station slid into the same position. A point whose station is gone now flags itself and stalls the plan instead of quietly retargeting ([#310](https://github.com/Stalagmight/Stalagmight/issues/310))
- **Undoing a station move keeps every shot field**, and **corrupt persisted undo entries no longer empty the whole stack**

#### SpeleoDB

- **Your own landed work no longer reads as a conflict** - pushing while keeping the write lock, editing again, then pushing raised "resolve conflict" against a commit you had just made yourself. Related routes into the same false conflict are closed: an upload whose reply carried no commit id, a publish whose first upload did not confirm, and a stale status reply resurrecting the "not uploaded yet" warning
- **Write locks behave when resumed, not just when taken** - resuming a lock you already held looked identical to taking it fresh, which could explain another session's upload away as your own and hide a real conflict. "Continue editing" on a stranded lock handed that lock back whenever the server had moved on, leaving un-pushed work in a project anyone could claim. Releasing the lock from Project Settings released it on the server but left the app believing it could still edit
- **Revert is safer** - it now stops and asks you to save or discard unsaved edits rather than replacing them anyway; a failed upload retries just the upload instead of redoing the whole revert (which discarded anything edited since, and could collide with its own just-uploaded revert); the Retry is reachable inside the dialog; and adopting an Ariane project re-checks what the open project owes immediately before replacing anything
- **The API key is handled honestly** - turning the OS keyring off now deletes the key it already held instead of leaving it on the machine; "keep for this session only" says so when a copy could not be removed rather than promising it will be gone; the storage prompt names where the key actually went when a file write fails; signing in with Settings open no longer has an unrelated save post a stale email back over it; and "Try again" no longer forgets that you declined the keychain. **You will be asked to sign in once after this update** - Stalagmight now records whether it used the keychain, and no previous version wrote that down. Nothing is lost
- **Leaving a project with un-uploaded work always says so** - opening another project, or starting a new one, only checked for unsaved-to-disk changes; opening a project from SpeleoDB checked nothing at all. Also fixed: a 401 mid-session hiding the failed-upload notice behind the force-edit banner, push being offered while force-editing when the server can only refuse, and removing a collaborator not asking first

#### Interface

- **The grabbed point stays under the cursor while moving** - grabbing a segment, station or shot a few pixels off its attachment made the whole thing jump, worst when zoomed out ([#20](https://github.com/Stalagmight/Stalagmight/issues/20), [#79](https://github.com/Stalagmight/Stalagmight/issues/79))
- **Tool state no longer carries across a project switch** - the active tool and its pending targets survived loading another project, and because ids are small integers they resolve in the new project too, so the next click could act on the wrong station
- **Dropdowns no longer dismiss themselves as they open** ([#268](https://github.com/Stalagmight/Stalagmight/issues/268)), **data-table sub-header dropdowns stay clickable when they flip upward** ([#162](https://github.com/Stalagmight/Stalagmight/issues/162)), and **a toast can no longer swallow a click meant for a dialog**
- **Typing into a just-opened dialog no longer loses keystrokes** - the initial-focus heuristic ran a frame after opening and could yank focus from a control you had already clicked ([#289](https://github.com/Stalagmight/Stalagmight/issues/289))
- **Section Adjust accepts negative and partial offsets** - the dx/dy fields rejected a leading minus sign, making it impossible to nudge a section in the -X or -Y direction ([#161](https://github.com/Stalagmight/Stalagmight/issues/161))
- **Merging projects to a path with no extension no longer overwrites a file silently** - `.stalx` was appended after the "output already exists" check ([#169](https://github.com/Stalagmight/Stalagmight/issues/169))
- **Anchored sections dim correctly under the move tools** ([#301](https://github.com/Stalagmight/Stalagmight/issues/301)), and **shot and comment visibility are restored when a project loads**
- **macOS: a save blocked by revoked folder access explains itself** instead of reporting a misleading "corrupted database" failure ([#39](https://github.com/Stalagmight/Stalagmight/issues/39)), and **scrolling over the map no longer drags the window** ([#43](https://github.com/Stalagmight/Stalagmight/issues/43))

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
