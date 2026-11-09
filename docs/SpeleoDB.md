# SpeleoDB integration and native-file contract

Stalagmight uses the published `speleodb-api` crate. The dependency version and
registry checksum are authoritative in `src-tauri/Cargo.toml` and `Cargo.lock`.
The desktop application's Cargo workspace is standalone, including when the
checkout is located below another repository.

## Boundaries

The `stalagmight-speleodb` crate adapts generated SDK responses to the application's
small project, revision and error projections. All SpeleoDB HTTP operations go
through that SDK. A shared Tokio runtime bridges the async SDK to the existing
blocking command boundary; frontend IPC and the core sync engine stay synchronous.
Core orchestration still owns cache paths, credentials, project identity, local
edit protection, lock ownership, revision ancestry and undo policy.

The frontend lists only `STALAGMIGHT` projects. It displays project name, SpeleoDB
identity, permission and lock owner. A lock held by the signed-in account is labeled
as yours, independently of whether editing is enabled yet, and opening requires no
additional same-account session check or warning. A read-only SQLite metadata
preflight checks access before replacing the open project, including cold recents,
file-picker, drag/drop and OS file opens. Opening automatically attempts to acquire
the server mutex and reconcile the local base. Only successful
acquisition/reconciliation enables editing. A lock held by another account keeps
the project read-only and the contention dialog identifies its current editor. Offline opening
stays read-only; a transient connection failure after acquisition permits local
editing. Confirmed lock loss, sign-out or permission loss closes the editing gate.

The home screen uses the same card or table row for downloaded and undownloaded
SpeleoDB projects. Selecting one never exposes local Project Details, local open,
or local deletion actions. Opening always attempts a fresh download. Only a DNS,
connection-unavailable or timeout failure allows opening an existing cache, whose
stored project ID and endpoint must match. The UI announces that offline fallback
and preserves the cached unsynced-edit state. Authentication, permission, missing
remote project, TLS and invalid-download errors do not fall back to the cache.
If a successful download would overwrite unsynced edits, the user can cancel or
explicitly confirm replacing them; the prompt offers no online local-copy shortcut.

Collaborator/team management and remote project deletion are absent. Local file
management, local imports and local exports remain separate application features.

## Operations used by the app

All paths below are relative to `/api/v2/`.

| Method | Path | Use |
| --- | --- | --- |
| POST | `user/auth-token/` | Exchange email/password for a token |
| GET | `user/` | Validate pasted tokens and resolve their account email |
| GET | `projects/` | List accessible native projects and lock states |
| GET | `projects/{id}/` | Metadata, permission, mutex and short lock probes |
| POST | `projects/` | Create a private/public project from publish metadata |
| PATCH | `projects/{id}/` | Internal managed-type updates and publishing compatibility |
| GET | `projects/{id}/revisions/` | Revision history and ancestry checks |
| POST | `projects/{id}/acquire/` | Acquire the write lock |
| POST | `projects/{id}/release/` | Release the individual project lock |
| PUT | `projects/{id}/upload/stalagmight/` | Upload one native SQLite project |
| GET | `projects/{id}/download/stalagmight/` | Download the native project at HEAD |
| GET | `projects/{id}/download/stalagmight/{hexsha}/` | Download a pinned native revision |

The request and response schemas come from the SDK. Project permissions are
`WEB_VIEWER`, `READ_ONLY`, `READ_AND_WRITE` and `ADMIN`; absent permissions do not
grant access. Lock ownership comes from `active_mutex`, independently of permission.
A narrow profile compatibility case accepts the email from a successful response
with an empty country: existing accounts can have no country, while the SDK country
enum requires a country code. Non-success responses and other malformed profiles
still fail authentication.

Project-list decoding alone tolerates future enum values: unknown types are omitted
from the native browser, unknown permissions grant nothing, and unknown optional
metadata does not invalidate other entries. Required IDs/names/structure, HTTP errors,
invalid JSON and all mutation responses remain strict.

The SDK is `AGPL-3.0-only`; first-party code remains `AGPL-3.0-or-later`. Version 3
is available under the app's grant, so the combined distribution uses AGPL version 3.
This does not grant later-version rights for the SDK or combined distribution.
SDK attribution remains in `THIRD-PARTY-LICENSES.md`; neither project is relicensed.

## Native file transfer

`project.stalx` is a SQLite database. Upload sends one multipart `artifact` with
that filename and `application/vnd.sqlite3`, plus a `message`. Download returns
the raw SQLite file. There is no archive extraction, candidate selection, companion
Ariane upload, or remote Ariane conversion. The server may use a different stored
filename; callers identify the artifact through the dedicated format endpoint.

Before uploading, core saves the live database, creates its existing consistent
snapshot, and sanitizes local state according to the project's undo policy. The
snapshot remains independent of subsequent local edits. The authoritative upload
result is its top-level `hexsha`; an HTTP 304 remains the existing no-change outcome.
An uncertain upload does not clear dirty state or automatically release the lock.

Downloads stream to an owned temporary file, with a 512 MiB limit. The cache
installer and downloaded-revision policy probes open private copies through
`open_existing_untrusted`, with a 64 MiB SQLite value limit and a 30-second
processing deadline. The installer checks the schema, stages the replacement,
strips inherited undo unless an explicit Unwind requires it, and preserves local
display preferences.
The downloaded copy receives its validated SpeleoDB link before replacement. A
failed download, validation, link write or staged-file synchronization leaves the
existing cache intact. Finished staging files are synchronized before atomic rename;
the parent directory is synchronized where supported. Ordinary pulls capture backend
session ownership before downloading, then check it under the project lock before
replacement. Native load cancellation invalidates old downloads even if the newer
open fails; pending native readers also exclude replacement. Replacements
refuse to overwrite unuploaded edits unless the user explicitly confirms discard.
When a revision is known, the download is pinned to that SHA; an undated HEAD
download cannot be stamped with a stale project-list hint.

## Authentication and transport

Email/password login exchanges the supplied credentials for a token; pasted-token
login validates the token by reading its profile. Live tests validate the profile
for both authentication paths. Saved tokens are managed by the backend and do not
cross the frontend as profile data. Session generations
and per-account lock claims continue to guard late responses and account changes.

The existing HTTP policy permits loopback/private deployments and requires HTTPS
elsewhere unless explicitly configured otherwise. Redirects and implicit Reqwest
retries are disabled. Safe reads and token exchange retry transient transport/5xx
failures twice, after 200 ms and 500 ms. Mutations are never automatically replayed.
Metadata requests use 30 seconds and lock probes five seconds with no retries.
Downloads have a 30-second connection limit and a 120-second read inactivity limit,
with no total transfer deadline. Buffered multipart uploads have a size-aware total
budget of 120 seconds plus transfer time at 16 KiB/s. Response-read timeouts are not
upload-progress timeouts. JSON responses are capped at 10 MiB. Production settings
do not read the live-test environment variables.

HTTP statuses retain their existing typed frontend actions: re-login on an expired
session, read/fence handling for permissions, retryable read errors, and dirty-state
retention for failed writes. Error text is for display; it does not determine sync
or ownership decisions. Diagnostic transport errors omit request URLs.

## Project workspace

The full **SpeleoDB logo + SpeleoDB** toolbar button opens the left dock for local and managed
projects, including signed-out and read-only projects. Survey starts on Sections;
Sections and SpeleoDB use accessible tabs with arrow-key navigation. Plan and Export
retain SpeleoDB on request, and returning to Survey restores its previous tab.
Opening SpeleoDB from the fullscreen table exits fullscreen without clearing table
selection or scroll. Navigation never acquires or releases a lock.

For managed projects, the persistent header shows identity, editing access, lock owner and
connection status. Everyday controls are Save Changes, Switch to Read Only Mode or
Resume editing, Reload Project and Open on SpeleoDB. History is the only expandable section. Close Project sits below Reload Project,
warns about unsaved work, releases the editing lock on confirmed close and returns
to the project listing. History includes inspection, restore/revert and
Unwind/Rewind; revision editing remains Survey-only.

Account sign-in, endpoint and connection management live exclusively in application
Settings under SpeleoDB. Every sign-in link opens that category. A blocked save
retains its project, validated description and Save-and-Close intent while Settings
is open. Authentication returns to confirmation without saving or uploading.
Changing project or account invalidates the continuation.

Local settings retains project validation and elevation settings. Linked names are
server-managed and cannot be renamed through local-settings IPC. There are no
remote metadata, rendering, per-project undo-policy or administrative lock-recovery
controls. Existing persisted undo-policy values remain respected. Creation and
publishing retain their initial metadata inputs.

The left dock reuses Sections' saved width and pin/hover preferences. SpeleoDB has
a 320px minimum and a 400px maximum; constrained layouts float the dock over the
map. Programmatic opening focuses the selected tab without changing the saved
pin/hover preference. Keyboard focus inside keeps a floating dock accessible.
Tabs, collapsed sections and hidden docks preserve history state.
Navigation never submits changes. Local settings remains available from the menu;
Home retains local-project rename.

Project-editor SpeleoDB menus and the old settings dialog are replaced by this
workspace. Home retains sign-in, browsing, creation and local-project publishing.
Local projects expose the SpeleoDB tab with one centered conversion action and a
short explanation focused on version history and team collaboration. Conversion
opens the existing project creation form. Account forms remain in application
Settings; returning from sign-in restores the creation draft without submitting it.
Publishing shows a centered, app-blocking progress overlay through completion.
The overlay expires after 120 seconds with a timeout explanation and an enabled
Close action; an in-flight request cannot be submitted again. Account/project
changes and newer edits still invalidate stale results.
On confirmation, the project is saved and its first revision uploaded, then a fresh
server copy is downloaded and opened as a managed project. Editing is acquired once
through the shared verified acquisition flow. Unconfirmed uploads preserve the
linked working copy for Save Changes; failed downloads preserve the remote identity
and offer Reload Project. Retrying recovery never creates a second server project.

## Save, switching and exit

Menu Save, Cmd/Ctrl+S and Save Changes share one dispatcher. Local projects retain
local Save. Linked projects open the upload dialog, including a blocked explanation
when the editing lock is missing. Sign-in and Resume editing recover access without
uploading automatically; the user confirms the upload afterward. A clean linked
project reports No changes to upload, without creating an empty revision.

Uploading requires a nonblank change description, saves locally first, and verifies
current permission and lock ownership against the server. Ordinary successful upload
retains the lock. The same centered progress surface blocks the app during explicit
uploads from Save Changes, menu Save and Cmd/Ctrl+S. It expires after 120 seconds,
allows closing the dialog, and preserves the description without resubmitting.
Offline, failed or uncertain uploads never report success; the
message and local work remain available for retry. Autosave and failed-autosave
retry write only to the local SQLite file.

Save and Close carries its close intent through recovery and closes only after a
confirmed upload and successful release, with no newer local changes. Cancellation,
conflict, uncertainty and release failure leave the project open. Plain Close,
project switching and Quit automatically release the session's lock without
uploading. Unsaved survey work and form drafts require Discard changes / Cancel.
Saved unuploaded work remains in the local file. Backend release consent remains
scoped to the project, authenticated account and session generation. Another
account's lock is never released by an ordinary exit.

Switch to Read Only Mode refuses unsaved or unuploaded work, including direct IPC
calls: "Save your changes using Save Changes before switching to read-only mode."
It never discards or uploads. The clean check and the switch to read-only happen
together, serialized against mutations, before the release request is sent; edits
attempted while it is in flight are refused as read-only rather than waiting. A
failed release returns the same session to editing. Consent is bound to the
project, account, session and edit version.
Only the signed-in account's lock can be released. The server has no atomic
compare-and-release operation; changes between the ownership probe and release
remain a protocol limitation. Offline release failures leave the project open.

Reload Project verifies live revision history without acquiring a lock. Pending
work requires Discard changes / Cancel, explaining that saving first preserves it.
Discard removes unsaved and unuploaded modifications. Historical checkouts and
explicit discard return to the server version even if BASE already equals the tip.
Equal clean revisions need no download. Reload preserves the existing editing mode;
a failed download or validation preserves the current tree and pending work.

Opening, Resume editing, held-lock resume and authentication recovery requesting
editing all use Start Editing. It acquires or confirms the lock, fetches fresh
revision history, resolves the tip from parent topology and reconciles BASE. Only
verified newer descendants are downloaded, by exact revision. Cached listing
metadata cannot prove freshness. Ambiguous history and unavailable verification
cannot open the editing gate. Status refresh may close editing on confirmed lock
or permission loss, but never enables editing. An already acquired session may
continue local editing through transient disconnection. Offline opening remains
read-only. In-place frontend reconciliation suppresses automatic acquisition.

An unreachable server or forcibly terminated process cannot guarantee server-side
release. Close, Quit and Save-and-Close retain their separate lifecycle behavior.

## Network activity and responsiveness

Tauri runs synchronous commands on the main thread, so a SpeleoDB network wait
inside one freezes the whole window. The SpeleoDB commands, the Settings save and
reload, and project deletion run their work off the main thread. Panel, column and gas settings writes never wait on SpeleoDB: only a
settings change that moves to another SpeleoDB instance joins the queue of lock
operations, and its lock release is sent after the settings lock is let go. While
an edit session is active, the lock check that runs at most every 20 minutes
happens in the background; if it finds the lock gone, the next edit is refused
and routed to the conflict prompt.

While any SpeleoDB network call is in flight, a small spinner beside the SpeleoDB
tab label says "Talking to SpeleoDB..."; it overlays the tab and never changes its
size. While a lock, upload, download or account call runs, the controls that would
start another one are disabled: the workspace's Save Changes, Resume editing /
Switch to Read Only Mode, Reload Project, Close Project and conversion, History's
Unwind/Rewind, revision View/Restore/Revert, opening from SpeleoDB, the held-lock
prompt's Resume and Release, publishing, and the SpeleoDB endpoint, connection and
sign-in/sign-out controls in Settings. Reads such as the status refresh show the
spinner but lock nothing. The map, panels, other settings and editing stay
available. Explicit uploads and publishing keep their app-blocking progress.

## Verification

See [SpeleoDB testing](speleodb-dev-testing.md) for automatic `.env` loading, both
required authentication paths, synthetic native-file round trips, test-project
deletion and the offline/UI coverage matrix. Generated IPC types are regenerated
from Rust with `pnpm gen:ipc-types`; removed commands and their generated types must
also disappear from browser mocks and telemetry.

## Opening and closing request ownership

Project switches reserve a shared request generation before access metadata or
replacement queues are awaited. Newer preflight requests suppress older probes,
warnings and undispatched work, even if the newer warning is cancelled. A confirmed
operation that already dispatched backend work reconciles its result until a newer
mutation begins. Thus cancelling a newer warning cannot leave a completed native
load hidden behind an indefinite loading overlay. Same-path opens share execution
only while current; A-B-A selects the final A. Tree replacement retains its ordering
contract while independent access probes can proceed concurrently.
Remote opens carry ownership through warning, download and file load. A newer
confirmed native transition, successful login, rejected authentication, or newer
download reservation invalidates the backend download's cache-write authority
as well as its frontend continuation, so a late pull cannot close the newer cache.
Create-project operations distinguish preflight cancellation from dispatched-work
reconciliation in the same way.

The close dialog becomes busy before probing its destination and stays busy through
saving, upload/release, and hand-back. Dismissal and editable choices are disabled;
duplicate activation is ignored synchronously. Escape from outside the dialog
routes through the visible dialog's dismissal guard as well. Cancelling the native
access warning restores the parent controls without saving, releasing, or closing. Replacing the
prompt, project, or authenticated session stops stale continuations. Ordinary saves
may refresh the project object without invalidating the operation. Routine session
status refreshes are also allowed; login/logout changes the session generation and
invalidates the operation. Older-version upload confirmation carries request/session
ownership with the pending exit and checks it before upload/release or hand-back,
while retaining its cancel-return flow.

Cancelling read-only or locked-project warnings in the browser or managed-file prompt
restores retry and dismissal without an error. A replaced managed-file prompt retains
ownership of its own controls. A superseded discard-and-open in the unpushed-local
prompt similarly restores retry and dismissal without resetting a replacement prompt's
operation.
