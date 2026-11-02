// No-unannotated-sleep gate for the Playwright tier (#576 E14).
//
// docs/TESTING.md has said "Do not sleep" for a long time: a hard
// `page.waitForTimeout()` is the single biggest flake source, and a sleep that
// stands in for a real condition makes a test slow when the condition is quick
// and wrong when it is slow. Nothing enforced it, and the count grew (41 -> 48
// lines by #576). This gate fails on every sleep in e2e-playwright/ that is not
// explicitly annotated as a deliberate settle. A sleep is (#576 RV3-FE-12):
//   - any reference to `waitForTimeout`, not just a direct call - so
//     `page.waitForTimeout.bind(page)`, `const { waitForTimeout } = page`,
//     `page['waitForTimeout'](...)` and a call split across lines count;
//   - a test-runner `setTimeout(` (`await new Promise((r) => setTimeout(r, 500))`),
//     i.e. one that is not inside a callback the BROWSER runs (page.evaluate,
//     addInitScript, waitForFunction, $eval, ...);
//   - an import of `timers/promises`, whose `setTimeout` is a sleep under any
//     alias.
//
// THE ESCAPE HATCH - some waits are legitimate: proving that something does NOT
// happen ("press the key, give a buggy handler time to react, assert the tool is
// unchanged") cannot be written as a poll, because a poll accepts the
// pre-update value on its first read. Those are allowed when the `//` comment
// block directly above the call carries
//
//     // settle: <why a fixed wait is the only way to prove this>
//
// with a real reason (at least MIN_REASON characters). Everything else should
// wait for its condition: a web-first assertion, `expect.poll`, `toPass`, or a
// helper from e2e-playwright/helpers/app.ts (waitForMapIdle, waitForActiveTool,
// ...). See docs/testing-recipes.md, "Waiters".
//
// Out of scope by design: a `setTimeout` inside page.evaluate and friends, or
// anywhere under e2e-playwright/mocks/ (the IPC mock is serialized into the
// page, so its timers are mock latency, not the test runner sleeping), and
// Playwright's own `test.setTimeout` / `testInfo.setTimeout` (a budget, not a
// wait). Comments are stripped with the
// shared string-aware scanner and same-line string literals are blanked, so a
// waitForTimeout named in prose or in a label does not count; a symlinked spec
// fails, as in every source gate.
//
// Runs in the `smoke` job (e2e-smoke.yml) before the browser install, after its
// fixture test (scripts/check-e2e-no-sleep.test.mjs).
//
// Usage:  node scripts/check-e2e-no-sleep.mjs   (or: pnpm lint:e2e-no-sleep)

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { walkFiles } from './lib/src-files.mjs';
import { matchParen, stripComments } from './lib/js-comments.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCAN_DIR = 'e2e-playwright';
export const MIN_REASON = 12;

// Any mention of the name outside comments and strings: a call, a bind, a
// destructure. `page['waitForTimeout']` is matched before strings are blanked.
const SLEEP_RE = /\bwaitForTimeout\b/g;
const SLEEP_BRACKET_RE = /\[\s*(['"`])waitForTimeout\1\s*\]/g;
// A bare or global `setTimeout(`; `test.setTimeout(` / `testInfo.setTimeout(`
// (budgets) are member calls on something else and do not match.
const TIMER_RE = /(?:^|[^.\w$]|\b(?:globalThis|global)\.)setTimeout\s*\(/g;
const TIMERS_PROMISES_RE = /(['"])(?:node:)?timers\/promises\1/g;
// Calls whose callback runs in the page, where a timer is not a runner sleep.
const BROWSER_CALL_RE = /\.(?:evaluate|evaluateHandle|evaluateAll|addInitScript|waitForFunction|\$eval|\$\$eval)\s*\(/g;
export const BROWSER_SIDE_DIRS = ['e2e-playwright/mocks/'];
const SETTLE_RE = /^\/\/\s*settle:\s*(.*)$/;

// The settle reason in the contiguous `//` comment block ending right above
// line `i` (0-based), or null. A block comment or a blank line ends the block.
export function settleReason(lines, i) {
  for (let j = i - 1; j >= 0; j--) {
    const t = lines[j].trim();
    if (!t.startsWith('//')) break;
    const m = SETTLE_RE.exec(t);
    if (m && m[1].trim().length >= MIN_REASON) return m[1].trim();
  }
  return null;
}

// Every sleep in one file's code: [{lineNo, reason}] where reason is the
// settle annotation or null. `rel` (repo-relative) decides whether runner-side
// timers are in scope (not under BROWSER_SIDE_DIRS).
// Same-line string literals are blanked too (stripComments keeps them, since
// other gates match INSIDE strings): a label like 'page.waitForTimeout(100)'
// is not a call. The blanking keeps each literal's length, so offsets into the
// blanked text are offsets into the stripped text.
const STRING_RE = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g;
const blank = (lit) => lit[0] + ' '.repeat(lit.length - 2) + lit[lit.length - 1];

export function findSleeps(text, rel = '') {
  const lines = text.split('\n');
  const stripped = stripComments(lines);
  const code = stripped.map((c) => c.replace(STRING_RE, blank));
  const lineHits = new Map(); // 0-based line -> number of sleeps on it
  const hit = (i, n = 1) => lineHits.set(i, (lineHits.get(i) ?? 0) + n);
  stripped.forEach((c, i) => {
    const n = (c.match(SLEEP_BRACKET_RE) ?? []).length + (c.match(TIMERS_PROMISES_RE) ?? []).length;
    if (n) hit(i, n);
  });
  code.forEach((c, i) => {
    const n = (c.match(SLEEP_RE) ?? []).length;
    if (n) hit(i, n);
  });
  if (!BROWSER_SIDE_DIRS.some((d) => rel.startsWith(d))) {
    const joined = code.join('\n');
    const strippedJoined = stripped.join('\n');
    const browser = [];
    let m;
    BROWSER_CALL_RE.lastIndex = 0;
    while ((m = BROWSER_CALL_RE.exec(joined)) !== null) {
      const open = m.index + m[0].length - 1;
      browser.push([open, matchParen(strippedJoined, open)]);
    }
    TIMER_RE.lastIndex = 0;
    while ((m = TIMER_RE.exec(joined)) !== null) {
      const at = m.index + m[0].indexOf('setTimeout');
      if (browser.some(([a, b]) => a < at && at < b)) continue;
      hit(joined.slice(0, at).split('\n').length - 1);
    }
  }
  const out = [];
  for (const i of [...lineHits.keys()].sort((a, b) => a - b)) {
    const reason = settleReason(lines, i);
    for (let k = 0; k < lineHits.get(i); k++) out.push({ lineNo: i + 1, reason });
  }
  return out;
}

// Scan repo-relative files; `readFile` is injected for the fixture test.
export function scan(files, readFile) {
  const violations = [];
  let settles = 0;
  for (const rel of files) {
    for (const s of findSleeps(readFile(rel), rel)) {
      if (s.reason) settles++;
      else violations.push({ rel, lineNo: s.lineNo });
    }
  }
  return { violations, settles };
}

export function main(root = REPO_ROOT, log = console.log, err = console.error) {
  if (!fs.existsSync(path.join(root, SCAN_DIR))) {
    err(`check-e2e-no-sleep: ${path.join(root, SCAN_DIR)} not found (run from the repo root).`);
    return 1;
  }
  const { files, symlinks } = walkFiles(root, SCAN_DIR, { exts: ['.ts', '.tsx'] });
  const { violations, settles } = scan(files, (rel) => fs.readFileSync(path.join(root, rel), 'utf8'));
  if (violations.length === 0 && symlinks.length === 0) {
    log(`✓ e2e-playwright no-sleep: ${files.length} files, no unannotated sleep (${settles} annotated settle(s)).`);
    return 0;
  }
  err(`\n✗ e2e-playwright no-sleep check failed - ${violations.length + symlinks.length} issue(s):\n`);
  for (const v of violations) err(`  ${v.rel}:${v.lineNo}  a sleep (waitForTimeout, a runner-side setTimeout or timers/promises) without a "// settle: <reason>" comment above it`);
  for (const l of symlinks) err(`  ${l.rel}  is a symlink (-> ${l.target}); not followed, so not scanned - replace it with a regular file`);
  err(
    '\nWait for the condition instead (web-first assertion, expect.poll, toPass, or a helper\n' +
      'in e2e-playwright/helpers/app.ts). If the wait proves that something does NOT happen,\n' +
      `annotate it: "// settle: <why>" (>= ${MIN_REASON} chars) directly above the call.\n` +
      'See scripts/check-e2e-no-sleep.mjs and docs/TESTING.md.\n',
  );
  return 1;
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) process.exit(main());
