// No-unannotated-sleep gate for the Playwright tier (#576 E14).
//
// docs/TESTING.md has said "Do not sleep" for a long time: a hard
// `page.waitForTimeout()` is the single biggest flake source, and a sleep that
// stands in for a real condition makes a test slow when the condition is quick
// and wrong when it is slow. Nothing enforced it, and the count grew (41 -> 48
// lines by #576). This gate fails on every `waitForTimeout(` call in
// e2e-playwright/ that is not explicitly annotated as a deliberate settle.
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
// Out of scope by design: a `setTimeout` inside page.evaluate (that is mock
// latency or an in-page timer, not the test runner sleeping) and Playwright's
// own `test.setTimeout` (a budget, not a wait). Comments are stripped with the
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
import { stripComments } from './lib/js-comments.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCAN_DIR = 'e2e-playwright';
export const MIN_REASON = 12;

const SLEEP_RE = /\bwaitForTimeout\s*\(/g;
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

// Every waitForTimeout call in one file's code: [{lineNo, reason}] where reason
// is the settle annotation or null.
// Same-line string literals are blanked too (stripComments keeps them, since
// other gates match INSIDE strings): a label like 'page.waitForTimeout(100)'
// is not a call.
const STRING_RE = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g;

export function findSleeps(text) {
  const lines = text.split('\n');
  const code = stripComments(lines).map((c) => c.replace(STRING_RE, "''"));
  const out = [];
  code.forEach((c, i) => {
    const hits = c.match(SLEEP_RE);
    if (!hits) return;
    const reason = settleReason(lines, i);
    for (let k = 0; k < hits.length; k++) out.push({ lineNo: i + 1, reason });
  });
  return out;
}

// Scan repo-relative files; `readFile` is injected for the fixture test.
export function scan(files, readFile) {
  const violations = [];
  let settles = 0;
  for (const rel of files) {
    for (const s of findSleeps(readFile(rel))) {
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
    log(`✓ e2e-playwright no-sleep: ${files.length} files, no unannotated waitForTimeout (${settles} annotated settle(s)).`);
    return 0;
  }
  err(`\n✗ e2e-playwright no-sleep check failed - ${violations.length + symlinks.length} issue(s):\n`);
  for (const v of violations) err(`  ${v.rel}:${v.lineNo}  waitForTimeout without a "// settle: <reason>" comment above it`);
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
