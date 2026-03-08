# Telemetry

Anonymous, session-level usage telemetry. Opt-in only, no PII.

## Architecture

```
User action → telemetry.ts (batch counts) → IPC → Rust TelemetryCollector
                                                         │
                                          ┌──────────────┴──────────────┐
                                          ▼                             ▼
                                   HTTP POST to                  Buffer to disk
                                   telemetry server              (retry next flush)
```

**Frontend** (`src/utils/telemetry.ts`): Batches event counts in memory, flushes
to Rust every 60 seconds.

**Backend** (`src-tauri/src/telemetry.rs`): Aggregates counts per session, flushes
to `https://TELEMETRY_ENDPOINT/v1/events` every 5 minutes. Buffers to
`~/.local/share/stalagmight/Stalagmight/telemetry-buffer/*.json` when offline.

**Feature-gated**: All Rust telemetry is behind `#[cfg(feature = "telemetry")]`.
When disabled, all methods are zero-cost no-ops eliminated by the compiler.
The frontend self-gates by calling `is_telemetry_available` at startup.

**Opt-in**: Controlled by `general.telemetry_enabled` in config. Users are
prompted on first launch via `TelemetryOptInDialog`.

## Payload

### v2 — Packed MsgPack (current wire format)

Sent with `Content-Type: application/msgpack`. Event keys are replaced with
numeric IDs from a shared registry, session ID is 16 raw bytes, and the whole
payload is msgpack-encoded.

```
{
  v: 2,                          // version
  a: "0.8.0",                   // app_version
  o: "linux",                   // os
  s: <16 bytes>,                // session_id (binary UUID)
  d: 3600,                      // duration_secs
  p: 1,                         // project_seq
  e: [16, 1, 42, 95, 1, 10],   // flat [event_id, source_id, count, ...]
  x: { "display-state.showGrid:true": 1 }  // overflow (unregistered keys)
}
```

The `e` array is a flat sequence of `(event_id, source_id, count)` triples.
IDs are defined in `src-tauri/src/telemetry/registry.rs` (Rust) and
`telemetry-worker/src/registry.ts` (worker). Source ID 0 means no source
suffix; known sources (keyboard, toolbar, etc.) map to IDs 1-13.

Events not found in the registry go into the `x` overflow map with their
original string keys — no data is ever lost.

### v1 — JSON (disk buffer / legacy)

Used for on-disk buffering and backward compatibility. Sent with
`Content-Type: application/json`.

```json
{
  "v": 1,
  "app_version": "0.8.0",
  "os": "linux",
  "session_id": "a1b2c3d4-...",
  "duration_secs": 3600,
  "project_seq": 1,
  "events": {
    "command.create_shot": 42,
    "action.tool.draw:keyboard": 10,
    "dialog-cancel.import": 2
  }
}
```

Buffered v1 payloads are automatically converted to v2 packed format when
retried via `send_buffered()`.

### Registry files

| File | Role |
|------|------|
| `src-tauri/src/telemetry/registry.rs` | Rust: event/source name → numeric ID |
| `telemetry-worker/src/registry.ts` | Worker: numeric ID → event/source name |

Both files must stay in sync. See [Registry ID Stability](#registry-id-stability)
below for the append-only policy and how to add new entries.

**`project_seq`** — auto-incrementing project context counter. `0` means global
view (no project open) or Rust-originated events. Each time the user opens a
project (`setView('single')`), the sequence increments. A single flush never
mixes events from different project contexts — the frontend force-flushes
pending events before advancing the counter.

No file paths, project names, survey data, coordinates, or user identity.

## Event Reference

### Commands — `command.<name>` / `command.<name>:<source>`

Every IPC call (except telemetry's own) is tracked via `trackCommand`. When
a source hint is set (e.g., `keyboard`, `toolbar`), it's appended after `:`.

```
command.undo:keyboard       — undo triggered by keyboard shortcut
command.save_project        — save with no known source
command.create_shot:toolbar — shot created from toolbar action
```

**Excluded from tracking**: `track_events`, `flush_telemetry`,
`is_telemetry_available`, `set_telemetry_enabled`.

### Actions — `action.<name>:<source>`

UI-only events tracked via `trackAction`. Always include a source.

| Category | Events | Sources |
|----------|--------|---------|
| Tool switches | `tool.select`, `tool.draw`, `tool.merge`, ... | `keyboard`, `toolbar` |
| Navigation | `nav.zoom`, `nav.pan`, `nav.fit-to-bounds`, `nav.zoom-to-section`, ... | `mouse`, `touch`, `keyboard`, `dblclick` |
| Display toggles | `toggle.showStations`, `toggle.showGrid`, ... | `display-menu` |
| Selection | `select.station`, `select.shot`, `select.section` | `map`, `data-table`, `sections-panel`, `detail-panel` |
| Multi-select | `select-add.station`, `select-add.shot` | `map`, `data-table` |
| Dialogs | `dialog.import`, `dialog.settings`, ... | `unknown`, `context-menu` |
| Panel toggles | `panel-open.sections`, `panel-close.detail`, `panel-open.data-table` | `keyboard`, `unknown` (= collapse button) |
| Context menu | `unmerge`, `remove-closure`, `toggle-reference` | `context-menu`, `detail-panel` |

### Dialog Cancellations — `dialog-cancel.<name>`

Emitted when a dialog closes without its success path calling
`trackDialogComplete()`. Tracks user abandonment rate per dialog.

```
dialog-cancel.import        — user opened import dialog then cancelled
dialog-cancel.merge         — user cancelled merge dialog
```

**Completion-flag pattern**: Success handlers call `trackDialogComplete(name)`
before `closeDialog()`. Then `closeDialog()` checks the flag — if unset, emits
the cancel event. Dialog chaining (dialog A opens dialog B) is handled
automatically — the previous dialog is marked as completed.

### Undo Regret — `undo-after.<command>`

When the user undoes within 15 seconds of an undoable command, the pair is
recorded. High `undo-after.X` rates relative to `command.X` signal that
operation X frequently produces unwanted results.

```
undo-after.merge_stations   — user merged then immediately undid
undo-after.delete_shot      — user deleted then immediately undid
```

### Display Steady-State — `display-state.<key>:<value>`

Emitted once at project load for each display toggle that differs from
`DISPLAY_DEFAULTS`. Answers "which defaults do users override most?"

```
display-state.showGrid:true          — user has grid on (default: off)
display-state.showStationLabels:true — user has labels on (default: off)
display-state.gridSpacing:5          — user changed spacing from default 10
```

New projects with default settings emit nothing.

### Workflow Dwell Time — `dwell.<state>`

Tracks cumulative seconds spent in each workflow state per session. States are
mutually exclusive — switching to a new state flushes the accumulated time on
the previous one.

```
dwell.tool.select              — seconds with Select tool active
dwell.tool.draw                — seconds with Draw tool active
dwell.dialog.settings          — seconds in Settings dialog
dwell.dialog.import            — seconds in Import dialog
dwell.placement                — seconds in placement mode
dwell.global-view              — seconds on the Welcome/project-list screen
```

**Integration points** (all in `uiStore.ts`):

| Trigger | Dwell key |
|---------|-----------|
| `setView('single-system')` | `tool.{activeTool}` |
| `setView('global')` | `global-view` |
| `setActiveTool(tool)` | `tool.{tool}` (skipped when dialog/placement active) |
| `openDialog(name)` | `dialog.{name}` |
| `closeDialog()` | Resumes `placement` or `tool.{activeTool}` |
| `startPlacementMode()` | `placement` |
| `cancelPlacementMode()` / `confirmPlacement()` | `tool.{activeTool}` |

**Flush on close**: `flushTelemetry()` calls `flushDwell()` to capture the
final state's accumulated time before sending.

**Same-key no-op**: Calling `setDwellState` with the same key is a no-op —
prevents timer resets from redundant calls.

## Key Files

| File | Role |
|------|------|
| `src/utils/telemetry.ts` | Frontend batching, source hints, dialog/display tracking |
| `src/utils/ipc.ts` | Calls `trackCommand` for every IPC invocation |
| `src/store/uiStore.ts` | Wires tracking into `closeDialog`, `openDialog`, `setSelection`, `addToSelection`, panel toggles, display settings |
| `src-tauri/src/telemetry/mod.rs` | Rust collector, HTTP send, disk buffer, periodic flush |
| `src-tauri/src/telemetry/registry.rs` | Event/source string ↔ numeric ID registry |
| `src-tauri/src/commands/telemetry.rs` | IPC commands: `track_events`, `flush_telemetry`, etc. |
| `telemetry-worker/src/registry.ts` | Worker-side reverse lookup arrays (ID → string) |
| `src/store/displaySelectors.ts` | `DISPLAY_DEFAULTS` — single source of truth for default values |

## Source Tracking

The `setSource(name)` / `consumeSource()` pattern provides attribution for
where an action originated. Source is a global singleton — set before an action,
consumed by the first `trackAction` or `trackCommand` that fires.

Auto-resets after 50ms to prevent bleed to unrelated actions.

| Source | Meaning |
|--------|---------|
| `keyboard` | Keyboard shortcut (set in `useKeyboardShortcuts`) |
| `toolbar` | Toolbar button click |
| `map` | Map canvas interaction |
| `data-table` | Data table row/cell click |
| `sections-panel` | Sections panel click |
| `detail-panel` | Detail panel link/button |
| `display-menu` | Display toggle menu |
| `context-menu` | Right-click context menu action |
| `dialog` | Dialog-initiated (dialog chaining) |
| `unknown` | No source set (default) |

### Caveat: single consumption

Source is consumed by whichever `trackAction` or `trackCommand` fires first. If
a single handler triggers both (e.g., selection + IPC), only the first gets the
source. In practice, current code paths don't mix these in the same synchronous
call, but be aware of this when adding new handlers.

## Suppression

`withTrackingSuppressed(fn)` runs `fn` with all `trackAction` calls suppressed.
Used for programmatic UI changes that shouldn't appear as user actions (e.g.,
onboarding auto-opening panels).

```typescript
import { withTrackingSuppressed } from '../../utils/telemetry';

// Onboarding opens the sections panel — not a user action
withTrackingSuppressed(() => toggleSectionsPanel());
```

## Registry ID Stability

Event and source IDs are positional — the index in the `EVENT_NAMES` /
`SOURCE_NAMES` arrays is the numeric ID sent on the wire. Older desktop clients
that haven't updated continue sending the IDs they were compiled with, so
**existing IDs must never change**.

### Append-only policy (tied to `v`)

The packed payload version (`v: 2`) implicitly defines a frozen registry
baseline. For v2, the first 286 event entries and 14 source entries are locked.
New entries must be appended after the `// ── Appended after v2 baseline ──`
comment in both `registry.rs` and `registry.ts`.

A compile-time test (`registry_id_stability`) enforces this by hashing the
frozen portion and failing if any entry is modified, inserted, or removed.

### What is safe

| Operation | Safe? | Reason |
|-----------|-------|--------|
| Append new entry at end | Yes | Existing IDs unchanged |
| Change a string value | **No** | Hash changes, test fails |
| Insert mid-array | **No** | Shifts all subsequent IDs |
| Remove an entry | **No** | Shifts all subsequent IDs |
| Reorder entries | **No** | Changes ID ↔ name mapping |

### Adding a new registry entry

1. Append the entry at the end of `EVENT_NAMES` in `registry.rs` (after the
   `// ── Appended after v2 baseline ──` comment).
2. Append the same entry at the same position in `registry.ts`.
3. Update `event_count` test if needed.
4. Run `cargo test --manifest-path src-tauri/Cargo.toml --features telemetry -- registry::tests`
   to verify all checks pass.

### Registry reorganization (version bump)

When the append-at-end approach becomes unwieldy (e.g., after many additions),
you can reorganize the arrays by bumping the payload version:

1. Increment `PACKED_PAYLOAD_VERSION` in `telemetry/mod.rs` (e.g., 2 → 3).
2. Reorganize `EVENT_NAMES` / `SOURCE_NAMES` freely (sort, remove stale
   entries, etc.).
3. Update `V2_FROZEN_EVENTS`, `V2_FROZEN_SOURCES`, and both FNV hashes in the
   `registry_id_stability` test to reflect the new baseline (rename to V3).
4. In the Cloudflare Worker, keep the v2 lookup table alongside the new v3
   table so payloads from older clients still decode correctly.
5. After enough time has passed for most users to upgrade, drop the v2 table.

### Automated tests

| Test | What it checks |
|------|----------------|
| `registry_id_stability` | FNV-1a hash of frozen entries — catches insertions, removals, renames |
| `registry_covers_all_commands` | Every `generate_handler![]` command has a `command.*` entry (and vice versa) |
| `rust_ts_registry_in_sync` | Rust and TypeScript registries are identical element-by-element |
| `no_duplicate_event_names` | No duplicate strings in `EVENT_NAMES` |
| `event_count` / `source_count` | Array lengths match expected totals |

## Adding Telemetry to New Features

### New dialog

1. Add `trackDialogComplete('my-dialog')` before every success-path
   `closeDialog()` call.
2. Cancel/dismiss paths need no changes — `closeDialog()` auto-detects.
3. For informational dialogs (no meaningful cancel), add
   `trackDialogComplete` before every close path.

### New IPC command

Automatic — `invokeIpc` calls `trackCommand` for all non-telemetry commands.
If the command is undoable, add it to `UNDOABLE_COMMANDS` in `telemetry.ts`.

You must also add a `command.<name>` entry to both registries — append it at the
end (see [Registry ID Stability](#registry-id-stability)). The
`registry_covers_all_commands` test will fail if you forget.

### New selection source

Call `setSource('my-panel')` before `setSelection()` or `addToSelection()`.

### New keyboard shortcut

If added to `useKeyboardShortcuts`, source is automatic (set at handler entry).
For keyboard handlers elsewhere, call `setSource('keyboard')` before the action.

### New panel toggle

Track in the toggle function with `trackAction('panel-open.name')` /
`trackAction('panel-close.name')`. See existing panel toggles in `uiStore.ts`.
