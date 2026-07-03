/**
 * Low-level page-context helpers. We enforce WebDriver Classic (no BiDi against
 * WebKitWebDriver), so anything async in the webview goes through
 * `executeAsync` with a done-callback rather than `execute` (which does not
 * await returned promises).
 */
import type { Browser } from 'webdriverio';

/** Marker an in-page helper uses to report an error back across the bridge. */
interface PageError {
  __agentError: string;
}

function isPageError(value: unknown): value is PageError {
  return typeof value === 'object' && value !== null && '__agentError' in value;
}

/**
 * Invoke a Tauri command from the webview via window.__TAURI__.core.invoke and
 * return its result. Throws if the command rejects.
 */
export async function invokeInApp<T = unknown>(
  browser: Browser,
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const raw = await browser.executeAsync(
    (cmd: string, cmdArgs: Record<string, unknown> | undefined, done: (r: unknown) => void) => {
      const w = window as unknown as {
        __TAURI__?: { core?: { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> } };
      };
      const invoke = w.__TAURI__?.core?.invoke;
      if (!invoke) {
        done({ __agentError: 'window.__TAURI__.core.invoke unavailable' });
        return;
      }
      invoke(cmd, cmdArgs)
        .then((value) => done({ value }))
        .catch((err: unknown) => done({ __agentError: String(err) }));
    },
    command,
    args,
  );
  if (isPageError(raw)) throw new Error(`ipc ${command}: ${raw.__agentError}`);
  return (raw as { value: T }).value;
}

/**
 * Run an agent-supplied function body in the webview (async supported). The
 * body is `return`-style JS text; `args` are passed through and JSON-returned.
 */
export async function evalInApp<T = unknown>(
  browser: Browser,
  body: string,
  args: unknown[] = [],
): Promise<T> {
  const raw = await browser.executeAsync(
    (fnBody: string, fnArgs: unknown[], done: (r: unknown) => void) => {
      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function(`return (async (...args) => { ${fnBody} })(...arguments)`)();
        Promise.resolve(fn.apply(null, fnArgs))
          .then((value: unknown) => done({ value }))
          .catch((err: unknown) => done({ __agentError: String(err) }));
      } catch (err) {
        done({ __agentError: String(err) });
      }
    },
    body,
    args,
  );
  if (isPageError(raw)) throw new Error(`eval: ${raw.__agentError}`);
  return (raw as { value: T }).value;
}

/** Cap a value's JSON size, returning { value, truncated }. */
export function capJson(value: unknown, maxBytes: number): { value: unknown; truncated: boolean } {
  const json = JSON.stringify(value ?? null);
  if (json.length <= maxBytes) return { value, truncated: false };
  return { value: `${json.slice(0, maxBytes)}...[truncated ${json.length} bytes]`, truncated: true };
}
