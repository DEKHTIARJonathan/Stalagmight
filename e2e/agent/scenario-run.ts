/**
 * Run ONE stress scenario against a live app session, at a chosen seed and
 * iteration count, then a full oracle sweep. The companion to
 * `scenarios-smoke.ts` (which runs every scenario once at small n): this is the
 * one to reach for when a seeded scenario needs re-running - a fuzzer repro, or
 * a long soak at a bigger n than the gate would tolerate.
 *
 * Run on the repo-pinned Node (`nvm use`), with a display or under xvfb:
 *
 *   pnpm agent:scenario undo-redo-fuzz --seed 7 --iterations 60
 *
 * `--trace <file>` REPLAYS a recorded trace instead of drawing moves - same
 * bridge, same oracles, same model, same failure payload; only the source of the
 * decisions changes. A trace is dropped into the session artifacts dir whenever
 * a fuzz run fails, so the usual loop is "run, fail, replay the trace it left,
 * then `pnpm agent:fuzz-shrink` it".
 *
 * `--release` (or `STALAGMIGHT_AGENT_RELEASE=1`) drives the release binary
 * instead of the debug one. Opt-in on purpose: a debug build's `debug_assert!`s
 * and `debug_assertions`-gated self-checks are oracles in their own right, so
 * the default keeps them. See docs/agent-harness.md.
 *
 * Exits non-zero when the scenario throws or the sweep reports a fatal finding,
 * so it works as a one-off gate too.
 */
import * as path from 'path';
import { AppSession } from './session';
import { getScenario, listScenarios, runScenario } from './scenarios';
import { runSweep, newOracleState } from './lib/oracles';

interface Args {
  name: string;
  seed?: number;
  iterations?: number;
  release: boolean;
  /** Replay a recorded trace instead of drawing moves. */
  trace?: string;
}

function parseArgs(argv: string[]): Args {
  const [name, ...rest] = argv;
  if (!name) {
    throw new Error(
      `usage: pnpm agent:scenario <name> [--seed N] [--iterations M] [--release] [--trace FILE]\n` +
        `known: ${listScenarios().join(', ')}`,
    );
  }
  const args: Args = { name, release: false };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--release') {
      args.release = true;
      continue;
    }
    if (flag === '--trace') {
      const value = rest[i + 1];
      if (value === undefined) throw new Error('--trace needs a path');
      i += 1;
      args.trace = value;
      continue;
    }
    const raw = rest[i + 1];
    const value = Number(raw);
    if (raw === undefined || !Number.isFinite(value)) {
      throw new Error(`flag ${flag} needs a numeric value`);
    }
    i += 1;
    if (flag === '--seed') args.seed = value;
    else if (flag === '--iterations') args.iterations = value;
    else throw new Error(`unknown flag ${flag}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!getScenario(args.name)) {
    throw new Error(`unknown scenario "${args.name}"; known: ${listScenarios().join(', ')}`);
  }

  // Set BEFORE `session.start()`: `agentBuildMode()` is read at call time, which
  // is what lets a flag parsed after this module's imports still take effect.
  if (args.release) process.env.STALAGMIGHT_AGENT_RELEASE = '1';
  // Same reason, and it is how replay reaches the scenario: the scenarios read
  // their knobs from the environment, so the flag is just a nicer spelling of
  // the env var and the two are interchangeable.
  if (args.trace) process.env.STALAGMIGHT_FUZZ_REPLAY = path.resolve(args.trace);

  const session = new AppSession();
  const started = await session.start({ build: 'auto' });
  process.stdout.write(
    `session ${started.state} (${started.buildMode} build ${started.buildAction})\n`,
  );
  let failed = false;

  try {
    const metrics = await runScenario(args.name, session, {
      ...(args.seed === undefined ? {} : { seed: args.seed }),
      ...(args.iterations === undefined ? {} : { iterations: args.iterations }),
      log: (line) => process.stdout.write(`   . ${line}\n`),
    });
    const sweep = await runSweep(session, newOracleState(), { full: true, recorder: session.recorder });
    const fatal = sweep.findings.filter((finding) => finding.severity === 'fatal');
    if (fatal.length) failed = true;
    process.stdout.write(
      `${fatal.length ? 'FAIL' : 'PASS'}: ${args.name} seed=${metrics.seed} iterations=${metrics.iterations} ` +
        `mode=${started.buildMode} ` +
        `(${metrics.durationMs}ms) ${JSON.stringify(metrics.metrics)}` +
        `${sweep.findings.length ? ` findings=${JSON.stringify(sweep.findings)}` : ''}\n`,
    );
  } catch (err) {
    failed = true;
    process.stdout.write(`FAIL: ${args.name} threw:\n${err instanceof Error ? err.message : String(err)}\n`);
  } finally {
    await session.stop('scenario-run');
  }

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
