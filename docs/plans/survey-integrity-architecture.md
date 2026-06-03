# Survey Data Representation — Integrity Review & Roadmap

> Architecture review produced 2026-06-03 from a multi-agent audit (4 readers mapped the model,
> 5 lenses diagnosed 39 weaknesses, 4 design proposals were each scored by 3 adversarial judges).
> Goal: make the recurring survey-integrity bugs **impossible by construction** or **caught at
> source**, rather than patched case-by-case. Group A of the roadmap was implemented on branch
> `fix/geometry-robustness`; B and C remain.

## Why case-by-case patching keeps losing

Every integrity fix so far adds a **new post-hoc check that fires after the corrupt state already
exists** in the model (or on disk). It never removes the ability to *represent* the corrupt state.
Four representational choices generate essentially all of the recurring bugs.

### Root 1 — Station identity is positional, not stable
`StationRef = { section_id, station_index: u32 }` (`src-tauri/src/models/station.rs:7-11`) names a
station by its `0..=shots.len()` position. Stations carry **no** stable id, even though every `Shot`
already has a stable v4 `uuid` (`src-tauri/src/models/shot.rs:55-65`).

- Every shot insert/delete must hand-rewrite five collections via `shift_station_refs`
  (`project.rs:926-983`), re-enumerated independently in `cleanup_section_references`
  (`project.rs:772-797`) and the `remove_shot_with_rewire` retain block (`project.rs:1518-1524`) —
  **three hand-maintained lists that must stay in sync**.
- A missed or off-by-one shift leaves a ref **in-range but pointing at the wrong physical station**.
  `check_structural_integrity`'s `station_ref_violation` (`project.rs:6186-6201`) only flags
  *missing-section / index > len* — so in-range displacement is **invisible to every gate**,
  including the command-guard rollback (which fires only on `has_critical`).

Source of bug classes: missed/wrong shift, in-range displacement, insert-before/after off-by-one,
first-shot index-0 aliasing, collab three-phase index reuse.

### Root 2 — `section_offsets` is derived but persisted and trusted stale
`section_offsets` is documented as derived yet is a serialized field (`project.rs:163-165`) **and** a
real SQLite table with full create/migrate/drop machinery (`sqlite.rs:753-767`, written `1337`, read
`1879`). The load-time re-solve `redrive_offsets_after_load → realign_merges` **early-returns when
merge drift < 5 cm** (`project.rs:6588-6591`), so a sub-tolerance stale/wrong cached offset is
honored verbatim across reload and re-persisted on next save. `station_offsets` (`sqlite.rs:760,
2269`) is a second derived-but-persisted store keyed by the positional `StationRef` — same disease.

### Root 3 — `is_aligned` is a one-way latch consumed as a rigid constraint
`LoopClosure.is_aligned` is set true (`project.rs:340, 2542`) and **never reset**
(`project.rs:6431-6432`). The cascade honors every `is_aligned` closure as a rigid coincidence edge
(`project.rs:1786-1790`). After a shot edit reopens a loop, the stale flag pulls a whole component to
a no-longer-true position; `check_closure_alignment` (`project.rs:6437-6467`) only *reports* it.
Separately, the merge cycle-rejection walk `get_connected_section_ids` (`project.rs:1696-1705`)
follows **all** closures including inert ones, while the cascade follows only aligned ones — the
construction-time invariant asserts a *different graph* than the solver actually uses.

### Root 4 — Multiple bespoke mutation paths bypass the one guard
`execute()`'s epilogue (corruption rollback `commands.rs:338-360`, orphan conversion `367-369`,
reconcile `374-376`) is **re-implemented or skipped** by `apply_collab_changes` (`collab.rs:151-201`),
`execute_import_sections` (`commands.rs:1000-1119`), and `execute_delete_last_shot_and_section`
(`commands.rs:2457-2635`). `ApplyCollabChanges` is in **neither** `command_can_dangle_refs` nor
`command_can_orphan_closures` (`commands.rs:95-120`), and collab writes raw shot f64 with no
`all_finite` (`collab.rs:307-317`). `capture_after_snapshot_or_rollback` rolls back only on serialize
failure, never on integrity.

## Full weakness catalog (39)

Risk = residual risk after current mitigations.

### Reference identity (Root 1)
1. (high) Positional StationRef has no stable identity; every insert/delete must hand-rewrite refs.
2. (high) Integrity check flags only out-of-range/missing-section refs, not in-range *displaced* refs.
3. (med) `shift_station_refs` enumerates a fixed list; a new ref-bearing collection is silently missed.
4. (med) Collab changeset applies baseline-positional indices in three phases over a mutating index space.
5. (med) `ShotId` is regenerated on load, but undo records / changeset anchors reference it.
6. (med) Import & IPC construct StationRefs from raw indices with no per-ref existence/range guard.
7. (low) First-shot deletion collapses station identities 0 and 1 onto index 0 (positional aliasing).
8. (med) Merge acyclicity / "already connected" uses connectivity that **includes inert closures**.
9. (med) Persisted `section_offsets` cache is corrupted by stale/mis-shifted refs without detection.

### Derived-state coherence (Root 2/3)
10. (med) `section_offsets` persisted yet recomputed on load; re-solve overwrites only when drift > 5 cm.
11. (med) `realign_merges` gated on 5 cm AND merges only — sub-tolerance & aligned-closure drift never re-solved.
12. (med) `is_aligned` one-way latch stays a RIGID constraint after edits, actively mis-positioning sections.
13. (high) `ApplyCollabChanges` mutates topology but bypasses dangling-ref rollback & orphan conversion.
14. (med) Transient caches serde-skipped; rebuilds scattered — `restore_section` never rebuilds merge adjacency.
15. (low) Undo offset capture depends on the cache that can be stale → wrong section set captured/restored.
16. (low) Save persists drifted geometry with only a warning.

### Invariant-enforcement timing (Root 4)
17. (high) Collab `apply_changeset` writes raw shot geometry — no finite check, no orphan convert, no rollback.
18. (high) TML import overlap-interpolation overwrites shot geometry by direct assignment, no `all_finite`.
19. (high) `execute_import_sections` never runs the rollback guard or orphan conversion.
20. (med) Load constructs ZeroDatum/Shot from raw f64 with no validating constructor; GPS never validated.
21. (high) Positional StationRef → dangling/mis-pointed refs prevented only by post-execute rollback.
22. (med) Colocation & aligned-closure geometry enforced after mutation (cascade→detect/heal/flag), not at construction.
23. (med) `execute_delete_last_shot_and_section` omits reconcile + orphan conversion.
24. (med) Command-guard rollback gated on `has_critical` only — Warning-severity dangling refs never blocked.

### Boundary validation
25. (med) File-load builds `GpsCoordinates` via struct literal, bypassing validation.
26. (med) `load_project` reads raw shot f64 with no finiteness gate; critical violations logged-not-blocked.
27. (high) Collab apply writes foreign TML shot data directly with no validation / rollback.
28. (med) TML parser turns literal `"NaN"`/`"inf"` into non-finite f64 with no filtering.
29. (med) Import overlap-interpolation writes into shots with no `all_finite` / rollback.
30. (med) Loaders accept out-of-range / dangling positional StationRefs into the live model.
31. (low) `merge_projects` loads per-source files raw and concatenates; geometry/refs never validated.
32. (low) Permissive serde of persisted `Command`/`UndoData`/`CollabState` (schema drift).

### Undo/redo coherence
33. (med) **MoveStation undo silently drops `pitch_in`/`pitch_out`** (lossy lightweight record).
34. (high) `apply_collab_changes` skips orphan conversion, reconcile, and rollback guard.
35. (med) `execute_delete_last_shot_and_section` captures its after-snapshot without reconciling new merges.
36. (low) `ZeroDatumInfo` undo/redo asymmetry: undo restores exact offsets, redo recomputes.
37. (low) `UnmergeInfo` fallback pushes a raw merge and leaves merge adjacency stale (legacy record).
38. (low) Redo of `CreatedShotSnapshot` append branch skips ref-shift/cascade, diverging from forward insert.
39. (low) Snapshot-restore cache rebuild duplicated per call-site, so a new restore path can forget it.

## Prioritized roadmap

### Group A — quick wins / catch-at-source guards (no schema change) — IMPLEMENTED (branch `fix/geometry-robustness`)
| # | Change | Closes | Status |
|---|--------|--------|--------|
| A1 | Shared `AppState::finalize_structural_edit()` (orphan-convert + reconcile + critical-corruption report); route `apply_collab_changes` and `execute_import_sections` through it with rollback-on-critical; add `ShotData::all_finite()` skip-and-warn to `apply_changeset` edit + add phases. | 13, 17, 19, 27, 34 | ✅ done |
| A2 | `AppState::restore_snapshot_into(slot, snapshot)` — the single chokepoint that always rebuilds `section_index_cache` + `merge_adjacency_cache`; `rollback_project`, both `capture_after_snapshot_or_rollback` error paths, the 3 `execute_delete_last_shot_and_section` inline rollbacks, and the `ProjectSnapshot`/`ProjectSnapshotPair` undo+redo arms all route through it. | 14, 39 | ✅ done |
| A3 | Merge cycle-check switched from `get_connected_section_ids` to the existing `get_rigid_connected_section_ids` (merges + **aligned** closures only) — the same graph the cascade solves. `create_loop_closure`'s pre-connection check left as-is. | 8 | ✅ done |
| A4 | `MoveStation` undo → full `ProjectSnapshotPair` (legacy `StationMoveInfo` apply arm kept for back-compat). | 33 (pitch drop) + lrud/temperature/cascade-side-effect drop | ✅ done |

**Scope note — delete-last (catalog #23/#35) intentionally NOT changed.** Investigation showed
`preserve_connections_for_section_deletion` (`project.rs:552`) only creates replacement merges
*within an already-colocated merge group* (`record_station_merge` between members that are by
definition identical), so the claimed "after-snapshot carries a drifted merge" is **not
reproducible** — a regression test built to the #35 description passed even with the delete-last
finalize disabled. Rather than restructure that path's snapshot capture for a no-op reconcile, it
was left as-is. (The merge/unmerge/move-station undo records *were* genuinely lossy and are fixed.)
An example of an audit single-lens finding down-weighted by implementation evidence; re-open #35
only if a concrete drifting-merge repro appears.

Tests added: `apply_changeset_skips_non_finite_edit_and_add`,
`restore_snapshot_into_rebuilds_transient_caches`,
`merge_allowed_across_inert_closure_but_rejected_across_aligned`,
`undo_move_station_restores_pitch_and_adjacent_shots`.

### Group B — medium structural refactors
| # | Change | Closes | Effort | Risk |
|---|--------|--------|--------|------|
| B1 | Validating newtypes (`Finite(f64)`, `GpsCoordinates::try_from`) at the deserialize boundary, **paired with per-column validating construction in the SQLite loader** (it builds structs by raw column literal `sqlite.rs:1774,1869`, not serde) + an `is_finite` filter in `tml.rs:480-492`. | 18, 20, 25, 26, 28, 29, 32 | M | med |
| B2 | Single `visit_station_refs_mut(&mut FnMut)` traversal consumed by shift, cleanup, and integrity. | 3 (missed ref-bearing collection); prerequisite for C1 | S | low |
| B3 | Persisted `aligned_intent: bool` (legacy `is_aligned` maps to it); cascade treats a closure as rigid only when `aligned_intent && endpoints within tolerance`. **Keep** the misclosure banner — do not auto-zero a measured loop. | 12 (stale aligned closure) | M | med |

### Group C — larger re-architectures (durable wins, sequenced last)
| # | Change | Closes | Effort | Risk |
|---|--------|--------|--------|------|
| C1 | **Stable station identity.** `StationRef { section_id, anchor: StationAnchor }`, `enum StationAnchor { SectionStart, AfterShot(ShotUuid) }`. Resolve to a positional index only at the geometry/render boundary. **Deletes `shift_station_refs` and its three call sites.** | 1, 2, 4, 6, 7, 21, 30, plus insert/delete off-by-one class | XL | high |
| C2 | **Stop trusting persisted offsets.** Recompute `section_offsets` unconditionally on load/commit; **persist only per-floating-component anchors** (free `move_section`/`move_segment` placement via `adjust_section_offset` `project.rs:818` is *not* derivable). Treat any cache/recompute mismatch as "stale," never honor it. | 9, 10, 11, 15, 16 | L | med |

### Adoption order & dependencies
```
A1 → A2 → A4 → A3        (Group A: schema-safe, guards the base; ship first)
        ↓
B1 (independent)  B2 (independent)  B3 (pairs with A3)
        ↓
C2  (depends on a trustworthy solver: A2 + B3)
        ↓
C1  (LAST — depends on B2 centralizing the traversal; lands on a base where every
     mutation already flows through A1's finalize and offsets are derived)
```
Back-loading C1/C2 is deliberate: they eliminate the most bug classes but are the riskiest. Landing
A1 first means a C1/C2 regression is **caught at the commit boundary instead of silently persisted**
— exactly the failure mode this effort is ending. Each step independently removes a bug class, so the
sequence degrades gracefully if stopped partway.

## Highest-leverage change: A1

Not C1 (which closes more classes but is XL/high-risk). **A1 is the keystone**: low-risk, no schema
change, closes the highest-residual-risk holes (collab/import/delete-last-shot bypasses) immediately,
and is the guard that catches regressions from every later change. First step:

1. Extract `execute()`'s epilogue (`commands.rs:338-376`) into one
   `finalize_structural_command(&self) -> Vec<IntegrityViolation>` running orphan conversion →
   reconcile → `check_structural_integrity`; caller rolls back to `before` on any Critical.
2. In `apply_collab_changes`: add `all_finite` skip-and-warn at the `collab.rs:307-317` write site,
   then call `finalize_structural_command()` and roll back to the **already-captured** before
   snapshot on Critical (do not double-snapshot by adding it to `command_can_dangle_refs`).
3. Repeat in `execute_import_sections` and `execute_delete_last_shot_and_section` before each
   captures its after-snapshot.
4. One regression test per path (collab NaN edit rejected; collab removal → sole-bridge converted;
   import-overlap NaN rejected; delete-last-shot bridging two sections reconciled before snapshot).

## Adversarial corrections (overclaims cut)

- **"Drop the persisted `section_offsets` column entirely"** → DOWNGRADED. `move_section`/`move_segment`
  write free placement into `section_offsets` via `adjust_section_offset` (`project.rs:818`); for a
  datum-less, merge-less component that value is non-derivable. C2 must persist a per-floating-component
  anchor, not blanket-drop.
- **"`#[serde(try_from)]` makes non-finite unrepresentable on load"** → DOWNGRADED. The `.stalx` loader
  uses raw column struct literals (`sqlite.rs:1774, 1869`), not serde — B1 must add per-column
  validation; the serde shim alone guards only IPC/collab/TML.
- **"Migration mints uuids lazily on load"** → CORRECTED. `ensure_shot_uuids` runs only in
  `save_project` (`project_io.rs:302`), never on load — C1's anchor migration needs a load-time
  mint-then-anchor pass for pre-v6 files.
- **"C1 is a one-resolve-boundary edit"** → CORRECTED to a cross-stack XL: the binary IPC envelope
  packs stations as fixed-width 2×u32 (`loadProjectBinary.ts:64,327-328`) and there are ~228 frontend
  `station_index` references across 24 files. C1 must keep surfacing a derived positional index over
  IPC for display.
- **"Auto-correct aligned-closure drift in the solver"** → CUT. Forcing a measured loop misclosure to
  zero is over-constrained; the detect-and-report design (`project.rs:6437-6467`) is intentional. B3
  only *deactivates* a stale closure as a rigid edge.
- **"Filter `is_aligned` by editing `get_connected_section_ids`"** → SCOPED. That function has 6+
  callers; A3 must use a *separate* aligned-only walk.

### Perf caveats (noted, not blocking)
- C2's unconditional re-solve adds a full cascade (`section_local_coords`, O(all shots)) per command —
  keep the `cascade_deferred` opt-out for bulk import.
- C1's `resolve()` needs a per-section uuid→index map (built in the existing `section_local_coords`
  precompute) to stay O(1), and converts the 8-byte `Copy` `StationRef` into a non-`Copy` key — intern
  to a `u32 StationId` to avoid hashing cost in the cascade hot loop.
