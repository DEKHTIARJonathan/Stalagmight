# Carrying Ariane's shot UUID through a round trip (#423)

Status: **decided by Nico, 2026-08-05.** This doc is the implementation brief.
An earlier revision proposed a parallel `shot_uuids` side-channel on
`ImportSectionConfig` and accepted losing every foreign id in the B half of a
section split; both were rejected under review - see "Rejected shapes". The
decision is: carry the id on `ShotData`, and lose it nowhere.

## Problem

Ariane 26 gives each `<SurveyData>` row a stable `<UUID>` (`<UU>` in `.tmlu`).
We discard it on import and mint our own, so a file that leaves Ariane and comes
back has a completely new identity for every shot.

## What the code actually does

| Fact | Evidence |
|---|---|
| `Shot::uuid` is a persistent v4 minted at creation, stable across saves, already persisted | `models/shot.rs:208-217`, `:551-554`; `persistence/sqlite/schema.rs:437-441` (v5->v6 ALTER), `:1307` |
| It is the station-anchor identity | `models/station.rs:42` `AfterShot(String)`; resolved section-locally, first match wins, `models/project.rs:1037-1056` |
| Two shots in one section sharing a UUID is a **Critical** violation, auto-repaired before every save by re-minting the second | `models/project/integrity.rs:88-104`; `models/project.rs:721-743`, called at `core/state/project_io.rs:117` |
| Cross-section repeats are legal by design | `docs/ariane-export.md:74-90` |
| Export emits the STORED uuid; the mint is a fallback for a never-saved project | `export/tml.rs:562-567` |
| Import has no `<UUID>` key, so the element is discarded and the shot gets a fresh v4 | `parsers/tml.rs:168-196`; `docs/ariane-export.md:92-93` |
| `ShotData` - the shape the importers and the undo payloads both use - has no identity field, so `to_shot_data()` drops it | `models/shot.rs:259-290`, `:653-671` |

### Two claims in the issue text that the tree contradicts

1. **Export does not mint fresh v4s per shot.** `shot_export_uuid`
   (`export/tml.rs:562-567`) returns the stored uuid verbatim, minting only when it
   is `None` or empty. The churn point is **import**, once.
2. **An ordinary SpeleoDB pull does not churn identities.** The `.tml` re-import runs
   only from `adopt_build_into` (`core/state/speleodb_pull.rs:1873-1893`); a normal
   pull replaces the cached `.stalx`, which carries the uuids. Real exposure: every
   `.tml` import, plus every re-adoption (`:1182-1185`).

## The decision: `uuid: Option<String>` on `ShotData`

One optional field on the struct that already travels every path identity needs to
survive. `None` means "mint one", which is exactly today's behaviour for every
other importer and every payload written before this change.

1. **Parse it.** Add `b"UUID" | b"UU" => Some("uuid")` to `normalize_key_bytes`
   (`parsers/tml.rs:168-196`) and a `uuid: Option<String>` on `RawShot` (`:137`) and
   `TmlShot` (`:87`). An empty element is `None` - `shot_export_uuid` already treats
   empty as "no identity". Do **not** validate or coerce the value into a v4;
   coercing recreates the churn this issue is about.
2. **Carry it.** `ShotData` gains `#[serde(default)] #[ts(optional)] uuid:
   Option<String>`. The TML converter fills it; every other importer leaves it `None`.
3. **Use it.** Wherever a `Shot` is built from a `ShotData`, identity is
   `data.uuid.or(explicit_uuid)` - a single documented precedence. The explicit
   parameter of `Shot::with_uuid` (`models/shot.rs:559`) stays **only** because undo
   entries written before this change carry their uuid outside the payload
   (`core/state/undo_restore.rs:183` already mints when it is `None`).
4. **Stop dropping it.** `Shot::to_shot_data()` (`models/shot.rs:653-671`) copies the
   uuid. That one line is what makes a section split preserve identity, since the B
   half is rebuilt from `to_shot_data()` (`core/state/command_delete_split.rs:335-343`).
   Delete the "The shots moved into section B get fresh UUIDs" comment at `:97-101`
   and the positional-remap rationale that depends on it - re-read that block, since
   the split's cross-reference remap was written around uuids changing.
5. **Repair, do not reject.** Call `ensure_unique_shot_uuids` after
   `execute_import_sections` so a source file that repeats a UUID inside one section
   is repaired before it can be saved - keeping the FIRST, which is the collision
   policy we want.
6. **Relax the project-merge rule to match the model.** `merge_projects`
   (`core/state/project_merge.rs:121-134`) dedupes uuids **project-wide**, which is
   stricter than the invariant the app actually enforces (per-section) and stricter
   than the format allows (cross-section repeats are legal). As written it re-mints
   every repeated foreign id when two projects that imported the same Ariane file are
   merged. Narrow it to per-section. If the implementer finds a reason the wider rule
   is load-bearing - a consumer that assumes project-wide uniqueness - stop and report
   instead of relaxing it.
7. Update `docs/ariane-export.md:92-93`: the element stops being write-only.

### Why not a parallel `shot_uuids` vector (the earlier proposal)

- It has to stay index-aligned with `shots` through every transform. The trap is
  concrete: `command_import.rs:648-652` reverses shots in place, and a uuid vector
  reversed one step out of sync puts every station anchor on the wrong shot.
  Reversing `Vec<ShotData>` moves each id with its own shot, for free.
- It needs an "empty means mint all" convention and a `debug_assert` on matching
  lengths - an import-only field living on a struct undo also uses.
- It does nothing for the split, so the B half's foreign ids stay lost.

### Why not a separate `Shot::foreign_id` column

A second column and migration, a precedence rule at `export/tml.rs:401-403`, a second
uniqueness invariant with no integrity check behind it, and a second thing every
merge/split path must decide about - to express the same meaning twice. Also a schema
change, which this shape does not need.

### Why not export-side UUIDv5 derivation

Refuted on its own terms: any id derived from shot identity changes when its inputs
change, which is precisely what a stable id must not do, and it cannot reproduce the
id Ariane already assigned.

## The one real cost

`Shot::uuid` stops being "always a v4 we minted". Consequences, both bounded:

- `speleodb_uuid` (`export/tml.rs:1842-1846`) drops a non-v4 value from the SpeleoDB
  sidecar, so such a shot loses its GeoJSON feature id in the server preview. The
  comment at `:1839-1841` already anticipates this. Ariane writes v4s, so this bites
  only on hand-edited or third-party files. Unchanged by this design; documented, not
  fixed.
- Identity now travels in the same payload as geometry. The defence already exists and
  is unconditional: `ensure_unique_shot_uuids` runs before every save. Any future
  clone/duplicate-shot path must clear `ShotData::uuid`; say so in the field's doc
  comment, since the repair keeping the FIRST would otherwise silently re-mint the
  copy rather than the original.

## Migration and compatibility

- **`.stalx`: nothing.** No DDL, no `SCHEMA_VERSION` bump, no backfill. Existing
  projects keep the identities they have; only newly imported shots differ.
- **Undo:** `#[serde(default)]` means every payload written before this change
  deserialises with `uuid: None` and behaves exactly as today.
- **IPC:** `ShotData.ts` and `ImportSectionConfig.ts` regenerate; the field is optional,
  so the DMP wizard's TS literals compile unchanged.
- **Re-export:** strictly improved - import then export of an Ariane-authored file
  starts reproducing the source's `<UUID>` values.

## Test strategy

Injection-first; each test names what turns it red. No fixture files - synthetic XML
built in-test.

1. **Round trip, `.tml` and `.tmlu`**: known `<UUID>` per shot survives import ->
   export verbatim. Red today at `normalize_key_bytes`; red again if export re-mints.
2. **Partial coverage**: three shots, only the middle carrying `<UUID>`. The middle
   keeps its value; the others get distinct non-empty fresh v4s. Red if the carry
   misaligns by index.
3. **Intra-section duplicate**: two shots in one section sharing a `<UUID>`. After
   import, integrity reports no `duplicate_shot_uuid`, the FIRST keeps the foreign
   value, the second is re-minted. Red if step 5 is skipped.
4. **Reverse-on-import**: import with `reverse: true`; the uuid that was on the last
   shot is on the first. Red if identity stops travelling with its own `ShotData`.
5. **Split preserves both halves** - the case the earlier proposal gave up on. Split a
   section of imported shots: A and B both keep their foreign ids, and every station
   cross-reference still resolves to the same station it did before the split. Red on
   today's `to_shot_data`.
6. **Project merge preserves repeated ids**: merge two projects that imported the same
   Ariane file; the second project's foreign ids survive. Red on today's project-wide
   dedupe.
7. **Non-canonical spellings**: a braced and a hyphenless v4 are written verbatim by
   the user profile and canonicalised by the sidecar; a nil uuid is verbatim in the
   user profile and omitted from the sidecar. Pins the asymmetry between
   `export/tml.rs:401-403` and `:1886-1892`.
8. **Adoption is idempotent**: adopt the same fully-covered `.tml` twice
   (`speleodb_pull.rs:1873-1893`); both runs give the same uuid set. Full coverage is
   load-bearing - uncovered shots mint per adoption, so a mixed file must compare the
   foreign subset only. Red today; this is the user-visible bug in the issue.
9. **Undo of an import restores the same identities**, not fresh ones - the field
   travels in the payload now, so this must be pinned rather than assumed.
