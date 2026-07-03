// hygiene MUST be first: it silences wdio + routes console.* off stdout before
// webdriverio (imported transitively via ./session) can log there.
import './hygiene';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AppSession } from '../session';
import { readStore, callStoreAction, postDigest, type StoreName } from '../lib/stores';
import { LogCursor, type LogLevel } from '../lib/logs';
import { invokeInApp, evalInApp, capJson } from '../lib/page';
import {
  waitForAppReady,
  waitForUiIdle,
  waitForMapIdle,
  waitForActiveTool,
} from '../lib/waiters';

const STORE_NAMES = ['ui', 'project', 'globalView', 'gasPlan', 'speleo', 'export', 'network'] as const;

const session = new AppSession();
let logCursor: LogCursor | null = null;

type ToolResult = { content: Array<Record<string, unknown>>; isError?: boolean };

function textResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value ?? null) }] };
}
function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

interface RunOutput<T> {
  result: T;
  resolved?: unknown;
  artifacts?: { screenshot?: string; stateSnapshot?: string };
}

/** Time + record a tool call to the session action log, then return its result. */
async function record<T>(
  tool: string,
  params: unknown,
  fn: (seq: number) => Promise<RunOutput<T>>,
  opts: { digest?: boolean } = {},
): Promise<T> {
  const start = Date.now();
  const seq = session.hasRecorder ? session.recorder.nextSeq() : 0;
  try {
    const { result, resolved, artifacts } = await fn(seq);
    if (session.hasRecorder) {
      let post: unknown;
      if (opts.digest) {
        post = await postDigest(session.browser).catch(() => undefined);
      }
      session.recorder.action({
        seq,
        ts: new Date().toISOString(),
        tool,
        params,
        resolved,
        outcome: { ok: true, durationMs: Date.now() - start },
        result: capJson(result, 4096).value,
        artifacts,
        post,
      });
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (session.hasRecorder) {
      session.recorder.action({
        seq,
        ts: new Date().toISOString(),
        tool,
        params,
        outcome: { ok: false, durationMs: Date.now() - start, error: message },
      });
    }
    throw err;
  }
}

const server = new McpServer({ name: 'stalagmight-app', version: '0.1.0' });

function define<S extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.registerTool(name, { description, inputSchema: schema }, handler as any);
}

// ---------------------------------------------------------------- lifecycle

define(
  'app_start',
  'Build (if stale) and launch the real Tauri app under WebDriver, returning session info. Requires Node 22.',
  {
    build: z.enum(['auto', 'skip', 'force']).optional(),
    headed: z.boolean().optional(),
    freshProfile: z.boolean().optional(),
  },
  async (args) => {
    try {
      const res = await session.start({
        build: args.build ?? 'auto',
        headed: args.headed,
        freshProfile: args.freshProfile,
      });
      logCursor = new LogCursor(session.browser);
      await logCursor.checkpoint().catch(() => undefined);
      return textResult(res);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
);

define('app_stop', 'Close the app and driver, freeing the session.', {}, async () => {
  try {
    await session.stop('app_stop');
    logCursor = null;
    return textResult({ stopped: true });
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
});

define(
  'app_restart',
  'Stop and restart the session. By default keeps the profile (to reproduce persisted-state bugs).',
  { freshProfile: z.boolean().optional() },
  async (args) => {
    try {
      await session.stop('app_restart');
      const res = await session.start({ build: 'skip', freshProfile: args.freshProfile ?? false });
      logCursor = new LogCursor(session.browser);
      await logCursor.checkpoint().catch(() => undefined);
      return textResult(res);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
);

define('app_status', 'Report session liveness and basic info.', {}, async () => {
  return textResult({
    state: session.state,
    uptimeMs: session.uptimeMs(),
    driverAlive: session.driverAlive(),
    sessionDir: session.sessionDir,
    node: process.versions.node,
  });
});

// ------------------------------------------------------------- observation

define('screenshot', 'Capture a PNG screenshot (returned as image + saved to the session dir).', {
  name: z.string().optional(),
}, async (args) => {
  try {
    const { base64, path } = await record('screenshot', args, async (seq) => {
      const b64 = await session.exclusive(() => session.browser.takeScreenshot());
      const p = session.recorder.writeScreenshot(seq, args.name ?? 'shot', b64);
      return { result: { base64: b64, path: p }, artifacts: { screenshot: p } };
    });
    return {
      content: [
        { type: 'image', data: base64, mimeType: 'image/png' },
        { type: 'text', text: JSON.stringify({ path }) },
      ],
    };
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
});

define(
  'store_state',
  'Read a Zustand store. With no path, returns a key/type summary; with a dot path, the value (JSON-capped).',
  {
    store: z.enum(STORE_NAMES),
    path: z.string().optional(),
    maxBytes: z.number().optional(),
  },
  async (args) => {
    try {
      const value = await record('store_state', args, async () => ({
        result: await session.exclusive(() =>
          readStore(session.browser, args.store as StoreName, args.path ?? null, args.maxBytes ?? 16384),
        ),
      }));
      return textResult(value);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
);

define(
  'logs',
  'Return ring-buffer log lines since the last read. level filters output; peek does not advance the cursor.',
  { level: z.enum(['all', 'warn', 'error']).optional(), peek: z.boolean().optional() },
  async (args) => {
    try {
      if (!logCursor) return errorResult('no session (call app_start)');
      const res = await record('logs', args, async () => ({
        result: await session.exclusive(() => logCursor!.read((args.level ?? 'error') as LogLevel, args.peek)),
      }));
      return textResult(res);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
);

define(
  'wait_for',
  'Wait for a condition: selector visible/hidden, app-ready, ui-idle, map-idle, active-tool, or a store dot-path equalling a value.',
  {
    condition: z.enum(['selector', 'hidden', 'app-ready', 'ui-idle', 'map-idle', 'active-tool', 'store-path']),
    selector: z.string().optional(),
    tool: z.string().optional(),
    store: z.enum(STORE_NAMES).optional(),
    path: z.string().optional(),
    equals: z.unknown().optional(),
    timeoutMs: z.number().optional(),
  },
  async (args) => {
    try {
      const timeout = args.timeoutMs ?? 10000;
      const res = await record('wait_for', args, async () => {
        await session.exclusive(async () => {
          const b = session.browser;
          switch (args.condition) {
            case 'selector':
              await b.$(String(args.selector)).waitForDisplayed({ timeout });
              break;
            case 'hidden':
              await b.$(String(args.selector)).waitForDisplayed({ timeout, reverse: true });
              break;
            case 'app-ready':
              await waitForAppReady(b);
              break;
            case 'ui-idle':
              await waitForUiIdle(b);
              break;
            case 'map-idle':
              await waitForMapIdle(b);
              break;
            case 'active-tool':
              await waitForActiveTool(b, String(args.tool));
              break;
            case 'store-path':
              await b.waitUntil(
                async () => {
                  const v = await readStore(b, args.store as StoreName, String(args.path));
                  return JSON.stringify((v as { value?: unknown }).value) === JSON.stringify(args.equals);
                },
                { timeout, timeoutMsg: 'store-path did not match' },
              );
              break;
            default:
              throw new Error(`unknown condition ${args.condition}`);
          }
        });
        return { result: { met: true } };
      });
      return textResult(res);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
);

// ------------------------------------------------------------- interaction

define(
  'click',
  'Click an element by data-testid, CSS selector, or canvas coordinates. Optional right/middle button, double, and modifier keys.',
  {
    testid: z.string().optional(),
    selector: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    button: z.enum(['left', 'right', 'middle']).optional(),
    double: z.boolean().optional(),
    modifiers: z.array(z.enum(['Control', 'Shift', 'Alt'])).optional(),
  },
  async (args) => {
    try {
      const res = await record(
        'click',
        args,
        async () => {
          const b = session.browser;
          const selector = args.testid ? `[data-testid="${args.testid}"]` : args.selector;
          return session.exclusive(async () => {
            let point: { x: number; y: number } | undefined;
            const button = args.button ?? 'left';
            const simple = button === 'left' && !args.double && !(args.modifiers && args.modifiers.length);
            if (selector) {
              const el = b.$(selector);
              await el.waitForClickable({ timeout: 5000 });
              if (simple) {
                await el.click();
              } else {
                await el.moveTo();
                await clickWithOptions(b, button, args.double, args.modifiers);
              }
            } else if (typeof args.x === 'number' && typeof args.y === 'number') {
              point = { x: Math.round(args.x), y: Math.round(args.y) };
              await b
                .action('pointer', { parameters: { pointerType: 'mouse' } })
                .move({ x: point.x, y: point.y })
                .down({ button })
                .up({ button })
                .perform();
            } else {
              throw new Error('click needs one of testid, selector, or x+y');
            }
            return { result: { clicked: true }, resolved: { selector, point } };
          });
        },
        { digest: true },
      );
      return textResult(res);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
);

define(
  'type_text',
  'Type text, optionally focusing a target first (testid/selector). clear empties it first; submit presses Enter after.',
  {
    text: z.string(),
    testid: z.string().optional(),
    selector: z.string().optional(),
    clear: z.boolean().optional(),
    submit: z.boolean().optional(),
  },
  async (args) => {
    try {
      const res = await record(
        'type_text',
        args,
        async () => {
          const b = session.browser;
          const selector = args.testid ? `[data-testid="${args.testid}"]` : args.selector;
          return session.exclusive(async () => {
            if (selector) {
              const el = b.$(selector);
              await el.waitForDisplayed({ timeout: 5000 });
              if (args.clear) await el.clearValue();
              await el.setValue(args.text);
            } else {
              await b.keys(args.text.split(''));
            }
            if (args.submit) await b.keys(['Enter']);
            return { result: { typed: true }, resolved: { selector } };
          });
        },
        { digest: true },
      );
      return textResult(res);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
);

define('press_keys', 'Press a sequence of WebDriver keys (e.g. ["Control","z"]).', {
  keys: z.array(z.string()),
}, async (args) => {
  try {
    const res = await record(
      'press_keys',
      args,
      async () => {
        await session.exclusive(() => session.browser.keys(args.keys));
        return { result: { pressed: args.keys } };
      },
      { digest: true },
    );
    return textResult(res);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
});

// ------------------------------------------------------------ escape hatches

define('eval', 'Run an async function body in the webview (page context) and return its value.', {
  script: z.string(),
  args: z.array(z.unknown()).optional(),
}, async (args) => {
  try {
    const value = await record('eval', args, async () => ({
      result: await session.exclusive(() => evalInApp(session.browser, args.script, args.args ?? [])),
    }));
    return textResult(capJson(value, 16384));
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
});

define('ipc', 'Invoke a Tauri command from the webview (e.g. get_recent_logs_since, check_project_integrity).', {
  command: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
}, async (args) => {
  try {
    const value = await record('ipc', args, async () => ({
      result: await session.exclusive(() => invokeInApp(session.browser, args.command, args.args)),
    }));
    return textResult(capJson(value, 16384));
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
});

define(
  'store_action',
  'Call an action on a Zustand store (generic seeding/driving primitive).',
  { store: z.enum(STORE_NAMES), action: z.string(), args: z.array(z.unknown()).optional() },
  async (args) => {
    try {
      const res = await record(
        'store_action',
        args,
        async () => ({
          result: await session.exclusive(() =>
            callStoreAction(session.browser, args.store as StoreName, args.action, args.args ?? []),
          ),
        }),
        { digest: true },
      );
      return textResult(res);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------- map

define('map_view', 'Read or set the MapLibre view (center/zoom/bearing or fit the project).', {
  set: z
    .object({ center: z.array(z.number()).optional(), zoom: z.number().optional(), bearing: z.number().optional() })
    .optional(),
  fit: z.enum(['project']).optional(),
}, async (args) => {
  try {
    const res = await record('map_view', args, async () => ({
      result: await session.exclusive(async () => {
        const out = await evalInApp<{ ok: boolean; view?: unknown }>(
          session.browser,
          `
          const map = window.__stalagmight_map__;
          if (!map) return { ok: false };
          const set = args[0]; const fit = args[1];
          if (fit === 'project' && map.__fitProject) { map.__fitProject(); }
          else if (set) { map.jumpTo({ ...(set.center ? { center: set.center } : {}), ...(set.zoom != null ? { zoom: set.zoom } : {}), ...(set.bearing != null ? { bearing: set.bearing } : {}) }); }
          return { ok: true, view: { center: map.getCenter && map.getCenter(), zoom: map.getZoom && map.getZoom(), bearing: map.getBearing && map.getBearing() } };
        `,
          [args.set ?? null, args.fit ?? null],
        );
        return out;
      }),
    }));
    return textResult(res);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
});

define('map_click', 'Click a geographic point on the map canvas (lngLat -> pixel via map.project).', {
  lngLat: z.array(z.number()).length(2),
  button: z.enum(['left', 'right']).optional(),
}, async (args) => {
  try {
    const res = await record(
      'map_click',
      args,
      async () =>
        session.exclusive(async () => {
          const b = session.browser;
          const point = await evalInApp<{ x: number; y: number } | null>(
            b,
            `
            const map = window.__stalagmight_map__;
            if (!map || !map.project) return null;
            const p = map.project(args[0]);
            const canvas = document.querySelector('[data-testid="map-canvas"]');
            const rect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
            return { x: Math.round(rect.left + p.x), y: Math.round(rect.top + p.y) };
          `,
            [args.lngLat],
          );
          if (!point) throw new Error('map not available or point off-canvas');
          const button = args.button ?? 'left';
          await b
            .action('pointer', { parameters: { pointerType: 'mouse' } })
            .move({ x: point.x, y: point.y })
            .down({ button })
            .up({ button })
            .perform();
          return { result: { clicked: true }, resolved: { lngLat: args.lngLat, point } };
        }),
      { digest: true },
    );
    return textResult(res);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
});

// -------------------------------------------------------------- helpers

async function clickWithOptions(
  b: AppSession['browser'],
  button: 'left' | 'right' | 'middle',
  double?: boolean,
  modifiers?: Array<'Control' | 'Shift' | 'Alt'>,
): Promise<void> {
  const mods = modifiers ?? [];
  if (mods.length) {
    const key = b.action('key');
    for (const m of mods) key.down(m);
    await key.perform();
  }
  const pointer = b
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .down({ button })
    .up({ button });
  if (double) pointer.down({ button }).up({ button });
  await pointer.perform();
  if (mods.length) {
    const up = b.action('key');
    for (const m of mods) up.up(m);
    await up.perform();
  }
}

// ---------------------------------------------------------------------- boot

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[agent-mcp] server connected on stdio\n');

  const shutdown = async () => {
    try {
      if (session.state !== 'idle') await session.stop('server-shutdown');
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
}

main().catch((err) => {
  process.stderr.write(`[agent-mcp] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
