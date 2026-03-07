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

/**
 * Track an IPC command invocation.
 * Called from `invokeIpc` for every IPC call.
 */
export function trackCommand(command: string): void {
  counts[`command.${command}`] = (counts[`command.${command}`] || 0) + 1;
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
