/**
 * Anonymous telemetry — batches event counts in memory and periodically
 * flushes them to the Rust backend via IPC.
 *
 * Self-gating: if the `is_telemetry_available` command doesn't exist
 * (telemetry feature not compiled), all calls are no-ops.
 */

import { invoke } from '@tauri-apps/api/core';

/** How often (ms) to flush batched counts to Rust. */
const FLUSH_INTERVAL_MS = 60_000;

/** In-memory event counters. */
const counts: Record<string, number> = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let available: boolean | null = null;

/** Source hint for the next action — consumed by dispatchers. */
let _source = 'unknown';
let _sourceTimer: ReturnType<typeof setTimeout> | null = null;

/** Last undoable command — for regret detection. */
let _lastUndoable: { command: string; time: number } | null = null;
const REGRET_WINDOW_MS = 15_000;

/** Commands that push to the undo stack. */
const UNDOABLE_COMMANDS: ReadonlySet<string> = new Set([
  'create_section', 'update_section', 'delete_section', 'move_section', 'move_segment',
  'create_shot', 'update_shot', 'delete_shot', 'set_shot_reference',
  'merge_stations', 'unmerge_stations', 'unmerge_station_pair',
  'set_zero_datum', 'remove_zero_datum', 'set_station_comment', 'move_comment', 'move_station',
  'create_loop_closure', 'remove_loop_closure', 'adjust_loop_closures',
  'create_section_and_merge', 'delete_shot_and_split', 'delete_last_shot_and_section',
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
    await invoke('track_events', { events: snapshot });
  } catch {
    // Restore counts if flush failed — they'll be retried next cycle
    for (const [key, value] of Object.entries(snapshot)) {
      counts[key] = (counts[key] || 0) + value;
    }
  }
}

/** Set source for the next action. Auto-resets after 50ms to prevent bleed. */
export function setSource(source: string): void {
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

/** Track a user action with source. */
export function trackAction(action: string, source?: string): void {
  const src = source ?? consumeSource();
  const key = `action.${action}:${src}`;
  counts[key] = (counts[key] || 0) + 1;
  scheduleFlush();
}

/**
 * Track an IPC command invocation.
 * Called from `invokeIpc` for every IPC call.
 */
export function trackCommand(command: string): void {
  counts[`command.${command}`] = (counts[`command.${command}`] || 0) + 1;

  if (command === 'undo' && _lastUndoable && (Date.now() - _lastUndoable.time) < REGRET_WINDOW_MS) {
    const key = `undo-after.${_lastUndoable.command}`;
    counts[key] = (counts[key] || 0) + 1;
    _lastUndoable = null;
  } else if (UNDOABLE_COMMANDS.has(command)) {
    _lastUndoable = { command, time: Date.now() };
  }

  scheduleFlush();
}

/**
 * Track a UI-only event (tool switch, dialog open, etc.)
 * that doesn't go through IPC.
 */
export function trackUIEvent(name: string): void {
  counts[name] = (counts[name] || 0) + 1;
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    void flushToRust();
  }, FLUSH_INTERVAL_MS);
}

/**
 * Initialize telemetry — checks feature availability.
 * Call once at app startup.
 */
export async function initTelemetry(): Promise<void> {
  await checkAvailable();
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
  await flushToRust();

  if (available) {
    try {
      await invoke('flush_telemetry');
    } catch {
      // Best-effort on close
    }
  }
}
