// Dev-only "agent bridge" webview client. Pairs with the Vite plugin in
// scripts/lib/vite-agent-bridge.mjs to let an outside process on the same
// machine (Claude Code, via curl/tail) read the live frontend console and run
// JavaScript inside the running `pnpm tauri dev` webview.
//
// Loaded only under import.meta.env.DEV (see src/main.tsx), so it tree-shakes
// out of production builds. Every path is wrapped so a bridge failure never
// propagates into the app, and the bridge itself NEVER calls console.* (that
// would recurse through the console mirror below).
//
// See docs/debug-gates.md, "Agent console bridge (dev-only)".

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

interface ConsoleEntry {
  ts: number;
  level: string;
  text: string;
}

interface EvalItem {
  id: number;
  code: string;
}

// Caps: per-console-line text, in-memory buffer (bounded in case the token
// never arrives so we never flush), and per-eval serialized value.
const MAX_TEXT_BYTES = 8 * 1024;
const MAX_BUFFER_ENTRIES = 5000;
const MAX_VALUE_BYTES = 64 * 1024;

const CONSOLE_FLUSH_MS = 300;
const EVAL_POLL_MS = 400;
const MAX_TOKEN_ATTEMPTS = 8;

let token: string | null = null;
const buffer: ConsoleEntry[] = [];

/**
 * Format console arguments into a single string, mirroring
 * src/utils/consoleCapture.ts: strings as-is, Errors as `name: message`,
 * objects via JSON.stringify (falling back to String() on failure).
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fetch the shared token, retrying with capped exponential backoff since this
// module loads early (before the dev server middleware may be fully warm).
// Returns null if it never succeeds, in which case the bridge stays inert.
async function fetchToken(): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch('/__agent/token');
      if (resp.ok) {
        const text = (await resp.text()).trim();
        if (text) return text;
      }
    } catch {
      // Server not ready yet, retry.
    }
    await sleep(Math.min(200 * 2 ** attempt, 3000));
  }
  return null;
}

// Wrap whatever console.* implementation is currently installed (the
// consoleCapture patch runs first in main.tsx) so both fire: the original is
// still called, and we also buffer a mirrored entry. Installed immediately so
// early logs are captured even before the token arrives.
function installConsoleMirror(): void {
  for (const method of CONSOLE_METHODS) {
    const original = console[method].bind(console) as (...args: unknown[]) => void;
    console[method] = (...args: unknown[]): void => {
      original(...args);
      try {
        buffer.push({
          ts: Date.now(),
          level: method satisfies ConsoleMethod,
          text: formatArgs(args).slice(0, MAX_TEXT_BYTES),
        });
        if (buffer.length > MAX_BUFFER_ENTRIES) {
          buffer.splice(0, buffer.length - MAX_BUFFER_ENTRIES);
        }
      } catch {
        // Never let mirroring throw into the caller's console.* call.
      }
    };
  }
}

// POST the buffered console entries. Swallows every error; the batch is dropped
// on failure (best-effort mirror, never a source of back-pressure).
function flushConsole(): void {
  if (!token || buffer.length === 0) return;
  const batch = buffer.splice(0, buffer.length);
  void fetch('/__agent/console', {
    method: 'POST',
    headers: { 'x-agent-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(batch),
  }).catch(() => {});
}

// Build the async function constructor (not exposed globally): the only way to
// evaluate arbitrary source that may `await`.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...callArgs: unknown[]) => Promise<unknown>;

// Evaluate one snippet. Expression form first (so `1+1` or `({a:1})` return a
// value); on a construction-time SyntaxError, fall back to statement form
// (caller uses an explicit `return`).
function evaluate(code: string): Promise<unknown> {
  let fn: (...callArgs: unknown[]) => Promise<unknown>;
  try {
    fn = new AsyncFunction(`return (${code})`);
  } catch (err) {
    if (err instanceof SyntaxError) {
      fn = new AsyncFunction(code);
    } else {
      throw err;
    }
  }
  return fn();
}

// JSON replacer: Errors -> {name, message, stack}, functions -> truncated
// source, bigints -> string (JSON.stringify throws on them otherwise).
function replacer(_key: string, val: unknown): unknown {
  if (val instanceof Error) {
    return { name: val.name, message: val.message, stack: val.stack };
  }
  if (typeof val === 'function') {
    const src = String(val);
    return src.length > 512 ? `${src.slice(0, 512)}…[truncated]` : src;
  }
  if (typeof val === 'bigint') {
    return String(val);
  }
  return val;
}

// Produce a JSON-safe representation of an eval result value: undefined -> null,
// circular structures -> String(value), and anything whose serialized form
// exceeds MAX_VALUE_BYTES -> a truncated-string marker (so the enclosing result
// body stays valid JSON either way).
function encodeValue(value: unknown): unknown {
  let json: string | undefined;
  try {
    json = JSON.stringify(value, replacer);
  } catch {
    // Circular-structure TypeError (or any other stringify failure).
    return String(value);
  }
  if (json === undefined) return null; // undefined / function-at-top / symbol
  if (json.length > MAX_VALUE_BYTES) {
    return `${json.slice(0, MAX_VALUE_BYTES)}…[truncated ${json.length} bytes]`;
  }
  // Re-parse so the value embeds as its real structure (number stays a number)
  // rather than a double-encoded string.
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

async function handleEval(item: EvalItem): Promise<void> {
  let body: string;
  try {
    const value = await evaluate(item.code);
    body = JSON.stringify({ id: item.id, ok: true, value: encodeValue(value) });
  } catch (error) {
    const err =
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { name: 'Error', message: String(error) };
    body = JSON.stringify({ id: item.id, ok: false, error: err });
  }
  if (!token) return;
  try {
    await fetch('/__agent/result', {
      method: 'POST',
      headers: { 'x-agent-token': token, 'content-type': 'application/json' },
      body,
    });
  } catch {
    // Result POST failed (server gone / restarting), drop it.
  }
}

async function pollEval(): Promise<void> {
  if (!token) return;
  let items: unknown;
  try {
    const resp = await fetch('/__agent/pull', { headers: { 'x-agent-token': token } });
    if (!resp.ok) return;
    items = await resp.json();
  } catch {
    return;
  }
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as EvalItem).id === 'number' &&
      typeof (item as EvalItem).code === 'string'
    ) {
      // One failed eval must not kill the loop.
      await handleEval(item as EvalItem);
    }
  }
}

/**
 * Install the dev-only agent bridge. Safe to call unconditionally under DEV:
 * it aborts silently if the token endpoint is never reachable, and any
 * unexpected error is swallowed rather than propagated to the app.
 */
export function installAgentBridge(): void {
  try {
    if (typeof window === 'undefined' || typeof fetch === 'undefined') return;

    // Patch console immediately so entries buffer even before the token lands.
    installConsoleMirror();

    void (async () => {
      const t = await fetchToken();
      if (!t) return; // Bridge unavailable: stay inert (console still buffers, never flushes).
      token = t;

      setInterval(flushConsole, CONSOLE_FLUSH_MS);

      let polling = false;
      setInterval(() => {
        if (polling) return;
        polling = true;
        void pollEval().finally(() => {
          polling = false;
        });
      }, EVAL_POLL_MS);
    })();
  } catch {
    // Bridge must never break the app.
  }
}
