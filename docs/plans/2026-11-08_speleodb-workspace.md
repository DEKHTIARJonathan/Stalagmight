# SpeleoDB project workspace

The project editor has one left dock. Linked projects expose Sections and
SpeleoDB tabs in Survey; Plan and Export expose SpeleoDB on request. Opening a
project selects Sections. Tab navigation never changes lock ownership.

## Action inventory and destinations

| Existing action | Destination |
| --- | --- |
| Status icon and its menu | Logo + SpeleoDB toolbar button, workspace |
| Upload, release/resume, refresh, web link | Persistent everyday controls |
| Revision history, inspect, restore, revert, unwind/rewind | History accordion |
| Remote metadata, rendering, undo policy, lock recovery | Project settings accordion |
| Open remote project, refresh/search, create project | Projects accordion |
| Sign in/out, server and connection preferences | Account & connection accordion |
| Remote actions in hamburger, Project Details, undo menu | Workspace navigation |
| Home sign-in, browsing, creation, local publishing | Retained on Home |
| Explicit Save and keyboard Save | Shared local-save/remote-upload dispatcher |
| Autosave and autosave retry | Local save only |

## State matrix

| State | Navigation | Local mutations | Upload |
| --- | --- | --- | --- |
| Local project | Sections in Survey | Survey only | Local Save |
| Linked, acquired lock | All modes | Survey only | Verify ownership, require description |
| Linked, read-only or another editor | All modes | Blocked | Explain missing lock |
| Open offline | All modes | Blocked | Connection error |
| Transient offline after acquisition | All modes | Survey only | Connection error |
| Signed out, permission lost, confirmed lock loss | All modes | Blocked immediately | Recovery first, confirm afterward |
| Busy | Navigation available | Operation gate applies | Disabled during operation |
| Already uploaded | All modes | According to lock | No changes to upload |

Save and Close closes only after a confirmed upload and successful release, with
no newer changes. Cancel, conflict, uncertain response and release failure leave
the project open. Ordinary upload retains the lock. Plain Close, switch and Quit
retain automatic release and Discard changes / Cancel protection.

## Sidebar wireframe

```text
+--------------------------------+
| Sections | SpeleoDB             |
| Project name                   |
| Editing/read-only, owner, online|
| Upload changes                 |
| Release lock / Resume editing  |
| Get latest | Open on SpeleoDB   |
| > History                      |
| > Project settings             |
| > Projects                     |
| > Account & connection         |
+--------------------------------+
```

One accordion opens at a time. Collapsing or hiding content preserves its drafts
and scroll position. Project/account replacement protects drafts independently
of validity. Requests are bound to project identity and session generation.
Programmatic navigation focuses the selected tab without changing the saved
pin/hover preference. SpeleoDB needs 320px within the existing 400px maximum;
constrained layouts use the existing overlay dock.

## Verification record

Implementation and acceptance results are recorded here as work completes.
Only synthetic data may be committed. Live acceptance requires controlled test
projects and an available authenticated real-app session.
