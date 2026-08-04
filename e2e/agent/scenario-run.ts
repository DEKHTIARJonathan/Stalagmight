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
 * Exits non-zero when the scenario throws or the sweep reports a fatal finding,
 * so it works as a one-off gate too.
 */
import { AppSession } from './session';
import { getScenario, listScenarios, runScenario } from './scenarios';
import { runSweep, newOracleState } from './lib/oracles';

interface Args {
  name: string;
  seed?: number;
  iterations?: number;
}

function parseArgs(argv: string[]): Args {
  const [name, ...rest] = argv;
  if (!name) {
    throw new Error(`usage: pnpm agent:scenario <name> [--seed N] [--iterations M]\nknown: ${listScenarios().join(', ')}`);
  }
  const args: Args = { name };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = Number(rest[i + 1]);
    if (!Number.isFinite(value)) throw new Error(`flag ${flag} needs a numeric value`);
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

  const session = new AppSession();
  const started = await session.start({ build: 'auto' });
  process.stdout.write(`session ${started.state} (build ${started.buildAction})\n`);
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
