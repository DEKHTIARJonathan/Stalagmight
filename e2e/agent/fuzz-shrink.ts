/**
 * Automatic minimization of a recorded fuzz trace.
 *
 *   pnpm agent:fuzz-shrink <trace.json> [--release] [--max-tests N] [--out FILE]
 *
 * Give it the trace a failing fuzz run left in the session artifacts dir and it
 * returns the SHORTEST subsequence of that run's moves which still fails the same
 * way, plus a numbered action list you can transcribe straight into a Rust test.
 * That is the step triage used to do by hand.
 *
 * ## How a replay is run
 *
 * ONE app session for the whole shrink, and one `runScenario` call per candidate.
 * A scenario already resets everything it depends on at the start of a run - it
 * closes whatever project is open, materializes a FRESH copy of the fixture,
 * deletes that copy's persisted undo history, re-injects the oracle (which resets
 * the snapshot model) and asserts both stacks came up empty - so a replay
 * inherits nothing from the one before it. Paying a process start per candidate
 * instead would roughly quadruple the wall clock for no isolation the scenario
 * does not already provide, and the assertion that both stacks are empty is the
 * tripwire if that ever stops being true.
 *
 * ## What "still fails the same way" means
 *
 * The target signature is taken from the FIRST replay of the unshrunk trace, not
 * from the header the recording wrote. Those should agree, and the run says so
 * when they do not - but if the build has moved since the recording, the honest
 * baseline is what this binary actually does now, and a shrink against a stale
 * signature would reject everything.
 *
 * A candidate that fails DIFFERENTLY is rejected exactly like one that passes
 * (`fuzzShrink.ts` documents why, and the divergent count is reported), so a
 * shrink cannot wander off onto one of the other ten open bugs.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AppSession } from './session';
import { getScenario, runScenario } from './scenarios';
import {
  describeSignature,
  describeSteps,
  failureSignature,
  readTrace,
  sameSignature,
  writeTrace,
  type FailureSignature,
  type FuzzTrace,
  type TraceStep,
} from './lib/fuzzTrace';
import { ddmin, type ShrinkVerdict } from './lib/fuzzShrink';

interface Args {
  trace: string;
  release: boolean;
  maxTests: number;
  out: string | null;
}

function parseArgs(argv: string[]): Args {
  const [trace, ...rest] = argv;
  if (!trace) {
    throw new Error('usage: pnpm agent:fuzz-shrink <trace.json> [--release] [--max-tests N] [--out FILE]');
  }
  const args: Args = { trace: path.resolve(trace), release: false, maxTests: 0, out: null };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--release') {
      args.release = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined) throw new Error(`flag ${flag} needs a value`);
    i += 1;
    if (flag === '--max-tests') args.maxTests = Number(value);
    else if (flag === '--out') args.out = path.resolve(value);
    else throw new Error(`unknown flag ${flag}`);
  }
  return args;
}

/** Outcome of replaying one candidate: null when it passed. */
type ReplayOutcome = { message: string; signature: FailureSignature } | null;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const trace = readTrace(args.trace);
  if (!getScenario(trace.scenario)) {
    throw new Error(`trace names scenario "${trace.scenario}", which this build does not have`);
  }
  if (args.release) process.env.STALAGMIGHT_AGENT_RELEASE = '1';

  // The env the recording ran under is part of the repro: tolerance, fixture,
  // stream and the persistence knobs all change what a replay does. Restore it
  // rather than inheriting whatever shell the shrink was started from.
  for (const [key, value] of Object.entries(trace.env)) process.env[key] = value;

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-shrink-'));
  const candidatePath = path.join(scratch, 'candidate.json');
  // Point the scenario's own trace-on-failure at the scratch dir, so a shrink
  // does not litter the artifacts dir with one file per rejected candidate.
  process.env.STALAGMIGHT_FUZZ_TRACE = path.join(scratch, 'replay-out.json');
  process.env.STALAGMIGHT_FUZZ_REPLAY = candidatePath;

  const session = new AppSession();
  const started = await session.start({ build: 'auto' });
  process.stdout.write(
    `session ${started.state} (${started.buildMode} build ${started.buildAction})\n` +
      `trace ${args.trace}\n` +
      `  scenario=${trace.scenario} seed=${trace.seed} fixture=${trace.fixture} ` +
      `steps=${trace.steps.length} rev=${trace.gitRev.slice(0, 12)}\n` +
      `  env=${JSON.stringify(trace.env)}\n`,
  );

  const replayTimesMs: number[] = [];
  const replay = async (steps: readonly TraceStep[]): Promise<ReplayOutcome> => {
    writeTrace(candidatePath, { ...trace, steps: [...steps], failure: null });
    const started = Date.now();
    try {
      await runScenario(trace.scenario, session, { seed: trace.seed, iterations: trace.iterations });
      return null;
    } catch (err) {
      return {
        message: err instanceof Error ? err.message : String(err),
        signature: failureSignature(err instanceof Error ? err.message : String(err)),
      };
    } finally {
      replayTimesMs.push(Date.now() - started);
    }
  };

  const wallStart = Date.now();
  let failed = false;
  let minimal: TraceStep[] = trace.steps;

  try {
    // 1. Establish the baseline by replaying the whole trace.
    const baseline = await replay(trace.steps);
    if (!baseline) {
      process.stdout.write(
        'the trace REPLAYED GREEN: nothing to shrink.\n' +
          '  Either the bug is fixed, or the failure needed something the trace does not carry.\n',
      );
      failed = true;
      return;
    }
    process.stdout.write(`baseline failure reproduced in ${replayTimesMs[0]} ms:\n${describeSignature(baseline.signature)}\n`);
    if (trace.failure && !sameSignature(trace.failure.signature, baseline.signature)) {
      process.stdout.write(
        'NOTE: the replay signature differs from the one recorded in the trace header.\n' +
          `  recorded:\n${describeSignature(trace.failure.signature)}\n` +
          '  Shrinking against the REPLAYED signature, which is what this build does now.\n',
      );
    }
    const target = baseline.signature;

    // 2. ddmin.
    const result = await ddmin(trace.steps, {
      maxTests: args.maxTests,
      test: async (candidate): Promise<ShrinkVerdict> => {
        const outcome = await replay(candidate);
        if (!outcome) return 'passed';
        return sameSignature(outcome.signature, target) ? 'preserved' : 'divergent';
      },
      onProgress: (info) => {
        process.stdout.write(
          `  [${String(info.stats.tests).padStart(3)}] tried ${String(info.candidateSize).padStart(3)} step(s) ` +
            `-> ${info.verdict} (best ${info.bestSize})\n`,
        );
      },
    });
    minimal = result.minimal;

    const wallMs = Date.now() - wallStart;
    const perReplay = replayTimesMs.reduce((sum, ms) => sum + ms, 0) / Math.max(replayTimesMs.length, 1);
    const outPath = args.out ?? args.trace.replace(/\.json$/, '') + '.min.json';
    writeTrace(outPath, {
      ...trace,
      steps: minimal,
      failure: { message: baseline.message, signature: target },
    });

    process.stdout.write(
      [
        '',
        `SHRUNK ${trace.steps.length} -> ${minimal.length} step(s)` +
          `${args.maxTests > 0 && result.stats.tests >= args.maxTests ? ' (budget exhausted: SMALLEST FOUND, not proven 1-minimal)' : ' (1-minimal: no single step can still be removed)'}`,
        `  replays: ${result.stats.tests} (+${result.stats.cacheHits} cached) - ` +
          `${result.stats.preserved} preserved, ${result.stats.passed} lost the failure, ` +
          `${result.stats.divergent} failed DIFFERENTLY and were rejected`,
        `  wall clock: ${(wallMs / 1000).toFixed(1)} s, ${Math.round(perReplay)} ms per replay ` +
          `(${replayTimesMs.length} replays incl. the baseline)`,
        `  minimal trace: ${outPath}`,
        '',
        'minimal action list:',
        describeSteps(minimal),
        '',
      ].join('\n'),
    );
  } catch (err) {
    failed = true;
    process.stdout.write(`shrink failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  } finally {
    await session.stop('fuzz-shrink');
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

/** Re-exported for the type checker's benefit; the CLI is the only consumer. */
export type { FuzzTrace };
