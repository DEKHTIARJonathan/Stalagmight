// File-size ratchet for the `stalagmight` Rust crate (src-tauri/src).
//
// Keeps non-test `.rs` files from re-bloating after the module-split refactor
// (docs/refactor.md). The crate had files up to ~7k production LOC, which raises
// agent-context cost and hurts readability; this guard stops them growing back.
//
// Metric: PRODUCTION code LOC = source lines minus blank/comment lines, with
// inline `#[cfg(test)] mod ... { ... }` blocks stripped. Whole test files
// (tests.rs, *_tests.rs, command_tests.rs, *_fuzz.rs, test_helpers.rs) are
// excluded entirely.
//
// Baseline: src-tauri/file-size-baseline.json records the current prod LOC of
// every non-test file. CI runs this in check mode; it FAILS if:
//   - a baselined file at/above `warn_loc` GROWS past its recorded size (the
//     ratchet — big files may shrink, never grow), or
//   - any file exceeds the hard `fail_loc` budget (no new god-files).
// It WARNS (non-fatal) for any file at/above `warn_loc`. To move a baseline
// deliberately (a split lowered it, or a real feature grew a file), run with
// `--update` and commit the diff so the change is visible in review.
//
// Runs in the `check` job (ci.yml) — which runs on `src-tauri/**` changes and is
// NOT path-ignored (unlike `smoke`), so it actually sees Rust edits. Mirrors the
// existing tripwire `scripts/check-e2e-parallel-safe.mjs`.
//
// Heuristic, not a Rust parser: brace counting for `#[cfg(test)]` blocks is
// line-granular, and a `//`/`/*` inside an exotic string form (raw strings) could
// miscount — accepted gaps; the guard only needs monotonic, stable numbers.
//
// Usage:  node scripts/check-rust-file-size.mjs            (pnpm lint:rust-file-size)
//         node scripts/check-rust-file-size.mjs --update   (regenerate the baseline)

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(REPO_ROOT, 'src-tauri', 'src');
const BASELINE_PATH = path.join(REPO_ROOT, 'src-tauri', 'file-size-baseline.json');

const DEFAULT_WARN_LOC = 1500;
const DEFAULT_FAIL_LOC = 2000;

// Whole-file test modules — excluded from the metric entirely.
const TEST_FILE_RE = /(^|\/)(tests\.rs|.*_tests\.rs|command_tests\.rs|.*_fuzz\.rs|test_helpers\.rs)$/;

// Files allowed to exceed the budget without ratcheting, each with a written
// reason. The baseline already grandfathers today's large files, so this is only
// for a future file that is genuinely irreducible. Add a row with a justification.
const ALLOW = [];

// Drop `#[cfg(test)]`-gated blocks by brace matching: from the attribute through
// the matching close brace of the following `{ ... }` block. Line-granular.
function stripCfgTestModules(lines) {
  const kept = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/#\[cfg\(test\)\]/.test(line) || /#\[cfg\(all\(test/.test(line)) {
      let j = i;
      let depth = 0;
      let opened = false;
      while (j < lines.length) {
        for (const ch of lines[j]) {
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
        if (lines[j].includes('{')) opened = true;
        if (opened && depth <= 0) break;
        j++;
      }
      if (opened) {
        i = j + 1;
        continue;
      }
    }
    kept.push(line);
    i++;
  }
  return kept;
}

// Count code lines, ignoring blanks and comments (string-aware, so `//`/`/*`
// inside a "..." literal is not treated as a comment).
function codeLoc(text) {
  let count = 0;
  let inBlock = false; // inside /* ... */
  for (const raw of text.split('\n')) {
    let i = 0;
    const n = raw.length;
    let hasCode = false;
    let inStr = false; // inside a "..." literal
    while (i < n) {
      const c = raw[i];
      if (inBlock) {
        if (c === '*' && raw[i + 1] === '/') {
          inBlock = false;
          i += 2;
          continue;
        }
        i++;
        continue;
      }
      if (inStr) {
        hasCode = true;
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '"') inStr = false;
        i++;
        continue;
      }
      if (c === '"') {
        inStr = true;
        hasCode = true;
        i++;
        continue;
      }
      if (c === '/' && raw[i + 1] === '/') break;
      if (c === '/' && raw[i + 1] === '*') {
        inBlock = true;
        i += 2;
        continue;
      }
      if (!/\s/.test(c)) hasCode = true;
      i++;
    }
    if (hasCode) count++;
  }
  return count;
}

function listRustFiles(dir) {
  const out = [];
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listRustFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.rs')) out.push(full);
  }
  return out;
}

function relPosix(full) {
  return path.relative(REPO_ROOT, full).split(path.sep).join('/');
}

// Map repo-relative path -> production LOC for every non-test .rs file.
function measureTree() {
  const out = {};
  for (const full of listRustFiles(SRC_DIR)) {
    const rel = relPosix(full);
    if (TEST_FILE_RE.test(rel)) continue;
    const kept = stripCfgTestModules(fs.readFileSync(full, 'utf8').split('\n'));
    out[rel] = codeLoc(kept.join('\n'));
  }
  return out;
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return {};
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

function writeBaseline(measured, warn, fail) {
  const files = {};
  for (const k of Object.keys(measured).sort()) files[k] = measured[k];
  const payload = {
    _README:
      'Generated by scripts/check-rust-file-size.mjs --update. Production code LOC ' +
      '(blank/comment lines and inline #[cfg(test)] modules stripped) per non-test ' +
      '.rs file under src-tauri/src. The CI `check` job runs the script in check ' +
      'mode: it FAILS if a baselined file >= warn_loc grows past its recorded size ' +
      '(the ratchet), or any file exceeds fail_loc. To move a baseline deliberately ' +
      '(a split lowered it, or a real feature grew a file), run --update and commit ' +
      'the diff.',
    warn_loc: warn,
    fail_loc: fail,
    files,
  };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n');
}

function isAllowed(rel) {
  return ALLOW.some((a) => a.file === rel);
}

function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`check-rust-file-size: ${SRC_DIR} not found.`);
    return 1;
  }

  const baseline = loadBaseline();
  const warn = Number(baseline.warn_loc ?? DEFAULT_WARN_LOC);
  const fail = Number(baseline.fail_loc ?? DEFAULT_FAIL_LOC);
  const measured = measureTree();

  if (process.argv.includes('--update')) {
    writeBaseline(measured, warn, fail);
    const tracked = Object.values(measured).filter((v) => v >= warn).length;
    console.log(
      `baseline updated: ${Object.keys(measured).length} files recorded ` +
        `(${tracked} at/above warn=${warn}). wrote ${relPosix(BASELINE_PATH)}`,
    );
    return 0;
  }

  const recorded = baseline.files ?? {};
  const errors = [];
  const warnings = [];

  for (const rel of Object.keys(measured).sort()) {
    const loc = measured[rel];
    const base = recorded[rel];
    if (isAllowed(rel)) continue;
    if (base !== undefined && base >= warn && loc > base) {
      errors.push(
        `${rel}: ${loc} LOC > baseline ${base} (ratchet: a file at/above ${warn} ` +
          `may shrink but not grow — split it, or run --update to rebaseline if the ` +
          `growth is intentional)`,
      );
    } else if (loc > fail && !(base !== undefined && loc <= base)) {
      errors.push(
        `${rel}: ${loc} LOC exceeds the hard budget of ${fail} (split it into ` +
          `logical modules — see docs/refactor.md)`,
      );
    } else if (loc >= warn) {
      warnings.push(`${rel}: ${loc} LOC (>= warn ${warn})`);
    }
  }

  for (const w of warnings) console.log(`  ⚠ file-size: ${w}`);

  if (errors.length > 0) {
    console.error(`\n✗ Rust file-size check failed — ${errors.length} issue(s):\n`);
    for (const e of errors) console.error(`  ${e}`);
    console.error(
      '\nProduction files must stay under the size budget; see docs/refactor.md for the\n' +
        'split plan. To rebaseline an intentional change: pnpm lint:rust-file-size --update\n',
    );
    return 1;
  }

  console.log(
    `✓ Rust file-size: ${Object.keys(measured).length} non-test files checked, ` +
      `none over the ${fail}-LOC budget or grown past baseline ` +
      `(${warnings.length} at/above the ${warn} warn line).`,
  );
  return 0;
}

process.exit(main());
