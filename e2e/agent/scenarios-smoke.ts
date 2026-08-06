/**
 * Runs every stress scenario once at small iteration counts against a live app
 * session, printing pass/fail + metrics. This is the Phase 5 scenario gate:
 * proves each scenario drives the real app without throwing or tripping a fatal
 * oracle finding. Run on the repo-pinned Node (`nvm use`):
 *
 *   pnpm agent:scenarios
 */
import { createSession } from './createSession';
import { listScenarios, runScenario } from './scenarios';
import { runSweep, newOracleState } from './lib/oracles';
import { callStoreAction } from './lib/stores';

// Small iteration counts for a fast gate; the real stress values are the
// scenarios' defaultIterations.
const SMOKE_ITERATIONS: Record<string, number> = {
  'seed-large-project': 1,
  'undo-redo-churn': 5,
  // RED at the moment, and deliberately so: seed 1 reaches a classified known
  // bug at this count on the v2 generator stream (it took 3 actions on v1, but
  // v2 draws differently - see the scenario header). `undo-redo-fuzz`
  // reproduces eight open undo bugs, so making the gate green would mean
  // weakening its oracle. Run the whole gate with
  // STALAGMIGHT_FUZZ_ALLOW_KNOWN_BUGS=1 to tolerate the classified ones.
  // Lower it only if someone decides a green gate matters more than the
  // standing reminder - and re-check that the lower count still fails.
  'undo-redo-fuzz': 40,
  // RED at the moment, deliberately, for the same reason as `undo-redo-fuzz`
  // above: it reproduces open app bugs, so a green gate would mean its oracle had
  // been weakened. ONE iteration is enough and is what the entry is set to - the
  // scenario is not a random walk, so every iteration builds the same 18-entry
  // covering stack and crosses the same save/reload boundary; a second iteration
  // adds ~5 s and no new signal.
  //
  // What that one iteration hits, deterministically: finding 12 (undo of
  // set_shot_kind / update_shot edits the wrong shot after a reload) on the first
  // id-bearing entry the unwind reaches, which is where a STRICT run stops. With
  // STALAGMIGHT_FUZZ_ALLOW_KNOWN_BUGS=1 it walks the whole restored stack in both
  // directions and also reports bug 1, bug 8 and finding 11, all classified.
  // Raise it only if someone wants a longer soak here rather than in
  // `pnpm agent:scenario`, and re-check that the lower count still fails.
  'undo-persistence-fuzz': 1,
  'dialog-cycling': 8,
  'tool-switch-spam': 20,
  'map-storm': 30,
  'save-under-churn': 4,
  'import-repeatedly': 5,
  'rapid-project-cycle': 4,
};

/**
 * Scenarios that are EXPECTED to fail, and why.
 *
 * Both reproduce open app bugs by construction, so a green run would mean their
 * oracles had been weakened - that is the standing reminder the comments above
 * are protecting, and none of it changes here. What does change is that their
 * failure no longer costs the gate its meaning: with the two of them failing
 * unconditionally, `pnpm agent:scenarios` exited 1 whatever the other nine did,
 * so it could not answer the question it exists to answer ("does the harness
 * still drive the app?"). An expected failure is now reported as XFAIL and does
 * not fail the run.
 *
 * The other direction is enforced too, and matters more: an expected-red
 * scenario that PASSES fails the gate. That is the bug having been fixed, and
 * the entry has to be removed here (and the scenario's own header updated)
 * rather than quietly becoming a test of nothing.
 */
const EXPECTED_RED: Record<string, string> = {
  'undo-redo-fuzz':
    'reproduces the open undo bugs at issue #413 (seed 1 x40 reaches bug 1 on the v2 stream)',
  'undo-persistence-fuzz':
    'reproduces finding 12 on the first id-bearing entry of the restored stack (issue #413)',
};

/** Opt in to walking past classified bugs - see EXPECTED_RED. */
const ALLOW_KNOWN_BUGS = process.env.STALAGMIGHT_FUZZ_ALLOW_KNOWN_BUGS === '1';

/**
 * Does this failure come from the scenario's OWN oracle?
 *
 * Every fuzz-scenario failure is composed by its `fail()` helper, which always
 * emits a `reproduce:` line naming the seed and iteration count. A throw
 * without one did not come from an oracle - it is the harness failing to drive
 * the app - and an expected-red entry must not absorb that.
 */
function looksLikeAnOracleFailure(message: string): boolean {
  return message.includes('reproduce:');
}

async function main(): Promise<void> {
  const session = createSession();
  let failed = false;
  const xfailed: string[] = [];
  const xpassed: string[] = [];
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
        const expectedRed = EXPECTED_RED[name];
        if (fatal.length && expectedRed === undefined) failed = true;
        if (expectedRed !== undefined && fatal.length > 0) {
          // Expected-red, and it DID fail - through the sweep rather than by
          // throwing. Same news, so the same XFAIL: `fatal` is a second failure
          // channel, and treating it as a pass would report a crashing scenario
          // as a fixed bug.
          xfailed.push(name);
          process.stdout.write(`XFAIL: ${name} failed as expected via a fatal finding (${expectedRed}).\n`);
        } else if (expectedRed !== undefined && !ALLOW_KNOWN_BUGS) {
          // Did not throw and swept clean, in STRICT mode: the bug it pins is
          // fixed (or its oracle stopped seeing it) and the list above is wrong.
          failed = true;
          xpassed.push(name);
          process.stdout.write(
            `UNEXPECTED PASS: ${name} was expected to fail (${expectedRed}).\n` +
              `  If the bug is fixed, remove it from EXPECTED_RED and update the scenario header.\n`,
          );
        } else if (expectedRed !== undefined) {
          // Tolerant mode is the documented way to run this gate, and it is
          // exactly what makes these two scenarios complete: they walk PAST the
          // classified bugs rather than stopping on them. A pass here says
          // nothing about whether the bug is fixed, so it is not news.
          process.stdout.write(
            `PASS (tolerant): ${name} completed with STALAGMIGHT_FUZZ_ALLOW_KNOWN_BUGS=1; ` +
              `that walks past the classified bugs rather than proving them fixed.\n`,
          );
        }
        const label = fatal.length ? 'FAIL' : sweep.findings.length ? 'PASS+findings' : 'PASS';
        process.stdout.write(
          `${label}: ${name} (${metrics.durationMs}ms) ${JSON.stringify(metrics.metrics)}` +
            `${sweep.findings.length ? ` findings=${JSON.stringify(sweep.findings)}` : ''}\n`,
        );
      } catch (err) {
        const expectedRed = EXPECTED_RED[name];
        const detail = err instanceof Error ? err.message : String(err);
        if (expectedRed === undefined) {
          failed = true;
          process.stdout.write(`FAIL: ${name} threw: ${detail}\n`);
        } else if (looksLikeAnOracleFailure(detail)) {
          xfailed.push(name);
          process.stdout.write(
            `XFAIL: ${name} failed as expected (${expectedRed}):\n` +
              `${detail.split('\n').slice(0, 3).map((line) => `  | ${line}`).join('\n')}\n`,
          );
        } else {
          // Expected-red covers the scenario's OWN oracle saying "the app did
          // the wrong thing". It does not cover the harness failing to drive the
          // app at all - a WebDriver attach failure, a missing test hook, a
          // renamed store action - and swallowing those is exactly how this gate
          // would stop answering the question it exists to answer.
          failed = true;
          process.stdout.write(
            `FAIL: ${name} threw something that is NOT its oracle (so not the expected red):\n${detail}\n`,
          );
        }
      }
    }
  } finally {
    await session.stop('scenarios-smoke');
  }

  if (xfailed.length > 0) {
    process.stdout.write(
      `\n${xfailed.length} scenario(s) failed as EXPECTED (open app bugs, not harness regressions): ` +
        `${xfailed.join(', ')}\n`,
    );
  }
  if (xpassed.length > 0) {
    process.stdout.write(`${xpassed.length} expected-red scenario(s) PASSED: ${xpassed.join(', ')}\n`);
  }
  process.stdout.write(failed ? '\nSCENARIOS FAILED\n' : '\nSCENARIOS PASSED\n');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
