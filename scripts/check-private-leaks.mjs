// Private-reference leak guard for the public tree (issue #226).
//
// The repo went public under AGPL-3.0-or-later. The de-internalization sweep
// (PR #229) scrubbed maintainer names, private cloud-build infra, personal home
// paths, and internal planning/coordination docs out of the tracked tree. This
// guard stops them creeping back in — a leak committed to PUBLIC git history is
// expensive to undo, and `docs/plans/` already re-accumulates (a planning doc was
// re-added the day after #229 removed the directory).
//
// It scans every git-TRACKED text file (`git ls-files` — exactly the set that
// gets published) for a small set of high-signal markers:
//   - maintainer names / handles (exempted in the attribution files below, where
//     public credit is legitimate — README, CONTRIBUTING, AUTHORS, LICENSE, …).
//     Because these are word-bounded, they ALSO catch a personal home path like
//     /home/daniel or /Users/ndh — the form #229 actually had to scrub. (A generic
//     /home/<anything> rule was tried and dropped: it false-fired on benign example
//     paths like /home/v1.0 in unit tests.)
//   - the private cloud-build provider + its env-var prefix + the SSH-key alias
//   - the private planning/coordination doc + tool filenames
//   - the private issue-tracker references
//
// WHERE IT RUNS — its own workflow (.github/workflows/leak-scan.yml) with NO
// path filter. This is load-bearing: the `check` job and the `smoke` job BOTH
// path-ignore `**/*.md` and `docs/**`, which is exactly where a leak lands (a
// `docs/plans/*.md` change runs NEITHER today). So a gate wired into either of
// those would be a no-op for the riskiest files. Mirrors the placement reasoning
// of scripts/check-e2e-parallel-safe.mjs (it lives in `smoke` because `check`
// ignores e2e-playwright/**).
//
// This is a heuristic tripwire for the common, accidental re-introduction — not a
// secret scanner or a guarantee. Accepted gaps: it matches literal markers, so a
// novel paraphrase ("the maintainer in Prague") slips through; it skips binary
// files and the vendored upstream crate; and it cannot judge intent. Block on a
// hit, allow-list a verified-benign match with a written reason.
//
// Usage:  node scripts/check-private-leaks.mjs   (or: pnpm lint:private-leaks)

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Files where naming a maintainer is legitimate public attribution, so the
// `name` rule is suppressed there (every OTHER rule still applies). Matched by
// basename, case-insensitively, so docs/AUTHORS.md is covered too.
const ATTRIBUTION_BASENAMES = new Set([
  'readme.md', 'contributing.md', 'security.md', 'code_of_conduct.md',
  'authors', 'authors.md', 'contributors', 'contributors.md',
  'license', 'license.md', 'license-mit', 'license-apache', 'notice',
  'changelog.md', 'codeowners',
]);

// One rule per marker. `re` MUST carry the `g` flag (scanned with exec-in-loop).
// `accept(match)` exempts a benign sub-match (e.g. a placeholder username).
// `exemptAttribution` suppresses the rule in the attribution files above.
export const RULES = [
  {
    id: 'maintainer-name',
    // Word-bounded, so `daniel` matches `/home/daniel/…` too but NOT `ndhailey`
    // (the longer alternative claims that) or `Danielle`. `ndh` = the maintainer's
    // actual home-dir/account name (catches `/Users/ndh`).
    re: /\b(nico|daniel|saska|ndhailey|ndh)\b/gi,
    exemptAttribution: true,
    why: 'maintainer name/handle in a non-attribution file — internal-coordination leak. '
      + 'Use role-neutral phrasing or an issue link; public credit belongs in AUTHORS/README/CHANGELOG.',
  },
  {
    id: 'private-cloud-infra',
    // The private cloud-build provider, its env-var prefix, and the SSH-key alias.
    re: /\bscaleway\b|\bSCW_[A-Za-z]|\banzu\b/gi,
    why: 'private cloud-build infra reference (provider / SCW_ env var / SSH-key alias) — '
      + 'these live in the maintainer-only private repo, not the public tree.',
  },
  {
    id: 'private-doc-or-tool',
    // Filenames of the private coordination/planning docs and personal tool dirs.
    re: /personaldocs|workingnotes|stalagmight-inflight|stalagmight-project-notes|coord_board|ns-CLAUDE|stag-private|nico_sm_prioritized|\bnuc-i5\b/gi,
    why: 'reference to a private/personal coordination doc or tool path — never published.',
  },
  {
    id: 'private-tracker',
    // The private issue tracker (avoid bare "plane" — geometry uses the word).
    re: /\bplane\.so\b|\bplane[ -]id\b/gi,
    why: 'private issue-tracker reference (Plane) — track work in GitHub issues for the public repo.',
  },
];

// Verified-benign matches: {file (repo-relative POSIX), ruleId, reason}. Empty by
// design — the functional self-hosted-runner tokens kept in ci.yml
// (`i5-nuc-runner`, `NUC_RUNNER_READ_PAT`) are NOT matched by any rule above
// (the `nuc-i5` marker is the reversed personal tool-dir name), and a regression
// test pins that. Add a row here only for a real, justified exception.
export const ALLOW = [];

// Whole files excluded from the scan.
const EXCLUDE_EXACT = new Set([
  'src/types/ipc.generated.ts', // generated IPC types
  'scripts/check-private-leaks.mjs', // this scanner (defines the markers verbatim)
  'scripts/check-private-leaks.test.mjs', // its fixtures plant the markers on purpose
]);
const EXCLUDE_PREFIXES = [
  'src-tauri/vendor/', // vendored upstream crate — left verbatim (its own author/license)
  'src/types/ipc/', // generated IPC types
];
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'icns', 'pdf', 'svg', 'webp',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z',
  'wasm', 'dmp', 'stalx', 'db', 'sqlite', 'sqlite3', 'bin', 'keystore', 'jks',
  'p12', 'der', 'class', 'jar', 'mp4', 'mov', 'webm', 'snap',
]);

export function isExcluded(rel) {
  if (EXCLUDE_EXACT.has(rel)) return true;
  if (EXCLUDE_PREFIXES.some((p) => rel.startsWith(p))) return true;
  if (rel.endsWith('Cargo.lock') || rel.endsWith('pnpm-lock.yaml')) return true;
  const ext = rel.includes('.') ? rel.slice(rel.lastIndexOf('.') + 1).toLowerCase() : '';
  return BINARY_EXT.has(ext);
}

export function isAttributionFile(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase();
  return ATTRIBUTION_BASENAMES.has(base);
}

// Scan one file's text. Returns [{ruleId, lineNo, snippet, why, match}].
export function findLeaks(text, rel) {
  const attribution = isAttributionFile(rel);
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of RULES) {
      if (rule.exemptAttribution && attribution) continue;
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        if (m.index === rule.re.lastIndex) rule.re.lastIndex++; // guard zero-width
        if (rule.accept && rule.accept(m)) continue;
        out.push({
          ruleId: rule.id,
          lineNo: i + 1,
          snippet: line.trim().slice(0, 200),
          why: rule.why,
          match: m[0],
        });
      }
    }
  }
  return out;
}

function isAllowed(rel, ruleId) {
  return ALLOW.some((a) => a.file === rel && a.ruleId === ruleId);
}

function gitTrackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.toString('utf8').split('\0').filter(Boolean);
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function main() {
  let files;
  try {
    files = gitTrackedFiles();
  } catch (e) {
    console.error(`check-private-leaks: could not list tracked files (run from a git repo): ${e.message}`);
    return 1;
  }

  const violations = [];
  let scanned = 0;
  for (const rel of files.sort()) {
    if (isExcluded(rel)) continue;
    const full = path.join(REPO_ROOT, rel);
    let buf;
    try {
      buf = fs.readFileSync(full);
    } catch {
      continue; // staged-but-absent / submodule pointer / race — nothing to scan
    }
    if (looksBinary(buf)) continue;
    scanned++;
    for (const v of findLeaks(buf.toString('utf8'), rel)) {
      if (isAllowed(rel, v.ruleId)) continue;
      violations.push({ rel, ...v });
    }
  }

  if (violations.length === 0) {
    console.log(`✓ private-leak scan: ${scanned} tracked text files, no internal/personal references.`);
    return 0;
  }

  console.error(`\n✗ private-leak scan failed — ${violations.length} reference(s) that should not be public:\n`);
  for (const v of violations) {
    console.error(`  [${v.ruleId}] ${v.rel}:${v.lineNo}  (matched "${v.match}")`);
    console.error(`      ${v.snippet}`);
    console.error(`      ${v.why}\n`);
  }
  console.error(
    'Remove the reference (move it to the maintainer-only private repo), rephrase it\n' +
      'role-neutrally, or — if it is genuinely benign — add an ALLOW row with a reason in\n' +
      'scripts/check-private-leaks.mjs. See the file header for the rationale.\n',
  );
  return 1;
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) process.exit(main());
