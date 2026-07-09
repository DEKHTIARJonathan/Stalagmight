// hygiene MUST be first: it silences wdio + routes console.* off stdout before
// webdriverio (imported transitively via ./session) can log there.
import './hygiene';
import * as fs from 'fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AppSession } from '../session';
import { readStore, callStoreAction, postDigest, type StoreName } from '../lib/stores';
import { LogCursor, type LogLevel } from '../lib/logs';
import { invokeInApp, evalInApp, capJson } from '../lib/page';
import { newOracleState, runSweep, type OracleState } from '../lib/oracles';
import { listScenarios, runScenario } from '../scenarios';
import { fixturePath, DEFAULT_FIXTURE } from '../scenarios/common';
import {
  waitForAppReady,
  waitForUiIdle,
  waitForMapIdle,
  waitForActiveTool,
} from '../lib/waiters';

const STORE_NAMES = ['ui', 'project', 'globalView', 'gasPlan', 'speleo', 'export', 'network'] as const;

const session = new AppSession();
let logCursor: LogCursor | null = null;
let oracleState: OracleState = newOracleState();

type ToolResult = { content: Array<Record<string, unknown>>; isError?: boolean };

function textResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value ?? null) }] };
}
function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}
function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
      // Under the command mutex like every other WebDriver call - a raw
      // browser.execute here was the one path that could interleave with a
      // concurrent tool's exclusive block.
      if (opts.digest) {
        post = await session.exclusive(() => postDigest(session.browser)).catch(() => undefined);
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
    if (session.hasRecorder) {
      session.recorder.action({
        seq,
        ts: new Date().toISOString(),
        tool,
        params,
        outcome: { ok: false, durationMs: Date.now() - start, error: asMessage(err) },
      });
    }
    throw err;
  }
}

/**
 * Record a tool call, then (for mutating tools) run a cheap oracle sweep and
 * merge any new findings into the JSON envelope so the agent sees problems the
 * moment they appear. The tool's own result object is spread at the top level;
 * findings ride under `oracle`.
 */
async function run(
  tool: string,
  params: unknown,
  fn: (seq: number) => Promise<RunOutput<unknown>>,
  opts: { digest?: boolean; sweep?: boolean } = {},
): Promise<ToolResult> {
  try {
    const result = await record(tool, params, fn, { digest: opts.digest });
    const envelope: Record<string, unknown> =
      result && typeof result === 'object' ? { ...(result as Record<string, unknown>) } : { value: result };
    if (opts.sweep) {
      const oracle = await sweepBestEffort();
      if (oracle) envelope.oracle = oracle;
    }
    return textResult(envelope);
  } catch (err) {
    // A failed action is the highest-signal moment for the oracle (the failure
    // may BE the crash), so sweep on the error path too.
    const payload: Record<string, unknown> = { error: asMessage(err) };
    if (opts.sweep) {
      const oracle = await sweepBestEffort();
      if (oracle) payload.oracle = oracle;
    }
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true };
  }
}

/**
 * Reset oracle state and align its ring cursor to the CURRENT ring tail, so
 * the first post-action sweep only reports lines emitted after this point.
 * Startup noise (benign boot-time warnings) predates any agent interaction
 * and must not be attributed to the first tool call - this mirrors what
 * LogCursor.checkpoint() already does for the `logs` tool.
 */
async function resetOracles(): Promise<void> {
  oracleState = newOracleState();
  try {
    const logs = await session.exclusive(() =>
      invokeInApp<{ latest_seq: number }>(session.browser, 'get_recent_logs_since', { afterSeq: 0 }),
    );
    oracleState.logCursor = logs.latest_seq;
  } catch {
    // Best-effort: a failed checkpoint only means the first sweep may include
    // startup lines.
  }
}

/** Cheap sweep that never throws; returns an `oracle` block or null. */
async function sweepBestEffort(): Promise<{ worst: unknown; findings: unknown[] } | null> {
  try {
    const sweep = await runSweep(session, oracleState, {
      recorder: session.hasRecorder ? session.recorder : undefined,
    });
    return sweep.newFindings.length ? { worst: sweep.worst, findings: sweep.newFindings } : null;
  } catch {
    return null;
  }
}

const server = new McpServer({ name: 'stalagmight-app', version: '0.1.0' });

// The MCP SDK does NOT serialize tool handlers: protocol.js's _onrequest fires
// each handler via Promise.resolve().then(...) without awaiting it, so a client
// that pipelines two tool calls runs both handlers concurrently. The session's
// exclusive() mutex only covers the WebDriver leg inside each handler - the
// recorder seq allocation, the oracle sweep bookkeeping (oracleState.reported /
// logCursor / findingCount), and postDigest would still interleave across
// tools. Serialize WHOLE handlers here so one tool call fully completes
// (mutation + digest + sweep) before the next begins.
let toolChain: Promise<unknown> = Promise.resolve();

function define<S extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>,
  opts: { serialize?: boolean } = {},
): void {
  const wrapped =
    opts.serialize === false
      ? handler
      : (args: z.infer<z.ZodObject<S>>): Promise<ToolResult> => {
          const run = toolChain.then(() => handler(args));
          toolChain = run.catch(() => undefined);
          return run;
        };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.registerTool(name, { description, inputSchema: schema }, wrapped as any);
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
      await resetOracles();
      logCursor = new LogCursor(session.browser);
      await logCursor.checkpoint().catch(() => undefined);
      return textResult(res);
    } catch (err) {
      return errorResult(asMessage(err));
    }
  },
);

define('app_stop', 'Close the app and driver, freeing the session.', {}, async () => {
  try {
    await session.stop('app_stop');
    logCursor = null;
    return textResult({ stopped: true });
  } catch (err) {
    return errorResult(asMessage(err));
  }
});

define(
  'app_restart',
  'Stop and restart the session. By default keeps the profile (to reproduce persisted-state bugs).',
  { freshProfile: z.boolean().optional() },
  async (args) => {
    try {
      const fresh = args.freshProfile ?? false;
      // Keep the profile dir across the stop unless a fresh one was requested;
      // this is what makes "restart with persisted state" actually persist.
      await session.stop('app_restart', { keepProfile: !fresh });
      const res = await session.start({ build: 'skip', freshProfile: fresh });
      await resetOracles();
      logCursor = new LogCursor(session.browser);
      await logCursor.checkpoint().catch(() => undefined);
      return textResult(res);
    } catch (err) {
      return errorResult(asMessage(err));
    }
  },
);

// serialize:false - a pure in-process read with no WebDriver/recorder/oracle
// touch, kept unserialized so it stays a usable liveness probe even while a
// long build or scenario holds the tool chain.
define(
  'app_status',
  'Report session liveness and basic info.',
  {},
  async () => {
    return textResult({
      state: session.state,
      uptimeMs: session.uptimeMs(),
      driverAlive: session.driverAlive(),
      sessionDir: session.sessionDir,
      node: process.versions.node,
    });
  },
  { serialize: false },
);

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
    return errorResult(asMessage(err));
  }
});

define(
  'store_state',
  'Read a Zustand store. With no path, returns a key/type summary; with a dot path, the value (JSON-capped).',
  { store: z.enum(STORE_NAMES), path: z.string().optional(), maxBytes: z.number().optional() },
  (args) =>
    run('store_state', args, async () => ({
      result: await session.exclusive(() =>
        readStore(session.browser, args.store as StoreName, args.path ?? null, args.maxBytes ?? 16384),
      ),
    })),
);

define(
  'logs',
  'Return ring-buffer log lines since the last read. level filters output; peek does not advance the cursor.',
  { level: z.enum(['all', 'warn', 'error']).optional(), peek: z.boolean().optional() },
  (args) =>
    run('logs', args, async () => {
      if (!logCursor) throw new Error('no session (call app_start)');
      return { result: await session.exclusive(() => logCursor!.read((args.level ?? 'error') as LogLevel, args.peek)) };
    }),
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
  (args) =>
    run('wait_for', args, async () => {
      const timeout = args.timeoutMs ?? 10000;
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
    }),
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
  (args) =>
    run(
      'click',
      args,
      async () => {
        const b = session.browser;
        const selector = args.testid ? `[data-testid="${args.testid}"]` : args.selector;
        const button = args.button ?? 'left';
        return session.exclusive(async () => {
          let point: { x: number; y: number } | undefined;
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
      { digest: true, sweep: true },
    ),
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
  (args) =>
    run(
      'type_text',
      args,
      async () => {
        const b = session.browser;
        const selector = args.testid ? `[data-testid="${args.testid}"]` : args.selector;
        return session.exclusive(async () => {
          let method: 'keys' | 'paste' = 'keys';
          let verified: boolean | null = null;
          if (selector) {
            const el = b.$(selector);
            await el.waitForDisplayed({ timeout: 5000 });
            if (args.clear) await el.clearValue();
            await el.setValue(args.text);
            // WebKitWebDriver can coalesce rapid repeated keystrokes ("8000"
            // arriving as "800"), silently corrupting input. Verify the value
            // landed; on mismatch fall back to a synthetic paste through the
            // native value setter + input event (React-compatible).
            const landed = (await el.getValue().catch(() => null)) as string | null;
            if (typeof landed === 'string') {
              verified = landed === args.text;
              if (!verified) {
                method = 'paste';
                await evalInApp(
                  b,
                  `
                  const el = document.querySelector(args[0]);
                  if (!el) return false;
                  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                  setter.call(el, args[1]);
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  return true;
                `,
                  [selector, args.text],
                );
                const after = (await el.getValue().catch(() => null)) as string | null;
                verified = after === args.text;
              }
            }
          } else {
            await b.keys(args.text.split(''));
          }
          if (args.submit) await b.keys(['Enter']);
          return { result: { typed: true, method, verified }, resolved: { selector } };
        });
      },
      { digest: true, sweep: true },
    ),
);

define('press_keys', 'Press a sequence of WebDriver keys (e.g. ["Control","z"]).', {
  keys: z.array(z.string()),
}, (args) =>
  run(
    'press_keys',
    args,
    async () => {
      await session.exclusive(() => session.browser.keys(args.keys));
      return { result: { pressed: args.keys } };
    },
    { digest: true, sweep: true },
  ),
);

// ------------------------------------------------------------ escape hatches

define('eval', 'Run an async function body in the webview (page context) and return its value.', {
  script: z.string(),
  args: z.array(z.unknown()).optional(),
}, (args) =>
  run(
    'eval',
    args,
    async () => ({
      result: capJson(await session.exclusive(() => evalInApp(session.browser, args.script, args.args ?? [])), 16384),
    }),
    { sweep: true },
  ),
);

define('ipc', 'Invoke a Tauri command from the webview (e.g. get_recent_logs_since, check_project_integrity).', {
  command: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
}, (args) =>
  run(
    'ipc',
    args,
    async () => ({
      result: capJson(await session.exclusive(() => invokeInApp(session.browser, args.command, args.args)), 16384),
    }),
    { sweep: true },
  ),
);

define(
  'store_action',
  'Call an action on a Zustand store (generic seeding/driving primitive).',
  { store: z.enum(STORE_NAMES), action: z.string(), args: z.array(z.unknown()).optional() },
  (args) =>
    run(
      'store_action',
      args,
      async () => ({
        result: await session.exclusive(() =>
          callStoreAction(session.browser, args.store as StoreName, args.action, args.args ?? []),
        ),
      }),
      { digest: true, sweep: true },
    ),
);

// ---------------------------------------------------------------------- map

define('map_view', 'Read or set the MapLibre view (center/zoom/bearing).', {
  set: z
    .object({ center: z.array(z.number()).optional(), zoom: z.number().optional(), bearing: z.number().optional() })
    .optional(),
}, (args) =>
  run('map_view', args, async () => ({
    result: await session.exclusive(() =>
      evalInApp<{ ok: boolean; view?: unknown }>(
        session.browser,
        `
        const map = window.__stalagmight_map__;
        if (!map) return { ok: false };
        const set = args[0];
        if (set) map.jumpTo({ ...(set.center ? { center: set.center } : {}), ...(set.zoom != null ? { zoom: set.zoom } : {}), ...(set.bearing != null ? { bearing: set.bearing } : {}) });
        return { ok: true, view: { center: map.getCenter && map.getCenter(), zoom: map.getZoom && map.getZoom(), bearing: map.getBearing && map.getBearing() } };
      `,
        [args.set ?? null],
      ),
    ),
  })),
);

define('map_click', 'Click a geographic point on the map canvas (lngLat -> pixel via map.project).', {
  lngLat: z.array(z.number()).length(2),
  button: z.enum(['left', 'right']).optional(),
}, (args) =>
  run(
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
          const canvas = document.querySelector('[data-testid="map-canvas"]') || document.querySelector('.maplibregl-canvas');
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
    { digest: true, sweep: true },
  ),
);

// ----------------------------------------------------------------- seeding

define(
  'seed',
  'Seed a project: open a fixture (.stalx), open a fractal fixture, or create a basic empty project. Fixtures resolve under e2e/fixtures/.',
  {
    mode: z.enum(['fixture', 'fractal', 'basic']),
    name: z.string().optional(),
    projectName: z.string().optional(),
  },
  (args) =>
    run(
      'seed',
      args,
      async () => {
        if (args.mode === 'basic') {
          const res = await session.exclusive(() =>
            callStoreAction(session.browser, 'project', 'createProject', [args.projectName ?? 'harness-project']),
          );
          return { result: { mode: 'basic', result: res } };
        }
        const fixture = args.name ?? (args.mode === 'fractal' ? 'fractal_plant_iter2.stalx' : DEFAULT_FIXTURE);
        const p = fixturePath(fixture);
        if (!fs.existsSync(p)) {
          throw new Error(`fixture not found: ${p} (fixtures live under e2e/fixtures/)`);
        }
        const res = await session.exclusive(() =>
          callStoreAction(session.browser, 'project', 'openProject', [p]),
        );
        return { result: { mode: args.mode, fixture, result: res }, resolved: { path: p } };
      },
      { digest: true, sweep: true },
    ),
);

// -------------------------------------------------------------- escape hatch: driver script

define(
  'driver_script',
  'Run a Node-context async function body with browser/ipc/evalInApp/readStore/callAction/log in scope, under the session mutex, for tight stress loops (one MCP call per action is ~100x too slow). Returns the value (JSON-capped).',
  { script: z.string(), timeoutMs: z.number().optional() },
  (args) =>
    run(
      'driver_script',
      args,
      async () => {
        const timeoutMs = args.timeoutMs ?? 60000;
        const value = await session.exclusive(async () => {
          // A promise cannot be killed: on timeout the script body keeps
          // running even though the mutex is released. Fence every helper
          // (and the browser proxy) so a timed-out script cannot keep driving
          // the app concurrently with later tool calls.
          let expired = false;
          const fence = () => {
            if (expired) throw new Error('driver_script timed out; its helpers are disabled');
          };
          const helpers = {
            browser: new Proxy(session.browser, {
              get(target, prop) {
                fence();
                const v = Reflect.get(target, prop) as unknown;
                return typeof v === 'function'
                  ? (v as (...a: unknown[]) => unknown).bind(target)
                  : v;
              },
            }),
            ipc: (c: string, a?: Record<string, unknown>) => {
              fence();
              return invokeInApp(session.browser, c, a);
            },
            evalInApp: (b: string, a?: unknown[]) => {
              fence();
              return evalInApp(session.browser, b, a ?? []);
            },
            readStore: (s: StoreName, p?: string) => {
              fence();
              return readStore(session.browser, s, p ?? null);
            },
            callAction: (s: StoreName, act: string, a?: unknown[]) => {
              fence();
              return callStoreAction(session.browser, s, act, a ?? []);
            },
            log: (m: unknown) => {
              if (session.hasRecorder) session.recorder.event('driver-log', { message: String(m) });
            },
          };
          // eslint-disable-next-line no-new-func
          const fn = new Function(
            'helpers',
            `return (async () => { const { browser, ipc, evalInApp, readStore, callAction, log } = helpers; ${args.script} })();`,
          );
          const body = fn(helpers) as Promise<unknown>;
          const raced = await withTimeout(body, timeoutMs);
          if (raced === TIMED_OUT) {
            expired = true;
            if (session.hasRecorder) session.recorder.event('driver-script-timeout', { timeoutMs });
            // A promise cannot be killed, and the fence only stops NEW helper
            // calls - an already-awaiting WebDriver command, or a script
            // driving an unproxied element/action handle, keeps running. Hold
            // the mutex for a bounded grace so it can settle; if the body is
            // STILL running after that, poison the session (state 'crashed')
            // so no later tool call can interleave with it on the same
            // WebDriver session - only app_restart recovers.
            const settled = await withTimeout(
              body.catch(() => undefined),
              10000,
            );
            if (settled === TIMED_OUT) {
              session.state = 'crashed';
              if (session.hasRecorder) {
                session.recorder.event('crash-detected', { reason: 'driver-script-wedged', timeoutMs });
              }
              throw new Error(
                `driver_script timed out after ${timeoutMs}ms and is still running; ` +
                  'session disabled to prevent concurrent WebDriver traffic - call app_restart',
              );
            }
            throw new Error(
              `driver_script timed out after ${timeoutMs}ms (body settled during the grace window; helpers disabled)`,
            );
          }
          return raced;
        });
        return { result: capJson(value, 16384) };
      },
      { sweep: true },
    ),
);

// ------------------------------------------------------------- oracles + scenarios

define(
  'check_problems',
  'Run the full oracle sweep: crash markers, error/warn logs, error boundary, project integrity, leftover temp files, memory growth, and a responsiveness probe. Use after scenarios and before ending a session.',
  {},
  async () => {
    try {
      const result = await record('check_problems', {}, async () => {
        const sweep = await runSweep(session, oracleState, {
          full: true,
          recorder: session.hasRecorder ? session.recorder : undefined,
        });
        return {
          result: {
            ok: sweep.worst === null,
            worst: sweep.worst,
            findings: sweep.findings,
            newFindings: sweep.newFindings,
          },
        };
      });
      return textResult(result);
    } catch (err) {
      return errorResult(asMessage(err));
    }
  },
);

define(
  'run_scenario',
  `Run a named stress scenario against the current session, then a full sweep. Scenarios: ${listScenarios().join(', ')}.`,
  { name: z.string(), seed: z.number().optional(), iterations: z.number().optional() },
  async (args) => {
    try {
      // record() puts the scenario run in actions.jsonl so replays and repro
      // reports include it (a scenario is a mutating action, not observation).
      const metrics = await record('run_scenario', args, async () => ({
        result: await runScenario(args.name, session, {
          seed: args.seed,
          iterations: args.iterations,
          log: (m) => {
            if (session.hasRecorder) session.recorder.event('scenario-log', { scenario: args.name, message: m });
          },
        }),
      }));
      const sweep = await runSweep(session, oracleState, {
        full: true,
        recorder: session.hasRecorder ? session.recorder : undefined,
      });
      return textResult({
        scenario: args.name,
        metrics,
        ok: sweep.worst === null || sweep.worst === 'warning',
        worst: sweep.worst,
        findings: sweep.findings,
      });
    } catch (err) {
      return errorResult(asMessage(err));
    }
  },
);

// -------------------------------------------------------------- helpers

const TIMED_OUT = Symbol('timed-out');
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
  try {
    const pointer = b
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .down({ button })
      .up({ button });
    if (double) pointer.down({ button }).up({ button });
    await pointer.perform();
  } finally {
    // Always release modifiers, or a failed click leaves e.g. Control held
    // down for every subsequent action in the session.
    if (mods.length) {
      const up = b.action('key');
      for (const m of mods) up.up(m);
      await up.perform().catch(() => undefined);
    }
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
