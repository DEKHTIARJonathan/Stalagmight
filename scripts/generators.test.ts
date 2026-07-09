/**
 * Golden tests for the agent-session generators (generate-replay.mjs and
 * generate-repro-report.mjs). Both are pure JSONL-in -> text-out transformers
 * with no test until now, so a parser regression shipped silently. Each test
 * builds a minimal-but-representative actions.jsonl fixture in a temp session
 * dir, runs the generator as a child process (the only supported interface),
 * and asserts the load-bearing lines of the output - "contains", not a full
 * snapshot, so cosmetic template tweaks don't churn the test.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..');
const replayGen = path.join(repoRoot, 'scripts', 'generate-replay.mjs');
const reportGen = path.join(repoRoot, 'scripts', 'generate-repro-report.mjs');

let sessionDir: string;

const record = (obj: object): string => JSON.stringify(obj);

beforeAll(() => {
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-gen-test-'));
  const ts = (s: number) => new Date(1751970000000 + s * 1000).toISOString();
  const lines = [
    record({
      type: 'session-start',
      v: 1,
      sessionId: 'golden-fixture',
      startedAt: ts(0),
      gitHead: 'abc1234',
      binaryPath: '/home/user/.cargo_build/debug/stalagmight',
      binaryMtime: 0,
      display: ':89',
      headed: false,
      profileDir: '/tmp/stalagmight-agent-x',
      freshProfile: true,
    }),
    record({
      type: 'action',
      v: 1,
      seq: 1,
      ts: ts(1),
      tool: 'seed',
      params: { mode: 'fixture', name: 'fractal_plant_iter2.stalx' },
      resolved: { path: '/repo/e2e/fixtures/fractal_plant_iter2.stalx' },
      outcome: { ok: true, durationMs: 120 },
    }),
    record({
      type: 'action',
      v: 1,
      seq: 2,
      ts: ts(2),
      tool: 'click',
      params: { testid: 'save-button' },
      resolved: { selector: '[data-testid="save-button"]' },
      outcome: { ok: true, durationMs: 40 },
    }),
    // A driver_script that TIMED OUT live: the replay must bound it with the
    // recorded timeout and tolerate the failure instead of hanging.
    record({
      type: 'action',
      v: 1,
      seq: 3,
      ts: ts(3),
      tool: 'driver_script',
      params: { script: 'while (true) { await ipc("get_recent_logs_since", {afterSeq: 0}); }', timeoutMs: 5000 },
      outcome: { ok: false, durationMs: 5001, error: 'driver_script timed out after 5000ms' },
    }),
    record({
      type: 'action',
      v: 1,
      seq: 4,
      ts: ts(4),
      tool: 'run_scenario',
      params: { name: 'mapStorm', seed: 7, iterations: 3 },
      outcome: { ok: true, durationMs: 9000 },
    }),
    record({
      type: 'event',
      v: 1,
      seq: 4,
      ts: ts(5),
      event: 'finding',
      detail: { severity: 'error', kind: 'log-error', message: 'ERROR something broke' },
    }),
    record({
      type: 'action',
      v: 1,
      seq: 5,
      ts: ts(6),
      tool: 'store_state',
      params: { store: 'project', path: 'isDirty' },
      outcome: { ok: true, durationMs: 10 },
      result: { value: false },
    }),
    record({ type: 'session-end', v: 1, ts: ts(7), reason: 'app_stop', actions: 5 }),
  ];
  fs.writeFileSync(path.join(sessionDir, 'actions.jsonl'), `${lines.join('\n')}\n`);
});

afterAll(() => {
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

describe('generate-replay.mjs', () => {
  it('emits executable steps for every mutating action, bounded and tolerant for recorded failures', () => {
    const out = path.join(sessionDir, 'replay.spec.ts');
    execFileSync(process.execPath, [replayGen, sessionDir, '--out', out], { encoding: 'utf8' });
    const spec = fs.readFileSync(out, 'utf8');

    // seed -> a real openProject call using the RESOLVED fixture path.
    expect(spec).toContain(`'openProject', ["/repo/e2e/fixtures/fractal_plant_iter2.stalx"]`);
    // click -> the resolved selector, clicked.
    expect(spec).toContain(`await $("[data-testid=\\"save-button\\"]").click();`);
    // Timed-out driver_script -> recorded timeout threaded through AND the
    // failure tolerated, so the replay proceeds past it the way the live run did.
    const dsLine = spec.split('\n').find((l) => l.includes('driverScript(browser,'));
    expect(dsLine).toBeDefined();
    expect(dsLine).toContain(', 5000)');
    expect(dsLine).toContain('.catch(() => undefined); // recorded as FAILED');
    // run_scenario -> deterministic replay with the recorded seed + iterations.
    expect(spec).toContain(`await runScenarioReplay(browser, "mapStorm", 7, 3);`);
    // Observation-only tools stay comments.
    expect(spec).toContain('store_state');
    expect(spec).not.toContain('await storeState');
  });
});

describe('generate-repro-report.mjs', () => {
  it('produces a report.md with the mutating steps and the recorded finding, scrubbed of $HOME', () => {
    execFileSync(process.execPath, [reportGen, sessionDir, '--title', 'Golden fixture'], {
      encoding: 'utf8',
    });
    const md = fs.readFileSync(path.join(sessionDir, 'report.md'), 'utf8');

    expect(md).toContain('Golden fixture');
    // The mutating actions appear as repro steps; observations do not lead.
    expect(md).toContain('seed');
    expect(md).toContain('run_scenario');
    expect(md).toContain('mapStorm');
    // The oracle finding is surfaced.
    expect(md).toContain('log-error');
    // Public-paste hygiene: no raw $HOME-bearing absolute path survives.
    const home = process.env.HOME ?? '';
    if (home) expect(md).not.toContain(`${home}/`);
  });
});
