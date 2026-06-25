# SpeleoDB dev/integration testing

How the SpeleoDB client (`src-tauri/src/speleodb/`) is tested against a **real**
SpeleoDB server, and how to design future multi-account / permission /
collaboration tests against the dev box.

The SpeleoDB server source lives at `~/src/cave/SpeleoDB` — the API contract notes
below were verified against it, not against the (sometimes stale) GitHub issue text.

## The dev box

A throwaway SpeleoDB instance on the lab network. Connection details live in the
**gitignored** `.env` at the repo root (never committed):

| Env var | Meaning |
|---------|---------|
| `DEV_SPELEODB_URL` | Base URL of the dev box (e.g. `http://10.10.0.220:8000/`). The client appends the `/api/v2/...` paths. |
| `DEV_SPELEODB_EMAIL` | Login email for the primary (superuser) test account. |
| `DEV_SPELEODB_PASSWORD` | Login password for the primary test account. |
| `DEV_SPELEODB_EMAIL2` | Login email for a **second**, email-verified collaborator (for the two-account tests). Optional — those tests skip if unset. |
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

Provisioning caveat — **email verification is mandatory**. The server sets
`ACCOUNT_EMAIL_VERIFICATION = "mandatory"` (`config/settings/base.py`), and the
auth-token endpoint rejects accounts whose email is unverified. So a plain
allauth headless self-signup (the headless routes are mounted under
`/api/v2/auth/`) yields an account that **cannot** obtain a token until its email
is verified. To mint a usable test
account, the superuser must create it *and mark its email verified* — via the
Django admin (`/admin/`), a `manage.py shell` snippet, or a management command —
rather than relying on the self-signup flow alone.

Server-side cleanup tooling that exists for tests (run on the box, not from here):
`manage.py wipe_test_user_projects` and `manage.py wipe_test_gitlab`.

### The second account (for multi-user tests)

Some live tests need **two** identities — a project owner and a collaborator — to
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
has `user2` hold the mutex — then deletes the project on the way out. They **skip
cleanly** when `DEV_SPELEODB_EMAIL2`/`_PASSWORD2` are absent, so a box without the
second account still runs the single-account suite.

## Test layers

The client follows a two-layer convention (see the plan for #183 and the epic #182):

1. **Always-run unit tests** — pure functions, no network. `dump::classify`, DTO
   parsing, Bearer/URL construction, the in-memory `TokenStore` fallback. These run
   in normal `cargo test` and in CI.
2. **Env-gated live tests** — real HTTP against the dev box. Marked `#[ignore]` so
   they never run in normal `cargo test` or CI, and they early-return (skip) if the
   `DEV_SPELEODB_*` env vars are absent. They live in the `live_tests` module of
   `src-tauri/src/speleodb/mod.rs`.

### Self-seeding, self-cleaning (no shared fixtures)

The live round-trip owns all of its own state — there is **no** pre-seeded
`DEV_SPELEODB_PROJECT_ID` to keep alive:

- Each run **creates a throwaway project** with a UUID-suffixed name
  (`stalagmight-spike-<uuid>`) via `client::create_project`.
- A `ProjectCleanup` guard (`Drop`) **soft-deletes** that project on the way out —
  even if an assertion panics partway through — so runs don't leak projects.
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

- `--ignored` is required — the live tests are `#[ignore]`d by default.
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
- **`permission` is a STRING label** — `"WEB_VIEWER" | "READ_ONLY" |
  "READ_AND_WRITE" | "ADMIN"` — and the field is **absent** (not null) when the user
  has no permission. (Issues #188/#203 say "parse the integer" — wrong.)
- **Project `type`** is a string enum: `ariane | compass | stickmaps | therion |
  walls | other`.
- **The `.stalx` lands at `misc/project.stalx`** in the dump ZIP. Locate it by the
  `.stalx` **suffix**, never the hard-coded `misc/` path (survives a server
  `TARGET_FOLDER` change).
- **Upload requires the mutex** — `PUT /projects/{id}/upload/auto/` is gated by
  `UserOwnsProjectMutex`, so seed via `acquire_lock` first, then `release_lock`.
