// TEMPORARY: instrumentation for the macOS-only UI lockup investigation.
// Symptom: after the first interactive action (any tool click, any zoom),
// no further tool actions work until the project is reopened. See
// docs/debugging-macos-pan-zoom.md. Import this at the very top of main.tsx
// (before installConsoleCapture) and delete the file once fixed.

// Cache the original console funcs BEFORE installConsoleCapture wraps them.
// Without this, every [debug-lockup] log would itself fire push_frontend_log
// IPC, which we are trying to measure.
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
let tauriPatched = false;

interface TauriInternals {
  invoke?: (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown>;
  __debugPatched?: boolean;
}

function patchTauriInvoke(): void {
  const w = window as unknown as { __TAURI_INTERNALS__?: TauriInternals };
  const internals = w.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') {
    window.setTimeout(patchTauriInvoke, 50);
    return;
  }
  if (internals.__debugPatched) return;
  internals.__debugPatched = true;
  tauriPatched = true;

  const orig = internals.invoke.bind(internals);
  internals.invoke = (cmd: string, args?: unknown, opts?: unknown) => {
    const id = ++nextId;
    const start = performance.now();
    const silent = NOISY_COMMANDS.has(cmd);

    const warnTimer = window.setTimeout(() => {
      warn(
        `[debug-lockup] IPC HANG ${cmd} > 3s (id=${id}, inFlight=${inFlight.size})`,
      );
    }, 3000);

    inFlight.set(id, { command: cmd, start, warnTimer });
    if (!silent) {
      log(`[debug-lockup] IPC -> ${cmd} (id=${id}, inFlight=${inFlight.size})`);
    }

    return orig(cmd, args, opts).then(
      (res: unknown) => {
        window.clearTimeout(warnTimer);
        const ms = Math.round(performance.now() - start);
        inFlight.delete(id);
        if (!silent || ms > 500) {
          log(
            `[debug-lockup] IPC ok ${cmd} ${ms}ms (id=${id}, inFlight=${inFlight.size})`,
          );
        }
        return res;
      },
      (err: unknown) => {
        window.clearTimeout(warnTimer);
        const ms = Math.round(performance.now() - start);
        inFlight.delete(id);
        error(
          `[debug-lockup] IPC FAIL ${cmd} ${ms}ms (id=${id}, inFlight=${inFlight.size}) reason=${String(err)}`,
        );
        throw err;
      },
    );
  };

  log('[debug-lockup] Tauri IPC bridge patched');
}

patchTauriInvoke();

// Global error capture — surface anything React's render error boundary or
// promise chains might be swallowing.
window.addEventListener('error', (e) => {
  error('[debug-lockup] window.onerror', {
    message: e.message,
    filename: e.filename,
    lineno: e.lineno,
    err: String(e.error),
  });
});
window.addEventListener('unhandledrejection', (e) => {
  error('[debug-lockup] unhandledrejection', String(e.reason));
});

// Document-level click logger (capture phase, never preventDefault). Confirms
// whether clicks even reach the document after the lockup.
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
// this file has no static dependency on the rest of the app.
void import('../store/uiStore').then(({ useUIStore }) => {
  let prev = useUIStore.getState().activeTool;
  useUIStore.subscribe((state) => {
    if (state.activeTool !== prev) {
      log(`[debug-lockup] activeTool: ${prev} -> ${state.activeTool}`);
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
    tauriPatched,
    inFlightCount: inFlight.size,
    inFlightByCommand: byCommand,
    oldest: stale.slice(0, 10),
    activeTool:
      (window as unknown as { __getActiveTool?: () => string }).__getActiveTool?.() ?? null,
  };
  log('[debug-lockup] snapshot:', JSON.stringify(snapshot, null, 2));
  return snapshot;
};

log('[debug-lockup] instrumentation loaded');
