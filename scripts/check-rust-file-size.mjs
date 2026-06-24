// File-size ratchet for the `stalagmight` Rust crate (src-tauri/src).
//
// Keeps non-test `.rs` files from re-bloating after the module-split refactor
// (#157). The crate had files up to ~7k production LOC, which raises agent-context
// cost and hurts readability; this guard stops them growing back.
//
// Metric: PRODUCTION code LOC = source lines minus blank/comment lines, with
// `#[cfg(test)]`-gated items (both `mod tests { … }` blocks and braceless
// `#[cfg(test)] use …;` items) stripped. Whole test files (tests.rs, *_tests.rs,
// command_tests.rs, *_fuzz.rs, test_helpers.rs) are excluded entirely.
//
// Policy (baseline = src-tauri/file-size-baseline.json):
//   - A file at/above `WARN_LOC` (1500) prod LOC is "large" and FROZEN by the
//     ratchet: it may shrink, never grow past its recorded baseline. Split it at
//     an API boundary, or run `--update` to rebaseline an intentional change.
//   - A NEW (non-baselined) file may not be introduced at/above `WARN_LOC` —
//     no new god-files born just under the cap.
//   - A NEW or GROWN file may never exceed the hard `FAIL_LOC` (2000) budget.
//   - Files below `WARN_LOC` grow freely (so ordinary edits to small files don't
//     need a rebaseline); grandfathered files already over the cap only need to
//     stop growing.
// Anything at/above `WARN_LOC` that isn't a violation prints a non-fatal warning.
//
// Runs in the `check` job (ci.yml) — which runs on `src-tauri/**` changes and is
// NOT path-ignored (unlike `smoke`), so it actually sees Rust edits. The strip
// heuristic is pinned by scripts/check-rust-file-size.test.mjs. Mirrors the
// existing tripwire `scripts/check-e2e-parallel-safe.mjs`.
//
// Usage:  node scripts/check-rust-file-size.mjs            (pnpm lint:rust-file-size)
//         node scripts/check-rust-file-size.mjs --update   (regenerate the baseline)

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(REPO_ROOT, 'src-tauri', 'src');
const BASELINE_PATH = path.join(REPO_ROOT, 'src-tauri', 'file-size-baseline.json');

// Thresholds are owned by the script (the single source of truth). The baseline
// JSON echoes them for readability, but `main()` asserts the echo matches these
// and `--update` always writes these — so editing the generated artifact can't
// quietly loosen the gate.
export const WARN_LOC = 1500;
export const FAIL_LOC = 2000;

// Whole-file test modules — excluded from the metric entirely.
const TEST_FILE_RE = /(^|\/)(tests\.rs|.*_tests\.rs|command_tests\.rs|.*_fuzz\.rs|test_helpers\.rs)$/;

// `#[cfg(test)]`, `#[cfg(all(test, …))]`, `#[cfg(any(test, …))]` — the test-gated
// forms whose items we strip. NOT `#[cfg_attr(test, …)]` (that conditionally
// applies an attribute to a *production* item) and NOT `#[cfg(not(test))]` (the
// production-only form) — both correctly fall through and stay counted.
const CFG_TEST_RE = /#\[cfg\((?:test\b|all\(test|any\(test)/;

// Files allowed to exceed the budget without ratcheting, each with a written
// reason. The baseline already grandfathers today's large files, so this is only
// for a future file that is genuinely irreducible. Add a row with a justification.
const ALLOW = [];

// Mask string-literal and comment spans so downstream brace/`;` counting sees only
// real code, while keeping the LOC count faithful. Comments → spaces (a
// comment-only line becomes blank, so it isn't counted). String/char content →
// a non-whitespace placeholder `M` (so a line of multi-line-string body still
// counts as code, like tokei, but its braces/`;` don't perturb the strip scan).
// Handles // line comments, /* */ (nesting), "…" (with \ escapes, multi-line),
// raw strings r#*"…"#*, byte variants (b"…", br#"…"#), and char literals ('{',
// '\n') vs lifetimes ('a). Factored out so the same state machine feeds both the
// LOC count and the #[cfg(test)] strip — the previous per-line brace counter saw
// string braces and could run a strip to EOF (a silent under-count).
const MASK = 'M'; // non-whitespace, non-brace, non-`;` placeholder for string/char bytes
function maskStr(s) {
  return s.replace(/\S/g, MASK); // keep whitespace (so an all-space string line stays blank)
}
export function maskNonCode(lines) {
  const masked = [];
  let blockDepth = 0; // /* */ nesting depth, persists across lines
  let str = null; // null | {raw:false} | {raw:true, hashes:N}, persists across lines
  for (const line of lines) {
    const n = line.length;
    let out = '';
    let i = 0;
    while (i < n) {
      const c = line[i];
      const c2 = line[i + 1];
      if (blockDepth > 0) {
        if (c === '/' && c2 === '*') { blockDepth++; out += '  '; i += 2; continue; }
        if (c === '*' && c2 === '/') { blockDepth--; out += '  '; i += 2; continue; }
        out += ' '; i++; continue;
      }
      if (str) {
        if (str.raw) {
          const close = '"' + '#'.repeat(str.hashes);
          if (line.startsWith(close, i)) { out += maskStr(close); i += close.length; str = null; continue; }
          out += maskStr(c); i++; continue;
        }
        if (c === '\\') { out += maskStr(line.slice(i, i + 2)); i += 2; continue; } // escape (incl. line continuation)
        if (c === '"') { out += MASK; i++; str = null; continue; }
        out += maskStr(c); i++; continue;
      }
      if (c === '/' && c2 === '/') { out += ' '.repeat(n - i); break; } // line comment → rest of line
      if (c === '/' && c2 === '*') { blockDepth = 1; out += '  '; i += 2; continue; }
      const rest = line.slice(i);
      const rawStart = /^b?r(#*)"/.exec(rest);
      if (rawStart) {
        str = { raw: true, hashes: rawStart[1].length };
        out += maskStr(rawStart[0]); i += rawStart[0].length; continue;
      }
      const strStart = /^b?"/.exec(rest);
      if (strStart) {
        str = { raw: false };
        out += maskStr(strStart[0]); i += strStart[0].length; continue;
      }
      if (c === "'") {
        const charLit = /^'(?:\\.|[^'])'/.exec(rest); // '{' / '\n' — not a lifetime 'a
        if (charLit) { out += maskStr(charLit[0]); i += charLit[0].length; continue; }
        out += c; i++; continue; // lifetime: keep the ' (harmless; no brace)
      }
      out += c; i++;
    }
    masked.push(out);
  }
  return masked;
}

// Given code-only (masked) lines, return a boolean[] marking lines that belong to
// a `#[cfg(test)]` item — block (`mod tests { … }`) or braceless (`use …;`). On a
// malformed/unclosed scan it keeps the lines (safe over-count) and records a
// warning rather than silently dropping everything to EOF.
export function markCfgTestItems(masked, warnings = []) {
  const drop = new Array(masked.length).fill(false);
  let i = 0;
  while (i < masked.length) {
    if (!CFG_TEST_RE.test(masked[i])) { i++; continue; }
    let depth = 0;
    let sawBrace = false;
    let endLine = -1;
    for (let j = i; j < masked.length && endLine < 0; j++) {
      for (const ch of masked[j]) {
        if (ch === '{') { depth++; sawBrace = true; }
        else if (ch === '}') { depth--; }
        else if (ch === ';' && depth === 0 && !sawBrace) { endLine = j; break; } // braceless item ends
        if (sawBrace && depth === 0) { endLine = j; break; } // block item closed
      }
    }
    if (endLine >= 0) {
      for (let k = i; k <= endLine; k++) drop[k] = true;
      i = endLine + 1;
    } else {
      if (sawBrace) {
        warnings.push(
          `unbalanced #[cfg(test)] block starting near line ${i + 1}; kept as production ` +
            `LOC (safe over-count) — verify the strip heuristic.`,
        );
      }
      i++; // keep the attribute line, continue scanning
    }
  }
  return drop;
}

// Production code LOC for one file's text: mask strings/comments, drop #[cfg(test)]
// items, then count remaining lines that still hold a non-space character.
export function prodLoc(text, warnings = []) {
  const lines = text.split('\n');
  const masked = maskNonCode(lines);
  const drop = markCfgTestItems(masked, warnings);
  let count = 0;
  for (let k = 0; k < lines.length; k++) {
    if (!drop[k] && /\S/.test(masked[k])) count++;
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
function measureTree(warnings = []) {
  const out = {};
  for (const full of listRustFiles(SRC_DIR)) {
    const rel = relPosix(full);
    if (TEST_FILE_RE.test(rel)) continue;
    out[rel] = prodLoc(fs.readFileSync(full, 'utf8'), warnings);
  }
  return out;
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return {};
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

function writeBaseline(measured) {
  const files = {};
  for (const k of Object.keys(measured).sort()) files[k] = measured[k];
  const payload = {
    _README:
      'Generated by scripts/check-rust-file-size.mjs --update. Production code LOC ' +
      '(blank/comment lines and #[cfg(test)] items stripped) per non-test .rs file ' +
      'under src-tauri/src. warn_loc/fail_loc echo the script constants (the script ' +
      'asserts they match). The CI `check` job runs the script in check mode: a file ' +
      'at/above warn_loc is frozen (may shrink, not grow), no new file may be born ' +
      'at/above warn_loc, and no new/grown file may cross fail_loc. To move a baseline ' +
      'deliberately (a split lowered it, or a real feature grew a file), run --update ' +
      'and commit the diff.',
    warn_loc: WARN_LOC,
    fail_loc: FAIL_LOC,
    files,
  };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n');
}

function isAllowed(rel) {
  return ALLOW.some((a) => a.file === rel);
}

// Pure classification of one file against its baseline. level ∈ 'ok'|'warn'|'error'.
export function classify(rel, loc, base) {
  if (isAllowed(rel)) return { level: 'ok' };
  const isNew = base === undefined;
  const grew = !isNew && loc > base;
  if (loc > FAIL_LOC && (isNew || grew)) {
    return {
      level: 'error',
      message:
        `${rel}: ${loc} LOC exceeds the hard ${FAIL_LOC}-prod-LOC budget — split it into ` +
        `logical modules at an API boundary (#157).`,
    };
  }
  if (grew && loc >= WARN_LOC) {
    return {
      level: 'error',
      message:
        `${rel}: ${loc} LOC > baseline ${base} — a file at/above ${WARN_LOC} prod LOC may ` +
        `shrink but not grow. Split it (#157), or run --update to rebaseline if the growth ` +
        `is intentional.`,
    };
  }
  if (isNew && loc >= WARN_LOC) {
    return {
      level: 'error',
      message:
        `${rel}: new file at ${loc} prod LOC (>= warn ${WARN_LOC}) — new files may not be ` +
        `introduced at/above the warn line. Split it, or run --update to baseline it ` +
        `deliberately (#157).`,
    };
  }
  if (loc >= WARN_LOC) return { level: 'warn', message: `${rel}: ${loc} LOC (>= warn ${WARN_LOC})` };
  return { level: 'ok' };
}

function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`check-rust-file-size: ${SRC_DIR} not found.`);
    return 1;
  }

  const baseline = loadBaseline();
  // The script owns the thresholds; a drifted echo in the generated baseline is a
  // tampering smell, not a config knob — fail loudly instead of honoring it.
  for (const [key, want] of [['warn_loc', WARN_LOC], ['fail_loc', FAIL_LOC]]) {
    if (baseline[key] !== undefined && Number(baseline[key]) !== want) {
      console.error(
        `check-rust-file-size: baseline ${key}=${baseline[key]} disagrees with the script ` +
          `default ${want}. Thresholds are owned by the script; run --update to re-sync the ` +
          `baseline JSON (do not hand-edit it to change the gate).`,
      );
      return 1;
    }
  }

  const warnings = [];
  const measured = measureTree(warnings);

  if (process.argv.includes('--update')) {
    writeBaseline(measured);
    const tracked = Object.values(measured).filter((v) => v >= WARN_LOC).length;
    console.log(
      `baseline updated: ${Object.keys(measured).length} files recorded ` +
        `(${tracked} at/above warn=${WARN_LOC}). wrote ${relPosix(BASELINE_PATH)}`,
    );
    for (const w of warnings) console.warn(`  ⚠ ${w}`);
    return 0;
  }

  const recorded = baseline.files ?? {};
  const errors = [];
  const softWarnings = [];

  for (const rel of Object.keys(measured).sort()) {
    const verdict = classify(rel, measured[rel], recorded[rel]);
    if (verdict.level === 'error') errors.push(verdict.message);
    else if (verdict.level === 'warn') softWarnings.push(verdict.message);
  }

  for (const w of warnings) console.warn(`  ⚠ strip-heuristic: ${w}`);
  for (const w of softWarnings) console.log(`  ⚠ file-size: ${w}`);

  if (errors.length > 0) {
    console.error(`\n✗ Rust file-size check failed — ${errors.length} issue(s):\n`);
    for (const e of errors) console.error(`  ${e}`);
    console.error(
      '\nProduction files must stay within the size budget; see #157 for the split plan.\n' +
        'To rebaseline an intentional change: pnpm lint:rust-file-size --update\n',
    );
    return 1;
  }

  console.log(
    `✓ Rust file-size: ${Object.keys(measured).length} non-test files checked, ` +
      `none over the ${FAIL_LOC}-LOC budget or grown past baseline ` +
      `(${softWarnings.length} at/above the ${WARN_LOC} warn line).`,
  );
  return 0;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main());
