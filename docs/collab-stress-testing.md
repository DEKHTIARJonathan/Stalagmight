# Collaboration stress-testing guide

Hands-on guide for extensively testing the Ariane `.tml` collaboration round-trip.
For the design, see [collaboration.md](collaboration.md).

Reconcile is triggered on **project open**: when collaboration is enabled and the
sibling `<stem>.tml` changed since the last export, Stalagmight opens the
**Collaboration Review** dialog. Shot matching tiers: UUID (Ariane 26+) → Ariane
integer id (guarded) → geometry fingerprint → positional.

## 0. Invariants (every test must preserve these)

A failure = any one of these breaks:

1. **Clean round-trip is a no-op.** Export → reopen with no external edit → no
   review dialog (empty change set).
2. **Stalagmight-only data survives** an Apply on surviving shots: loop closures,
   station merges, section/station offsets, station comments, dual azimuth
   (`azimuth_out`), `pitch_out`, marker index, temperature, quality, direction.
3. **No phantom sections.** A georeferenced (zero datum off station 0) or
   branched/merged survey must not report `(reversed)` / `(pre-zero-datum)` legs as
   new sections.
4. **Inserts land in the right place.** A mid-section insert connects to its real
   predecessor station, not the section end; downstream stations shift.
5. **Renames reconcile, not destroy.** A section renamed in Ariane → one `name`
   change, never delete + re-add.
6. **Apply is atomic + undoable.** One `Ctrl+Z` fully reverts a reconcile.
7. **No false sibling warnings.** A `.tml` that was never a companion (e.g. a TML
   import source) must not trigger the "won't be kept in sync" toast.

## 1. Setup

```bash
./scripts/dev.sh                                   # dev build (handles cleanup)
cp -r ~/src/cave/data/collab_test_data /tmp/collab_stress   # scratch copy
```

The test data has a real Naharon resurvey `.stalx`, **7 progressive `.tml`
versions** (a real Ariane edit history), and the source `.dmp`s.

Hand-edit the (zipped) sibling `.tml`:

```bash
cd /tmp/collab_stress && mkdir -p tmp && (cd tmp && unzip -o ../<stem>.tml)
# edit tmp/Data.xml, then:
(cd tmp && zip -r ../<stem>.tml Data.xml)
```

Inspect the stored baseline (lives in the `.stalx` SQLite):

```bash
sqlite3 /tmp/collab_stress/<stem>.stalx "SELECT state_json FROM collab_state;" | python3 -m json.tool
# watch: last_export_tml_sha256, shot_baseline length, section_name_map, synthetic_section_names
```

## 2. Core manual loop

1. Open a project → **Project details** → toggle **Ariane collaboration** ON (also
   test the toggle in the **recent-projects panel** in the global view).
2. **Save** (`Ctrl+S`) — seeds the baseline and writes `<stem>.tml`.
3. Edit the `.tml` — in real Ariane, by hand (§1), or by swapping in another version.
4. **Close and reopen** the project → the review dialog appears if the `.tml` changed.
5. Review counts/lists → **Apply Changes**.
6. **Verify** invariants (§0), then `Ctrl+Z` and confirm full revert.

> Test **both Ariane versions**: 26+ preserves `<UUID>` (tier 1); ≤25 drops it,
> forcing the geometry tier. Very different code paths.

## 3. Replay the real edit history (best soak)

1. Copy the `.stalx`, enable collab, save (baseline = version 1).
2. For each successive `.tml` (`_12-01`, `_12-04`, `_12-04_21h17`, `_12-07`,
   `_12-09`…): copy it over the project's sibling `.tml`, reopen, review, **Apply**.
3. After each step, confirm the counts match the real diff between consecutive
   versions, and that closures/merges you added survive.
4. Re-import the matching `.dmp` independently to cross-check geometry.

## 4. Scenario matrix (run each; vary Ariane version)

| # | Mutation in the `.tml` | Expect |
|---|---|---|
| 1 | No edit (re-save only) | **Empty** change set, no dialog |
| 2 | Change one shot's length/azimuth/depth | 1 Edit; others untouched |
| 3 | Append a shot at section end | 1 Added at end |
| 4 | Insert a shot **mid-section** | 1 Added at correct index; downstream shift |
| 5 | Insert **several** consecutive mid-section | All added, order preserved |
| 6 | Delete a mid-section shot | 1 Removed |
| 7 | Delete a shot anchoring a **loop closure** | Removed + `DeleteShotImpact` warning |
| 8 | Add a brand-new section | 1 New section |
| 9 | **Rename** a section | 1 `name` change, **0** removed/added |
| 10 | Change section color / surveyor / date | meta change(s) only |
| 11 | **Zero datum off station 0**, clean round-trip | **Empty** (no phantom section) |
| 12 | **Merged child section**, clean round-trip | **Empty** (no phantom section) |
| 13 | **Two sections sharing a name**, clean round-trip | **Empty** (split by identity) |
| 14 | Combine rename + mid-insert + delete + meta in one `.tml` | each reported once |

## 5. Adversarial / edge inputs

- **Ariane ID renumbering**: re-save so integer IDs shift wholesale → guard falls
  back to geometry; no mass remove+add.
- **Near-identical geometry** (geo-key collision): positional fallback + the
  "approximate" match-quality banner appears.
- **Reversed-leg edit**: editing a shot inside a `(reversed)`/`(pre-zero-datum)` leg
  is ignored by design (v1 limit) — confirm no crash/garble.
- **Branch split**: a section returning as `Foo (branch 1)`/`(branch 2)` → no false
  rename.
- **Unicode / very long names**, or names literally ending in `(reversed)` /
  `(branch 1)` → not misclassified.
- **Empty `.tml`** / all shots deleted → whole section removed; undo restores.
- **Corrupt/truncated `.tml`** → detection fails gracefully (no crash; project opens).
- **`.tml` deleted** between save and reopen → no error, no dialog.
- **False-warning check**: import `cave.tml`, save `cave.stalx` beside it with collab
  **OFF**, reopen → **no** "companion won't sync" toast.
- **Autosave churn**: with collab on, let autosave fire while editing → `.tml` stays
  consistent, sha/baseline track.
- **i18n**: switch locale → review dialog + sibling toast are translated, not English.

## 6. Bulk / fuzz / soak

Add a property-based round-trip fuzzer as a Rust test. The reconcile harness in
`src-tauri/src/core/reconcile.rs::tests` already exposes `baseline_project` /
`returned` / `diff`, and `apply_changeset` is reachable from
`core::state::collab::tests`.

```text
for 10_000 random seeds:
  1. generate a random project (1–8 sections, 0–50 shots each, random datums/merges/closures)
  2. export → seed baseline
  3. apply a random mutation to the parsed TmlFile
     (edit / insert / delete / rename / reorder / add-section / clear-uuids / shift-ids)
  4. cs = diff(base, mutated)
  5. apply_changeset(&mut base, &cs)
  6. ASSERT:
     - re-export(base) diffed again == empty   (convergence / idempotence)
     - Stalagmight-only fields unchanged on surviving shots
     - shot count == mutated shot count
     - no panics
```

Run under `cargo test`, and on nightly with `RUSTFLAGS=-Zsanitizer=address` for
memory safety. Log seeds; promote each minimized failure into a permanent unit test.

Complementary layers:

- **Playwright soak**: extend `e2e-playwright/collab-review-dialog.spec.ts` to drive
  the store (`__E2E_TEST__.projectStore`) through `detectCollabChanges()` /
  `applyCollabChanges()` over a batch of synthetic change sets.
- **CLI batch**: for each `.tml` in a corpus, copy it as the sibling, open headless
  (`xvfb-run pnpm test:ui`), assert the change set.

## 7. Per-run verification checklist

- [ ] Dialog counts match the actual `.tml` edit.
- [ ] Map geometry matches Ariane (no displaced/duplicated passages).
- [ ] A pre-set loop closure / station merge / station offset still exists.
- [ ] `Ctrl+Z` fully reverts; `Ctrl+Y` re-applies.
- [ ] Reopen with no new edit → **no dialog** (convergence).
- [ ] Logs show no errors (raise log level per [configuration.md](configuration.md)).
- [ ] `SELECT state_json FROM collab_state` shows baseline + sha refreshed after Apply+save.
