/**
 * Stress-scenario framework. A Scenario is a deterministic (seeded-PRNG) loop
 * of app interactions run through a ScenarioContext. The context exposes the
 * same primitives as the MCP tools (eval/ipc/store reads+actions/keys) but as
 * direct Node calls, so a scenario can do thousands of interactions without the
 * per-call MCP round-trip. Every context primitive goes through the session
 * command mutex, so a scenario never interleaves with another WebDriver caller.
 *
 * A scenario FAILS by throwing (a thrown step aborts the run). Invariant
 * breaches should throw with a clear message. Timing/memory observations are
 * recorded as metrics (warnings), not failures; the oracle full-sweep that the
 * runner's callers perform afterwards turns real problems into findings.
 */
import type { Browser } from 'webdriverio';
import { invokeInApp, evalInApp } from '../lib/page';
import { readStore, callStoreAction, type StoreName } from '../lib/stores';

/** Minimal session surface a scenario needs; AppSession satisfies it. */
export interface ScenarioTarget {
  readonly browser: Browser;
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
}

export interface ScenarioContext {
  readonly browser: Browser;
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  eval<T = unknown>(body: string, args?: unknown[]): Promise<T>;
  ipc<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
  readStore(store: StoreName, path?: string | null): Promise<unknown>;
  callAction(
    store: StoreName,
    action: string,
    args?: unknown[],
  ): Promise<{ ok: boolean; result?: unknown; error?: string }>;
  keys(keys: string[]): Promise<void>;
  /** Uniform in [0, 1). Deterministic for a given seed. */
  rng(): number;
  /** Integer in [min, max] inclusive. */
  randInt(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  log(message: string): void;
  metric(key: string, delta?: number): void;
  setMetric(key: string, value: number): void;
  sleep(ms: number): Promise<void>;
  readonly metrics: Record<string, number>;
}

export interface Scenario {
  name: string;
  description: string;
  defaultIterations: number;
  run(ctx: ScenarioContext, opts: { iterations: number }): Promise<void>;
}

export interface ScenarioMetrics {
  scenario: string;
  seed: number;
  iterations: number;
  durationMs: number;
  metrics: Record<string, number>;
}

/** mulberry32: tiny, fast, deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeContext(
  target: ScenarioTarget,
  seed: number,
  onLog?: (message: string) => void,
): ScenarioContext & { metrics: Record<string, number> } {
  const rand = mulberry32(seed || 1);
  const metrics: Record<string, number> = {};
  return {
    get browser() {
      return target.browser;
    },
    metrics,
    exclusive: (fn) => target.exclusive(fn),
    eval: (body, args = []) => target.exclusive(() => evalInApp(target.browser, body, args)),
    ipc: (command, args) => target.exclusive(() => invokeInApp(target.browser, command, args)),
    readStore: (store, path = null) => target.exclusive(() => readStore(target.browser, store, path)),
    callAction: (store, action, args = []) =>
      target.exclusive(() => callStoreAction(target.browser, store, action, args)),
    keys: (keys) => target.exclusive(() => target.browser.keys(keys)),
    rng: () => rand(),
    randInt: (min, max) => min + Math.floor(rand() * (max - min + 1)),
    pick: (items) => items[Math.floor(rand() * items.length)] as (typeof items)[number],
    log: (message) => onLog?.(message),
    metric: (key, delta = 1) => {
      metrics[key] = (metrics[key] ?? 0) + delta;
    },
    setMetric: (key, value) => {
      metrics[key] = value;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
