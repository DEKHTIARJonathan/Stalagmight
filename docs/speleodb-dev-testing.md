# SpeleoDB dev/integration testing

How the SpeleoDB client (`src-tauri/src/speleodb/`) is tested against a **real**
SpeleoDB server, and how to design future multi-account / permission /
collaboration tests against the dev box.

The SpeleoDB server source lives at `~/src/cave/SpeleoDB` - the API contract notes
below were verified against it, not against the (sometimes stale) GitHub issue text.

## The dev box

A throwaway SpeleoDB instance on the lab network. Connection details live in the
**gitignored** `.env` at the repo root (never committed):

| Env var | Meaning |
|---------|---------|
| `DEV_SPELEODB_URL` | Base URL of the dev box (e.g. `http://10.10.0.220:8000/`). The client appends the `/api/v2/...` paths. |
| `DEV_SPELEODB_EMAIL` | Login email for the primary (superuser) test account. |
| `DEV_SPELEODB_PASSWORD` | Login password for the primary test account. |
| `DEV_SPELEODB_EMAIL2` | Login email for a **second**, email-verified collaborator (for the two-account tests). Optional - those tests skip if unset. |
| `DEV_SPELEODB_PASSWORD2` | Login password for the second account. |

> `cargo test` does **not** auto-load `.env`. The live tests read these from the
> process environment, so pass them on the command line (see "Running the live
> tests"). `.env` is just the local record of the values for the running app and
> for copy-pasting into a test command.

### The configured account is a Django superuser

The account in `DEV_SPELEODB_EMAIL` (`dab@dab.com` on the current box) is a Django
**superuser**. That matters for test design: a superuser can provision *additional*
accounts, so future tests that need more than one user (permission tiers,
collaboration hand-off, lock contention) don't have to share the one login.

Provisioning caveat - **email verification is mandatory**. The server sets
`ACCOUNT_EMAIL_VERIFICATION = "mandatory"` (`config/settings/base.py`), and the
auth-token endpoint rejects accounts whose email is unverified. So a plain
allauth headless self-signup (the headless routes are mounted under
`/api/v2/auth/`) yields an account that **cannot** obtain a token until its email
is verified. To mint a usable test
account, the superuser must create it *and mark its email verified* - via the
Django admin (`/admin/`), a `manage.py shell` snippet, or a management command -
rather than relying on the self-signup flow alone.

Server-side cleanup tooling that exists for tests (run on the box, not from here):
`manage.py wipe_test_user_projects` and `manage.py wipe_test_gitlab`.

### The second account (for multi-user tests)

Some live tests need **two** identities - a project owner and a collaborator - to
exercise permission tiers and cross-user locks. That second account
(`DEV_SPELEODB_EMAIL2`/`_PASSWORD2`, `user2@dab.com` on the current box) must be
**pre-provisioned with a verified email**, because (per the caveat above) a
verified user cannot be created over HTTP with just the superuser bearer token.
Create it once, box-side, e.g.:

```bash
python manage.py shell -c "from django.contrib.auth import get_user_model; from allauth.account.models import EmailAddress; U=get_user_model(); u=U.objects.create_user(email='user2@dab.com', password='ChangeMe123!'); EmailAddress.objects.create(user=u, email='user2@dab.com', verified=True, primary=True)"
```

The two-account tests then **self-seed** the rest over HTTP: the superuser creates
a throwaway project, grants `user2` a permission level
(`POST /api/v2/projects/{id}/permission/user/detail/` `{"user","level"}`), and/or
has `user2` hold the mutex - then deletes the project on the way out. They **skip
cleanly** when `DEV_SPELEODB_EMAIL2`/`_PASSWORD2` are absent, so a box without the
second account still runs the single-account suite.

## Test layers

The client follows a two-layer convention (see the plan for #183 and the epic #182):

1. **Always-run unit tests** - pure functions, no network. `dump::classify`, DTO
   parsing, Bearer/URL construction, the in-memory `TokenStore` fallback. These run
   in normal `cargo test` and in CI.
2. **Env-gated live tests** - real HTTP against the dev box. Marked `#[ignore]` so
   they never run in normal `cargo test` or CI, and they early-return (skip) if the
   `DEV_SPELEODB_*` env vars are absent. They live in the `live_tests` module of
   `src-tauri/src/speleodb/mod.rs`.

### Self-seeding, self-cleaning (no shared fixtures)

The live round-trip owns all of its own state - there is **no** pre-seeded
`DEV_SPELEODB_PROJECT_ID` to keep alive:

- Each run **creates a throwaway project** with a UUID-suffixed name
  (`stalagmight-spike-<uuid>`) via `client::create_project`.
- A `ProjectCleanup` guard (`Drop`) **soft-deletes** that project on the way out -
  even if an assertion panics partway through - so runs don't leak projects.
- Seeding a known-good `.stalx` goes through the real single-writer dance:
  `acquire_lock → upload_auto_single → release_lock`. (Upload requires holding the
  project mutex; the server enforces `UserOwnsProjectMutex`.)
- The pull half then exercises `download_dump → classify → extract →
  Database::open_existing`, proving the dump opens self-contained.

This is the pattern to copy for new live tests: **one project per run, created and
destroyed by the test**, keyed by a UUID so parallel/repeat runs never collide.
For multi-user scenarios, have the superuser provision the extra accounts (see
above), grant them the project permission under test, and tear everything down in a
`Drop` guard the same way.

## Running the live tests

```bash
DEV_SPELEODB_URL=http://10.10.0.220:8000/ \
DEV_SPELEODB_EMAIL=dab@dab.com \
DEV_SPELEODB_PASSWORD=dab \
TELEMETRY_ENDPOINT=http://localhost/dummy \
cargo test --manifest-path src-tauri/Cargo.toml --features telemetry \
  speleodb::live_tests -- --ignored
```

- `--ignored` is required - the live tests are `#[ignore]`d by default.
- `TELEMETRY_ENDPOINT` is needed because `build.rs` requires it under
  `--features telemetry` (which the project's test command uses anyway).
- Drop the `DEV_SPELEODB_*` vars and the tests skip cleanly (they print a skip line
  and pass), so this command is safe to leave in a script.
- `live_bad_credentials_returns_400` needs only `DEV_SPELEODB_URL` (it sends junk
  credentials and asserts the 400 contract); the full round-trip needs all three.

## Verified API contract (for writing more tests)

Checked against `~/src/cave/SpeleoDB`; these override the stale issue text:

- **Base path `/api/v2/`** (`api_router.py`); v1 is a deprecated alias. v2 responses
  are **bare** JSON (the `DRFWrapResponseMiddleware` only wraps `/api/v1/`).
- **Auth header `Authorization: Bearer <token>`** (not `Token`); the token is
  non-rotating (`get_or_create`).
- **Bad credentials → HTTP 400** (`{"errors":{"non_field_errors":[…]}}`), *not* 401.
  A `401` means "not authenticated" on a protected endpoint (e.g. listing with a
  dead token); a missing auth header yields `403`.
- **`permission` is a STRING label** - `"WEB_VIEWER" | "READ_ONLY" |
  "READ_AND_WRITE" | "ADMIN"` - and the field is **absent** (not null) when the user
  has no permission. (Issues #188/#203 say "parse the integer" - wrong.)
- **Project `type`** is a string enum: `ariane | compass | stickmaps | therion |
  walls | other`.
- **The `.stalx` lands at `misc/project.stalx`** in the dump ZIP. Locate it by the
  `.stalx` **suffix**, never the hard-coded `misc/` path (survives a server
  `TARGET_FOLDER` change).
- **Upload requires the mutex** - `PUT /projects/{id}/upload/auto/` is gated by
  `UserOwnsProjectMutex`, so seed via `acquire_lock` first, then `release_lock`.

## Concurrency model - one same-account session at a time (#193)

The single-writer lock (mutex) is the only concurrency control; the server itself
is last-writer-wins. The ambiguous-push self-heal (guardrail 7, `sync::classify_ancestry`)
recovers a lost push confirmation by asking *"is the commit now on top of BASE
authored by me?"* - it identifies our own landed commits **purely** by
`author_email == my_email`.

**Constraint:** edit a given project from **one session per account at a time.**
A *second* session under the **same account** editing the same project
concurrently is unsupported: its commit also reads as `author_email == me`, so the
self-heal could mistake it for our own landed push and wrongly clear the dirty bit
(dropping un-pushed edits). The single-writer lock makes this rare in practice, but
nothing stops a determined user from running two app instances logged in as the
same account.

**Mitigation (the notice):** `speleodb_open_project` checks the project's
`active_mutex` at open time; if the lock is already held by **our own** account, a
concurrent same-account session is live, and the open result carries
`concurrent_session = true` (`sync::concurrent_session_notice`) so the UI warns the
user. A lock held by a *different* account is an ordinary contended-lock case, not
this notice. (Detection is verified by the `live_orch_open_flags_concurrent_*`
tests; the pure predicate by `concurrent_session_flagged_only_for_a_same_account_lock_hold`.)

## Render-compat verification (#184 - the P0.5 gate)

The premise of the whole `.tml` render sidecar is that SpeleoDB's `openspeleo_lib`
accepts **our exporter's** `.tml` and regenerates a `ProjectGeoJSON`. #184 proves
that against the live box. Three `#[ignore]` tests live in `speleodb::live_tests`
(single-account tier):

- `live_render_compat_georef_generates_geojson` - **the gate.** Builds an in-memory
  georeferenced project (a `ZeroDatum` with real lat/long), `export_tml`s it, pushes
  it via the production two-`artifact` `upload/auto`, then **reads the render back**
  and asserts features exist.
- `live_render_compat_no_anchor_records_geojson_state` - pushes an un-georeferenced
  project (0/0 START) and records that no new render is generated (the D2 path).
- `live_open1_bare_tml_mime_outcome` - resolves OPEN-1 (below).

Key server facts these depend on (checked against `~/src/cave/SpeleoDB`):

- **A 200 upload does NOT prove a render.** `survey_to_geojson` runs best-effort
  *after* the commit; `api/v2/views/file.py` catches `NoKnownAnchorError` /
  `EmptySurveyError` / any `Exception` and `continue`s, so the push still 200s with
  no `ProjectGeoJSON`. The render must be read back to be verified.
- **Read the render back via OGC API - Features** (no `Authorization` header - the
  token authenticates via the URL path; the `user_token` converter requires a
  **40-hex** key, which the DRF token is):

  ```
  GET /api/v2/gis-ogc/user/<token>/collections/<commit_sha>_points/items
  GET /api/v2/gis-ogc/user/<token>/collections/<commit_sha>_lines/items
  ```

  Returns a **bare** `FeatureCollection` (`{"type":"FeatureCollection","features":[…],
  "numberMatched":N,…}`, a `StreamingHttpResponse`) on 200, and **404** when no
  `ProjectGeoJSON` exists for that commit + geometry group. The collection id is
  `<sha>_(points|lines)` (`ogc_typed_id` converter). A lighter
  `GET /api/v2/projects/{id}/geojson/` (Bearer, ≥ READ_ONLY) lists the commits that
  have a render.
- **No-anchor → "may be stale", not blank.** On `NoKnownAnchorError` the server keeps
  the previous commit's `ProjectGeoJSON` row (it only skips generating a *new* one),
  which is why the D2 banner copy says the map *may be stale* rather than missing.

### OPEN-1 - is explicit per-part MIME required for the `.tml`?

The server selects the upload processor by **extension** (`processors/auto_selector.py`:
`.tml` → `ArianeTMLFileProcessor`), then validates the multipart part's `Content-Type`
against `ArianeTMLFileProcessor.ALLOWED_MIMETYPES = ["application/octet-stream",
"application/zip"]` (enforced in `processors/artifact.py::assert_valid`). **`text/plain`
is not allowed**, so a part whose Content-Type is `text/plain` (the multipart default
when none is set, or `mime_guess` on the unknown `.tml` extension) is rejected →
`ValidationError` → `ATOMIC_REQUESTS` rollback → **400**. Our production
`client::upload_auto` always sends `application/octet-stream`, so it passes. This means
the `client.rs::mime_for` comment ("explicit MIME is robustness, not a hard
requirement") is **wrong on the server contract**: an `octet-stream`/`zip` Content-Type
is genuinely required for the `.tml` part. `live_open1_bare_tml_mime_outcome` confirms
empirically what Content-Type `ureq`'s bare `Part::file()` actually sends (and thus
whether *our client specifically* could omit the explicit MIME); it prints the verdict.

### Live-run results (2026-06-27, box `http://10.10.0.220:8000/`)

Ran `live_render_compat_georef_generates_geojson`, `live_render_compat_no_anchor_records_geojson_state`,
and `live_open1_bare_tml_mime_outcome` against the box - all pass:

- **🟢 GATE GREEN.** A Stalagmight-exported **georeferenced** `.tml` regenerated a
  `ProjectGeoJSON`: the OGC `<sha>_points` layer returned HTTP 200 with **1** feature
  and `<sha>_lines` returned 200 with **2** features (the 2 shot segments). So
  `openspeleo_lib` accepts our exporter output - the P1 render/push half is de-risked;
  no exporter fix / #219 fast-track is needed to proceed.
- **No-anchor → no render.** A push of the same project with **no** zero datum (0/0
  START) still 200'd, but both `<sha>_points` and `<sha>_lines` returned **404** - i.e.
  no new `ProjectGeoJSON` for that commit (the D2 "may be stale" banner path). 0/0 IS
  treated as "no known anchor".
- **OPEN-1 resolved → explicit MIME REQUIRED.** A `.tml` part sent **without** an
  explicit `Content-Type` (bare `ureq` `Part::file()`) was rejected with **HTTP 400** -
  ureq's default part Content-Type is not in `ArianeTMLFileProcessor`'s
  `{octet-stream, zip}` allow-list. So `client::mime_for`'s explicit
  `application/octet-stream` for `.tml` is load-bearing, not defensive (the old "not a
  hard requirement" comment was wrong and has been corrected).

## Loop-UI client coverage (#198/#200/#201/#202)

The single-writer loop UI added three client methods that had no live coverage.
Each now has a `#[ignore]` single-account live test in `speleodb::live_tests`:

- `live_get_project_reflects_holder_and_tip` (**#202**) - pins the two fields the
  lazy re-verify (`speleodb_verify_lock_if_expired`) branches on: while we hold the
  mutex `client::get_project` reports `active_mutex.user == me` and carries a
  `latest_commit`; after `release_lock`, `active_mutex` goes **absent** (the
  lost-lock signal that routes to the divergence prompt). It deliberately does NOT
  assert `latest_commit.id` equals the pushed hexsha - that field is
  `max(authored_date)` and documented unreliable as a tip, which is why #202's
  tip-moved check is best-effort.
- `live_release_all_locks_releases_held` (**#201**) - `client::release_all_locks`
  (`DELETE /user/release_all_locks/`) drops **every** lock the token holds in one
  request; the test locks two throwaway projects, releases all, asserts both are
  freed, then re-calls to confirm the empty-handed no-op still 2xxes (idempotent).
  Caveat: it clears **all** locks for the configured account, so run it only against
  the throwaway box.
- `live_patch_exclude_geojson_roundtrips` (**#200**) - `client::patch_project`
  (`PATCH /projects/{id}/`, write permission, no lock) round-trips
  `exclude_geojson`: flip to `true`, confirm the PATCH response and a follow-up GET
  both report `true`, then flip back to `false` (the shipped Enable-rendering
  action) and confirm the cleared state.

### Live-run results (2026-07-02, box `http://10.10.0.220:8000/`)

Full suite green: `cargo test … speleodb::live_tests -- --ignored --test-threads=1`
ran **all 25** live tests (22 existing + the 3 above) against the box - **25 passed,
0 failed** in ~50s, with both `DEV_SPELEODB_EMAIL2`/`_PASSWORD2` set (so the
two-account tier ran too). This also confirms the loop-UI DTO additions
(`Project.exclude_geojson`, `ProjectMetadata.speleodb_project_id`) still parse real
server responses. Run single-threaded because `live_release_all_locks_releases_held`
clears account-wide locks and must not race lock-holding tests.

## F2 live-suite acceptance coverage (#212)

The env-gated live round-trip / render-compat / negative suite (F2) is the
`#[ignore]` + `DEV_SPELEODB_*` model above (the issue's `SPELEODB_TEST_URL` name
predates the adopted `DEV_SPELEODB_URL` convention; the CI/offline-green
guarantee comes from `#[ignore]`, so those runs never touch the box). Each #212
acceptance item maps to concrete tests across `speleodb::live_tests` (client) and
`core::state::speleodb` orchestration live tests:

| #212 criterion | Covering test(s) |
|----------------|------------------|
| Skips when the box is absent; CI/offline stay green | `#[ignore]` on every live test + `live_env()`/`orch_env()` early-return when `DEV_SPELEODB_*` is unset |
| Round-trip tree shape + 2nd-checkout pull matches | `live_round_trip_seed_pull_open` (seed → pull a fresh checkout → open self-contained), `live_orch_start_editing_edit_done_advances_base` (full start→edit→done loop, BASE advances), `live_orch_pushed_dump_is_self_contained_without_sidecars` (server dump = one `.stalx` located by suffix + `ariane.tml` at root + no sqlite sidecar; re-opens carrying the pushed edit) |
| Render-compat: `ProjectGeoJSON` + OGC feature counts; no-anchor → no render + D2 | `live_render_compat_georef_generates_geojson` (OGC `<sha>_points`=1 / `<sha>_lines`=2), `live_render_compat_no_anchor_records_geojson_state` (0/0 START → 404 render → D2 "may be stale") |
| Negative: 403-no-mutex | `live_upload_without_mutex_returns_403` (push while `active_mutex` is unheld → `UserOwnsProjectMutex` → 403) |
| Negative: 400-contended, locked-by via re-GET (not string parse) | `live_acquire_contended_returns_400`, `live_lock_holder_reflects_other_user`, `live_orch_start_editing_reports_locked_by_other_account` |
| Negative: stale push → fence trips, no clobber | `live_orch_update_diverges_when_dirty_and_tip_moved` (dirty + moved tip → `DivergenceNeeded`, dirty bit preserved), `live_orch_start_editing_diverges_on_unreconcilable_base` (unreconcilable BASE → divergence prompt + lock released, no overwrite) |

Note on "regenerated GeoJSON": the render is a server-side `ProjectGeoJSON`
served via the **OGC API** (`gis-ogc/.../collections/<sha>_(points\|lines)/items`),
**not** a file committed to the dump tree - so it is asserted by the render-compat
tests reading the render back, not by inspecting the ZIP. (This is the mechanism
#219/#220 aim to retire.) The self-contained-dump test locates the `.stalx` by its
suffix, never the hard-coded `misc/project.stalx` path, per the verified contract.

## Adopting a `.tml`-only project (C2, #214)

When a SpeleoDB project's dump holds an `ariane.tml` but **no `.stalx`**, opening
it routes to the one-time adoption bootstrap (the single sanctioned server-`.tml`
read; never an ongoing reconcile). `speleodb_open_project` surfaces the typed
`SpeleoDbAction::Adopt` (not a hard error); the browser then offers a confirm
dialog, and on confirm `speleodb_adopt_ariane` downloads the dump, imports the
`ariane.tml` through the normal TML importer (`include_excluded=false`,
`comments_on_stations=true` - the same settings the collab `.tml` round-trip
uses), saves a new `.stalx` at the pull cache path, stamps the `speleo_link`
(`base = server tip`, `has_unpushed_edits = true`), and best-effort PATCHes the
server project `type` ariane→other.

Offline coverage: the typed-signal seams are unit-tested (`dto_for_error(
AdoptAriane) → Adopt`; the dump classifier's adopt arm carries the `ariane.tml`
path), and the FE confirm→adopt→reload flow has a component test
(`OpenFromSpeleoDbDialog.test.tsx`). The full create→import→save orchestration
needs an app handle + a live box, so it is verified manually on the dev box:

1. Seed / pick an `ariane`-type project whose dump contains only `ariane.tml`.
2. Open-from-SpeleoDB → pick it → the confirm dialog spells out the consequences.
3. Confirm → the survey imports, a `.stalx` lands in the cache, and the UI opens
   it **read-only** (remote, no lock); a success toast shows.
4. DB-inspect the cached `.stalx`: one `speleo_link` row, `base` = the server
   tip, `has_unpushed_edits = 1`.
5. On the server the project `type` is now `other`.
6. Start editing (UpToDate, no divergence prompt) → edit → Done → the `.stalx`
   pushes, and a later fresh pull now classifies as `Stalx` (normal open),
   confirming the bootstrap is one-time.
7. Negative: with a READ_ONLY account, adoption still opens the project locally
   and the toast notes the server type was not updated (`type_flipped = false`).

## Optimistic force-edit - editing without the lock (E2, #213)

Force-edit lets an **opted-in** user edit a remote project **without** the write
lock (to survey offline, or while someone else holds it), behind a persistent
big-red "this `.stalx` cannot be merged" warning. It introduces a transient
`force_editing` flag distinct from `edit_enabled`: `edit_enabled && force_editing`
= editing WITHOUT the lock; `edit_enabled && !force_editing` = the normal lock-held
mode. Force-edit changes nothing else in the state model - edits set the existing
dirty bit, BASE never moves (no acquire), and reconnect runs the SAME acquire+fence
as Start-editing (it folds into `speleodb_start_editing`, no new verb).

The opt-in is `SpeleoDbConfig.allow_force_edit` (default false); without it the
"Edit without the write lock" affordance stays hidden and `speleodb_force_edit` refuses.

Offline coverage is the pure-state seam (no network): `speleodb_force_edit` flips
both gates only when opted-in + remote + read-only; with `force_editing` set,
`speleodb_held_lock_release_params` returns `None` (close/exit/switch never release
a non-existent lock), `speleodb_verify_lock_if_expired` is a no-op (#202 exempt),
`speleodb_done`/`speleodb_push_only` return the coded reconnect error, and
`speleodb_logout` drops both gates without a release. FE coverage: the confirm
dialog, banner + Reconnect, the settings toggle, and the menu gating each have a
Vitest test. The reconnect handshake needs a live box, so verify manually:

1. Settings → enable "Allow editing without the write lock"; open a remote project
   (opens read-only).
2. Menu (or the status button) → "Edit without the write lock" → confirm the big-red dialog →
   the persistent red banner appears and the survey becomes editable; make an edit.
3. DB-inspect the cached `.stalx`: `speleo_link.base_commit_sha` is **unchanged**
   (no acquire) and `has_unpushed_edits = 1`.
4. Confirm the #202 re-verify never fires while force-editing (no 20-min lock check).
5. Close + reopen → opens read-only again (force-edit is transient; the edits
   persist via the `.stalx` + dirty bit - re-enter force-edit to continue).
6. Reconnect (the banner action, = Start-editing) while the server is unchanged →
   UpToDate → normal lock-held editing (banner clears, Done available).
7. Reconnect while another account holds the lock → 400 → "locked by {holder}", and
   the force-edit banner persists (keep editing offline).
8. Reconnect after the server tip moved with local edits → the divergence prompt.
9. Opt-out account: no "Edit without the write lock" affordance; only read-only + the existing
   "Save a local copy" detach.
