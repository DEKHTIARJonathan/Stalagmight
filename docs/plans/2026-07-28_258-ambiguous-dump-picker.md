# SpeleoDB ambiguous-dump picker (#258) - Implementation Plan

## Summary & status

When a SpeleoDB project dump contains more than one `.stalx`, opening it dead-ends:
`dump::classify` returns `AmbiguousStalx`, which becomes `SpeleoDbError::AmbiguousDump`
and maps to `SpeleoDbAction::Fatal`. The user sees raw, untranslated Rust text
(`"SpeleoDB contained multiple ambiguous .stalx files: a.stalx, b.stalx"`) and has no
way forward from inside the app. This plan replaces that dead end with a chooser.

Three facts established by code review shape everything below.

1. **Stalagmight can never cause this.** The push hard-codes the canonical multipart
   wire name `project.stalx` (`src-tauri/src/speleodb/client.rs:752`, pinned by
   `client.rs:1636` and `:2077`) precisely because SpeleoDB's `upload/auto/` is
   additive. A multi-`.stalx` dump is therefore always exogenous: a web-UI upload, or
   a non-Stalagmight client. The feature is a recovery ramp for someone else's mess,
   which is the argument both for building it cheaply and for measuring it.
2. **The picker cannot remove the ambiguity.** Because the push always writes
   `project.stalx`, a user who picks `backup/old.stalx` and later pushes silently
   overwrites the canonical file, and the extra file stays in the tree forever. Every
   later open, update and start-editing re-hits the same condition. The design must
   make the safe pick the default and say so in the copy.
3. **It is not an open-flow feature.** Four backend sites classify - pull
   (`core/state/speleodb.rs:1421`), adopt (`:1568`), restore/view (`:2479`) and
   fast-forward (`:3050`) - feeding fourteen frontend entry points. The fast-forward
   arm runs *after* the lock is acquired and its error path releases it (`:2059-2062`).

The issue body quotes fallback copy ("Remove the extra file(s) on SpeleoDB, leaving a
single one") that **does not exist in master** and never landed. This plan adds it.

Prerequisite: `core/state/speleodb.rs` is at 1952 production LOC against a 1500 warn
line, so a single added production line fails CI. It is split first, as a separate
mechanical PR - the architecture item already tracked in #275.

---

## Decision ledger (locked)

Ballot answers from the issue, plus the decisions the ballot did not ask about.
Every `D-*` below is the authority for resolving a conflict during implementation.

| ID | Decision | Resolution |
|----|----------|-----------|
| **q1** | Candidate set | **Stalx-only.** The `ariane.tml` is a derived render sidecar we generate on every push (#219/#221); offering it would be offering a lossy derivative over the canonical file. Confirmed correct, not a compromise. |
| **q2** | How the choice reaches the backend | **Optional `entryPath` arg on the existing commands** - not a new command. Threaded through `speleodb_open_project`, `speleodb_open_project_discarding_local` and `speleodb_restore_revision`. Justified as "one verb, one disambiguating arg", **not** as EVENT_NAMES avoidance (that premise was a June-2026 scope freeze pinned at 418; the count is 683 and the same plan doc sanctions bumping it). |
| **q3** | Where the resolve code lives | **Split `core/state/speleodb.rs` into meaningful modules first**, then place the new code where it belongs. The pure candidate/membership logic goes in `speleodb/dump.rs` beside `classify`. No `speleodb_dump_resolve.rs`. See the prerequisite section. |
| **q4** | Picker UX shape and placement | **Shared component, hosted as a third independent top-layer overlay** in `App.tsx` after the storage-choice mount, on the `heldLockPromptOpen`/`storageChoiceOpen` pattern. Never through `activeDialog` - that slot is single-valued and would evict the host dialog (the bug `SpeleoRestoreDialog` has today). List mechanics from `RemoveClosureDialog`; overlay hosting from `SpeleoStorageChoiceDialog`. |
| **q5 / q10** | Restore and View | **Both.** They share `classify_dump_entry` (`:2479`) and a single `restore: bool`. View is *not* a throwaway peek - it rewrites the cache `.stalx` and reloads the project (`:2582-2589`); only its BASE stamp lets a later Update fast-forward it away. |
| **q6** | How candidates cross IPC | **New `SpeleoDbAction::Ambiguous` + `dump_candidates` field on `SpeleoErrorDto`**, mirroring the shipped `unpushed_local` side-channel exactly. One round trip, one download. |
| **q7** | Candidate metadata | **entry path + uncompressed size + optional mtime**, exposed by a *new* `Dump::entry_details()`. Free (the existing `by_index` loop already parses each local header). Do not widen `entry_paths()` - it has four call sites and nine tests. The UI suppresses any column whose values are all equal, which is the likely git-archive mtime case. |
| **q8** | Re-download on resolve | **Re-download.** Already the shipped pattern: `speleodb_adopt_ariane` re-downloads after the FE confirm (`:1557-1562`), discarding the bytes `speleodb_open_project` fetched. No `AppState` dump cache; peak RSS is already budgeted at ~1.15 GiB. |
| **q9** | Validating `entry_path` | **Re-classify and require membership**, against the same `Dump` being extracted. The ballot premise was wrong: `entry_path` never reaches the filesystem (it is only an `IndexMap` key at `dump.rs:185`; every fs path derives from `speleodb_cache_path(uuid)`), so zip-slip and traversal are structurally inexpressible and no path sanitisation is warranted. One `==` against server-derived data. |
| **D-1** | Scope of v1 | **Open family + restore/view, plus a session-remembered choice.** `speleodb_fast_forward` (start-editing / update / take-remote) reuses the remembered entry silently and keeps today's fail-closed error when there is none. This closes the take-a-lock-then-Fatal hole without widening three zero-arg command signatures. |
| **D-2** | Non-canonical picks | ~~**Pre-select and badge the candidate whose basename is `project.stalx`**, and state the consequence in the picker body.~~ **REVERSED in review** - see the amendment below. Nothing is badged or pre-selected; the consequence copy stands, minus its reference to the badge. Persisting the chosen entry and guarding the push is correct but is a schema-fence change; filed as a follow-up. |
| **D-3** | Is the choice remembered | **Session only**, on `SpeleoDbSession`, keyed by project id, cleared on logout. Never persisted: the chosen entry is a property of the server tree at a commit, not of the local project, so a stored name can vanish and the re-ask path is needed regardless. |
| **D-4** | Cancel and lock ownership | **Let the error unwind and release the lock**; resolve re-enters from scratch. Never hold a server mutex across an unbounded user interaction - that is what `:2059-2062` exists to prevent. On the pull path cancel is already clean, since classify precedes the cache replace. |
| **D-5** | Ariane files | **Disregarded entirely whenever a `.stalx` exists.** Users are told the `.tml` is not for editing. A newer `ariane.tml` alongside a `.stalx` being ignored is intended behaviour, not a bug - no issue is filed for it. |
| **D-6** | Two or more `ariane.tml`, no `.stalx` | **Gets an ambiguity arm and the same picker.** Only reachable when there is no `.stalx`, so it never conflicts with D-5. Today the adopt path silently takes the first in central-directory order. |
| **D-7** | Telemetry | **Four dialog events** (`action.dialog.*`, `dialog-cancel.*`, `dwell.dialog.*`, `active-dwell.dialog.*`) plus a `REMOVED_DIALOGS` line, the pattern `held-lock-resume` already uses. Overlay dialogs otherwise emit nothing, and this condition is exogenous, so incidence and cancel rate are the only way to learn whether the picker earns its maintenance. |
| **D-8** | Row order and pre-selection | Canonical `project.stalx` first and pre-selected; remaining candidates by path. **Do not** copy `RemoveClosureDialog`'s auto-select-first - central-directory order is arbitrary. Order is pinned by a test. |
| **D-9** | Fallback copy | The "remove the extra file(s) on SpeleoDB" instruction the issue asked for is added as i18n, used on cancel and on every path the picker does not cover. |
| **D-10** | Test surface | **Rust unit + vitest only.** Playwright cannot express this: SpeleoDB has zero specs, all ten write-workflow commands are allowlisted unmocked, and the per-spec override can only throw a plain string, so `speleoErrorAction` returns `null` for it. "Typed-DTO rejection in the Playwright mock" is filed separately - it unblocks every future SpeleoDB spec, not just this one. |

---

## Prerequisite PR: split `core/state/speleodb.rs`

Its own PR, landing before any #258 code. This is the architecture item already tracked
in #275 ("speleodb.rs split - frozen at 1834 LOC + most active file in the repo - his next
PR hits the ratchet wall"); it is at 1952 now.

The split follows **the axis the file's own module doc already declares** (`speleodb.rs:6-21`),
which is the axis the six existing siblings were cut on.

| Module | Owns | Prod LOC |
|--------|------|---------|
| `speleodb_session.rs` | Everything reading or writing `SpeleoDbSession`: credential, lazy rehydration, login, the centralized 401 auto-drop, and the lock-acquisition provenance the session carries | ~353 |
| `speleodb_pull.rs` | Every path bringing server bytes into the cache `.stalx`: list / open / re-open, the one-shot Ariane adoption, and the fast-forward re-pull | ~350 |
| `speleodb_push.rs` | The BASE-vs-tip fence, the quiescent VACUUM snapshot, the `.tml` co-render, upload, and the Done / Push / Update verdicts | ~342 |
| `speleodb_project.rs` | The project record on SpeleoDB: create (publish), read, patch | ~307 |
| `speleodb_revisions.rs` | Revision history and the View / Restore swap | ~168 |
| `speleodb.rs` (residual) | The lock + edit gate, and the `speleo_link` persistence spine | **~505** |

Measured ranges sum to exactly 1952, matching `file-size-baseline.json:59`.

**Why fast-forward goes with pull, not push.** `speleodb_fast_forward` (`:3045-3060`) runs
the identical pipeline to `speleodb_pull_project` (`:1412-1437`) - `handle_auth` ->
`download_dump` -> `Dump::open` -> `classify_dump_entry` -> `replace_cache_stalx_with` -
differing only in the BASE stamp. Putting it beside the pull makes D-1's "chosen entry or
classify" helper one private fn with three call sites in one file.

**Why the lock and edit gate stay.** The behavioural corpus at `:4905-6496` shares nine
fixtures across tests that would otherwise scatter into four modules. Keeping that
production code where its fixtures already live is what makes everything else
cut-and-paste.

**Three findings that change how this must be sequenced.**

1. **Moving the test module buys no headroom.** Lines 3770-9157 already measure **0 prod
   LOC** - `markCfgTestItems` strips them. Test blocks move with their code for
   reviewability only, never for the ratchet.
2. **Three whole-region tripwires must be made split-proof *first*.** The dangerous one is
   `speleodb_cache.rs:284`, which asserts `replace_cache_stalx_abandoning` appears **zero**
   times in `include_str!("speleodb.rs")`. Once all three replace call sites move, it
   passes vacuously while guarding nothing. Same shape for the `write_collab_sibling`
   absence assertion (`:4820`); `base_commit_sha_advances_only_at_sanctioned_sites`
   (`:4710-4752`) fails loudly instead, which is the benign direction. Fix all three with a
   shared `speleodb_prod_sources()` helper in the existing `core/state/tests_support.rs`,
   carrying an "ADD A LINE HERE when a new module is born" comment.
3. **`#[expect]` is fulfillment-checked and `allow_attributes = "deny"`.** The test module
   carries `#[expect(clippy::panic)]` for the one test that poisons a mutex - which stays.
   Copying that expectation into a new module with no panicking test produces
   `unfulfilled_lint_expectation`.

**Visibility:** 15 private -> `pub(super)` promotions; **zero struct-field changes**
(`rehydrate_attempted` and `lock_acquired_here` stay private because everything touching
them lands in `speleodb_session.rs`). Nothing needs `pub(crate)`. Outside the family, only
`app_state.rs:89` and `:187` change path; `commands/speleodb.rs` needs no edit.

**Commit sequence** (each compiles and is green alone):

1. `test(speleodb): make the whole-region tripwires split-proof` - the only non-mechanical
   edit in the whole PR, isolated so every later commit reads as cut-and-paste.
2. `refactor(speleodb): widen the helpers the split will cross` - 15 single-token lines.
3. Move project metadata + publish. 4. Move revisions. 5. **Move pull / adopt /
   fast-forward** - land this before starting #258. 6. Move push. 7. Move session (largest
   test relocation, do it last). 8. Rebaseline and rewrite the module doc as a pointer map.

Steps 3-7 are order-independent; stopping after step 5 already leaves `speleodb.rs` at
~1140 and unfrozen.

**Proving nothing changed:** (a) line-cancellation residue per move commit - every moved
line appears once as `-` and once as `+`, and the residue must contain only `use` lines,
braces, doc lines and module wrappers; (b) prod-LOC conservation on a scratch rebaseline;
(c) an identical test inventory - `cargo test -- --list --include-ignored`, module path
stripped, sorted, diffed before and after. (c) is the one that catches the highest-risk
failure: a relocated test that silently stops running still reports success.

**Where #258 then lands:** `dump.rs` (candidate model, `entry_details`,
`candidate_is_member`), `speleodb_pull.rs` (`entryPath` threading, membership branch,
fast-forward reuse), `speleodb_revisions.rs` (`entryPath` on restore),
`speleodb_session.rs` (`chosen_dump_entries`, next to `lock_acquired_here`, and able to
stay **private** with `pub(super)` accessors). **Zero of #258's backend work lands in
`speleodb.rs` itself** - the file hardest to review is untouched by the feature.

---

## Work breakdown

### 1. Backend - candidate model and classifier (`src-tauri/src/speleodb/dump.rs`)

- Add `SpeleoDumpCandidate { entry_path: String, size_bytes: u64, modified: Option<String> }`
  (`Serialize`, `TS`, `#[ts(export)]`). Snake_case on the wire, matching every existing
  SpeleoDB DTO - `SpeleoErrorDto` has no `rename_all`.
- Add `Dump::entry_details() -> Result<Vec<DumpEntry>, SpeleoDbError>` alongside
  `entry_paths()`. `size()` and `last_modified()` are free: the existing `by_index` loop
  already parses each entry's local file header.
- Add `DumpClassification::AmbiguousAriane(Vec<String>)` (D-6) and the matching arm, so
  two or more `ariane.tml` with no `.stalx` stops being silent first-wins.
- Add the membership check used by resolve:

  ```rust
  pub(crate) fn candidate_is_member(names: &[String], chosen: &str) -> bool
  ```

  returning true only when `classify(names)` yields an ambiguous variant containing
  `chosen`. Exact string equality; no normalisation, no path handling (D-9/q9).
- Move `classify_dump_entry` here from `core/state/speleodb.rs:280-287`, so the error
  mapping sits beside the classifier it wraps.

### 2. Backend - typed action and DTO (`speleodb/contract.rs`, `speleodb/models.rs`)

- `SpeleoDbAction::Ambiguous` (contract.rs), documented as a routing signal like `Adopt`
  rather than a status-derived action.
- `SpeleoErrorDto.dump_candidates: Option<Vec<SpeleoDumpCandidate>>`, populated only for
  the ambiguous variants - mirroring how `unpushed_local` is populated only for the
  refused-replace guard.
- `SpeleoDbError::AmbiguousDump(Vec<String>)` becomes
  `AmbiguousDump(Vec<SpeleoDumpCandidate>)`; add `AmbiguousAriane` for D-6.
- Move both out of the fail-closed group in `dto_for_error` into the routing group. The
  source-level tripwire at `contract.rs:527-561` slices the match and requires the named
  arms with no `_ =>`; adding arms is safe, deleting is not.
- The `Display` impl at `mod.rs:93-95` currently joins bare strings and is pinned by a
  test at `mod.rs:184-188`; both need updating for the new payload type.
- **Consequence for the paths that keep failing closed.** Once the action is `Ambiguous`
  everywhere, `speleodb_fast_forward` errors also carry it - but `speleodb_start_editing`,
  `_update` and `_take_remote` take no `entryPath`, so there is nothing for the picker to
  replay. `useSpeleoActions.handleError` (which today branches only on `ReLogin`) gains an
  `Ambiguous` branch that renders the D-9 fallback copy instead of the raw Rust string.
  That is the home for the "remove the extra file(s) on SpeleoDB" instruction the issue
  asked for.
- Regenerate: `pnpm gen:ipc-types` **and** a `cargo test` run - the `src-tauri/bindings/`
  copies are written by ts-rs test hooks, not by the generator. A brand-new exported type
  must be added to *both* the `export::<T>()` call list and the `export_list` array in
  `src-tauri/examples/gen_ipc_types.rs`; nothing checks they agree.

### 3. Backend - `entryPath` threading and validation

- `speleodb_open_project`, `speleodb_open_project_discarding_local` and
  `speleodb_restore_revision` each gain `entry_path: Option<String>`.
- `speleodb_pull_project` and the restore body take it through to the classify step. When
  present, skip `classify_dump_entry` and instead require
  `candidate_is_member(&names, &chosen)` against the freshly downloaded archive; on
  failure return the ambiguous error again so the picker re-renders with current data.
- **`guard_local_edits` runs again on resolve** (it is deliberately hoisted ahead of the
  download at `:1397-1400`, pinned by a source-order test). A background poll can rewrite
  the link while the picker is open, so resolve can legitimately be refused the second
  time. That surfaces as the existing `UnpushedLocalEdits` route - a test case, not new
  machinery.

### 4. Backend - session-remembered choice (D-1, D-3)

- `SpeleoDbSession` gains `chosen_dump_entries: HashMap<String, String>` (project id ->
  entry path), written when a resolve succeeds, read by `speleodb_fast_forward` before it
  classifies, and cleared by `speleodb_logout`.
- Fast-forward consults it and validates membership exactly as resolve does. A miss falls
  through to today's fail-closed error - so start-editing after a picked open works, and
  a cold start still fails safe rather than guessing.

### 5. Frontend - store flag and overlay host

- `speleoStore`: `dumpPickerOpen`, `dumpPickerCandidates`, `dumpPickerRequest` (the
  pending call to replay), `openDumpPicker` / `closeDumpPicker`.
- Mount `<SpeleoDumpPickerDialog />` in `src/App.tsx` immediately after the storage-choice
  overlay.

**Correction, found in testing.** This step originally read "both wrappers use `z-[60]`,
so ordering is by `dialogStack`, not z-index". Both halves are false. `DialogWrapper`
declares `z-50` and `AlertDialog` declares `z-[60]`; they portal into a `#dialog-root`
that creates no stacking context, so z-index decides and DOM order never gets consulted.
And `dialogStack` only ever wrote `inert` - it had no bearing on painting at all. The
picker was therefore painted underneath any `AlertDialog` host while still being the
interactive one. `dialogStack` now stamps the layer alongside the inertness, which fixes
the class rather than the one pair.

### 6. Frontend - the picker component

`src/components/Dialogs/SpeleoDumpPickerDialog.tsx`, following the house conventions:
`DialogWrapper`, radio rows in a scroll box, Cancel then a `variant="primary"` confirm
(which auto-stamps `data-primary-action`, so the safe action takes initial focus),
`data-testid="speleodb-dump-picker"` with per-row `speleodb-dump-picker-option-<n>`,
`onClose={busy ? () => {} : dismiss}` while a resolve is in flight. Canonical candidate
first, pre-selected, badged "current" (D-2/D-8); the consequence sentence sits above the
list.

### 7. Frontend - wiring the seams

- `useOpenRemoteProject`: branch on `action === 'Ambiguous'` beside the existing `Adopt`
  and `UnpushedLocalEdits` branches, and re-invoke with `entryPath` on confirm -
  caller-driven re-invocation, exactly like `adoptRemote`. Re-run `handBackRefusal` on the
  resolve so the guard does not rest on a call-site convention.
- `useRestoreRevision`: same branch; it currently reaches only the `unpushedLocalEdits`
  helper and would otherwise drop `Ambiguous` into a generic error toast.
- Both drive the one shared overlay rather than each hosting their own copy.

### 8. i18n

New `speleodb.dumpPicker.*` namespace in `src/i18n/locales/en.json`, following the
`speleodb.browser.*` shape (title first, then states, then actions): `title`, `body`,
`consequence`, `currentBadge`, `sizeLabel`, `confirm`, `cancelHint` (the D-9 fallback
instruction), plus `speleodb.errors.ambiguousDump` for the paths that stay fail-closed.
No key-sync lint exists, so a missing key renders as `[key]` in dev - add them all in one
pass. `scripts/check-no-em-dash.mjs` scans `en.json`.

### 9. Telemetry (D-7)

Four `EVENT_NAMES` strings for the dialog quadruple, the `assert_eq!(EVENT_NAMES.len(), …)`
bump with its ledger comment, and a `REMOVED_DIALOGS` entry so
`registry_covers_all_dialogs` does not call them stale (it only scrapes
`activeDialog === '…'` literals out of `App.tsx`, and this is an overlay).

### 10. Tests

- **Rust, `dump.rs`**: membership accept/reject; a non-`.stalx` pick rejected; the
  `AmbiguousAriane` arm; and a **candidate order and contents pin** - today
  `two_stalx_fails_closed` asserts only `len() == 2`, yet the picker renders that order.
- **Rust, state**: resolve extracts the chosen entry; a stale pick after the tree changed
  is refused; the session-remembered entry is consulted by fast-forward and cleared by
  logout.
- **Vitest, component**: mirror `SpeleoStorageChoiceDialog.test.tsx` - a `Host()` gate
  mirroring the `App.tsx` mount, all three dismissal routes as an `it.each` table, a
  negative assertion that cancel issues no backend call, and that the canonical row is
  pre-selected.
- **Vitest, hooks**: `useOpenRemoteProject` and `useRestoreRevision` branch on a typed
  `Ambiguous` rejection and replay with `entryPath`. Both test files already inject typed
  DTO rejections.

---

## Out of scope - follow-ups to file

1. **Persist the chosen entry and guard the push.** Warn or refuse when pushing from a
   non-canonical pick. Correct, but a schema-fence change: `PRESERVED_SPELEOLINK_COLUMNS`,
   `migrate_schema`, the byte-identical fresh-DB script, an idempotent `ALTER`, a
   `SCHEMA_VERSION` bump, plus the model and both persistence sites.
2. **Typed-DTO rejection in the Playwright mock.** Unblocks e2e coverage for the whole
   `#186` action contract, not just this feature.
3. **Fast-forward picker.** If session memory proves insufficient in practice, widen
   `speleodb_start_editing` / `_update` / `_take_remote`.

---

## Risks

**R1 - the split lands badly.** The prerequisite touches the most active file in the
repo. Mitigation: land it as its own PR of purely mechanical moves, no logic edits, with
tests moving alongside their code so the diff reads as cut-and-paste.

**R2 - a new action nobody branches on.** There is no exhaustiveness test over
`SpeleoDbAction`; four variants already exist that the frontend never branches on. The
plan must add its own test, or `Ambiguous` quietly becomes the fifth.

**R3 - a dialog that reappears forever.** Because the push wire name is pinned and the
server is additive, a resolved project stays ambiguous. Session memory (D-3), the
canonical pre-selection (D-2) and the consequence copy are what keep this from being a
modal the user meets on every open. Without them, #258 relocates the problem rather than
closing it.

---

## Amendment (post-review): the remembered choice carries its revision

Two reviews of the shipped branch converged on the same hole, and it is a real one.

**What D-1 and D-3 got wrong.** They key the recall on project id alone. The resolver
reads from whatever entry the user picked, but a push always uploads to the server's
canonical wire name - so a non-canonical choice describes pre-push bytes the moment
*any* revision lands. `speleodb_revision_landed` already handled our own push. Nothing
observed a collaborator's, and that is the dangerous half: their work is what the stale
entry replaces. The fast-forward would extract the old file, stamp BASE at the new tip,
and the next push would overwrite their revision with no divergence to stop it.

Membership was the only guard, and it is far too weak on its own - the stale case
usually *passes* it, because a push leaves every non-canonical `.stalx` exactly where
it was.

**What changed.** `DumpChoice` now carries the revision the answer was about, and
`DumpAt` is what every classify site measures against. `Unknown` fails closed. This also
retired the probe's short-circuit, which skipped inspecting the requested revision
entirely on the strength of an answer about a different tree.

**Why D-1's "silently reuse or fail closed" needed a third answer.** Making the recall
revision-scoped would have turned a silent rollback into a dead end: the three
fast-forward verbs have no picker host (`dumpCandidates` is checked per verb on the
frontend, and `useSpeleoActions` does not check it), so a candidate list reaches a
surface that cannot ask. They now refuse with `AMBIGUOUS_NEEDS_REOPEN`, which names
re-opening as the flow that does host the picker. Note this dead end was already
reachable before the amendment - our own push cleared the recall, so start-editing after
a push met the raw ambiguity. The refusal is a strict improvement on that, not a new
limitation.

**Follow-up 3 is now the natural next step,** and cheaper than it was: with choices
already dated, widening `speleodb_start_editing` / `_update` / `_take_remote` is purely
"add the pre-flight probe", the same shape `speleodb_dump_candidates` already gives the
revert. Worth doing if the re-open step proves annoying in practice.

**R3 revisited.** Re-asking is now once per external revision on an ambiguous project,
where it used to be once per session. That is the honest frequency - the tree really did
move - but it is the number to watch if the picker starts feeling like a nag.


---

## Amendment 2 (post-review): D-2 reversed - nothing is badged or pre-selected

D-2 chose to badge the candidate whose basename is `project.stalx` as "current", sort
it first, pre-select it and let initial focus land on Confirm - on the reasoning that it
is the name a push writes, so accepting the default changes nothing on the server.

**That reasoning does not hold.** A push writes `<TARGET_FOLDER>/project.stalx`, and
`TARGET_FOLDER` is configurable and recorded nowhere in the dump. So the basename test
can name a file that is not the target at all. The case that makes it concrete:

| dump entry | badged by D-2 | actual push target with `TARGET_FOLDER=misc/` |
|---|---|---|
| `backup/project.stalx` | **yes** - sorted first, pre-selected, focused | no |
| `misc/current.stalx` | no | no |
| `misc/project.stalx` | *not in the dump* | **yes** |

The badge landed on the backup, and a stray Enter accepted the one file the next push
would overwrite. R3's mitigation list named this pre-selection as what keeps the picker
from being a nag; the price was a confident guess that can be wrong in exactly the
direction that costs data.

`entry_details` no longer computes it, `SpeleoDumpCandidate` no longer carries it, the
list is path-ordered, and Confirm starts disabled so focus falls to Cancel - Enter
cancels rather than picking a file on the user's behalf. `has_canonical_basename` is
gone with it; `CANONICAL_STALX_WIRE_NAME` remains, used only where it belongs, naming
the part a push actually uploads.

**What this costs:** every ambiguous open now needs a deliberate choice, including the
common case where `TARGET_FOLDER` does contain `project.stalx` and the old badge would
have been right. That is the accepted trade - the app cannot tell the two situations
apart, and D-2's mistake was acting as though it could.

Follow-up 1 (persist the chosen entry and guard the push) is the real fix and unchanged:
if the server ever reports the stored path, the badge can come back as a fact rather
than an inference.
