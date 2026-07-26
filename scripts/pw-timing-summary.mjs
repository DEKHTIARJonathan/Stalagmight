#!/usr/bin/env node
// Rank Playwright tests by cost from a `--reporter=json` report.
//
// Why: CI gives us no per-test timing. The `github` reporter prints a line only
// for tests that FAILED or FLAKED, so a green run is a black box - we know the
// suite took ~6.5 minutes but not which tests spent it. This turns a json report
// into the ranked table needed to decide what to keep in the @smoke subset.
//
// The interesting column is HOOK time. Playwright folds beforeEach/afterEach into
// a test's duration, so a slow suite can look like slow tests when it is really
// per-test setup (this repo re-seeds a mocked project in beforeEach for every
// test). Splitting hook from body says which of those two we are paying for.
//
// Usage:
//   node scripts/pw-timing-summary.mjs <results.json> [--top N]
//
// Writes a markdown summary to stdout, and additionally appends it to
// $GITHUB_STEP_SUMMARY when set (so it renders on the CI run page - no artifact
// download needed).

import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Two input shapes are accepted:
//  - scripts/pw-timing-reporter.mjs output ({tests:[…]}) - HAS hook timings.
//  - the built-in `json` reporter ({suites:[…]}) - has NO hook timings, because
//    that reporter does not emit `steps` at all. Report that as unavailable
//    rather than silently printing 0%, which reads as "setup is free" and is the
//    opposite of the truth.
export function buildRows(report) {
  const rows = [];
  let hooksAvailable = false;

  if (Array.isArray(report.tests)) {
    hooksAvailable = true;
    for (const t of report.tests) {
      rows.push({
        file: t.file,
        line: t.line,
        title: t.title,
        duration: t.duration ?? 0,
        // `worker` is deliberately excluded: Playwright charges its "Worker Cleanup"
        // step to whichever test ran last on that worker, so it is not this test's
        // setup. Counting it would inflate a near-arbitrary row above 100% hook.
        hook: (t.before ?? 0) + (t.after ?? 0),
        attempts: t.attempts ?? 1,
        status: t.status ?? 'unknown',
        everFailed: t.everFailed ?? (t.status ?? 'passed') !== 'passed',
      });
    }
  } else {
    /** Playwright nests suites arbitrarily deep (file suite -> describe -> describe). */
    const walk = (suite, fileName) => {
      const f = suite.file ?? fileName;
      for (const spec of suite.specs ?? []) {
        for (const t of spec.tests ?? []) {
          // Retries produce multiple results; charge the test for all attempts,
          // since that is what CI actually spends.
          const results = t.results ?? [];
          const last = results[results.length - 1];
          rows.push({
            file: f,
            line: spec.line,
            title: spec.title,
            duration: results.reduce((s, r) => s + (r.duration ?? 0), 0),
            hook: null,
            attempts: results.length,
            status: last?.status ?? t.status ?? 'unknown',
            everFailed: results.some((r) => (r.status ?? 'passed') !== 'passed'),
          });
        }
      }
      for (const child of suite.suites ?? []) walk(child, f);
    };
    for (const s of report.suites ?? []) walk(s, s.file);
  }
  return { rows, hooksAvailable };
}

// Workflow-command sanitizer. This text is printed to a `run:` step's stdout,
// and the Actions runner interprets `::something::` there as a command
// (`::error::`, `::add-mask::`, `::stop-commands::`). Test titles come from
// `e2e-playwright/**`, which any PR can edit, so they are untrusted input to
// that parser - neutralize the marker before it is ever echoed. A zero-width
// space between the colons defeats the parser while staying readable.
export const safe = (s) => String(s).replace(/::/g, ':​:');

export const NO_TESTS = '## Playwright timing\n\nNo tests found in report.';

/** Render the markdown report. Pure: returns the text, writes nothing. */
export function render(report, { top = 30 } = {}) {
  const { rows, hooksAvailable } = buildRows(report);

  if (rows.length === 0) return NO_TESTS;

  const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
  const hcell = (ms) => (hooksAvailable ? fmt(ms) : 'n/a');
  const total = rows.reduce((s, r) => s + r.duration, 0);
  const totalHook = rows.reduce((s, r) => s + (r.hook ?? 0), 0);
  const wall = report.stats?.duration ?? 0;
  const share = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '0%');

  const byFile = new Map();
  for (const r of rows) {
    const e = byFile.get(r.file) ?? { file: r.file, duration: 0, hook: 0, count: 0 };
    e.duration += r.duration;
    e.hook += r.hook ?? 0;
    e.count += 1;
    byFile.set(r.file, e);
  }

  const bad = rows.filter((r) => r.everFailed);

  const out = [];
  out.push('## Playwright timing');
  out.push('');
  out.push(
    `${rows.length} tests | test-time total ${fmt(total)} | ` +
      (hooksAvailable
        ? `hook (setup) ${fmt(totalHook)} (**${share(totalHook, total)}** of test time)`
        : 'hook (setup) **n/a** (json reporter emits no steps - use scripts/pw-timing-reporter.mjs)') +
      ` | wall clock ${fmt(wall)}`
  );
  out.push('');
  // A timed-out test bills the full test timeout, so it lands at the top of a
  // cost ranking looking exactly like an expensive-but-legitimate test. Ranking a
  // broken run is meaningless; say so loudly rather than letting the table be read
  // as a cost measurement.
  if (bad.length > 0) {
    out.push(
      `> ⚠️ **${bad.length} of ${rows.length} tests did not pass.** Their durations are ` +
        'timeout/failure cost, not real work - treat this ranking as invalid until the ' +
        'run is green.'
    );
    out.push('');
  }
  out.push('### Cost by file');
  out.push('');
  out.push('| file | tests | total | % of total | hook | hook % | avg/test |');
  out.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const e of [...byFile.values()].sort((a, b) => b.duration - a.duration)) {
    out.push(
      `| ${safe(e.file)} | ${e.count} | ${fmt(e.duration)} | ${share(e.duration, total)} | ${hcell(e.hook)} | ` +
        `${hooksAvailable ? share(e.hook, e.duration) : 'n/a'} | ${fmt(e.duration / e.count)} |`
    );
  }
  out.push('');
  out.push(`### Slowest ${Math.min(top, rows.length)} tests`);
  out.push('');
  out.push('| test | total | hook | attempts | status |');
  out.push('|---|---:|---:|---:|---|');
  for (const r of [...rows].sort((a, b) => b.duration - a.duration).slice(0, top)) {
    const title = safe(r.title).replace(/\|/g, '\\|');
    const status = r.status === 'passed' ? '' : `⚠️ ${safe(r.status)}`;
    out.push(
      `| \`${safe(r.file)}:${r.line}\` ${title} | ${fmt(r.duration)} | ${hcell(r.hook ?? 0)} | ` +
        `${r.attempts} | ${status} |`
    );
  }

  return out.join('\n');
}

// --- CLI ----------------------------------------------------------------------
// Guarded so the test file can import the pure functions above without this
// running (and without exiting the test process). Canonical-path comparison,
// matching scripts/check-no-em-dash.mjs - an endsWith() check would silently
// skip the whole block when invoked through a symlink or an unusual path form.
const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const topIdx = args.indexOf('--top');
  const top = topIdx === -1 ? 30 : Number(args[topIdx + 1]) || 30;

  if (!file) {
    console.error('usage: pw-timing-summary.mjs <results.json> [--top N]');
    process.exit(2);
  }

  const text = render(JSON.parse(readFileSync(file, 'utf8')), { top });
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
  }
}
