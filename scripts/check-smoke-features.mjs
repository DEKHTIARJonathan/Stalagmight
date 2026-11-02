// Critical-feature canary gate for the @smoke set (#576 E5).
//
// The @smoke Playwright subset is the only part of the browser tier that gates
// a merge (the full suite runs nightly). Its composition used to be an
// accident: whoever last tagged a test decided what was covered, so it drifted
// to a third gas-planning while project deletion, the detail panel and the
// move tools had no merge-time coverage at all. docs/TESTING.md now commits a
// list of critical user paths, each with ONE named canary test; this gate
// fails when a listed canary is no longer an @smoke test - renamed, untagged,
// skipped or deleted - so the list cannot decay the way the tags did.
//
// THE LIST - a markdown table between the `smoke-features:start` /
// `smoke-features:end` markers in docs/TESTING.md, one row per feature:
//
//   | Feature | Spec | Canary (title contains) |
//   |---|---|---|
//   | Delete a project | `globalview-delete-project.spec.ts` | `confirming deletes` |
//
// A row passes when that spec has a NON-skipped test whose title contains both
// `@smoke` and the canary fragment. Comments are stripped first, so a spec
// that merely mentions @smoke in prose (custom-renderer-health.spec.ts does)
// does not count. Only the test title is read - the repo's convention is the
// title suffix, not Playwright's `tag` option (docs/TESTING.md).
//
// WHERE IT RUNS - the smoke job (e2e-smoke.yml), before the browser install,
// and the leak-scan workflow: the list lives in docs/, which `smoke`
// path-ignores, so a docs-only edit to the table would otherwise run no gate
// that reads it (the "gate consumes a path-ignored file" class).
//
// Usage:  node scripts/check-smoke-features.mjs   (or: pnpm lint:smoke-features)

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { stripComments } from './lib/js-comments.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LIST_FILE = 'docs/TESTING.md';
export const SPEC_DIR = 'e2e-playwright';
const START = '<!-- smoke-features:start -->';
const END = '<!-- smoke-features:end -->';

// Parse the canary table. Returns {rows: [{feature, spec, canary, line}], error}.
export function parseFeatureList(md) {
  const lines = md.split(/\r?\n/);
  const a = lines.findIndex((l) => l.trim() === START);
  const b = lines.findIndex((l, i) => i > a && l.trim() === END);
  if (a < 0 || b < 0) return { rows: [], error: `${LIST_FILE} has no ${START} ... ${END} block` };
  const rows = [];
  const problems = [];
  for (let i = a + 1; i < b; i++) {
    const t = lines[i].trim();
    if (!t.startsWith('|')) continue;
    const cells = t.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue; // separator row
    if (/^feature$/i.test(cells[0])) continue; // header row
    const unquote = (c) => c.replace(/^`(.*)`$/, '$1').replace(/^"(.*)"$/, '$1').trim();
    const [feature, spec, canary] = [cells[0] ?? '', unquote(cells[1] ?? ''), unquote(cells[2] ?? '')];
    if (cells.length !== 3 || !feature || !/^[\w.-]+\.spec\.ts$/.test(spec) || !canary) {
      problems.push(`${LIST_FILE}:${i + 1}: expected | Feature | \`<file>.spec.ts\` | \`<title fragment>\` |`);
      continue;
    }
    rows.push({ feature, spec, canary, line: i + 1 });
  }
  if (problems.length) return { rows, error: problems.join('\n  ') };
  if (rows.length === 0) return { rows, error: `the ${START} table in ${LIST_FILE} has no feature rows` };
  return { rows, error: null };
}

// Titles of the runnable (not skipped / fixme'd) tests in a spec's source.
// Handles a title on the line after `test(` and all three quote styles.
const TEST_CALL_RE = /\btest(?:\.(only|fail|slow))?\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;
export function testTitles(source) {
  const code = stripComments(source.split('\n')).join('\n');
  const titles = [];
  let m;
  TEST_CALL_RE.lastIndex = 0;
  while ((m = TEST_CALL_RE.exec(code)) !== null) titles.push(m[3]);
  return titles;
}

// `read(rel)` returns file text or throws. Returns {problems, covered}.
export function checkFeatures(read) {
  let md;
  try {
    md = read(LIST_FILE);
  } catch (e) {
    return { problems: [`${LIST_FILE} unreadable: ${e.message}`], covered: [] };
  }
  const { rows, error } = parseFeatureList(md);
  if (error) return { problems: [error], covered: [] };
  const problems = [];
  const covered = [];
  const cache = new Map();
  for (const row of rows) {
    const rel = `${SPEC_DIR}/${row.spec}`;
    if (!cache.has(rel)) {
      try {
        cache.set(rel, testTitles(read(rel)));
      } catch {
        cache.set(rel, null);
      }
    }
    const titles = cache.get(rel);
    if (titles === null) {
      problems.push(`"${row.feature}": ${rel} does not exist (${LIST_FILE}:${row.line})`);
      continue;
    }
    const hit = titles.find((t) => t.includes('@smoke') && t.includes(row.canary));
    if (!hit) {
      const near = titles.find((t) => t.includes(row.canary));
      problems.push(
        `"${row.feature}": no @smoke test in ${rel} whose title contains "${row.canary}"` +
          (near ? ` (found it untagged: "${near}")` : ' (renamed or deleted?)') +
          ` - ${LIST_FILE}:${row.line}`,
      );
      continue;
    }
    covered.push({ feature: row.feature, rel, title: hit });
  }
  return { problems, covered };
}

export function main(read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'), log = console.log, err = console.error) {
  const { problems, covered } = checkFeatures(read);
  if (problems.length === 0) {
    log(`✓ smoke features: all ${covered.length} critical features in ${LIST_FILE} have an @smoke canary.`);
    return 0;
  }
  err(`\n✗ smoke-feature check failed - ${problems.length} problem(s):\n`);
  for (const p of problems) err(`  ${p}`);
  err(
    `\nEvery critical feature in ${LIST_FILE} ("Critical features") needs its canary to stay an\n` +
      '@smoke test. Re-tag it, point the row at the test that replaced it, or - if the feature\n' +
      'is no longer critical - remove the row in the same PR, with a reason.\n',
  );
  return 1;
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) process.exit(main());
