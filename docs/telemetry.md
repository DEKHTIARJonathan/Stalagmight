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
to `https://telemetry.stalagmight.com/v1/events` every 5 minutes. Buffers to
`~/.local/share/stalagmight/Stalagmight/telemetry-buffer/*.json` when offline.

**Feature-gated**: All Rust telemetry is behind `#[cfg(feature = "telemetry")]`.
When disabled, all methods are zero-cost no-ops eliminated by the compiler.
The frontend self-gates by calling `is_telemetry_available` at startup.

**Opt-in**: Controlled by `general.telemetry_enabled` in config. Users are
prompted on first launch via `TelemetryOptInDialog`.

## Payload

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
| `src-tauri/src/telemetry.rs` | Rust collector, HTTP send, disk buffer, periodic flush |
| `src-tauri/src/commands/telemetry.rs` | IPC commands: `track_events`, `flush_telemetry`, etc. |
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

### New selection source

Call `setSource('my-panel')` before `setSelection()` or `addToSelection()`.

### New keyboard shortcut

If added to `useKeyboardShortcuts`, source is automatic (set at handler entry).
For keyboard handlers elsewhere, call `setSource('keyboard')` before the action.

### New panel toggle

Track in the toggle function with `trackAction('panel-open.name')` /
`trackAction('panel-close.name')`. See existing panel toggles in `uiStore.ts`.
