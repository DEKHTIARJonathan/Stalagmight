# Collaboration Mode

## Overview

Collaboration mode lets people who use **Ariane** edit a Stalagmight survey. When
enabled on a project, Stalagmight keeps a sibling Ariane `.tml` file next to the
canonical `.stalx`. Stalagmight saves both files; an Ariane user edits the `.tml`;
on the next open, Stalagmight detects the external edit and offers to reconcile
those changes back into the `.stalx`.

The `.stalx` stays the source of truth — it stores data Ariane cannot represent
(loop closures, station merges, section/station offsets, comments, dual azimuth,
markers, temperature). Reconciliation never destroys that data on surviving shots.

## Operating model (v1)

- **Ariane only.** Compass is out of scope (its inclination model doesn't map to
  Stalagmight's depth model).
- **One shared file pair**, not one-per-collaborator: a `.stalx` and a sibling
  `<stem>.tml` (zipped) with the same basename in the same directory.
- **External edit lock** (a human agreement): only one person edits at a time, so
  there are no concurrent/conflicting edits. Ariane only writes the `.tml`;
  Stalagmight writes both. The `.tml` is therefore never stale; the `.stalx` can be
  stale if Ariane edited the `.tml` after Stalagmight last saved.
- **Reconcile is one-directional** (`.tml` → `.stalx`), triggered on open, with a
  preview the user confirms. There is no conflict-resolution UI.
- **Per-project toggle**, off by default, in the **Project details** panel (it is
  per-project state stored in the `.stalx`, not a global app setting). Opening a
  project that has a companion `.tml` while collaboration is off shows a warning
  toast that the `.tml` won't be kept in sync.

## Data flow

### Save (collab on) — `core/state/project_io.rs`
After the atomic `.stalx` write succeeds, `write_collab_sibling` exports the sibling
`.tml` (`export/tml.rs::export_tml_with_baseline`), then stores in the project's
`CollabState`:
- `last_export_tml_sha256` — sha256 of the inner `Data.xml` we just wrote,
- `shot_baseline` — a per-shot identity map,
- `section_name_map` — export-time section names (Ariane's names are lossy).

A failed `.tml` write degrades to success-with-warning; it never fails the `.stalx`
save. Persisted via the single-row `collab_state` table (`.stalx` schema v5).

### Open — `src/store/projectStore.ts`
After a successful load, the frontend calls `detect_collab_changes`. The backend
(`core/state/collab.rs::compute_collab`) returns `None` unless collab is enabled,
the sibling exists, and its inner-XML sha256 differs from `last_export_tml_sha256`.
If a non-empty `CollabChangeSet` comes back, the **Collaboration Review** dialog
opens.

### Reconcile — `core/reconcile.rs` (pure `diff`)
`diff(project, tml)` produces a `CollabChangeSet { shots_added, shots_edited,
shots_removed, sections_added, section_meta_changed, warnings, match_quality }`.

Applying it (`Command::ApplyCollabChanges`, `core/state/collab.rs`) re-runs `diff`
fresh, mutates the project in place as a **single undoable** snapshot-pair operation
(edits → removes (descending index) → appends → new sections → section metadata),
then sets `last_export_tml_sha256` to the consumed file's hash so open-detect won't
re-fire before the next save.

## Shot identity (matching)

Stalagmight shot IDs are regenerated on load, so the stable baseline key is
`(section_id, shot_index)`. Matching a returned `.tml` shot to a baseline shot uses
tiers, in order:

1. **UUID** — native `<UUID>`/`<UU>`, emitted on export. Ariane 26+ round-trips it;
   Ariane ≤25 drops it, so this tier only "switches on" once collaborators upgrade.
2. **Ariane integer ID** — *guarded*. Real Ariane data renumbers IDs across saves
   (verified in test data: v1→v2 went `0..74` → `29..160`). If the baseline∩returned
   ID overlap is below ~50%, this tier is skipped as untrustworthy.
3. **Geometry fingerprint** — the primary matcher in practice. A quantized key
   (`geo_key`: azimuth 0.1°, length 5 mm, depth-delta 1 cm) aligned with an
   LCS-style walk so a mid-section insert/delete doesn't cascade.
4. **Positional** fallback → `match_quality = Positional` (the review dialog warns).

Synthesized shots (START, CLOSURE, pre-zero-datum reversed legs, branch splits) have
no 1:1 Stalagmight identity and are excluded from the baseline.

## What is and isn't reconciled

**Overwritten from the `.tml`** on edited shots: azimuth (→ azimuth_in), length,
depth_in/out, inclination (→ pitch_in), L/R/U/D, comment, is_reference; and section
name/color/surveyor/date.

**Preserved (never overwritten):** azimuth_out, pitch_out, marker_index, temperature,
and project-level loop closures, station merges, section/station offsets, station
comments, quality, direction. When a removed shot underpins a closure/merge, the
review dialog surfaces a `DeleteShotImpact` warning before you apply.

## Key files

- `src-tauri/src/models/collab.rs` — `CollabState`, `ShotBaselineEntry`, `geo_key`
- `src-tauri/src/export/tml.rs` — UUID emission + `export_tml_with_baseline`
- `src-tauri/src/core/reconcile.rs` — pure `diff` engine + change-set types
- `src-tauri/src/core/state/collab.rs` — enable/detect/apply on `AppState`
- `src-tauri/src/commands/collab.rs` — IPC commands
- `src/components/Dialogs/CollabReviewDialog.tsx` — the review/apply preview
- `src/components/SingleSystemView/DetailPanel.tsx` — the per-project toggle
  (`CollaborationSection`, in the Details tab) and the open-time off warning

## Testing

- Rust reconcile/persistence/apply unit tests (search `collab` /
  `core::reconcile`), including the v1→v2 ID-renumber stress case and the
  Stalagmight-only-data preservation + undo test.
- Playwright: `e2e-playwright/collab-review-dialog.spec.ts` (review dialog render,
  Apply/Cancel wiring, the Collaboration settings tab) under mocked IPC.
- Manual end-to-end test data lives at `~/src/cave/data/collab_test_data`
  (7 `.tml` versions of one project + source `.dmp` files in `./dmps`).
