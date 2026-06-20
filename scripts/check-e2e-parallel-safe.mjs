// Parallel-safety guard for the Playwright tier (issue #126).
//
// The `e2e-playwright/` tier runs with `fullyParallel: true` at multiple workers.
// That is safe ONLY because every spec keeps its backend state per-page on
// `window.*` (mocked IPC) — no spec binds a port, writes a fixed disk path, or
// shares a server / global. This scanner fails the build if a spec introduces a
// pattern that would break that invariant. See docs/TESTING.md.
//
// Runs in the `smoke` job (e2e-smoke.yml) — the only CI job that triggers on
// `e2e-playwright/**`. `check` (the home of the repo's Rust/vitest grep-gates)
// path-ignores `e2e-playwright/**`, so a gate there would be a no-op for an
// e2e-playwright-only PR — exactly the change this must catch.
//
// Usage:  node scripts/check-e2e-parallel-safe.mjs   (or: pnpm lint:e2e-parallel)

import * as fs from 'fs';
import * as path from 'path';

const ROOT = process.cwd();
const SCAN_DIR = path.join(ROOT, 'e2e-playwright');
const SHARED_VITE_PORT = '1420'; // the one shared webServer every page talks to

// Files allowed to break a specific rule, each with the reason it is safe. The
// coverage fixture writes a per-(test,worker)-unique file under docs/coverage,
// gated behind E2E_COVERAGE=1 — parallel-safe by construction. To add a genuine
// exception, append a row here with a written justification.
const ALLOW = [{ file: 'e2e-playwright/fixtures/coverage.ts', rule: 'disk-write' }];

// One rule per parallel-unsafe pattern. `re` is tested per non-comment line; an
// optional `accept(match)` exempts a benign sub-case (used for the shared port).
const RULES = [
  {
    id: 'own-server',
    re: /\bcreateServer\s*\(/,
    why: 'starts its own server — every page shares the one Vite webServer (:1420).',
  },
  {
    id: 'port-listen',
    re: /\.listen\s*\(/,
    why: 'binds a port — parallel workers would collide on it.',
  },
  {
    id: 'disk-write',
    // Require the call paren so mock command labels such as 'plugin:fs|writeFile'
    // (string literals, no `(`) do not false-positive.
    re: /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\s*\(/,
    why: 'writes disk — use a per-(test,worker)-unique path only (see fixtures/coverage.ts), else concurrent workers clobber each other.',
  },
  {
    id: 'foreign-host-port',
    re: /(?:127\.0\.0\.1|localhost):(\d+)/,
    accept: (m) => m[1] === SHARED_VITE_PORT, // allow the shared Vite port
    why: `hardcodes a host:port other than :${SHARED_VITE_PORT} — implies a per-test server/socket, not parallel-safe.`,
  },
  {
    id: 'serial',
    re: /\b(?:describe|test)\.serial\b/,
    why: 'serial execution defeats fullyParallel. If genuinely required, add this file to ALLOW in this script with a written reason.',
  },
];

function isAllowed(relFile, ruleId) {
  return ALLOW.some((a) => a.file === relFile && a.rule === ruleId);
}

function listTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Cheap comment skip — not a real parser, just avoids the common false positive
// of a pattern appearing inside a line/block comment.
function isCommentLine(line) {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function main() {
  if (!fs.existsSync(SCAN_DIR)) {
    console.error(`check-e2e-parallel-safe: ${SCAN_DIR} not found (run from the repo root).`);
    return 1;
  }

  const files = listTsFiles(SCAN_DIR);
  const violations = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      // Drop a trailing line-comment so a pattern mentioned in prose (e.g.
      // `// avoid writeFileSync( here`) doesn't false-positive. Only strip `//`
      // preceded by whitespace, which leaves `://` inside URL strings intact.
      const code = line.replace(/\s\/\/.*$/, '');
      for (const rule of RULES) {
        const m = rule.re.exec(code);
        if (!m) continue;
        if (rule.accept && rule.accept(m)) continue;
        if (isAllowed(rel, rule.id)) continue;
        violations.push({ rel, lineNo: i + 1, ruleId: rule.id, why: rule.why, snippet: line.trim() });
      }
    });
  }

  if (violations.length === 0) {
    console.log(`✓ e2e-playwright parallel-safe: scanned ${files.length} files, no unsafe patterns.`);
    return 0;
  }

  console.error(`\n✗ e2e-playwright parallel-safety check failed — ${violations.length} issue(s):\n`);
  for (const v of violations) {
    console.error(`  [${v.ruleId}] ${v.rel}:${v.lineNo}`);
    console.error(`      ${v.snippet}`);
    console.error(`      ${v.why}\n`);
  }
  console.error(
    'The mocked Playwright tier runs fullyParallel at multiple workers; all state must\n' +
      'stay per-page (window.*). See docs/TESTING.md → "Parallel-safety invariant".\n',
  );
  return 1;
}

process.exit(main());
