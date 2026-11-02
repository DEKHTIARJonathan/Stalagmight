// Parallel-safety guard for the Playwright tier (issue #126).
//
// The `e2e-playwright/` tier runs with `fullyParallel: true` at multiple workers.
// That is safe ONLY because every spec keeps its backend state per-page on
// `window.*` (mocked IPC) - no spec binds a port, writes a fixed disk path, or
// shares a server / global. This scanner fails the build if a spec introduces a
// pattern that would break that invariant. See docs/testing-recipes.md.
//
// Runs in the `smoke` job (e2e-smoke.yml) - the only CI job that runs the
// Playwright tier on `e2e-playwright/**` changes. `check` (the home of the
// repo's Rust/vitest grep-gates) path-ignores `e2e-playwright/**`, so a gate
// there would be a no-op for an e2e-playwright-only PR - exactly the change this
// must catch. Its rules are pinned by scripts/check-e2e-parallel-safe.test.mjs
// (#576 E7), which runs first in the same job.
//
// The premise is checked too: the root `playwright.config.ts` must still say
// `fullyParallel: true` - a config that quietly turned it off would make every
// rule below moot while the gate kept passing.
//
// This is a line-based heuristic tripwire for the *common, accidental* regression,
// not a parser/sandbox. Comments are stripped by a small string-aware scanner
// (a quoted `/*` or `//` neither opens nor cuts a comment; block comments carry
// across lines), so a pattern named in prose does not fire while one inside a
// string does. Known accepted gaps: it doesn't inspect `page.screenshot({path})`
// (framework I/O, used with unique filenames) or `process.env`/module-global
// mutation, and a regex literal holding a quote can confuse the comment scanner
// for the rest of that one line (it can only cause a false positive).
//
// Usage:  node scripts/check-e2e-parallel-safe.mjs   (or: pnpm lint:e2e-parallel)

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { walkFiles } from './lib/src-files.mjs';
import { stripComments } from './lib/js-comments.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCAN_DIR = 'e2e-playwright';
export const CONFIG_FILE = 'playwright.config.ts';
const SHARED_VITE_PORT = '1420'; // the one shared webServer every page talks to

// Files allowed to break a specific rule, each with the reason it is safe. The
// coverage fixture writes a per-(test,worker)-unique file under docs/coverage,
// gated behind E2E_COVERAGE=1 - parallel-safe by construction. To add a genuine
// exception, append a row here with a written justification.
export const ALLOW = [
  {
    file: 'e2e-playwright/fixtures/coverage.ts',
    rule: 'disk-write',
    reason: 'per-(test,worker)-unique path under docs/coverage, gated on E2E_COVERAGE=1',
  },
];

// One rule per parallel-unsafe pattern. `re` is tested per comment-stripped line;
// an optional `accept(match)` exempts a benign sub-case (used for the shared port).
export const RULES = [
  {
    id: 'own-server',
    re: /\bcreateServer\s*\(/,
    why: 'starts its own server - every page shares the one Vite webServer (:1420).',
  },
  {
    id: 'port-listen',
    re: /\.listen\s*\(/,
    why: 'binds a port - parallel workers would collide on it.',
  },
  {
    id: 'disk-write',
    // Require the call paren so mock command labels such as 'plugin:fs|writeFile'
    // (string literals, no `(`) do not false-positive. `page.screenshot({path})`
    // is intentionally absent - it's framework I/O, used here with unique names.
    // Creating, deleting and linking paths mutate shared disk state exactly as a
    // write does (#576 E7). The ambiguous short async names (rm, cp, rename,
    // truncate) only count as a member call (`fs.rm(`, `fsp.rename(`), so a UI
    // helper called `rename(` does not fire. mkdtemp is not here: its path is
    // unique by construction.
    re: /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyFileSync|copyFile|cpSync|renameSync|mkdirSync|mkdir|unlinkSync|unlink|rmSync|rmdirSync|rmdir|symlinkSync|symlink|truncateSync)\s*\(|\.(?:rm|cp|rename|truncate)\s*\(/,
    why: 'writes, creates or deletes on disk - use a per-(test,worker)-unique path only (see fixtures/coverage.ts), else concurrent workers clobber each other.',
  },
  {
    id: 'foreign-host-port',
    // A literal port, or a template-interpolated one (`localhost:${port}`),
    // which is how a per-test server's address is usually spelled.
    re: /(?:127\.0\.0\.1|localhost):(\d+|\$\{[^}]*\})/,
    accept: (m) => m[1] === SHARED_VITE_PORT, // allow the shared Vite port
    why: `hardcodes a host:port other than :${SHARED_VITE_PORT} - implies a per-test server/socket, not parallel-safe.`,
  },
  {
    id: 'serial',
    // Both the `test.describe.serial(...)` shorthand and the idiomatic
    // `test.describe.configure({ mode: 'serial' })` form.
    re: /\b(?:describe|test)\.serial\b|mode:\s*['"]serial['"]/,
    why: 'serial execution defeats fullyParallel. If genuinely required, add this file to ALLOW in this script with a written reason.',
  },
];

export function isAllowed(relFile, ruleId) {
  return ALLOW.some((a) => a.file === relFile && a.rule === ruleId);
}

// Comment stripping is the shared string-aware scanner in
// scripts/lib/js-comments.mjs (re-exported for the fixture test). The old
// per-line version here opened a block comment at ANY `/*` - including one
// inside a string such as 'fixtures/*.dmp' - and then blanked the rest of the file.
export { stripComments };

// Scan files (repo-relative paths). `readFile(rel)` returns text; injected so
// the fixture test drives every rule without a tree on disk.
export function scan(files, readFile) {
  const violations = [];
  for (const rel of files) {
    const lines = readFile(rel).split('\n');
    const code = stripComments(lines);
    code.forEach((c, i) => {
      if (!c.trim()) return;
      for (const rule of RULES) {
        const m = rule.re.exec(c);
        if (!m) continue;
        if (rule.accept && rule.accept(m)) continue;
        if (isAllowed(rel, rule.id)) continue;
        violations.push({ rel, lineNo: i + 1, ruleId: rule.id, why: rule.why, snippet: lines[i].trim() });
      }
    });
  }
  return violations;
}

// The premise every rule rests on. Returns a problem string, or null.
export function checkPremise(configText) {
  if (configText === null) return `${CONFIG_FILE} not found - cannot confirm the suite runs fullyParallel.`;
  const code = stripComments(configText.split('\n')).join('\n');
  if (!/\bfullyParallel\s*:\s*true\b/.test(code)) {
    return `${CONFIG_FILE} no longer sets \`fullyParallel: true\` - the rules below guard that mode; if it was turned off on purpose, say why here and in docs/testing-recipes.md.`;
  }
  return null;
}

export function main(root = REPO_ROOT, log = console.log, err = console.error) {
  if (!fs.existsSync(path.join(root, SCAN_DIR))) {
    err(`check-e2e-parallel-safe: ${path.join(root, SCAN_DIR)} not found (run from the repo root).`);
    return 1;
  }
  const { files, symlinks } = walkFiles(root, SCAN_DIR, { exts: ['.ts', '.tsx'] });
  const violations = scan(files, (rel) => fs.readFileSync(path.join(root, rel), 'utf8'));
  for (const link of symlinks) {
    violations.push({ rel: link.rel, lineNo: 0, ruleId: 'symlink', why: 'a symlink is not followed, so its target is unscanned - replace it with a regular file.', snippet: `-> ${link.target}` });
  }
  const configPath = path.join(root, CONFIG_FILE);
  const premise = checkPremise(fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null);
  if (premise) violations.push({ rel: CONFIG_FILE, lineNo: 0, ruleId: 'premise', why: premise, snippet: '' });

  if (violations.length === 0) {
    log(`✓ e2e-playwright parallel-safe: scanned ${files.length} files, no unsafe patterns (${CONFIG_FILE}: fullyParallel).`);
    return 0;
  }

  err(`\n✗ e2e-playwright parallel-safety check failed - ${violations.length} issue(s):\n`);
  for (const v of violations) {
    err(`  [${v.ruleId}] ${v.rel}${v.lineNo ? `:${v.lineNo}` : ''}`);
    if (v.snippet) err(`      ${v.snippet}`);
    err(`      ${v.why}\n`);
  }
  err(
    'The mocked Playwright tier runs fullyParallel at multiple workers; all state must\n' +
      'stay per-page (window.*). See docs/testing-recipes.md, "Parallel-safety invariant".\n',
  );
  return 1;
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) process.exit(main());
