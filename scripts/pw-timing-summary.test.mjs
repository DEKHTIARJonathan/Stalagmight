// Fixture tests for the @smoke timing summary (scripts/pw-timing-summary.mjs).
//
// This tool exists to decide which tests get DELETED, so a wrong number here is
// worse than a crash: it is a confident, plausible-looking table that misdirects
// the pare-down. The cases pinned below are the ones that actually produced bad
// output during development, not hypotheticals.
//
// Pure Node, no test framework (mirrors scripts/check-no-em-dash.test.mjs).
// Run: node scripts/pw-timing-summary.test.mjs

import assert from 'node:assert/strict';
import { buildRows, render, safe, NO_TESTS } from './pw-timing-summary.mjs';

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
}

const custom = (tests, stats = { duration: 1000 }) => ({ stats, tests });

// --- the failure that motivated the status column -----------------------------
// A run where everything timed out once rendered a table topped by "slow" tests
// with a 98% hook share. It read as a valid measurement confirming the thesis;
// it was a broken tree. The table must refuse to be read that way.

test('a timed-out run is flagged, not presented as a cost ranking', () => {
  const text = render(
    custom([
      { file: 'a.spec.ts', line: 1, title: 'x', duration: 30000, before: 29000, status: 'timedOut' },
    ])
  );
  assert.match(text, /did not pass/);
  assert.match(text, /invalid until the run is green/);
});

test('per-test status reaches the table so a timeout cannot read as slow work', () => {
  const text = render(
    custom([
      { file: 'a.spec.ts', line: 1, title: 'boom', duration: 30000, status: 'timedOut' },
      { file: 'b.spec.ts', line: 2, title: 'fine', duration: 100, status: 'passed' },
    ])
  );
  assert.match(text, /`a\.spec\.ts:1` boom .*timedOut/);
});

test('a fully green run carries no warning banner', () => {
  const text = render(
    custom([{ file: 'a.spec.ts', line: 1, title: 'ok', duration: 100, status: 'passed' }])
  );
  assert.doesNotMatch(text, /did not pass/);
});

test('a retried test that eventually passed is still marked, since its time is inflated', () => {
  const { rows } = buildRows(
    custom([
      { file: 'a.spec.ts', line: 1, title: 'flaky', duration: 900, attempts: 2, status: 'passed', everFailed: true },
    ])
  );
  assert.equal(rows[0].everFailed, true);
});

// --- workflow-command injection ------------------------------------------------
// The rendered text is echoed to a `run:` step's stdout, where the Actions runner
// parses `::cmd::`. Test titles live in e2e-playwright/**, which any PR can edit.

test('a test title cannot smuggle a workflow command into the step output', () => {
  const text = render(
    custom([
      { file: 'a.spec.ts', line: 1, title: '::add-mask::secret', duration: 10, status: 'passed' },
    ])
  );
  assert.ok(!text.includes('::add-mask::'), 'raw workflow command survived into output');
  assert.match(text, /add-mask/, 'the title text itself should still be legible');
});

test('safe() neutralizes the marker wherever it appears, not just at the start', () => {
  assert.ok(!safe('trailing ::error::x').includes('::'));
  assert.ok(!safe('::stop-commands::tok').includes('::'));
});

test('a file path is sanitized too, not only the title', () => {
  const text = render(
    custom([{ file: '::error::.spec.ts', line: 1, title: 'x', duration: 10, status: 'passed' }])
  );
  assert.ok(!text.includes('::error::'));
});

// --- markdown integrity --------------------------------------------------------

test('a pipe in a title cannot break the table out of its column', () => {
  const text = render(
    custom([{ file: 'a.spec.ts', line: 1, title: 'a | b', duration: 10, status: 'passed' }])
  );
  assert.match(text, /a \\\| b/);
});

// --- arithmetic ----------------------------------------------------------------

test('hook share is computed against test time', () => {
  const text = render(
    custom([{ file: 'a.spec.ts', line: 1, title: 'x', duration: 1000, before: 400, after: 100, status: 'passed' }])
  );
  assert.match(text, /hook \(setup\) 500ms \(\*\*50%\*\*/);
});

test('Worker Cleanup time is excluded from a test hook total', () => {
  // Playwright charges "Worker Cleanup" to whichever test ran last on the worker.
  // Counting it as setup pushed single rows past 100% hook.
  const { rows } = buildRows(
    custom([
      { file: 'a.spec.ts', line: 1, title: 'x', duration: 1000, before: 100, after: 50, worker: 5000 },
    ])
  );
  assert.equal(rows[0].hook, 150);
});

test('a zero-duration report does not divide by zero', () => {
  const text = render(custom([{ file: 'a.spec.ts', line: 1, title: 'x', duration: 0, status: 'passed' }]));
  assert.match(text, /0%/);
  assert.doesNotMatch(text, /NaN/);
});

test('an empty report returns the explicit no-tests notice, not an empty string', () => {
  assert.equal(render(custom([])), NO_TESTS);
  assert.ok(NO_TESTS.length > 0);
});

// --- the built-in json reporter path -------------------------------------------
// It emits no `steps`, so hook data is genuinely unavailable. Reporting 0% there
// would read as "setup is free" - the exact opposite of the finding.

test('the built-in json shape reports hooks as n/a, never as 0%', () => {
  const builtin = {
    stats: { duration: 500 },
    suites: [
      {
        file: 'a.spec.ts',
        specs: [{ line: 3, title: 'x', tests: [{ results: [{ duration: 200, status: 'passed' }] }] }],
        suites: [],
      },
    ],
  };
  const text = render(builtin);
  assert.match(text, /hook \(setup\) \*\*n\/a\*\*/);
  assert.doesNotMatch(text, /hook \(setup\) 0ms/);
});

test('nested describes are walked, and the file name is inherited by children', () => {
  const builtin = {
    suites: [
      {
        file: 'a.spec.ts',
        specs: [],
        suites: [
          { specs: [{ line: 9, title: 'deep', tests: [{ results: [{ duration: 50, status: 'passed' }] }] }] },
        ],
      },
    ],
  };
  const { rows } = buildRows(builtin);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].file, 'a.spec.ts');
});

test('the built-in json path charges every retry attempt', () => {
  const builtin = {
    suites: [
      {
        file: 'a.spec.ts',
        specs: [
          {
            line: 1,
            title: 'flaky',
            tests: [{ results: [{ duration: 300, status: 'failed' }, { duration: 200, status: 'passed' }] }],
          },
        ],
        suites: [],
      },
    ],
  };
  const { rows } = buildRows(builtin);
  assert.equal(rows[0].duration, 500);
  assert.equal(rows[0].attempts, 2);
  assert.equal(rows[0].everFailed, true, 'a failed first attempt must stay on record');
});

if (failures.length > 0) {
  console.error(`pw-timing-summary tests: ${failures.length} FAILED`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`pw-timing-summary tests: ${passed} passed`);
