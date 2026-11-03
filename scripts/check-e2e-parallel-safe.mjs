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
// The same walk over every spec also checks one tier invariant that is not about
// parallelism (#576 RV8b-E3-3): each spec takes `test` from fixtures/coverage.ts,
// whose auto fixture is the unmocked-IPC teardown guard (rule `unguarded-test`).
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
// mutation. Regex literals are recognised, so a `/*` or a quote inside one
// neither opens a comment nor hides code (scripts/lib/js-comments.mjs).
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

// The fs calls that write, create, delete or link on disk, and the short async
// names (fs/promises) that are also common method names elsewhere.
const DISK_WRITE_NAMES = [
  'writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'createWriteStream', 'copyFileSync', 'copyFile', 'cpSync',
  'renameSync', 'mkdirSync', 'mkdir', 'unlinkSync', 'unlink', 'rmSync', 'rmdirSync', 'rmdir', 'symlinkSync', 'symlink',
  'truncateSync', 'openSync', 'writeSync', 'writevSync', 'linkSync', 'chmodSync', 'ftruncateSync',
];
const FS_SHORT_NAMES = ['open', 'link', 'chmod', 'rm', 'cp', 'rename', 'truncate'];
const LONG = DISK_WRITE_NAMES.join('|');
const FS_RECEIVER = '\\b(?:fs|fsp|fsPromises|promises)';

// `{ ... }` import / destructure sources that bind fs functions to plain names:
// `import {...} from '(node:)fs(/promises)'`, `const {...} = require(...)` (or
// `await import(...)`) of the same modules, and `{...} = fs | fsp |
// fsPromises | promises | fs.promises`. Matched on the whole comment-stripped
// file, so a multi-line import brace counts; group 1 is the brace contents.
const FS_IMPORT_RES = [
  /\bimport\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*(['"`])(?:node:)?fs(?:\/promises)?\2/g,
  /\b(?:const|let|var)\s+\{([^}]*)\}\s*=\s*(?:await\s+)?(?:require|import)\s*\(\s*(['"`])(?:node:)?fs(?:\/promises)?\2\s*\)/g,
  /\{([^}]*)\}\s*=(?![=>])\s*(?:fs\.promises|fsPromises|fsp|fs|promises)(?![\w$.])/g,
];
const FS_IMPORTED = new Set([...DISK_WRITE_NAMES, ...FS_SHORT_NAMES]);

// 0-based lines of `code` (stripComments output) that import or destructure a
// disk-write name from fs, alias or not: the line of the name itself.
function fsImportLines(code) {
  const text = code.join('\n');
  const lines = new Set();
  for (const re of FS_IMPORT_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      let at = m.index + m[0].indexOf('{') + 1;
      for (const entry of m[1].split(',')) {
        const name = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)/.exec(entry);
        if (name && FS_IMPORTED.has(name[1])) {
          lines.add(text.slice(0, at + name[0].length).split('\n').length - 1);
        }
        at += entry.length + 1;
      }
    }
  }
  return lines;
}

// [#576 RV8b-E3-3] The unmocked-IPC teardown guard (E3) is an auto fixture on the
// `test` that e2e-playwright/fixtures/coverage.ts exports: a spec that takes `test`
// from anywhere else runs with no guard, and an unmocked command silently answers
// null. So a spec must import `test` from fixtures/coverage, and must take no value
// import of `test` (nor a default / namespace import) from '@playwright/test' - a
// type-only import is fine. Returns the 0-based lines to report.
const SPEC_FILE_RE = /\.spec\.ts$/;
const GUARDED_TEST_IMPORT_RE =
  /\bimport\s*\{[^}]*\btest\b[^}]*\}\s*from\s*(['"`])(?:\.\.?\/)+(?:[\w.-]+\/)*fixtures\/coverage\1/;
const PLAYWRIGHT_IMPORT_RE = /\bimport\s+(type\s+)?([^;]*?)\s*from\s*(['"`])@playwright\/test\3/g;
function unguardedTestLines(code, rel) {
  const lines = new Set();
  if (!SPEC_FILE_RE.test(rel)) return lines;
  const text = code.join('\n');
  const lineOf = (at) => text.slice(0, at).split('\n').length - 1;
  PLAYWRIGHT_IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = PLAYWRIGHT_IMPORT_RE.exec(text)) !== null) {
    if (m[1]) continue; // `import type { ... }`
    const named = /\{([^}]*)\}/.exec(m[2]);
    const valueTest = named !== null && named[1].split(',').some((spec) => /^\s*test\b/.test(spec));
    const defaultOrNamespace = /^\s*(?:\*\s*as\s+[\w$]+|[\w$]+)\s*(?:,|$)/.test(m[2]);
    if (valueTest || defaultOrNamespace) lines.add(lineOf(m.index));
  }
  if (!GUARDED_TEST_IMPORT_RE.test(text)) lines.add(Math.max(0, code.findIndex((l) => l.trim())));
  return lines;
}

// One rule per parallel-unsafe pattern. `re` is tested per comment-stripped line;
// an optional `accept(match)` exempts a benign sub-case (used for the shared port),
// and an optional `fileLines(code, rel)` adds the lines a whole-file pattern fires on.
export const RULES = [
  {
    id: 'own-server',
    // A WebSocket server binds a port just the same (`ws`: `new WebSocketServer(`,
    // or the older `new WebSocket.Server(`; #576 NF-FIX3B-1).
    re: /\bcreateServer\s*\(|\bnew\s+(?:WebSocketServer|WebSocket\.Server)\s*\(/,
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
    // unique by construction. Opening a file for writing (openSync + writeSync),
    // a hard link and a mode change are the same shared-disk mutation
    // (#576 RV3-FE-12); `open` / `link` / `chmod` are common method names
    // (`window.open(`, a menu's `open(`), so their async forms count only on an
    // fs-looking receiver (`fs.`, `fsp.`, `fsPromises.`, `promises.`).
    // Bracket access (`fs['writeFileSync'](p)`; the short names only on an fs
    // receiver) and a name imported or destructured from fs / fs/promises,
    // alias or not (`import { writeFileSync as w } from 'node:fs'`,
    // `const { open } = fs.promises`), count too (#576 RV4-FE-FEB-3); the
    // import check reads the whole file, so a multi-line import brace counts.
    re: new RegExp(
      `\\b(?:${LONG})\\s*\\(|\\.(?:rm|cp|rename|truncate)\\s*\\(|${FS_RECEIVER}\\.(?:open|link|chmod)\\s*\\(`
        + `|\\[\\s*(['"\`])(?:${LONG})\\1\\s*\\]|${FS_RECEIVER}\\s*\\[\\s*(['"\`])(?:${FS_SHORT_NAMES.join('|')})\\2\\s*\\]`,
    ),
    fileLines: fsImportLines,
    why: 'writes, creates or deletes on disk - use a per-(test,worker)-unique path only (see fixtures/coverage.ts), else concurrent workers clobber each other.',
  },
  {
    id: 'foreign-host-port',
    // A literal port, a template-interpolated one (`localhost:${port}`), or one
    // concatenated onto the string (`'localhost:' + port`), which is how a
    // per-test server's address is usually spelled; `0.0.0.0` is the
    // all-interfaces spelling of the same bind (#576 NF-FIX3B-1), and `[::1]` /
    // `[::]` are the IPv6 loopback and all-interfaces ones (#576 NF-W4M-5).
    re: /(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1?\]):(?:(\d+|\$\{[^}]*\})|['"`]\s*\+\s*([^\s;,)]+))/,
    // Allow the shared Vite port, in any of the three spellings.
    accept: (m) => (m[1] ?? m[2]).replace(/^['"`]|['"`]$/g, '') === SHARED_VITE_PORT,
    why: `hardcodes a host:port other than :${SHARED_VITE_PORT} - implies a per-test server/socket, not parallel-safe.`,
  },
  {
    // Not a parallel-safety rule: the one tier invariant this walk over every spec
    // also checks (#576 RV8b-E3-3, see unguardedTestLines). Whole-file only.
    id: 'unguarded-test',
    re: /(?!)/,
    fileLines: unguardedTestLines,
    why: "takes `test` from somewhere other than ./fixtures/coverage - the unmocked-IPC teardown guard (#576 E3) rides on that fixture's `test`; import { test } from './fixtures/coverage' (a type-only import from @playwright/test is fine).",
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
    const fileHits = new Map(RULES.filter((r) => r.fileLines).map((r) => [r.id, r.fileLines(code, rel)]));
    code.forEach((c, i) => {
      if (!c.trim()) return;
      for (const rule of RULES) {
        const m = rule.re.exec(c);
        if (!m && !fileHits.get(rule.id)?.has(i)) continue;
        if (m && rule.accept && rule.accept(m)) continue;
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
