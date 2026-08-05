/**
 * Low-level page-context helpers. We enforce WebDriver Classic (no BiDi against
 * WebKitWebDriver), so anything async in the webview goes through
 * `executeAsync` with a done-callback rather than `execute` (which does not
 * await returned promises).
 *
 * macOS (tauri-wd / tauri-plugin-webdriver-automation) constraints on every
 * script that goes through here (#421):
 * - The plugin's execute-async has a HARD 30 s server-side timeout; scripts
 *   must resolve well inside it (poll in the harness, not in one long script).
 * - A resolved value containing BOTH `error` and `message` keys is coerced into
 *   a script error by the plugin. Never return that shape as data; wrap it
 *   (e.g. {value: ...}) if an app object legitimately carries both keys.
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
  let runner: (fnArgs: unknown[], done: (r: unknown) => void) => void;
  try {
    // Compile in the Node driver. WebDriver executes the resulting fixed script
    // directly, so the webview's production CSP does not need unsafe-eval.
    // eslint-disable-next-line no-new-func
    runner = new Function(
      'fnArgs',
      'done',
      `try {
        const fn = async (...args) => { ${body} };
        Promise.resolve(fn(...fnArgs))
          .then((value) => done({ value }))
          .catch((err) => done({ __agentError: String(err) }));
      } catch (err) {
        done({ __agentError: String(err) });
      }`,
    ) as (fnArgs: unknown[], done: (r: unknown) => void) => void;
  } catch (err) {
    throw new Error(`eval compile: ${String(err)}`);
  }
  const raw = await browser.executeAsync(runner, args);
  if (isPageError(raw)) throw new Error(`eval: ${raw.__agentError}`);
  return (raw as { value: T }).value;
}

/** Cap a value's JSON size, returning { value, truncated }. */
export function capJson(value: unknown, maxBytes: number): { value: unknown; truncated: boolean } {
  const json = JSON.stringify(value ?? null);
  if (json.length <= maxBytes) return { value, truncated: false };
  return { value: `${json.slice(0, maxBytes)}...[truncated ${json.length} bytes]`, truncated: true };
}
