import { invoke } from '@tauri-apps/api/core';

const LEVEL_MAP: Record<string, string> = {
  log: 'INFO',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
  debug: 'DEBUG',
};

const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/**
 * Format console arguments into a single string, similar to how the browser
 * console renders them (primitives via String(), objects via JSON).
 */
function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

/**
 * Monkey-patch console.log/info/warn/error/debug to also push each message
 * into the Rust ring buffer via the `push_frontend_log` IPC command.
 *
 * Call this once at app startup, before React renders.
 * Original console behaviour is fully preserved.
 */
export function installConsoleCapture(): void {
  // Guard: only patch if invoke is available (not in plain browser tests)
  if (typeof window === 'undefined') return;

  for (const method of METHODS) {
    const original = console[method].bind(console);
    const level = LEVEL_MAP[method];

    console[method] = (...args: unknown[]) => {
      // Always call the original first
      original(...args);

      // Fire-and-forget push to backend — never await, never throw
      try {
        const message = formatArgs(args);
        // Call invoke directly (not via trackInvoke): the debug tracker logs
        // failures through console.error, which is monkey-patched here to call
        // push_frontend_log again — wrapping this call would create a recursive
        // logging loop on IPC errors. Fire-and-forget.
        void invoke('push_frontend_log', { level, message });
      } catch {
        // IPC not ready yet or unavailable — silently ignore
      }
    };
  }
}
