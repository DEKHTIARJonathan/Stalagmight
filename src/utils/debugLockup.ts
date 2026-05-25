// TEMPORARY: instrumentation for the macOS-only UI lockup investigation.
// Symptom: after the first interactive action (any tool click, any zoom),
// no further tool actions work until the project is reopened.
// See docs/debugging-macos-pan-zoom.md. Import this at the top of main.tsx
// and delete the file once fixed.

// Cache original console funcs BEFORE installConsoleCapture wraps them, so
// our own logging does not loop back through push_frontend_log IPC.
const log = console.log.bind(console);
const warn = console.warn.bind(console);
const error = console.error.bind(console);

// IPC commands that fire on every console call or telemetry tick. Track them
// in the in-flight map (so we can see hangs) but do not log per call.
const NOISY_COMMANDS = new Set([
  'push_frontend_log',
  'track_events',
  'flush_telemetry',
  'is_telemetry_available',
  'set_telemetry_enabled',
]);

interface InFlightEntry {
  command: string;
  start: number;
  warnTimer: number;
}

const inFlight = new Map<number, InFlightEntry>();
let nextId = 0;

/**
 * Observe an existing IPC Promise for diagnostics. Pass-through: returns the
 * same Promise reference the caller passed in, so it cannot change the
 * behaviour of the caller's await/then chain. Side-branches via .then() to
 * track in-flight count and warn on hangs > 3 s.
 */
export function trackInvoke<T>(command: string, p: Promise<T>): Promise<T> {
  const id = ++nextId;
  const start = performance.now();
  const silent = NOISY_COMMANDS.has(command);

  const warnTimer = window.setTimeout(() => {
    warn(
      `[debug-lockup] IPC HANG ${command} > 3s (id=${id}, inFlight=${inFlight.size})`,
    );
  }, 3000);

  inFlight.set(id, { command, start, warnTimer });
  if (!silent) {
    log(`[debug-lockup] IPC -> ${command} (id=${id}, inFlight=${inFlight.size})`);
  }

  // Side-branch observation only. Both handlers swallow their result so this
  // branch never produces an unhandled rejection regardless of how the
  // caller handles the original promise.
  p.then(
    () => {
      window.clearTimeout(warnTimer);
      inFlight.delete(id);
      const ms = Math.round(performance.now() - start);
      if (!silent || ms > 500) {
        log(
          `[debug-lockup] IPC ok ${command} ${ms}ms (id=${id}, inFlight=${inFlight.size})`,
        );
      }
    },
    (err: unknown) => {
      window.clearTimeout(warnTimer);
      inFlight.delete(id);
      const ms = Math.round(performance.now() - start);
      error(
        `[debug-lockup] IPC FAIL ${command} ${ms}ms (id=${id}, inFlight=${inFlight.size}) reason=${String(err)}`,
      );
    },
  );

  return p;
}

// Global error capture — surface anything React error boundaries or
// fire-and-forget promise chains would otherwise swallow. Log the full
// stack so we can see the call chain that led to MapLibre's re-entry guard
// (or whatever else is throwing).
window.addEventListener('error', (e) => {
  const stack = e.error?.stack ?? '(no stack available)';
  error(
    `[debug-lockup] window.onerror: ${e.message}\n  at ${e.filename}:${e.lineno}\nFULL STACK:\n${stack}`,
  );
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason as { stack?: string; message?: string } | string | undefined;
  const stack = typeof reason === 'object' && reason?.stack ? reason.stack : String(reason);
  error(`[debug-lockup] unhandledrejection:\n${stack}`);
});

// Document-level click logger (capture phase, never preventDefault).
document.addEventListener(
  'click',
  (e) => {
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName.toLowerCase() ?? 'null';
    const tid = t?.closest?.('[data-testid]')?.getAttribute('data-testid') ?? null;
    const text = (t?.textContent ?? '').trim().slice(0, 40);
    log(
      `[debug-lockup] click <${tag}> testid=${tid} text="${text}" defaultPrevented=${e.defaultPrevented}`,
    );
  },
  { capture: true },
);

// Subscribe to activeTool changes once the store is loaded. Dynamic import so
// this file has no static dependency on the rest of the app. We log a short
// stack at each transition so it is obvious which click handler called
// setActiveTool, and what synchronous work follows.
void import('../store/uiStore').then(({ useUIStore }) => {
  let prev = useUIStore.getState().activeTool;
  useUIStore.subscribe((state) => {
    if (state.activeTool !== prev) {
      const stack = new Error().stack?.split('\n').slice(2, 8).join('\n') ?? '';
      log(`[debug-lockup] activeTool: ${prev} -> ${state.activeTool}\n${stack}`);
      prev = state.activeTool;
    }
  });
  (window as unknown as { __getActiveTool: () => string }).__getActiveTool = () =>
    useUIStore.getState().activeTool;
  log('[debug-lockup] uiStore.activeTool subscription installed');
});

// DevTools helper: call window.__lockupSnapshot() to see in-flight IPC.
(window as unknown as { __lockupSnapshot: () => unknown }).__lockupSnapshot = () => {
  const now = performance.now();
  const stale = Array.from(inFlight.entries())
    .map(([id, e]) => ({ id, command: e.command, ageMs: Math.round(now - e.start) }))
    .sort((a, b) => b.ageMs - a.ageMs);
  const byCommand = stale.reduce<Record<string, number>>((acc, e) => {
    acc[e.command] = (acc[e.command] ?? 0) + 1;
    return acc;
  }, {});
  const snapshot = {
    inFlightCount: inFlight.size,
    inFlightByCommand: byCommand,
    oldest: stale.slice(0, 10),
    activeTool:
      (window as unknown as { __getActiveTool?: () => string }).__getActiveTool?.() ?? null,
  };
  log('[debug-lockup] snapshot:', JSON.stringify(snapshot, null, 2));
  return snapshot;
};

log('[debug-lockup] instrumentation loaded (pass-through mode)');
