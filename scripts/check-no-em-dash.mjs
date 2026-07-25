// Unicode-dash guard for the tracked tree (issue #293).
//
// CLAUDE.md has said "No em-dashes" for a long time, but nothing enforced it,
// so the tree accumulated ~3.7k of them and review bots re-flagged pre-existing
// ones on nearly every PR. PR #293 swept them all to ASCII hyphens; this guard
// keeps them from creeping back.
//
// WHAT IT FLAGS - seven Unicode dashes, all replaced by a plain ASCII hyphen:
//   U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
//   U+2013 en dash, U+2014 em dash, U+2015 horizontal bar, U+2212 minus sign.
// The en dash is included deliberately (issue #293 q6-B): it IS the correct
// glyph for a numeric range, but a strictly-ASCII tree is the house rule and a
// context-sensitive "ranges are fine" exception would be hard to test and to
// explain. `0-360` and `Gauss-Newton` are the accepted cost.
// U+2010/U+2011 are included because they are visually INDISTINGUISHABLE from
// the ASCII hyphen: a reviewer cannot see one, so only a scanner can. The sweep
// missed a U+2010 in src-tauri/src/export/tml.rs while editing two lines away,
// which is exactly the failure mode that argues for banning them.
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
// This file itself contains no BANNED code point - they are built with
// String.fromCharCode rather than written literally - so the
// scanner never has to exclude itself, and neither does its test.
//
// There is deliberately no per-SITE allowlist. Issue #293 settled every edge
// case with a substitution instead (i18n display strings, the UI N/A glyphs, the
// glued `-ref-` diagram form), precisely so that no exception table has to be
// maintained. Note what that does and does not mean: whole PATHS are still
// excluded below (vendored, generated, lockfiles, binaries), so the guard is not
// unconditional - a file placed under one of those prefixes is not scanned. If a
// future case genuinely needs a per-site exception, add an ALLOW table here with
// a written reason rather than widening those prefixes.
//
// Usage:  node scripts/check-no-em-dash.mjs   (or: pnpm lint:no-em-dash)

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// One entry per banned code point: {char, name}. Written as escapes so this
// source file carries no banned code point and does not trip its own scan.
// (It is not pure ASCII: the pass/fail lines print U+2713/U+2717, as the sibling
// guards do. Only the banned set has to be absent for self-scanning to work.)
export const BANNED = [
  { code: 0x2010, name: 'U+2010 hyphen' },
  { code: 0x2011, name: 'U+2011 non-breaking hyphen' },
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
// Extensions skipped before reading. Text formats that can legitimately carry a
// dash - `.svg`, `.snap`, `.json` - are deliberately NOT here, so they get
// scanned; the null-byte `looksBinary` guard and MAX_SCAN_BYTES still protect
// against a real binary or a huge file.
//
// `dmp`, `tml` and `stalx` are survey-data formats, not opaque binaries: `.dmp`
// in particular is plain ASCII (the golden parser fixtures under
// e2e-playwright/fixtures/ are readable text). They are skipped anyway because
// they are DATA, where a byte is load-bearing - a dash inside a fixture is the
// input under test, and "fix" would mean corrupting the case it pins. That is a
// deliberate carve-out, not an oversight, and the fixture test pins it.
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

// Render a repo-relative path for printing into a PUBLIC CI log.
//
// This runs on `pull_request`, so on a fork PR every path comes from an
// attacker-chosen tree. Git permits a newline and `::` inside a tree entry name,
// and GitHub Actions parses `::workflow-command::` at the start of a log line -
// so a file named with an embedded newline plus `::error::` could forge
// annotations in this job's log. JSON-quoting escapes the control characters and
// makes the path unambiguous; the leading `::` of any forged command then sits
// mid-string rather than at line start.
export function safePath(rel) {
  return JSON.stringify(rel);
}

// Cap on printed rows, per category. A reverted sweep (violations) or a tree of
// planted NUL files (skips) would otherwise flood the CI log; the totals are
// still reported truthfully in the "... and N more" tail.
const SHOWN = 50;

// Scan a list of repo-relative paths. `readFile` is injected so the fixture test
// can drive every branch - the size cap and the unreadable path are otherwise
// unreachable on a healthy tree, and an untested branch in a fail-closed gate is
// how a gate silently starts passing everything.
export function scan(files, readFile) {
  const violations = [];
  const skipped = []; // {rel, reason} - each FAILS the gate (fail-closed)
  const symlinks = []; // not followed; does NOT fail the gate (see below)
  let scanned = 0;
  for (const rel of [...files].sort()) {
    if (isExcluded(rel)) continue;
    let buf;
    try {
      buf = readFile(rel);
    } catch (e) {
      // staged-but-absent / submodule pointer / permission / race.
      skipped.push({ rel, reason: `unreadable (${e.code || e.message})` });
      continue;
    }
    if (buf === null) {
      // Symlink. NOT followed: `readFileSync` would dereference it and scan
      // whatever it points at, which on a CI runner can be a path outside the
      // repo entirely (a fork PR chooses the link target).
      //
      // Unlike the other skips this does NOT fail the gate, because nothing is
      // hidden by it: a link to a tracked in-repo file (AGENTS.md -> CLAUDE.md)
      // has its target scanned on its own, and a link OUT of the repo points at
      // content that is not ours to lint. Either way the bytes we care about are
      // still covered, so failing closed here would only block a legitimate
      // symlink.
      symlinks.push(rel);
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
  return { violations, skipped, scanned, symlinks };
}

// Read one tracked file, returning null for a symlink so `scan` can skip it
// without dereferencing. `lstatSync` first: a dangling link would throw from
// `readFileSync` anyway, but a live one would be silently followed.
function readTracked(rel) {
  const full = path.join(REPO_ROOT, rel);
  if (fs.lstatSync(full).isSymbolicLink()) return null;
  return fs.readFileSync(full);
}

export function report(result, log = console.log, err = console.error) {
  const { violations, skipped, scanned, symlinks = [] } = result;
  if (!gateFails(violations, skipped)) {
    const note = symlinks.length ? ` (${symlinks.length} symlink(s) not followed)` : '';
    log(`✓ no-em-dash scan: ${scanned} tracked text files, no Unicode dashes.${note}`);
    return 0;
  }

  err('\n✗ no-em-dash scan failed:\n');
  for (const v of violations.slice(0, SHOWN)) {
    err(`  ${safePath(v.rel)}:${v.lineNo}:${v.col}  ${v.name}`);
  }
  if (violations.length > SHOWN) {
    err(`  ... and ${violations.length - SHOWN} more (${violations.length} total)`);
  }
  for (const s of skipped.slice(0, SHOWN)) {
    err(`  [unscanned] ${safePath(s.rel)} - ${s.reason}`);
    err('      could not scan this file; failing closed (shrink it, or exclude it deliberately).');
  }
  if (skipped.length > SHOWN) {
    err(`  ... and ${skipped.length - SHOWN} more unscanned (${skipped.length} total)`);
  }
  err(
    '\nReplace each one with an ASCII hyphen ("-"). CLAUDE.md: "No em-dashes".\n' +
      'See the header of scripts/check-no-em-dash.mjs for what is banned and why\n' +
      '(box-drawing characters in ASCII diagrams are NOT banned).\n',
  );
  return 1;
}

export function main() {
  let files;
  try {
    files = gitTrackedFiles();
  } catch (e) {
    console.error(`check-no-em-dash: could not list tracked files (run from a git repo): ${e.message}`);
    return 1;
  }
  return report(scan(files, readTracked));
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) process.exit(main());
