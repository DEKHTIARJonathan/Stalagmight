/**
 * Parallel (fixture x seed) matrix runner for the `undo-redo-fuzz` scenario.
 *
 * Three runners, three jobs:
 *   - `pnpm agent:scenarios`   - every scenario once, at small n. A cheap gate.
 *   - `pnpm agent:scenario`    - ONE scenario at ONE seed. A repro, or a soak.
 *   - `pnpm agent:fuzz-matrix` - THIS: one scenario over MANY (fixture, seed)
 *     cells, K live app sessions at a time, aggregated into one verdict.
 *
 * Reach for it when the question is coverage rather than a single answer: "does
 * the undo/redo model survive seeds 1..8 on both fixtures?", or a sweep after
 * touching an undo path. Every cell is a CHILD PROCESS of `scenario-run.ts`, so
 * a cell that wedges, crashes the app or leaks a driver cannot take the matrix
 * down with it, and each cell gets its own app session, profile, Xvfb display
 * and port block.
 *
 *   pnpm agent:fuzz-matrix [--fixtures a.stalx,b.stalx] [--seeds 1..8|1,3,7]
 *                          [--workers K] [--iterations M]
 *
 * `STALAGMIGHT_FUZZ_ALLOW_KNOWN_BUGS` reaches every child unchanged:
 * undo-redo-fuzz reproduces open undo bugs, so a matrix run without it is
 * expected to be red on the seeds that reach them. Exits non-zero if any cell
 * failed. Run on the repo-pinned Node (`nvm use`); the children need Xvfb.
 */
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { checkBuildFreshness } from './lib/build';
import { agentBuildMode } from '../lib/env';
import { fixtureSourcePath } from './lib/fixtures';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The repo's own tsx, so no pnpm wrapper sits between us and the child. */
const TSX_BIN = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const CHILD_SCRIPT = path.join('e2e', 'agent', 'scenario-run.ts');
const SCENARIO = 'undo-redo-fuzz';
/** Size of session.ts's Xvfb display pool - one display per worker, so 5 is the ceiling. */
const MAX_WORKERS = 5;
const BASE_PORT = 4544;
const PORT_STRIDE = 20;
const TOP_DISPLAY = 89;
const DEFAULT_ITERATIONS = 60;
const CHILD_TIMEOUT_MS = 20 * 60 * 1000;
const TAIL_LINES = 15;
/**
 * Metrics that are per-run MAXIMA, not counters: merging them across the matrix
 * takes the max. Everything else is a tally (`op:createShot`, `mutations`,
 * `knownAsymmetry`, ...) and sums. A per-run constant such as `historyLimit`
 * still sums, so it reads as cells * constant - that is the documented rule.
 */
const MAX_MERGED_METRICS = new Set(['snapshotBytesMax', 'maxDepth']);

const USAGE =
  'usage: pnpm agent:fuzz-matrix [--fixtures a.stalx,b.stalx] [--seeds 1..8|1,3,7] ' +
  '[--workers K] [--iterations M] [--release]';

interface Options {
  fixtures: string[];
  seeds: number[];
  iterations: number;
  workers: number;
  /** Drive the release binary (STALAGMIGHT_AGENT_RELEASE=1 in every child). */
  release: boolean;
}

interface RunResult {
  fixture: string;
  seed: number;
  passed: boolean;
  durationMs: number;
  metrics: Record<string, number>;
  // FAIL only: the error's first line, the scenario's own `reproduce:` line
  // verbatim, and the last TAIL_LINES of output for a crash with no FAIL line.
  headline: string;
  reproduce: string;
  tail: string;
}

function bail(message: string): never {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
}

function parseSeeds(raw: string): number[] {
  const range = raw.match(/^(-?\d+)\.\.(-?\d+)$/);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (to < from) bail(`--seeds "${raw}" is an empty range (end < start)`);
    if (to - from > 999) bail(`--seeds "${raw}" spans more than 1000 seeds`);
    return Array.from({ length: to - from + 1 }, (_unused, i) => from + i);
  }
  const parts = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!parts.length) bail('--seeds needs at least one value');
  return parts.map((entry) => {
    if (!/^-?\d+$/.test(entry)) bail(`--seeds: "${entry}" is not an integer`);
    return Number(entry);
  });
}

function positiveInt(flag: string, raw: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) < 1) bail(`--${flag} needs a positive integer, got "${raw}"`);
  return Number(raw);
}

/**
 * A switch that also accepts `--flag=VALUE`. Presence alone is NOT enough:
 * `--release=0` reads as "no release" to everyone who types it, and treating it
 * as true would silently drive the release binary - where the `debug_assert!`s
 * and `debug_assertions`-gated self-checks that are oracles in their own right
 * are compiled out, so the sweep passes on seeds the debug build would fail.
 */
function booleanFlag(flag: string, raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  bail(`--${flag} takes 1/0, true/false, yes/no or on/off, got "${raw}"`);
}

function parseArgs(argv: string[]): Options {
  const known = new Set(['fixtures', 'seeds', 'workers', 'iterations', 'release']);
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) bail(`unexpected argument "${token}"`);
    const eq = token.indexOf('=');
    const flag = eq >= 0 ? token.slice(2, eq) : token.slice(2);
    if (!known.has(flag)) bail(`unknown flag --${flag}`);
    // `--release` is a boolean switch; every other flag takes a value.
    if (flag === 'release' && eq < 0) {
      raw[flag] = '1';
      continue;
    }
    const value = eq >= 0 ? token.slice(eq + 1) : argv[++i];
    if (value === undefined) bail(`--${flag} needs a value`);
    raw[flag] = value;
  }

  let workers = Math.min(4, Math.max(1, os.cpus().length - 2), MAX_WORKERS);
  if (raw.workers !== undefined) {
    workers = positiveInt('workers', raw.workers);
    if (workers > MAX_WORKERS) {
      process.stdout.write(
        `note: --workers ${workers} clamped to ${MAX_WORKERS}, the size of the Xvfb display pool\n`,
      );
      workers = MAX_WORKERS;
    }
  }

  // The fixture root stays defined in exactly one place (lib/fixtures.ts).
  const fixtureDir = path.dirname(fixtureSourcePath('probe.stalx'));
  let fixtures: string[];
  if (raw.fixtures === undefined) {
    fixtures = fs.readdirSync(fixtureDir).filter((name) => name.endsWith('.stalx')).sort();
    if (!fixtures.length) bail(`no *.stalx fixtures found in ${fixtureDir}`);
  } else {
    fixtures = raw.fixtures.split(',').map((entry) => entry.trim()).filter(Boolean);
    if (!fixtures.length) bail('--fixtures needs at least one basename');
    for (const fixture of fixtures) {
      if (fixture !== path.basename(fixture)) bail(`--fixtures takes basenames, got "${fixture}"`);
      if (!fixture.endsWith('.stalx')) bail(`--fixtures: "${fixture}" is not a .stalx`);
      if (!fs.existsSync(fixtureSourcePath(fixture))) bail(`no such fixture: ${fixtureSourcePath(fixture)}`);
    }
  }

  const seeds = raw.seeds === undefined ? [1, 2, 3, 4] : parseSeeds(raw.seeds);
  const iterations = raw.iterations === undefined ? DEFAULT_ITERATIONS : positiveInt('iterations', raw.iterations);
  const release = raw.release === undefined ? false : booleanFlag('release', raw.release);
  return { fixtures, seeds, iterations, workers, release };
}

/**
 * Worker isolation. A SLOT is a lane held by exactly one live child at a time;
 * the next queued cell only takes it after its occupant has exited.
 *
 * Ports: session.ts does findFreePort(BASE_PORT) over a span of 10, then
 * findFreePort(driverPort + 1000) over another 10. Slot i therefore claims
 * driver ports in [4544+20i, 4544+20i+10) and native ports within
 * [5544+20i, 5562+20i]. Slot i+1's driver window starts 20 above ours and its
 * native window at 5564+20i, so a stride of 20 keeps both windows disjoint.
 *
 * Displays: STALAGMIGHT_AGENT_DISPLAYS narrows the pool to exactly one display.
 * That is load-bearing. The default first-that-starts walk calls a display free
 * when Xvfb has not exited within 250 ms, so two sessions launched together can
 * both conclude they own :89. One display per slot removes the race.
 *
 * Replay knobs: DROPPED, not inherited. A cell GENERATES moves at its own seed,
 * so an exported STALAGMIGHT_FUZZ_REPLAY left over from triage would make every
 * cell replay that one trace - a full pass/fail table and merged metrics for
 * coverage nothing exercised - and an exported STALAGMIGHT_FUZZ_TRACE would
 * point all K concurrent workers at one output file to clobber in turn.
 */
const INHERITED_ENV_BLOCKLIST = ['STALAGMIGHT_FUZZ_REPLAY', 'STALAGMIGHT_FUZZ_TRACE'] as const;

function slotEnv(slot: number, fixture: string, release: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // Inherited wholesale, so STALAGMIGHT_FUZZ_ALLOW_KNOWN_BUGS reaches the
    // child exactly as the caller set it.
    ...process.env,
    STALAGMIGHT_FUZZ_FIXTURE: fixture,
    STALAGMIGHT_AGENT_BASE_PORT: String(BASE_PORT + slot * PORT_STRIDE),
    STALAGMIGHT_AGENT_DISPLAYS: `:${TOP_DISPLAY - slot}`,
    // `--release` on the matrix sets it for every child; an inherited
    // STALAGMIGHT_AGENT_RELEASE=1 already reaches them through the spread.
    ...(release ? { STALAGMIGHT_AGENT_RELEASE: '1' } : {}),
  };
  for (const key of INHERITED_ENV_BLOCKLIST) delete env[key];
  return env;
}

const live = new Set<ChildProcess>();

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    // Children are spawned detached, so each leads its own group: one signal
    // reaps tsx + tauri-driver + WebKitWebDriver + the app together.
    process.kill(-child.pid, signal);
  } catch {
    // Group already gone.
  }
}

/** Metrics live at the tail of a PASS line, before an optional ` findings=[...]`. */
function parseMetrics(line: string): Record<string, number> {
  const marker = line.match(/\(\d+ms\)\s/);
  if (!marker || marker.index === undefined) return {};
  let json = line.slice(marker.index + marker[0].length);
  const findingsAt = json.indexOf(' findings=');
  if (findingsAt >= 0) json = json.slice(0, findingsAt);
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function runOne(fixture: string, seed: number, slot: number, opts: Options, label: string): Promise<RunResult> {
  const startedAt = Date.now();
  process.stdout.write(
    `${label} start ${fixture} seed=${seed} slot=${slot} port=${BASE_PORT + slot * PORT_STRIDE} ` +
      `display=:${TOP_DISPLAY - slot}\n`,
  );

  return new Promise<RunResult>((resolve) => {
    const child = spawn(
      TSX_BIN,
      [CHILD_SCRIPT, SCENARIO, '--seed', String(seed), '--iterations', String(opts.iterations)],
      { cwd: repoRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: slotEnv(slot, fixture, opts.release) },
    );
    live.add(child);
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, 'SIGTERM');
      setTimeout(() => killGroup(child, 'SIGKILL'), 5000).unref();
    }, CHILD_TIMEOUT_MS);

    // 'error' (spawn failure) and 'close' both settle: a child that emits only
    // 'error' would otherwise hang its worker slot for the life of the run.
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      live.delete(child);
      const outLines = stdout.join('').split('\n');
      const allLines = outLines.concat(stderr.join('').split('\n'));
      const passLine = outLines.find((line) => line.startsWith('PASS: '));
      const failIndex = outLines.findIndex((line) => line.startsWith('FAIL: '));
      const passed = !spawnError && code === 0 && Boolean(passLine);

      let headline = '';
      if (spawnError) headline = `spawn failed: ${spawnError.message}`;
      else if (timedOut) headline = `timed out after ${Math.round(CHILD_TIMEOUT_MS / 60000)}min (process group killed)`;
      else if (!passed && failIndex >= 0) {
        const failLine = outLines[failIndex].slice('FAIL: '.length).trim();
        headline = failLine.endsWith('threw:')
          ? `${failLine} ${(outLines.slice(failIndex + 1).find((line) => line.trim()) ?? '').trim()}`
          : failLine;
      } else if (!passed) headline = `child exited code=${code} signal=${signal ?? 'none'} with no FAIL line`;

      resolve({
        fixture,
        seed,
        passed,
        durationMs: Date.now() - startedAt,
        metrics: passLine ? parseMetrics(passLine) : {},
        headline,
        reproduce: passed ? '' : (allLines.find((line) => line.trim().startsWith('reproduce:')) ?? '').trim(),
        tail: passed ? '' : allLines.filter((line) => line.trim()).slice(-TAIL_LINES).join('\n'),
      });
    };
    child.on('error', (err: Error) => finish(null, null, err));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function printDone(result: RunResult, label: string): void {
  process.stdout.write(
    `${label} ${result.passed ? 'PASS ' : 'FAIL '} ${result.fixture} seed=${result.seed} ` +
      `(${secs(result.durationMs)})${result.passed ? '' : ` ${result.headline}`}\n`,
  );
}

function printReport(results: RunResult[], wallMs: number): void {
  const rows = results.map((r) => [r.fixture, String(r.seed), r.passed ? 'PASS' : 'FAIL', secs(r.durationMs), r.headline]);
  const header = ['fixture', 'seed', 'result', 'duration', 'detail'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]): string =>
    cells.map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ').trimEnd();

  process.stdout.write(`\n=== fuzz matrix: ${results.length} cell(s) ===\n${line(header)}\n`);
  for (const row of rows) process.stdout.write(`${line(row)}\n`);

  const failures = results.filter((r) => !r.passed);
  if (failures.length) {
    process.stdout.write('\n=== repro commands ===\n');
    for (const failure of failures) {
      process.stdout.write(
        `${failure.fixture} seed=${failure.seed}: ` +
          `${failure.reproduce || `(no reproduce line) STALAGMIGHT_FUZZ_FIXTURE=${failure.fixture} pnpm agent:scenario ${SCENARIO} --seed ${failure.seed}`}\n`,
      );
      if (!failure.reproduce && failure.tail) {
        process.stdout.write(`${failure.tail.split('\n').map((l) => `    | ${l}`).join('\n')}\n`);
      }
    }
  }

  const merged: Record<string, number> = {};
  for (const result of results) {
    for (const [key, value] of Object.entries(result.metrics)) {
      merged[key] = MAX_MERGED_METRICS.has(key)
        ? Math.max(merged[key] ?? Number.NEGATIVE_INFINITY, value)
        : (merged[key] ?? 0) + value;
    }
  }
  process.stdout.write('\n=== merged metrics (max for snapshotBytesMax/maxDepth, sum otherwise) ===\n');
  for (const key of Object.keys(merged).sort()) process.stdout.write(`  ${key} = ${merged[key]}\n`);

  const serialMs = results.reduce((sum, r) => sum + r.durationMs, 0);
  process.stdout.write(
    `\nwall clock ${secs(wallMs)}; serial-equivalent ${secs(serialMs)}; ` +
      `speedup ${(serialMs / Math.max(wallMs, 1)).toFixed(2)}x\n` +
      `${failures.length} failed / ${results.length} run(s)\n`,
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(TSX_BIN)) bail(`tsx not found at ${TSX_BIN}; run pnpm install`);
  const dropped = INHERITED_ENV_BLOCKLIST.filter((key) => process.env[key] !== undefined);
  if (dropped.length > 0) {
    process.stdout.write(
      `note: ${dropped.join(', ')} is set but NOT passed to the cells - a matrix run generates its ` +
        `own moves. Use pnpm agent:scenario --trace to replay one.\n`,
    );
  }
  const cells = opts.fixtures.flatMap((fixture) => opts.seeds.map((seed) => ({ fixture, seed })));
  const workers = Math.min(opts.workers, cells.length);
  process.stdout.write(
    `${SCENARIO}: ${cells.length} cell(s) = ${opts.fixtures.length} fixture(s) x ${opts.seeds.length} seed(s), ` +
      `iterations=${opts.iterations}, workers=${workers}, ` +
      `mode=${opts.release ? 'release' : agentBuildMode()}\n`,
  );

  process.on('SIGINT', () => {
    process.stdout.write(`\ninterrupted: killing ${live.size} live child run(s)\n`);
    for (const child of live) killGroup(child, 'SIGTERM');
    setTimeout(() => {
      for (const child of live) killGroup(child, 'SIGKILL');
      process.exit(130);
    }, 2000);
  });

  const startedAt = Date.now();
  const results: RunResult[] = [];
  // WARM-UP: from a cold tree the first cell runs ALONE, because each child does
  // its own `build: 'auto'` and K concurrent cargo builds would just queue on the
  // target-dir lock (or time out waiting for it). One solo cell pays for the
  // build; the pool then starts against a fresh binary. Skipped when the binary
  // is already fresh - there is nothing to pay for, and serializing a cell would
  // cost a whole app session.
  const freshness = checkBuildFreshness({ mode: opts.release ? 'release' : agentBuildMode() });
  let next = 0;
  if (cells.length > 1 && workers > 1 && !freshness.fresh) {
    const first = cells[0];
    next = 1;
    const label = `[1/${cells.length}]`;
    process.stdout.write(`${label} warm-up alone (rebuild needed: ${freshness.reasons.join('; ')})\n`);
    const warm = await runOne(first.fixture, first.seed, 0, opts, label);
    results.push(warm);
    printDone(warm, label);
  }

  await Promise.all(
    Array.from({ length: workers }, (_unused, slot) =>
      (async () => {
        for (;;) {
          const index = next++;
          if (index >= cells.length) return;
          const cell = cells[index];
          const label = `[${index + 1}/${cells.length}]`;
          const result = await runOne(cell.fixture, cell.seed, slot, opts, label);
          results.push(result);
          printDone(result, label);
        }
      })(),
    ),
  );

  results.sort((a, b) => a.fixture.localeCompare(b.fixture) || a.seed - b.seed);
  printReport(results, Date.now() - startedAt);
  process.exit(results.some((result) => !result.passed) ? 1 : 0);
}

main().catch((err) => {
  for (const child of live) killGroup(child, 'SIGKILL');
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
