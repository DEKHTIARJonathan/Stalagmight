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

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const topIdx = args.indexOf('--top');
const top = topIdx === -1 ? 30 : Number(args[topIdx + 1]) || 30;

if (!file) {
  console.error('usage: pw-timing-summary.mjs <results.json> [--top N]');
  process.exit(2);
}

const report = JSON.parse(readFileSync(file, 'utf8'));

// Two input shapes are accepted:
//  - scripts/pw-timing-reporter.mjs output ({tests:[…]}) - HAS hook timings.
//  - the built-in `json` reporter ({suites:[…]}) - has NO hook timings, because
//    that reporter does not emit `steps` at all. Report that as unavailable
//    rather than silently printing 0%, which reads as "setup is free" and is the
//    opposite of the truth.
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
      hook: (t.before ?? 0) + (t.after ?? 0),
      attempts: t.attempts ?? 1,
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
        rows.push({
          file: f,
          line: spec.line,
          title: spec.title,
          duration: results.reduce((s, r) => s + (r.duration ?? 0), 0),
          hook: null,
          attempts: results.length,
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, f);
  };
  for (const s of report.suites ?? []) walk(s, s.file);
}

if (rows.length === 0) {
  console.log('No tests found in report.');
  process.exit(0);
}

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
out.push('### Cost by file');
out.push('');
out.push('| file | tests | total | % of total | hook | hook % | avg/test |');
out.push('|---|---:|---:|---:|---:|---:|---:|');
for (const e of [...byFile.values()].sort((a, b) => b.duration - a.duration)) {
  out.push(
    `| ${e.file} | ${e.count} | ${fmt(e.duration)} | ${share(e.duration, total)} | ${hcell(e.hook)} | ` +
      `${hooksAvailable ? share(e.hook, e.duration) : 'n/a'} | ${fmt(e.duration / e.count)} |`
  );
}
out.push('');
out.push(`### Slowest ${Math.min(top, rows.length)} tests`);
out.push('');
out.push('| test | total | hook | attempts |');
out.push('|---|---:|---:|---:|');
for (const r of [...rows].sort((a, b) => b.duration - a.duration).slice(0, top)) {
  const title = r.title.replace(/\|/g, '\\|');
  out.push(
    `| \`${r.file}:${r.line}\` ${title} | ${fmt(r.duration)} | ${hcell(r.hook ?? 0)} | ${r.attempts} |`
  );
}

const text = out.join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
