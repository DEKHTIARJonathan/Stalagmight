/**
 * Runs every stress scenario once at small iteration counts against a live app
 * session, printing pass/fail + metrics. This is the Phase 5 scenario gate:
 * proves each scenario drives the real app without throwing or tripping a fatal
 * oracle finding. Run under Node 22 (see .nvmrc):
 *
 *   pnpm agent:scenarios
 */
import { AppSession } from './session';
import { listScenarios, runScenario } from './scenarios';
import { runSweep, newOracleState } from './lib/oracles';
import { callStoreAction } from './lib/stores';

// Small iteration counts for a fast gate; the real stress values are the
// scenarios' defaultIterations.
const SMOKE_ITERATIONS: Record<string, number> = {
  'seed-large-project': 1,
  'undo-redo-churn': 5,
  'dialog-cycling': 8,
  'tool-switch-spam': 20,
  'map-storm': 30,
  'save-under-churn': 4,
  'import-repeatedly': 5,
  'rapid-project-cycle': 4,
};

async function main(): Promise<void> {
  const session = new AppSession();
  let failed = false;
  const started = await session.start({ build: 'auto' });
  process.stdout.write(`session ${started.state} (build ${started.buildAction})\n`);
  const oracle = newOracleState();

  try {
    for (const name of listScenarios()) {
      // Reset to a clean slate between scenarios.
      await session.exclusive(() => callStoreAction(session.browser, 'project', 'closeProject', [])).catch(() => undefined);
      try {
        const metrics = await runScenario(name, session, {
          iterations: SMOKE_ITERATIONS[name],
          log: (m) => process.stdout.write(`   · ${m}\n`),
        });
        const sweep = await runSweep(session, oracle, { full: true, recorder: session.recorder });
        const fatal = sweep.findings.filter((f) => f.severity === 'fatal');
        // Gate: a scenario is "green" if it did not throw and produced no FATAL
        // finding. error/warning findings are app signals the harness is meant to
        // surface (that is the point), so they are reported but do not fail the
        // scenario gate.
        if (fatal.length) failed = true;
        const label = fatal.length ? 'FAIL' : sweep.findings.length ? 'PASS+findings' : 'PASS';
        process.stdout.write(
          `${label}: ${name} (${metrics.durationMs}ms) ${JSON.stringify(metrics.metrics)}` +
            `${sweep.findings.length ? ` findings=${JSON.stringify(sweep.findings)}` : ''}\n`,
        );
      } catch (err) {
        failed = true;
        process.stdout.write(`FAIL: ${name} threw: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  } finally {
    await session.stop('scenarios-smoke');
  }

  process.stdout.write(failed ? '\nSCENARIOS FAILED\n' : '\nSCENARIOS PASSED\n');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
