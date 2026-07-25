// Private-reference leak guard for the public tree (issue #226).
//
// The repo went public under AGPL-3.0-or-later. The de-internalization sweep
// (PR #229) scrubbed maintainer names, private cloud-build infra, personal home
// paths, and internal planning/coordination docs out of the tracked tree. This
// guard stops them creeping back in - a leak committed to PUBLIC git history is
// expensive to undo, and `docs/plans/` already re-accumulates (a planning doc was
// re-added the day after #229 removed the directory).
//
// It scans every git-TRACKED text file (`git ls-files` - exactly the set that
// gets published) for a small set of high-signal markers:
//   - maintainer names / handles. These also catch a name-bearing personal path
//     (`/home/daniel`, `/Users/ndh`). Suppressed only in ROOT attribution files
//     (README, CONTRIBUTING, AUTHORS, LICENSE, CHANGELOG, SECURITY, …), where
//     public credit is legitimate - NOT in nested code-adjacent READMEs.
//   - the private cloud-build provider + its env-var prefix + the SSH-key alias
//     + the private build host's rsync target.
//   - the private planning/coordination doc + tool filenames.
//   - the private issue-tracker references.
//
// WHERE IT RUNS - its own workflow (.github/workflows/leak-scan.yml) with NO
// path filter. This is load-bearing: the `check` job and the `smoke` job BOTH
// path-ignore `**/*.md` and `docs/**`, which is exactly where a leak lands (a
// `docs/plans/*.md` change runs NEITHER today). So a gate wired into either of
// those would be a no-op for the riskiest files. Mirrors the placement reasoning
// of scripts/check-e2e-parallel-safe.mjs (it lives in `smoke` because `check`
// ignores e2e-playwright/**).
//
// This is a heuristic tripwire for the common, accidental re-introduction - not a
// secret scanner or a guarantee. DELIBERATE coverage choices / accepted gaps:
//   - It targets maintainer-NAME-bearing paths, not generic build-box paths
//     (`/home/ubuntu`, `/home/runner`): those carry no identity and appear all
//     over CI docs, so a generic `/home/<x>` rule was tried and dropped (it
//     false-fired on `/home/v1.0` in a unit test).
//   - A name adjacent to letters (`Danielle`, `unicode`) does NOT fire, but a
//     name adjacent to `_`/`/`/digits (`daniel_saska`, `/home/daniel`) does. The
//     short `dan` nickname is intentionally NOT a marker (too false-positive
//     prone); `daniel` covers the full form.
//   - The doc/tool markers substring-match on purpose (to catch them inside
//     paths like `~/personaldocs/x`); they are distinctive enough that this is
//     safe.
//   - It matches literal markers, so a novel paraphrase ("the maintainer in
//     Prague") slips; it skips binary files and the vendored crate; and it cannot
//     judge intent. A file it CANNOT read, or that exceeds the size cap, is NOT a
//     silent skip - it FAILS the gate (fail-closed), so a marker can't be smuggled
//     past the scan inside a file the scanner declines to read (#232, Copilot).
// Block on a hit; allow-list a verified-benign match with a written reason.
//
// Usage:  node scripts/check-private-leaks.mjs   (or: pnpm lint:private-leaks)

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Files at the REPO ROOT where naming a maintainer is legitimate public
// attribution, so the `maintainer-name` rule is suppressed there (every OTHER
// rule still applies). Root-only on purpose: a nested code-adjacent README
// (src/.../README.md) is NOT an attribution file and stays fully scanned.
const ATTRIBUTION_BASENAMES = new Set([
  'readme.md', 'contributing.md', 'security.md', 'code_of_conduct.md',
  'authors', 'authors.md', 'contributors', 'contributors.md',
  'license', 'license.md', 'license-mit', 'license-apache', 'notice',
  'changelog.md', 'codeowners',
]);

// One rule per marker. `re` MUST carry the `g` flag (scanned with exec-in-loop).
// `exemptAttribution` suppresses the rule in the root attribution files above.
export const RULES = [
  {
    id: 'maintainer-name',
    // Long names use letter-lookaround (not `\b`), so `_`/digit-adjacent forms
    // (`daniel_saska`, `nico2`) and path forms (`/home/daniel`) fire, while a
    // letter-adjacent lookalike (`Danielle`, `unicode`→`nico`) does NOT. `ndhailey`
    // (the longer alt) claims that token before the short `ndh` branch can. `ndh`
    // (the maintainer's home-dir name) is path-anchored - `/Users/ndh` fires, a
    // standalone `ndh` token does not - to avoid false-firing on an incidental
    // 3-char token.
    re: /(?<![A-Za-z])(nico|daniel|saska|ndhailey)(?![A-Za-z])|(?<=[/\\])ndh(?![A-Za-z0-9])/gi,
    exemptAttribution: true,
    why: 'maintainer name/handle in a non-attribution file - internal-coordination leak. '
      + 'Use role-neutral phrasing or an issue link; public credit belongs in AUTHORS/README/CHANGELOG.',
  },
  {
    id: 'private-cloud-infra',
    // The private cloud-build provider, its env-var prefix (any trailing char,
    // incl. digit-led names), the SSH-key alias, and the build host's rsync
    // target (`cog:~/…` / `cog:/…`).
    re: /\bscaleway\b|\bSCW_|\banzu\b|\bcog:[~/]/gi,
    why: 'private cloud-build infra reference (provider / SCW_ env var / SSH-key alias / build-host rsync target) - '
      + 'these live in the maintainer-only private repo, not the public tree.',
  },
  {
    id: 'private-doc-or-tool',
    // Filenames of the private coordination/planning docs and personal tool dirs.
    // Substring-matched on purpose (catches them inside paths); each is distinctive.
    re: /personaldocs|workingnotes|stalagmight-inflight|stalagmight-project-notes|coord_board|ns-CLAUDE|stag-private|nico_sm_prioritized|\bnuc-i5\b/gi,
    why: 'reference to a private/personal coordination doc or tool path - never published.',
  },
  {
    id: 'private-tracker',
    // The private issue tracker (avoid bare "plane" - geometry uses the word).
    re: /\bplane\.so\b|\bplane[ -]id\b/gi,
    why: 'private issue-tracker reference (Plane) - track work in GitHub issues for the public repo.',
  },
];

// Verified-benign matches: {file (repo-relative POSIX), ruleId, reason}. Empty by
// design - the functional self-hosted-runner tokens kept in ci.yml
// (`i5-nuc-runner`, `NUC_RUNNER_READ_PAT`) are NOT matched by any rule above
// (the `nuc-i5` marker is the reversed personal tool-dir name), and a regression
// test pins that. Add a row here only for a real, justified exception.
export const ALLOW = [];

// Skip a file larger than this without scanning (logged). Bounds scan time and the
// violations array against an adversarial multi-MB single-line file on a fork PR;
// no tracked text file legitimately approaches this.
const MAX_SCAN_BYTES = 5 * 1024 * 1024;

// Whole files excluded from the scan.
const EXCLUDE_EXACT = new Set([
  'src/types/ipc.generated.ts', // generated IPC types
  'scripts/check-private-leaks.mjs', // this scanner (defines the markers verbatim)
  'scripts/check-private-leaks.test.mjs', // its fixtures plant the markers on purpose
]);
const EXCLUDE_PREFIXES = [
  'src-tauri/vendor/', // vendored upstream crate - left verbatim (its own author/license)
  'src/types/ipc/', // generated IPC types
];
// Genuinely-binary extensions (skipped before reading). NOTE: text formats that
// can carry a leak - `.svg` (title/desc/comments), `.snap` (serialized DOM/paths)
// - are deliberately NOT here, so they get scanned; the null-byte `looksBinary`
// guard + MAX_SCAN_BYTES still protect against a real binary or a huge file.
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'icns', 'pdf', 'webp',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z',
  'wasm', 'dmp', 'stalx', 'tml', 'db', 'sqlite', 'sqlite3', 'bin', 'keystore', 'jks',
  'p12', 'der', 'class', 'jar', 'mp4', 'mov', 'webm',
]);

export function isExcluded(rel) {
  if (EXCLUDE_EXACT.has(rel)) return true;
  if (EXCLUDE_PREFIXES.some((p) => rel.startsWith(p))) return true;
  if (rel.endsWith('Cargo.lock') || rel.endsWith('pnpm-lock.yaml')) return true;
  const ext = rel.includes('.') ? rel.slice(rel.lastIndexOf('.') + 1).toLowerCase() : '';
  return BINARY_EXT.has(ext);
}

// Attribution exemption applies only to ROOT-level files (no path separator), so a
// nested code-adjacent README is still fully scanned for maintainer names.
export function isAttributionFile(rel) {
  if (rel.includes('/')) return false;
  return ATTRIBUTION_BASENAMES.has(rel.toLowerCase());
}

// Scan one file's text. Returns [{ruleId, lineNo, why, match}]. Note: the matched
// substring (`match`) is the MARKER itself (e.g. "SCW_", "daniel") - never the
// whole line - so printing it to a public CI log can't publish an adjacent secret.
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
        out.push({ ruleId: rule.id, lineNo: i + 1, why: rule.why, match: m[0] });
      }
    }
  }
  return out;
}

function isAllowed(rel, ruleId) {
  return ALLOW.some((a) => a.file === rel && a.ruleId === ruleId);
}

// The gate fails if any marker fired OR any tracked file could not be scanned. A
// skip (oversized/unreadable) is a FAILURE, not a warning - otherwise a marker
// could be smuggled past the scan inside a file the scanner declines to read
// (Copilot review on #232).
export function gateFails(violations, skipped) {
  return violations.length > 0 || skipped.length > 0;
}

function gitTrackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.toString('utf8').split('\0').filter(Boolean);
}

export function looksBinary(buf) {
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
  const skipped = []; // {rel, reason} - oversized/unreadable; each FAILS the gate (fail-closed, #232)
  let scanned = 0;
  for (const rel of files.sort()) {
    if (isExcluded(rel)) continue;
    const full = path.join(REPO_ROOT, rel);
    let buf;
    try {
      buf = fs.readFileSync(full);
    } catch (e) {
      // staged-but-absent / submodule pointer / permission / race. Don't drop it
      // silently - a leak-containing file that fails to read must not pass as clean.
      skipped.push({ rel, reason: `unreadable (${e.code || e.message})` });
      continue;
    }
    if (buf.length > MAX_SCAN_BYTES) {
      skipped.push({ rel, reason: `${(buf.length / 1048576).toFixed(1)} MB > ${MAX_SCAN_BYTES / 1048576} MB cap` });
      continue;
    }
    if (looksBinary(buf)) {
      // A NUL byte in a file whose extension is NOT a known binary type (those are
      // excluded before we ever read them) is undecidable: it could be a mislabeled
      // binary, or a text file with an embedded NUL that hides a marker past it. Fail
      // closed (#232 / #241) instead of skipping silently -- if it is genuinely binary,
      // add its extension to BINARY_EXT so it is excluded up front.
      skipped.push({ rel, reason: 'binary-like content (NUL byte) in a non-binary extension' });
      continue;
    }
    scanned++;
    for (const v of findLeaks(buf.toString('utf8'), rel)) {
      if (isAllowed(rel, v.ruleId)) continue;
      violations.push({ rel, ...v });
    }
  }

  if (!gateFails(violations, skipped)) {
    console.log(`✓ private-leak scan: ${scanned} tracked text files, no internal/personal references.`);
    return 0;
  }

  console.error('\n✗ private-leak scan failed:\n');
  for (const v of violations) {
    // Print the MARKER and location only - never the surrounding line (a public CI
    // log on a public repo must not echo a secret that sits beside the marker).
    console.error(`  [${v.ruleId}] ${v.rel}:${v.lineNo}  (matched "${v.match}")`);
    console.error(`      ${v.why}\n`);
  }
  // Fail closed on a skip: a file the scanner can't read (or that exceeds the size
  // cap) must not pass as clean - else a marker could be smuggled inside it (#232).
  for (const s of skipped) {
    console.error(`  [unscanned] ${s.rel} - ${s.reason}`);
    console.error('      could not scan this file; failing closed (shrink it, or exclude it deliberately).\n');
  }
  console.error(
    'Remove the reference (move it to the maintainer-only private repo) or shrink/exclude\n' +
      'the unscanned file. If a match is genuinely benign, add an ALLOW row with a reason in\n' +
      'scripts/check-private-leaks.mjs. See the file header for the rationale.\n',
  );
  return 1;
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) process.exit(main());
