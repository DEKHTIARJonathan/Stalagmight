# Carrying Ariane's shot UUID through a round trip (#423)

Status: proposal, awaiting maintainer decision. No code changed.

## Problem

Ariane 26 gives each `<SurveyData>` row a stable `<UUID>` (`<UU>` in `.tmlu`). We
drop it on import and mint our own, so a file that leaves Ariane and comes back
has a completely new identity for every shot.

## What the code actually does

| Fact | Evidence |
|---|---|
| `Shot::uuid` is a persistent v4 minted at creation, stable across saves | `src-tauri/src/models/shot.rs:208-217`, `:551-554` |
| It is the station-anchor identity | `models/station.rs:42` `AfterShot(String)`; resolved section-locally, first match wins, at `models/project.rs:1037-1056` |
| Two shots in one section sharing a UUID is a **Critical** integrity violation | `models/project/integrity.rs:88-104` |
| ...and is auto-repaired before every save by re-minting the second | `models/project.rs:721-743`, called at `core/state/project_io.rs:117` |
| It is persisted in `.stalx` already | `persistence/sqlite/schema.rs:437-441` (v5->v6 ALTER), `:1307` |
| Export emits the STORED uuid; the mint is a fallback for a never-saved project | `export/tml.rs:562-567` `Some(u) if !u.is_empty() => u.to_string()` |
| Import has no `<UUID>` key, so the element is discarded and the shot gets a fresh v4 | `parsers/tml.rs:161-189`; `models/section.rs:306-308` -> `:332-338` -> `models/shot.rs:551-554` |
| This is documented as deliberate | `docs/ariane-export.md:92-93` "`<UUID>` is write-only as far as Stalagmight is concerned" |

## Where the issue text does not match the tree

1. **Export does not mint fresh v4s per shot.** `shot_export_uuid`
   (`export/tml.rs:562-567`) returns the stored `Shot::uuid` verbatim and mints only
   when it is `None` or empty. Re-export of a saved project is byte-stable by
   design (`docs/ariane-export.md:63-72`). The churn point is **import**, once.
2. **A SpeleoDB pull does not churn identities.** The `.tml` re-import on that path
   runs only from `adopt_build_into` (`core/state/speleodb_pull.rs:1873-1893`),
   reached from adoption of an Ariane-typed project (`speleodb_pull.rs:1206`). An
   ordinary pull of a Stalagmight-managed project replaces the cached `.stalx`, which
   carries the uuids. So the real exposure is: every `.tml` import, plus every
   **re**-adoption - which the code says is reachable (`speleodb_pull.rs:1182-1185`).
   Narrower than filed, still real.
3. **Nothing needs to change for split/merge/edit.** Editing geometry never touches
   `Shot::uuid`, and a split hands the identity to one half exactly as it does today.
   A carried foreign id inherits that behaviour unchanged - no new semantics.

## Constraints

- `.stalx`: no schema work. The `shots.uuid` column exists (`schema.rs:437-441`),
  `SCHEMA_VERSION = 16` (`persistence/sqlite.rs:74`) does not move.
- The carrier from parser to model has no uuid channel:
  `ImportSectionConfig.shots: Vec<ShotData>` (`models/section.rs:181`) and
  `SectionData.shots` both carry bare `ShotData` (`models/shot.rs:260-290`, no uuid).
  `ImportSectionConfig` is ts-rs exported (`models/section.rs:167-168`).
- The TML import path is entirely backend (`commands/import.rs:280-357`), so no
  wizard plumbing is needed for it - unlike DMP, which builds `ShotData` in TS.
- **Import-time reverse is a trap.** `command_import.rs:648-652` reverses
  `Vec<ShotData>` in place; the in-app reverse has to re-pair uuids explicitly
  (`models/project/reverse.rs:322`). Any parallel uuid vector must be reversed in
  lockstep or every anchor lands one shot off.
- The SpeleoDB sidecar already defends itself against foreign values: it emits
  `<UUID>` only for an RFC4122 v4 (`export/tml.rs:1842-1846`) not already used in the
  file (`export/tml.rs:1886-1892`). The **user** profile writes the value verbatim
  (`export/tml.rs:401-403`), which is what round-trip fidelity needs.
- Byte-identical re-export is the goal `Shot::uuid` exists to serve
  (`docs/ariane-export.md:63-72`); carrying a foreign id strengthens it rather than
  threatening it, because the second export of an imported file then matches the first.
- Partial coverage (taken from the issue's measurement, not verified here - no
  fixtures in this tree): real files mix rows with and without `<UUID>`. Whatever
  carries it must be per-shot optional.

## Candidates

### 1. Carry the Ariane UUID in `Shot::uuid`

Import parses `<UUID>`/`<UU>` into a per-shot `Option<String>`, threads it to
`Section::new`, and the shot is built with `Shot::with_uuid` (`models/shot.rs:559`)
instead of `Shot::new`. `None` keeps today's mint.

Everything downstream already works: persistence, `AfterShot` anchors, the export,
the sidecar's v4 gate. Uniqueness is already enforced - a file that repeats a UUID
inside one section is re-minted by `ensure_unique_shot_uuids` (`project.rs:721-743`),
keeping the first, which is exactly the collision policy we want. Cross-section
repeats are legal by design (`docs/ariane-export.md:74-90`).

Cost: `Shot::uuid` stops being "always a v4 we minted". A non-v4 foreign value is
dropped from the SpeleoDB sidecar by `speleodb_uuid` (`export/tml.rs:1842-1846`), so
that shot loses its GeoJSON feature id in the server preview. The comment at
`export/tml.rs:1839-1841` already anticipates exactly this.

### 2. A separate `Shot::foreign_id`

Keeps `Shot::uuid` a pure v4. Cost: a second column and migration, a precedence rule
at `export/tml.rs:401-403`, a second uniqueness invariant with no integrity check
behind it, and a second thing every merge/split path must decide about - to express
the same meaning twice.

### 3. Export-side deterministic derivation (UUIDv5 from shot identity)

Refuted on its own terms. Any derivation from shot identity changes when its inputs
change (position, geometry, section), which is precisely what a stable id must not
do, and it cannot reproduce the id Ariane already assigned, so it does not fix the
round trip. It only re-solves the never-saved-project case `shot_export_uuid`
already handles.

## Recommendation: candidate 1

1. Add `b"UUID" | b"UU" => Some("uuid")` to `normalize_key_bytes`
   (`parsers/tml.rs:161-189`) and a `uuid: Option<String>` on `RawShot`
   (`parsers/tml.rs:129-152`) and `TmlShot` (`parsers/tml.rs:80-103`). Treat an empty
   element as `None` - `shot_export_uuid` already treats empty as "no identity".
2. Add `#[serde(default)] shot_uuids: Vec<Option<String>>` to `ImportSectionConfig`
   (`models/section.rs:167-208`) and `SectionData`. An empty vector means "mint all",
   so every other importer and every existing undo snapshot is unaffected.
3. `Section::new` (`models/section.rs:286-308`) zips shots with `shot_uuids`,
   calling `with_uuid` where a value is present.
4. Reverse `shot_uuids` alongside `shots` at `command_import.rs:648-652`.
5. Call `ensure_unique_shot_uuids` after `execute_import_sections` so an
   intra-section repeat in the source file is repaired before it can be saved.
6. Do **not** validate or coerce the foreign value into a v4. Coercing recreates the
   churn this issue is about.
7. Update `docs/ariane-export.md:92-93` - the element stops being write-only.

`ShotData` deliberately does not gain the field: it is the undo payload shape
(`models/section.rs:319-328`), and undo already restores identity through a separate
channel (`core/state/undo_restore.rs:183`). Two identity sources inside one payload
is how they drift apart.

## Migration and compatibility

- **`.stalx`**: none. No DDL, no version bump, no backfill. Existing projects keep
  the identities they have; only newly imported shots differ.
- **IPC**: `ImportSectionConfig.ts` regenerates (`pnpm gen:ipc-types`). The field is
  optional with a serde default, so the DMP, GPX, Compass and Walls wizards compile
  and behave identically.
- **Undo**: unchanged. `SectionData.shot_uuids` defaults to empty for every payload
  written before the change, reproducing today's behaviour exactly.
- **Byte-identical re-export**: strictly improved - import -> export of an
  Ariane-authored file starts reproducing the source's `<UUID>` values.
- **SpeleoDB**: no sidecar change; a non-v4 foreign id is omitted there exactly as
  any other non-v4 value already would be (`export/tml.rs:1842-1846`).

## Test strategy

Injection-first - each test names what turns it red.

1. **Round trip, `.tml` and `.tmlu`** (`parsers/tml.rs` tests): synthetic file with a
   known `<UUID>` per shot -> import -> export -> the same strings come out. Red
   today at `normalize_key_bytes`; red again if the export ever re-mints.
2. **Partial coverage**: three shots, only the middle one carrying `<UUID>`. The
   middle keeps its foreign value; the other two get distinct fresh v4s and neither
   is empty. Red if the zip in `Section::new` misaligns by index.
3. **Intra-section duplicate**: two shots in one section sharing a `<UUID>`. After
   import, `check_structural_integrity` reports no `duplicate_shot_uuid`
   (`integrity.rs:88-104`), the FIRST shot keeps the foreign value, the second is
   re-minted. Red if step 5 of the recommendation is skipped.
4. **Reverse-on-import**: import with `reverse: true` and assert the uuid that was on
   the last shot is on the first. Red if only `shots` is reversed - the trap at
   `command_import.rs:648-652`.
5. **Non-v4 foreign id**: `<UUID>0000...0000` (nil). The user-profile export writes it
   verbatim; the SpeleoDB sidecar omits it. Pins the deliberate asymmetry.
6. **Adoption is idempotent**: adopt the same `.tml` twice
   (`speleodb_pull.rs:1873-1893`) and assert both runs produce the same shot uuid set.
   Red today - this is the user-visible bug in the issue.

No fixture files. Every case is synthetic XML built in-test.
