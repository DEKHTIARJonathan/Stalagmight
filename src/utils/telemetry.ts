/**
 * Anonymous telemetry — batches event counts in memory and periodically
 * flushes them to the Rust backend via IPC.
 *
 * Self-gating: if the `is_telemetry_available` command doesn't exist
 * (telemetry feature not compiled), all calls are no-ops.
 */

import { invoke } from '@tauri-apps/api/core';
import { DISPLAY_DEFAULTS } from '../store/displaySelectors';

/** How often (ms) to flush batched counts to Rust. */
const FLUSH_INTERVAL_MS = 60_000;

/** How often (ms) to flush dwell time to Rust so the backend's 10-min dwell-only flush works. */
const DWELL_FLUSH_INTERVAL_MS = 60_000;

/** In-memory event counters. */
const counts: Record<string, number> = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let dwellFlushInterval: ReturnType<typeof setInterval> | null = null;
let available: boolean | null = null;

/** Source hint for the next action — consumed by dispatchers. */
let _source = 'unknown';
let _sourceTimer: ReturnType<typeof setTimeout> | null = null;

/** Dialog completion flag — set before closeDialog() in success paths. */
let _dialogCompleted: string | null = null;

/** When true, trackAction/trackCommand calls are suppressed (for programmatic UI changes). */
let _silent = false;

/** Whether telemetry collection is enabled. Starts false; set by initTelemetry / setTelemetryEnabled. */
let _enabled = false;

/** Auto-incrementing project sequence (0 = global, 1 = first project opened, etc.). */
let _projectSeq = 0;

/** Current workflow state for dwell time tracking. */
let _dwellState: { key: string; since: number } | null = null;

/** Last undoable command — for regret detection. */
let _lastUndoable: { command: string; time: number } | null = null;
const REGRET_WINDOW_MS = 15_000;

/** Canonical navigation action names — parsed by registry exhaustiveness tests. */
export type NavigationAction =
  | 'center-on-shot'
  | 'center-on-station'
  | 'fit-to-bounds'
  | 'pan'
  | 'pan-to-shot'
  | 'zoom'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-to-section';

/** Canonical panel names — parsed by registry exhaustiveness tests. */
export type PanelName =
  | 'data-table'
  | 'detail'
  | 'sections';

/** Canonical selection types — parsed by registry exhaustiveness tests. */
export type SelectionType =
  | 'section'
  | 'shot'
  | 'station';

/** Canonical context-menu action names — parsed by registry exhaustiveness tests. */
export type ContextMenuAction =
  | 'remove-closure'
  | 'toggle-reference'
  | 'unmerge';

/** Canonical source names — parsed by registry exhaustiveness tests. */
export type SourceName =
  | 'context-menu'
  | 'data-table'
  | 'dblclick'
  | 'detail-panel'
  | 'dialog'
  | 'display-menu'
  | 'keyboard'
  | 'map'
  | 'mouse'
  | 'sections-panel'
  | 'toolbar'
  | 'touch';

/** Commands that push to the undo stack. */
const UNDOABLE_COMMANDS: ReadonlySet<string> = new Set([
  'create_section', 'update_section', 'delete_section', 'move_section', 'move_segment',
  'create_shot', 'update_shot', 'delete_shot', 'set_shot_reference',
  'merge_stations', 'unmerge_stations', 'unmerge_station_pair',
  'set_zero_datum', 'remove_zero_datum', 'set_station_comment', 'move_comment', 'move_station',
  'create_loop_closure', 'remove_loop_closure',
  'create_section_and_merge', 'delete_shot_and_split', 'delete_last_shot_and_section',
  'delete_shot_range_split', 'delete_shot_range_shift',
  'import_sections', 'execute_tml_import', 'execute_gpx_import', 'execute_batch',
]);

/**
 * Check if the telemetry feature is compiled into the Rust backend.
 * Cached after first call.
 */
async function checkAvailable(): Promise<boolean> {
  if (available !== null) return available;
  try {
    available = await invoke<boolean>('is_telemetry_available');
  } catch {
    available = false;
  }
  return available;
}

/** Flush batched counts to the Rust backend. */
async function flushToRust(): Promise<void> {
  flushTimer = null;

  const snapshot = { ...counts };
  // Clear immediately so new events during flush aren't lost
  for (const key of Object.keys(counts)) {
    delete counts[key];
  }

  const hasEvents = Object.keys(snapshot).length > 0;
  if (!hasEvents) return;

  try {
    await invoke('track_events', { events: snapshot, projectSeq: _projectSeq });
  } catch {
    // Restore counts if flush failed — they'll be retried next cycle
    for (const [key, value] of Object.entries(snapshot)) {
      counts[key] = (counts[key] || 0) + value;
    }
  }
}

/** Set source for the next action. Auto-resets after 50ms to prevent bleed. */
export function setSource(source: SourceName): void {
  _source = source;
  if (_sourceTimer) clearTimeout(_sourceTimer);
  _sourceTimer = setTimeout(() => { _source = 'unknown'; }, 50);
}

/** Read and reset the current source. */
export function consumeSource(): string {
  const s = _source;
  _source = 'unknown';
  if (_sourceTimer) { clearTimeout(_sourceTimer); _sourceTimer = null; }
  return s;
}

/** Run a callback with tracking suppressed (for programmatic UI changes like onboarding). */
export function withTrackingSuppressed(fn: () => void): void {
  _silent = true;
  try { fn(); } finally { _silent = false; }
}

/** Increment project sequence and force-flush pending events from previous project. */
export async function advanceProjectSeq(): Promise<void> {
  flushDwell();
  await flushToRust();
  _projectSeq++;
}

/**
 * Switch the dwell-time state. Flushes accumulated seconds on the previous
 * state and starts timing the new one. Passing the same key is a no-op.
 */
export function setDwellState(key: string): void {
  if (!_enabled) return;
  if (_dwellState && _dwellState.key === key) return;
  const now = Date.now();
  if (_dwellState) {
    const secs = Math.round((now - _dwellState.since) / 1000);
    if (secs > 0) {
      counts[`dwell.${_dwellState.key}`] = (counts[`dwell.${_dwellState.key}`] || 0) + secs;
    }
  }
  _dwellState = { key, since: now };
}

/** Flush the current dwell state's accumulated time (e.g., before app close). */
function flushDwell(): void {
  if (!_dwellState) return;
  const secs = Math.round((Date.now() - _dwellState.since) / 1000);
  if (secs > 0) {
    counts[`dwell.${_dwellState.key}`] = (counts[`dwell.${_dwellState.key}`] || 0) + secs;
  }
  _dwellState = { ..._dwellState, since: Date.now() };
}

/** Track a user action with source. */
export function trackAction(action: string, source?: string): void {
  if (!_enabled || _silent) return;
  const src = source ?? consumeSource();
  const key = `action.${action}:${src}`;
  counts[key] = (counts[key] || 0) + 1;
  scheduleFlush();
}

/** Track a navigation action. */
export function trackNav(nav: NavigationAction, source?: SourceName): void {
  trackAction(`nav.${nav}`, source);
}

/** Track a panel open/close toggle. */
export function trackPanelToggle(panel: PanelName, opening: boolean): void {
  trackAction(opening ? `panel-open.${panel}` : `panel-close.${panel}`);
}

/** Track a selection event. */
export function trackSelect(type: SelectionType): void {
  trackAction(`select.${type}`);
}

/** Track an add-to-selection event. */
export function trackSelectAdd(type: SelectionType): void {
  trackAction(`select-add.${type}`);
}

/** Track a context-menu action. */
export function trackContextMenuAction(action: ContextMenuAction, source?: SourceName): void {
  trackAction(action, source);
}

/**
 * Track an IPC command invocation.
 * Called from `invokeIpc` for every IPC call.
 * Includes source hint (keyboard, toolbar, etc.) when available.
 */
export function trackCommand(command: string): void {
  if (!_enabled) return;
  const src = consumeSource();
  const key = src !== 'unknown' ? `command.${command}:${src}` : `command.${command}`;
  counts[key] = (counts[key] || 0) + 1;

  if (command === 'undo' && _lastUndoable && (Date.now() - _lastUndoable.time) < REGRET_WINDOW_MS) {
    const key = `undo-after.${_lastUndoable.command}`;
    counts[key] = (counts[key] || 0) + 1;
    _lastUndoable = null;
  } else if (UNDOABLE_COMMANDS.has(command)) {
    _lastUndoable = { command, time: Date.now() };
  }

  scheduleFlush();
}

/** Mark dialog as completed. Call before closeDialog() in success paths. */
export function trackDialogComplete(dialogName: string): void {
  _dialogCompleted = dialogName;
}

/** Called from closeDialog(). Emits cancel event if no completion was registered. */
export function checkDialogCancel(dialogName: string): void {
  if (!_enabled) { _dialogCompleted = null; return; }
  if (_dialogCompleted === dialogName) {
    _dialogCompleted = null;
    return;
  }
  _dialogCompleted = null;
  const key = `dialog-cancel.${dialogName}`;
  counts[key] = (counts[key] || 0) + 1;
  scheduleFlush();
}

/** Emit events for display toggles that differ from defaults. */
export function trackDisplayState(current: object): void {
  if (!_enabled) return;
  const state = current as Record<string, unknown>;
  for (const [key, defaultValue] of Object.entries(DISPLAY_DEFAULTS)) {
    const value = state[key];
    if (value !== undefined && value !== defaultValue) {
      const eventKey = `display-state.${key}:${String(value)}`;
      counts[eventKey] = (counts[eventKey] || 0) + 1;
    }
  }
  // geometryMode is an enum, not a boolean toggle in DISPLAY_DEFAULTS. Emit its
  // non-default state (default is 'measured'); only 'closureAdjusted' is registered.
  const geometryMode = state['geometryMode'];
  if (typeof geometryMode === 'string' && geometryMode !== 'measured') {
    const eventKey = `display-state.geometryMode:${geometryMode}`;
    counts[eventKey] = (counts[eventKey] || 0) + 1;
  }
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    void flushToRust();
  }, FLUSH_INTERVAL_MS);
}

/** Start the periodic dwell flush interval. */
function startDwellInterval(): void {
  if (dwellFlushInterval) return;
  dwellFlushInterval = setInterval(() => {
    flushDwell();
    if (Object.keys(counts).length > 0) {
      void flushToRust();
    }
  }, DWELL_FLUSH_INTERVAL_MS);
}

/** Stop the periodic dwell flush interval. */
function stopDwellInterval(): void {
  if (dwellFlushInterval !== null) {
    clearInterval(dwellFlushInterval);
    dwellFlushInterval = null;
  }
}

/**
 * Initialize telemetry — checks feature availability and reads config.
 * Telemetry collection only starts if both compiled in and enabled in config.
 * Call once at app startup.
 */
export async function initTelemetry(enabled?: boolean): Promise<void> {
  await checkAvailable();
  if (available && enabled) {
    _enabled = true;
    startDwellInterval();
  }
}

/**
 * Enable or disable telemetry collection at runtime.
 * Called from the opt-in dialog and settings.
 */
export function setTelemetryEnabled(enabled: boolean): void {
  _enabled = enabled && available === true;
  if (_enabled) {
    startDwellInterval();
  } else {
    stopDwellInterval();
    // Clear any pending data
    for (const key of Object.keys(counts)) {
      delete counts[key];
    }
    _dwellState = null;
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }
}

/**
 * Whether the telemetry feature is available (compiled in).
 * Returns false until `initTelemetry()` has resolved.
 */
export function isTelemetryAvailable(): boolean {
  return available === true;
}

/**
 * Force-flush and optionally trigger a Rust-side flush (e.g., on app close).
 */
export async function flushTelemetry(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  stopDwellInterval();
  flushDwell();
  await flushToRust();

  if (available) {
    try {
      await invoke('flush_telemetry');
    } catch {
      // Best-effort on close
    }
  }
}
