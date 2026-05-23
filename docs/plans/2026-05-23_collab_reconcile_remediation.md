# Remediation Plan — Collab reconcile correctness + nits

_Created 2026-05-23. Source: `/ultrareview` of `collab-mode` → `master` (6 findings)._

These bugs are in the collaboration feature on the `collab-mode` branch (reconcile
engine, exporter, review dialog, sibling-warning) — **not** in the recent
recent-projects toggle. Work happens on branch `collab-reconcile-fixes` off
`collab-mode`, one commit per workstream.

## Verified architecture (grounding)

- **Export** (`export/tml.rs`, `core/state/project_io.rs::write_collab_sibling`)
  builds `shot_baseline` (per shot: `section_id`, `shot_index`, `ariane_id`,
  `uuid`, `geo_key`, `section_name`) and `section_name_map` **from forward baseline
  shots only**. Synthetic legs (`<name> (reversed)`, `<name> (pre-zero-datum)`) emit
  shots under a suffixed name with **no baseline entry and no UUID**.
- **Reconcile** (`core/reconcile.rs::diff`) matches sections by **exact name**
  (`name_to_id`), then per matched section runs `align_section` (shot tiers:
  UUID → Ariane id → geo-key LCS → positional). Shot UUIDs are only consulted
  **inside an already name-matched section** — a section rejected by name never
  reaches UUID matching.
- **Apply** (`core/state/collab.rs::apply_changeset`): edits in place → removes
  (descending index) → adds via `project.add_shot` (append) → new sections →
  section meta (`color`/`surveyor`/`date` only; **no `name` arm**).

## Root causes

- **bug_001 + bug_003** share one root cause: section identity = exact name, which
  is not stable (rename), unique (duplicates), or exclusive (synthetic legs).
- **bug_002** is independent: apply ignores insertion position.
- 3 nits are independent and localized.

---

## WS1 — Stable section identity (fixes bug_003: rename + duplicate names)

Stop keying sections on name; derive identity from shot identity.

1. Build a global map: baseline shot `uuid` (else `ariane_id` when `ids_reliable`) →
   baseline `section_id`.
2. For each returned `TmlSection`, resolve the owning baseline section by **majority
   vote** of its shots' identities; no/tied matches → genuinely new section.
3. Run existing `align_section` against the resolved owner id.
4. **Reconcile name:** if owner matches but name differs → emit a `name`
   `CollabFieldChange` **and add the missing `"name"` arm** to `apply_changeset`.
5. Keep name as a **fallback hint** only when shot identity is unavailable
   (Ariane ≤25 / unreliable ids), preserving current behaviour for old files.

**Trade-off:** reliable rename detection requires Ariane 26+ UUIDs; older files stay
name-based. **Edge:** a returned section whose shots span two baseline sections →
majority wins, remainder become adds/removes (acceptable v1).

## WS2 — Synthetic export legs (fixes bug_001 — highest user impact)

Record-and-skip (robust regardless of UUIDs):

1. At export, collect synthetic leg names into a new persisted `CollabState` field
   (e.g. `synthetic_section_names: Vec<String>`).
2. In `diff()`, skip any returned section whose name is in that set — they are
   reversed duplicates of forward geometry, not edits.

**Note:** WS1 alone does **not** fix this (legs carry no baseline entry/UUID, so they
still look new) — the explicit skip-list is required. **Caveat:** edits a
collaborator makes *inside* a reversed leg in Ariane are dropped (matches v1
"forward shot is source of truth"); document it.

## WS3 — Honor insert position (fixes bug_002) — DOING FIRST

Smallest, isolated, lowest risk.

1. `align_section`: stop emitting `position = proj_section.shots.len()`. For each
   added returned shot, compute the **proj shot id of the nearest preceding matched
   shot in returned order** (across all tiers) → `after_shot_id: Option<ShotId>`
   (None = front of section). Keep `position` = the returned index (used for apply
   ordering / chaining detection).
2. `apply_changeset`: insert adds (in returned order) via
   `insert_shot_after`/front-insert, which run `shift_station_refs` + offset
   compensation. Chain consecutive adds that share an anchor so multiple inserts in
   one gap keep order. `after_shot_id == None` + matched-shot-only section degrades
   to append.
3. The anchor is a **stable shot id** of a matched shot (matched ⇒ never removed in
   the same changeset), so it survives the edit/remove phases without index drift.

## WS4 — Nits

- **bug_009:** add i18n keys + `useTranslation`/`t()` in `CollabReviewDialog.tsx` and
  the sibling/"Reconcile Failed" strings in `projectStore.ts`.
- **bug_004:** dead `sibling_tml_relative` override — recommend removing the param
  (matches the fixed `<stem>.tml` v1 model); keep the `CollabState` field.
- **bug_013:** gate `collab_sibling_when_disabled` on **provenance** (warn only when
  `CollabState` has a recorded baseline/sha for this sibling), not mere existence.

## Testing

The current suite only covers the trivial single-section round-trip. Add Rust
reconcile tests, each asserting the changeset and the post-apply project:

- clean round-trip, zero datum at a mid-station → **empty** (bug_001)
- clean round-trip, child section merged mid/end → **empty** (bug_001 reversed)
- clean round-trip, two sections same name → **empty** (bug_003 dup)
- section renamed → exactly one `name` meta change, zero shot remove/add; apply
  updates the name (bug_003)
- mid-section insert → one add at the correct index; order + station shifts correct
  after apply (bug_002)
- Ariane ≤25 (no UUID) path → no regression

## Sequencing

1. **WS3** (small, isolated) ← starting here
2. **WS2** (highest impact: clean-round-trip duplication)
3. **WS1** (largest/riskiest — matching core; land last with the most tests)
4. **WS4** nits (anytime)

## Open decisions

1. **bug_004:** remove the override param, or honor a custom sibling name?
2. **WS1:** OK that reliable rename detection needs Ariane 26+ UUIDs?
3. **WS2:** OK that edits inside a reversed leg are ignored in v1, or invest in
   fold-back-into-parent?
