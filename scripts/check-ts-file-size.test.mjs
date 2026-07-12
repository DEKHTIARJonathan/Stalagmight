// Fixture tests for the TS file-size ratchet (scripts/check-ts-file-size.mjs).
//
// Pins the prod-LOC strip heuristic against the inputs most likely to trip a
// naive line-comment/string scanner: a `//` sequence inside a string, a
// multi-line template literal with a nested `${ … }` expression (itself
// containing braces/strings/comments), a regex literal, and JSX text/comments.
// Also pins the same warn/hard-cap/grow classification contract as the Rust
// ratchet (scripts/check-rust-file-size.mjs), since the policy is identical.
//
// Pure Node, no test framework (mirrors check-rust-file-size.test.mjs's style).
// Run: node scripts/check-ts-file-size.test.mjs  (also a CI `check` step, pnpm
// lint:ts-file-size:test).

import assert from 'node:assert/strict';
import { prodLoc, classify, maskNonCode, WARN_LOC, FAIL_LOC } from './check-ts-file-size.mjs';

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
}

// --- prodLoc: comment/string/template stripping ------------------------------

test('strips a trailing line comment, keeps the code on the same line', () => {
  const src = ['const a = 1; // trailing note', 'const b = 2;'].join('\n');
  assert.equal(prodLoc(src), 2);
});

test('a comment-only line does not count', () => {
  const src = ['function a() {', '  // just a note', '  return 1;', '}'].join('\n');
  assert.equal(prodLoc(src), 3); // fn a, return, }
});

test('a block comment spanning multiple lines does not count', () => {
  const src = ['const a = 1;', '/*', ' * multi-line doc comment', ' */', 'const b = 2;'].join('\n');
  assert.equal(prodLoc(src), 2);
});

test('REGRESSION: a `//` inside a string is NOT treated as a comment start', () => {
  // The naive scanner would see `//` in the URL and blank the rest of the line,
  // dropping the trailing `;` — a silent under-count.
  const src = ['const url = "http://example.com";', 'const kept = 1;'].join('\n');
  assert.equal(prodLoc(src), 2);
});

test('REGRESSION: a `/*`-shaped sequence inside a string does not open a fake block comment', () => {
  const src = ['const s = "/* not a comment */";', 'const kept = 1;'].join('\n');
  assert.equal(prodLoc(src), 2);
});

test('single and double quoted strings with escaped quotes are handled', () => {
  const src = ["const a = 'it\\'s fine';", 'const b = "she said \\"hi\\"";'].join('\n');
  assert.equal(prodLoc(src), 2);
});

test('a multi-line template literal body counts as production (tokei-style, not stripped)', () => {
  const src = ['const s = `', '  line one', '  line two', '`;'].join('\n');
  // all 4 physical lines carry non-whitespace masked content
  assert.equal(prodLoc(src), 4);
});

test('a template literal `${ … }` expression is scanned as real code, not string content', () => {
  const src = ['const s = `value: ${a + b}`;', 'const kept = 1;'].join('\n');
  assert.equal(prodLoc(src), 2);
});

test('REGRESSION: a comment inside a `${ … }` template expression still strips', () => {
  const src = ['const s = `${', '  // note', '  a', '}`;'].join('\n');
  // line 1: `const s = \`${` has code; line 2 comment-only strips; line 3 `a` counts; line 4 closer counts
  assert.equal(prodLoc(src), 3);
});

test('a nested object literal inside a template expression does not close the expression early', () => {
  const src = ['const s = `${JSON.stringify({ a: 1 })}`;', 'const kept = 1;'].join('\n');
  assert.equal(prodLoc(src), 2);
});

test('a JSX block comment `{/* … */}` blanks the comment but keeps surrounding braces as code', () => {
  const src = ['const el = <div>', '  {/* a note */}', '  <span>hi</span>', '</div>;'].join('\n');
  assert.equal(prodLoc(src), 4); // no line becomes fully blank (braces remain)
});

test('a regex literal is recognized after an operator/paren, not treated as division', () => {
  const src = ['const re = /foo/g;', 'const kept = 1;'].join('\n');
  assert.equal(prodLoc(src), 2);
});

test('REGRESSION: division after an identifier is NOT mistaken for a regex start', () => {
  const src = ['const half = total / 2;', 'const kept = 1;'].join('\n');
  assert.equal(prodLoc(src), 2);
});

test('a char class inside a regex literal does not confuse the terminating slash', () => {
  const src = ['const re = /[a-z/]/g;', 'const kept = 1;'].join('\n');
  assert.equal(prodLoc(src), 2);
});

test('unterminated string at EOF is reported, not silently swallowed', () => {
  const warnings = [];
  maskNonCode(['const s = "unterminated'], warnings);
  assert.equal(warnings.length, 1, 'expected one unterminated-context warning');
});

// --- classify: same policy contract as the Rust ratchet -----------------------

test('a small file may grow freely (no ratchet below warn)', () => {
  assert.equal(classify('f.ts', 210, 200).level, 'ok');
});

test('a file frozen at/above warn errors when it grows past baseline', () => {
  assert.equal(classify('f.ts', WARN_LOC + 100, WARN_LOC + 1).level, 'error');
});

test('crossing the warn line via growth errors (not just a soft warn)', () => {
  assert.equal(classify('f.ts', WARN_LOC + 100, WARN_LOC - 100).level, 'error');
});

test('a NEW file born at/above warn errors (no new god-files)', () => {
  assert.equal(classify('new.tsx', WARN_LOC + 400, undefined).level, 'error');
});

test('a NEW file below warn is fine', () => {
  assert.equal(classify('new.tsx', WARN_LOC - 1, undefined).level, 'ok');
});

test('a new/grown file over the hard cap reports the budget error', () => {
  const v = classify('big.tsx', FAIL_LOC + 500, undefined);
  assert.equal(v.level, 'error');
  assert.match(v.message, new RegExp(`hard ${FAIL_LOC}`));
});

test('a grandfathered over-cap file only warns while it is not growing', () => {
  assert.equal(classify('DmpNewImportDialog.tsx', 3657, 3657).level, 'warn');
  assert.equal(classify('DmpNewImportDialog.tsx', 3600, 3657).level, 'warn'); // shrank — still just a warn
});

// --- report ------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`✗ check-ts-file-size.test: ${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ check-ts-file-size.test: ${passed} assertions passed.`);
