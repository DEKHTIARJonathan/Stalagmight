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
// `@smoke` and the canary fragment (skipped = declared skip/fixme, inside a
// describe.skip/fixme group, or under a skip/fixme annotation; see testTitles).
// The TestInfo forms (`testInfo.skip()`, `test.info().fixme(cond)`) count as
// annotations, and a `test.fail` test - declared or annotated - is no canary,
// since it passes only while the feature is broken (#576 RV4-FE-FEB-1).
// Comments are stripped first, so a spec
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
import { matchParen, stripComments } from './lib/js-comments.mjs';

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
//
// A test does not run - so it is no canary - when (#576 RV3-FE-12):
//   - it is declared `test.skip('title', ...)` / `test.fixme('title', ...)`
//     (TEST_CALL_RE never matches those);
//   - it sits anywhere inside a `test.describe.skip(...)` /
//     `test.describe.fixme(...)` group;
//   - its body, an enclosing describe, or the file's top level calls the
//     annotation form `test.skip()` / `test.skip(condition, reason)` (or the
//     same for fixme). A condition is not evaluated: a canary must run on
//     every project, so any skip annotation in its scope disqualifies it;
//   - (#576 RV4-FE-FEB-1) the annotation is made through the TestInfo API -
//     `testInfo.skip()`, `info.fixme(cond)` (the parameter can have any
//     name), `test.info().skip(cond, reason)` - or it is a `fail` one: a
//     `test.fail('title', ...)` test, or `test.fail()` / `testInfo.fail()`
//     in scope, passes CI only while the feature is BROKEN, so it is no canary
//     (TEST_CALL_RE does not read `test.fail('title')` as a test at all).
// Scopes are the paren extents of the calls (scripts/lib/js-comments.mjs
// matchParen), so nesting depth and line breaks do not matter. The
// annotation's receiver is `test`, `test.info()` or the TestInfo parameter
// of a test or hook callback that encloses it - the second parameter, after
// the fixtures object (`async ({ page }, testInfo) =>`) - so `reader.skip(4)`
// or a helper's own `info.skip()` is not one (#576 RV9b-6); the lookbehind
// keeps `test.describe.skip(` / `test.step.skip(` (a member of a member) from
// reading as one. A skip made in a helper the canary calls is not seen.
const TEST_CALL_RE = /\btest(?:\.(only|slow))?\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;
const DECLARED_NOT_RUN_RE = /\btest\.(skip|fixme|fail)\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;
const SKIPPED_GROUP_RE = /\b(?:test\.)?describe\.(skip|fixme)\s*\(/g;
const GROUP_RE = /\b(?:test\.)?describe(?:\.(?:only|parallel|serial))?\s*\(/g;
const ANNOTATION_RE = /(?<![\w$.])(test\.info\(\)|[A-Za-z_$][\w$]*)\.(skip|fixme|fail)\s*\(\s*(?!['"`])/g;
// A test or hook call, and - read from the start of its arguments, past an
// optional title and details object - its callback's TestInfo parameter.
const TEST_OR_HOOK_RE = /\btest(?:\.(?:only|slow|skip|fixme|fail|beforeEach|afterEach|beforeAll|afterAll))?\s*\(/g;
const TESTINFO_PARAM_RE =
  /^\s*(?:(['"`])(?:\\.|(?!\1)[^\\])*\1\s*,\s*)?(?:\{[^{}]*\}\s*,\s*)?(?:async\s+)?(?:function\s*[\w$]*\s*)?\(\s*\{[^}]*\}\s*,\s*([A-Za-z_$][\w$]*)/;

// [{start, end, kind, open}] extents of every call `re` matches (its `(` is the
// match's last character); `kind` is the match's group 1, if any.
function callExtents(code, re) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(code)) !== null) {
    const open = code.lastIndexOf('(', m.index + m[0].length - 1);
    out.push({ start: m.index, end: matchParen(code, open), kind: m[1], open });
  }
  return out;
}

// Every test the spec declares: {title, runs, why}, `why` saying what stops one
// that does not run (#576 RV9b-6).
export function testEntries(source) {
  const code = stripComments(source.split('\n')).join('\n');
  const lineOf = (at) => code.slice(0, at).split('\n').length;
  const tests = [];
  let m;
  TEST_CALL_RE.lastIndex = 0;
  while ((m = TEST_CALL_RE.exec(code)) !== null) {
    const open = code.indexOf('(', m.index);
    tests.push({ title: m[3], start: m.index, end: matchParen(code, open) });
  }
  const skipped = callExtents(code, SKIPPED_GROUP_RE).map((g) => ({
    ...g,
    why: `it is in a describe.${g.kind} group (line ${lineOf(g.start)})`,
  }));
  // The TestInfo parameters in scope: each test or hook callback's own.
  const infoScopes = callExtents(code, TEST_OR_HOOK_RE)
    .map((c) => ({ ...c, name: TESTINFO_PARAM_RE.exec(code.slice(c.open + 1, c.end))?.[2] }))
    .filter((c) => c.name !== undefined);
  // An annotation skips its innermost enclosing test or describe, else the file.
  const scopes = [...tests, ...callExtents(code, GROUP_RE)];
  ANNOTATION_RE.lastIndex = 0;
  while ((m = ANNOTATION_RE.exec(code)) !== null) {
    const at = m.index;
    const receiver = m[1];
    const isTestInfo =
      receiver === 'test' ||
      receiver === 'test.info()' ||
      infoScopes.some((c) => c.name === receiver && c.start < at && at < c.end);
    if (!isTestInfo) continue;
    const inner = scopes
      .filter((s) => s.start < at && at < s.end)
      .reduce((best, s) => (best === null || s.start > best.start ? s : best), null);
    skipped.push({ ...(inner ?? { start: 0, end: code.length }), why: `${receiver}.${m[2]}() in its scope (line ${lineOf(at)})` });
  }
  const entries = tests.map((t) => {
    const stop = skipped.find((s) => s.start <= t.start && t.start < s.end);
    return { title: t.title, runs: stop === undefined, why: stop?.why ?? null };
  });
  DECLARED_NOT_RUN_RE.lastIndex = 0;
  while ((m = DECLARED_NOT_RUN_RE.exec(code)) !== null) {
    entries.push({ title: m[3], runs: false, why: `it is declared test.${m[1]}(...) (line ${lineOf(m.index)})` });
  }
  return entries;
}

export function testTitles(source) {
  return testEntries(source)
    .filter((e) => e.runs)
    .map((e) => e.title);
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
        cache.set(rel, testEntries(read(rel)));
      } catch {
        cache.set(rel, null);
      }
    }
    const entries = cache.get(rel);
    if (entries === null) {
      problems.push(`"${row.feature}": ${rel} does not exist (${LIST_FILE}:${row.line})`);
      continue;
    }
    const titles = entries.filter((e) => e.runs).map((e) => e.title);
    const hit = titles.find((t) => t.includes('@smoke') && t.includes(row.canary));
    if (!hit) {
      const near = titles.find((t) => t.includes(row.canary));
      const stopped = entries.find((e) => !e.runs && e.title.includes(row.canary));
      const why = near
        ? ` (found it untagged: "${near}")`
        : stopped
          ? ` (found it, but it does not run: ${stopped.why})`
          : ' (renamed or deleted?)';
      problems.push(`"${row.feature}": no @smoke test in ${rel} whose title contains "${row.canary}"${why} - ${LIST_FILE}:${row.line}`);
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
