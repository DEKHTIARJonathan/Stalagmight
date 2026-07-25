// Unicode-dash guard for the tracked tree (issue #293).
//
// CLAUDE.md has said "No em-dashes" for a long time, but nothing enforced it,
// so the tree accumulated ~3.7k of them and review bots re-flagged pre-existing
// ones on nearly every PR. PR #293 swept them all to ASCII hyphens; this guard
// keeps them from creeping back.
//
// WHAT IT FLAGS - five Unicode dashes, all replaced by a plain ASCII hyphen:
//   U+2012 figure dash, U+2013 en dash, U+2014 em dash, U+2015 horizontal bar,
//   U+2212 minus sign.
// The en dash is included deliberately (issue #293 q6-B): it IS the correct
// glyph for a numeric range, but a strictly-ASCII tree is the house rule and a
// context-sensitive "ranges are fine" exception would be hard to test and to
// explain. `0-360` and `Gauss-Newton` are the accepted cost.
//
// WHAT IT DOES NOT FLAG - box-drawing characters (U+2500..U+257F) and every
// other non-dash glyph. ASCII diagrams in docs/ rely on those for alignment and
// substituting them would wreck the drawing, so they stay.
//
// WHERE IT RUNS - the leak-scan workflow (.github/workflows/leak-scan.yml),
// which has NO path filter. This is load-bearing and mirrors the placement of
// scripts/check-private-leaks.mjs: the `check` and `smoke` jobs BOTH path-ignore
// `**/*.md` and `docs/**`, which is exactly where the prose (and most of the
// dashes) live, so a gate wired into either would be a no-op for the files that
// carry the most risk.
//
// This file itself is pure ASCII - the dashes are written as \u escapes - so the
// scanner never has to exclude itself, and neither does its test.
//
// There is deliberately NO allowlist. Issue #293 settled every edge case with a
// substitution instead (i18n display strings, the UI N/A glyphs, the glued
// `-ref-` diagram form), precisely so that no per-site exception table has to be
// maintained. If a future case genuinely needs one, add an ALLOW table here with
// a written reason rather than widening the exclusions.
//
// Usage:  node scripts/check-no-em-dash.mjs   (or: pnpm lint:no-em-dash)

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// One entry per banned code point: {char, name}. Written as escapes so this
// source file stays pure ASCII and does not trip its own scan.
export const BANNED = [
  { code: 0x2012, name: 'U+2012 figure dash' },
  { code: 0x2013, name: 'U+2013 en dash' },
  { code: 0x2014, name: 'U+2014 em dash' },
  { code: 0x2015, name: 'U+2015 horizontal bar' },
  { code: 0x2212, name: 'U+2212 minus sign' },
].map((b) => ({ ...b, char: String.fromCharCode(b.code) }));
const BANNED_NAME = new Map(BANNED.map((b) => [b.char, b.name]));
const BANNED_RE = new RegExp(`[${BANNED.map((b) => b.char).join('')}]`, 'g');

// Skip a file larger than this without scanning. Bounds scan time against an
// adversarial multi-MB single-line file on a fork PR; no tracked text file
// legitimately approaches this. An oversized file FAILS the gate (see below).
const MAX_SCAN_BYTES = 5 * 1024 * 1024;

// Whole files excluded from the scan.
const EXCLUDE_EXACT = new Set([
  'src/types/ipc.generated.ts', // generated IPC types (regenerate, don't hand-edit)
]);
const EXCLUDE_PREFIXES = [
  'src-tauri/vendor/', // vendored upstream crate - left verbatim (its own author/license)
  'src/types/ipc/', // generated IPC types
];
// Genuinely-binary extensions (skipped before reading). Text formats that can
// legitimately carry a dash - `.svg`, `.snap`, `.json` - are deliberately NOT
// here, so they get scanned; the null-byte `looksBinary` guard and
// MAX_SCAN_BYTES still protect against a real binary or a huge file.
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

// Scan one file's text. Returns [{lineNo, col, char, name}], one row per banned
// code point. Reports the offending CHARACTER and its position only - never the
// surrounding line - so the CI log stays terse on a bulk regression.
export function findDashes(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    BANNED_RE.lastIndex = 0;
    let m;
    while ((m = BANNED_RE.exec(lines[i])) !== null) {
      out.push({ lineNo: i + 1, col: m.index + 1, char: m[0], name: BANNED_NAME.get(m[0]) });
    }
  }
  return out;
}

// The gate fails if any banned dash was found OR any tracked file could not be
// scanned. A skip (oversized/unreadable) is a FAILURE, not a warning, matching
// check-private-leaks.mjs: a file the scanner declines to read must not pass as
// clean, or the tree can drift back behind it.
export function gateFails(violations, skipped) {
  return violations.length > 0 || skipped.length > 0;
}

export function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function gitTrackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.toString('utf8').split('\0').filter(Boolean);
}

function main() {
  let files;
  try {
    files = gitTrackedFiles();
  } catch (e) {
    console.error(`check-no-em-dash: could not list tracked files (run from a git repo): ${e.message}`);
    return 1;
  }

  const violations = [];
  const skipped = []; // {rel, reason} - each FAILS the gate (fail-closed)
  let scanned = 0;
  for (const rel of files.sort()) {
    if (isExcluded(rel)) continue;
    const full = path.join(REPO_ROOT, rel);
    let buf;
    try {
      buf = fs.readFileSync(full);
    } catch (e) {
      // staged-but-absent / submodule pointer / permission / race.
      skipped.push({ rel, reason: `unreadable (${e.code || e.message})` });
      continue;
    }
    if (buf.length > MAX_SCAN_BYTES) {
      skipped.push({ rel, reason: `${(buf.length / 1048576).toFixed(1)} MB > ${MAX_SCAN_BYTES / 1048576} MB cap` });
      continue;
    }
    if (looksBinary(buf)) {
      // A NUL byte in a file whose extension is NOT a known binary type is
      // undecidable. Fail closed; if it is genuinely binary, add its extension
      // to BINARY_EXT so it is excluded up front.
      skipped.push({ rel, reason: 'binary-like content (NUL byte) in a non-binary extension' });
      continue;
    }
    scanned++;
    for (const v of findDashes(buf.toString('utf8'))) violations.push({ rel, ...v });
  }

  if (!gateFails(violations, skipped)) {
    console.log(`✓ no-em-dash scan: ${scanned} tracked text files, no Unicode dashes.`);
    return 0;
  }

  console.error('\n✗ no-em-dash scan failed:\n');
  // Cap the printed rows: a reverted sweep would otherwise dump thousands of
  // lines into the CI log. The count below still reports the true total.
  const SHOWN = 50;
  for (const v of violations.slice(0, SHOWN)) {
    console.error(`  ${v.rel}:${v.lineNo}:${v.col}  ${v.name}`);
  }
  if (violations.length > SHOWN) {
    console.error(`  ... and ${violations.length - SHOWN} more (${violations.length} total)`);
  }
  for (const s of skipped) {
    console.error(`  [unscanned] ${s.rel} - ${s.reason}`);
    console.error('      could not scan this file; failing closed (shrink it, or exclude it deliberately).\n');
  }
  console.error(
    '\nReplace each one with an ASCII hyphen ("-"). CLAUDE.md: "No em-dashes".\n' +
      'See the header of scripts/check-no-em-dash.mjs for what is banned and why\n' +
      '(box-drawing characters in ASCII diagrams are NOT banned).\n',
  );
  return 1;
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) process.exit(main());
