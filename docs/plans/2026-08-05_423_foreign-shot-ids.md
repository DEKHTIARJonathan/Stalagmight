# Carrying Ariane's shot UUID through a round trip (#423)

Status: proposal, awaiting maintainer decision. No code changed. Anchors verified
against `origin/master` @ `7b390768`.

## Problem

Ariane 26 gives each `<SurveyData>` row a stable `<UUID>` (`<UU>` in `.tmlu`). We drop
it on import and mint our own, so a file that leaves Ariane and comes back has a
completely new identity for every shot.

## What the code actually does

| Fact | Evidence |
|---|---|
| `Shot::uuid` is a persistent v4 minted at creation, stable across saves, already persisted in `.stalx` | `models/shot.rs:208-217`, `:551-554`; `persistence/sqlite/schema.rs:437-441` (v5->v6 ALTER), `:1307` |
| It is the station-anchor identity | `models/station.rs:42` `AfterShot(String)`; resolved section-locally, first match wins, at `models/project.rs:1037-1056` |
| Two shots in one section sharing a UUID is a **Critical** violation, auto-repaired before every save by re-minting the second | `models/project/integrity.rs:88-104`; `models/project.rs:721-743`, called at `core/state/project_io.rs:117` |
| Export emits the STORED uuid; the mint is a fallback for a never-saved project | `export/tml.rs:562-567` `Some(u) if !u.is_empty() => u.to_string()` |
| Import has no `<UUID>` key, so the element is discarded and the shot gets a fresh v4 - documented as deliberate ("`<UUID>` is write-only as far as Stalagmight is concerned") | `parsers/tml.rs:168-196`; `models/section.rs:306-308` -> `:332-338` -> `models/shot.rs:551-554`; `docs/ariane-export.md:92-93` |

## Where the issue text does not match the tree

1. **Export does not mint fresh v4s per shot.** `shot_export_uuid`
   (`export/tml.rs:562-567`) returns the stored `Shot::uuid` verbatim, minting only
   when it is `None` or empty; re-export of a saved project is byte-stable by design
   (`docs/ariane-export.md:63-72`). The churn point is **import**, once.
2. **A SpeleoDB pull does not churn identities.** The `.tml` re-import on that path
   runs only from `adopt_build_into` (`core/state/speleodb_pull.rs:1873-1893`), reached
   from adoption of an Ariane-typed project (`:1206`); an ordinary pull replaces the
   cached `.stalx`, which carries the uuids. Real exposure: every `.tml` import, plus
   every **re**-adoption, which the code says is reachable (`:1182-1185`). Narrower
   than filed, still real.

## Constraints

- The carrier from parser to model has no uuid channel: `ImportSectionConfig.shots`
  (`models/section.rs:181`) and `SectionData.shots` both carry bare `ShotData`
  (`models/shot.rs:260-290`); `ImportSectionConfig` is ts-rs exported (`:167-168`).
  TML import is entirely backend (`commands/import.rs:280-357`), so no wizard plumbing
  is needed for it - unlike DMP, which builds `ShotData` in TS.
- **Import-time reverse is a trap.** `command_import.rs:648-652` reverses
  `Vec<ShotData>` in place; the in-app reverse re-pairs uuids explicitly
  (`models/project/reverse.rs:322`). A parallel uuid vector must be reversed in
  lockstep or every anchor lands one shot off.
- The SpeleoDB sidecar already defends itself: `<UUID>` only for an RFC4122 v4
  (`export/tml.rs:1842-1846`) not already used in the file, rewritten in canonical
  `8-4-4-4-12` spelling (`:1886-1892`). The **user** profile writes it verbatim
  (`:401-403`), which is what round-trip fidelity needs.
- Partial coverage (from the issue's measurement, not verified here - no fixtures in
  this tree): real files mix rows with and without `<UUID>`, so the carrier must be
  per-shot optional.

## What a carried foreign id does NOT survive

Two existing paths destroy it. Both already destroy self-minted uuids, so neither is a
regression - but a self-minted uuid is meaningless outside the app, whereas a foreign id
is the whole point of the feature, so the consequence is not equivalent.

- **Section split.** `split_shots_at` returns `Vec<ShotData>` via `Shot::to_shot_data`
  (`models/section.rs:448-464`), which drops uuid, and the B half is rebuilt from it.
  The code says so outright: "The shots moved into section B get fresh UUIDs"
  (`core/state/command_delete_split.rs:97-101`). **Every foreign id in the B half is
  permanently lost**, and a later export writes new ids for those shots.
- **Project merge.** `merge_projects` dedupes uuids **project-wide**
  (`project_merge.rs:121-134`), stricter than the per-section model invariant. Merging
  two projects that each imported the same Ariane file re-mints every repeated foreign
  id in the second, with a `warn!`.

There is **no** section-concatenation command (no `merge_sections` in `src-tauri/src`),
so "merging two sections turns a legal cross-section duplicate into an intra-section
Critical" has no code path today; if one is added, `ensure_unique_shot_uuids` handles
it by construction (re-mint the second, keep the first).

**Position:** accept both losses for the first iteration. The split loss deserves a
follow-up issue - silent, user-triggered, and it defeats the feature for the affected
shots - but preserving it means carrying uuids through `split_shots_at`, a signature
the undo path also uses. Say so in a code comment rather than leaving it to be found.

## Candidates

### 1. Carry the Ariane UUID in `Shot::uuid`

Import parses `<UUID>`/`<UU>` into a per-shot `Option<String>`, threads it to
`Section::new`, and the shot is built with `Shot::with_uuid` (`models/shot.rs:559`)
instead of `Shot::new`. `None` keeps today's mint.

Everything downstream already works: persistence, `AfterShot` anchors, the export, the
sidecar's v4 gate. Uniqueness is already enforced - a file repeating a UUID inside one
section is repaired by `ensure_unique_shot_uuids` (`project.rs:721-743`), keeping the
first, exactly the collision policy we want; cross-section repeats are legal by design
(`docs/ariane-export.md:74-90`). `merge_projects` is a working precedent for the
plumbing: it restores source uuids after `add_section` mints fresh ones, zipping a
`Vec<Option<String>>` over the new section's shots (`core/state/project_merge.rs:110-137`).

Cost: `Shot::uuid` stops being "always a v4 we minted". A non-v4 foreign value is
dropped from the SpeleoDB sidecar by `speleodb_uuid` (`export/tml.rs:1842-1846`), so
that shot loses its GeoJSON feature id in the server preview. The comment at
`export/tml.rs:1839-1841` already anticipates exactly this.

### 2. A separate `Shot::foreign_id`

Keeps `Shot::uuid` a pure v4. Cost: a second column and migration, a precedence rule at
`export/tml.rs:401-403`, a second uniqueness invariant with no integrity check behind
it, and a second thing every merge/split path must decide about - to express the same
meaning twice.

### 3. Export-side deterministic derivation (UUIDv5 from shot identity)

Refuted on its own terms: any derivation from shot identity changes when its inputs
change, precisely what a stable id must not do, and it cannot reproduce the id Ariane
already assigned. It only re-solves the never-saved case `shot_export_uuid` handles.

## Recommendation: candidate 1

1. Add `b"UUID" | b"UU" => Some("uuid")` to `normalize_key_bytes`
   (`parsers/tml.rs:168-196`) and a `uuid: Option<String>` on `RawShot` (`:137`) and
   `TmlShot` (`:87`). Treat an empty element as `None` - `shot_export_uuid` already
   treats empty as "no identity".
2. Add `#[serde(default)] shot_uuids: Vec<Option<String>>` to `ImportSectionConfig`
   (`models/section.rs:167-208`) and `SectionData`. Empty means "mint all", so every
   other importer and every existing undo snapshot is unaffected.
3. `Section::new` (`models/section.rs:286-308`) zips shots with `shot_uuids`, calling
   `with_uuid` where a value is present.
4. Reverse `shot_uuids` alongside `shots` at `command_import.rs:648-652`.
5. Call `ensure_unique_shot_uuids` after `execute_import_sections` so an intra-section
   repeat in the source file is repaired before it can be saved.
6. Do **not** validate or coerce the foreign value into a v4 - coercing recreates the
   churn this issue is about.
7. Update `docs/ariane-export.md:92-93` - the element stops being write-only.

`ShotData` deliberately does not gain the field: it is the undo payload shape, and undo
already restores identity through a separate channel (`core/state/undo_restore.rs:183`).
Two identity sources in one payload is how they drift apart.

**`shot_uuids` is import-only and must be pinned as such.** `to_section_data`
(`models/section.rs:319-328`) leaves it empty, which is correct - but an
empty-means-mint field on a struct undo also uses is the same dual-source drift
candidate 2 was rejected for. Guard it with a doc comment ("populated by importers only;
empty on every snapshot path") and a `debug_assert!` in `Section::new` that a non-empty
`shot_uuids` matches `shots` in length.

## Migration and compatibility

- **`.stalx`**: none. No DDL, no version bump, no backfill. Existing projects keep the
  identities they have; only newly imported shots differ.
- **IPC**: `ImportSectionConfig.ts` regenerates (`pnpm gen:ipc-types`). The field is
  optional with a serde default, so the DMP, GPX, Compass and Walls wizards compile and
  behave identically.
- **Undo**: unchanged - `SectionData.shot_uuids` defaults to empty for every payload
  written before the change, reproducing today's behaviour exactly.
- **Byte-identical re-export**: strictly improved; import -> export of an
  Ariane-authored file starts reproducing the source's `<UUID>` values.

## Test strategy

Injection-first - each test names what turns it red.

1. **Round trip, `.tml` and `.tmlu`**: synthetic file with a known `<UUID>` per shot ->
   import -> export -> the same strings come out. Red today at `normalize_key_bytes`;
   red again if the export ever re-mints.
2. **Partial coverage**: three shots, only the middle carrying `<UUID>`. The middle
   keeps its foreign value; the others get distinct non-empty fresh v4s. Red if the
   zip in `Section::new` misaligns by index.
3. **Intra-section duplicate**: two shots in one section sharing a `<UUID>`. After
   import, `check_structural_integrity` reports no `duplicate_shot_uuid`
   (`integrity.rs:88-104`), the FIRST keeps the foreign value, the second is re-minted.
   Red if step 5 of the recommendation is skipped.
4. **Reverse-on-import**: import with `reverse: true`; the uuid that was on the last
   shot is on the first. Red if only `shots` is reversed (`command_import.rs:648-652`).
5. **Non-canonical v4 spelling**: import a braced and a hyphenless v4. The user profile
   writes each verbatim; the sidecar emits canonical `8-4-4-4-12`. Pins the asymmetry
   between `export/tml.rs:401-403` and `:1886-1892`. A nil uuid covers the other branch:
   verbatim in the user profile, omitted from the sidecar.
6. **Adoption is idempotent**: adopt the same **fully covered** `.tml` twice
   (`speleodb_pull.rs:1873-1893`); both runs give the same uuid set. Full coverage is
   load-bearing - uncovered shots get fresh mints per adoption, so a mixed file must
   compare the foreign subset only. Red today; the user-visible bug in the issue.
7. **Split loses the B half, on purpose**: split a section of imported shots; the A half
   keeps its foreign ids, the B half does not. Pins the accepted loss at
   `command_delete_split.rs:97-101` so a later change is deliberate.

No fixture files. Every case is synthetic XML built in-test.
