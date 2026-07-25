// Fixture tests for the Rust file-size ratchet (scripts/check-rust-file-size.mjs).
//
// Pins the prod-LOC strip heuristic against the exact inputs that the naive
// brace-counter got wrong: a braceless `#[cfg(test)]` item that swallowed the
// next production fn, and an unbalanced brace inside a test string that ran the
// strip to EOF. Both are silent UNDER-counts - the dangerous direction for a
// ratchet - so they get first-class fixtures here.
//
// Pure Node, no test framework (mirrors scripts/reap-tracked.test.sh's on-demand
// style). Run: node scripts/check-rust-file-size.test.mjs  (also a CI `check` step).

import assert from 'node:assert/strict';
import { prodLoc, classify, markCfgTestItems, maskNonCode, WARN_LOC, FAIL_LOC } from './check-rust-file-size.mjs';

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

// --- prodLoc: #[cfg(test)] stripping -----------------------------------------

test('strips a trailing #[cfg(test)] mod block, keeps production', () => {
  const src = ['fn a() {', '    work();', '}', '', '#[cfg(test)]', 'mod tests {', '    fn t() {', '        a();', '    }', '}'].join('\n');
  // production: `fn a() {`, `work();`, `}` = 3
  assert.equal(prodLoc(src), 3);
});

test('REGRESSION: braceless `#[cfg(test)] use …;` does NOT swallow the next fn', () => {
  // The naive scanner hunted forward to the first `{` and stripped `production`.
  const src = ['#[cfg(test)]', 'use crate::foo::bar;', 'fn production() {', '    x();', '}', 'fn more() {', '    y();', '}'].join('\n');
  // The cfg+use lines strip; both production fns (6 code lines) stay. The old
  // scanner hunted to `production`'s `{` and stripped it → 3.
  assert.equal(prodLoc(src), 6);
});

test('REGRESSION: an unbalanced brace in a test string does not run the strip to EOF', () => {
  // `assert_eq!(s, "{")` - the unmatched `{` lives in a string; the real block
  // close still returns depth to 0. Production after the test block survives.
  const src = [
    'fn keep_me() {',
    '    real();',
    '}',
    '#[cfg(test)]',
    'mod tests {',
    '    fn t() {',
    '        assert_eq!(brace(), "{");',
    '    }',
    '}',
    'fn keep_me_too() {',
    '    also();',
    '}',
  ].join('\n');
  // keep_me (3) + keep_me_too (3) = 6
  assert.equal(prodLoc(src), 6);
});

test('strips #[cfg(all(test, …))] and #[cfg(any(test, …))] blocks', () => {
  const src = ['fn p() {}', '#[cfg(all(test, feature = "x"))]', 'mod a { fn t() {} }', '#[cfg(any(test, feature = "y"))]', 'mod b { fn u() {} }'].join('\n');
  assert.equal(prodLoc(src), 1); // only `fn p() {}`
});

test('does NOT strip #[cfg(not(test))] or #[cfg_attr(test, …)] (production)', () => {
  const src = ['#[cfg(not(test))]', 'fn prod_only() {', '    a();', '}', '#[cfg_attr(test, derive(Debug))]', 'struct S;'].join('\n');
  // all 6 lines are production (none stripped)
  assert.equal(prodLoc(src), 6);
});

test('multi-line raw string with braces does not corrupt the brace count', () => {
  const src = [
    'fn p() {',
    '    let sql = r#"',
    '        SELECT { not real braces }}}',
    '    "#;',
    '}',
    '#[cfg(test)]',
    'mod tests { fn t() {} }',
  ].join('\n');
  // production: fn p { ... } = the 5 lines of fn p (the raw-string lines are code lines inside it)
  assert.equal(prodLoc(src), 5);
});

test('char literal containing a brace is not counted as a real brace', () => {
  const masked = maskNonCode(["let open = '{';"]);
  assert.ok(!masked[0].includes('{'), "char-literal brace should be masked away");
});

test('multi-escape char literals (\\u{7b}, \\x7d) are masked, not leaked as braces', () => {
  const masked = maskNonCode(["let a = '\\u{7b}'; let b = '\\x7d';"]);
  assert.ok(!masked[0].includes('{') && !masked[0].includes('}'), 'escape braces must be masked');
});

test('REGRESSION: production code after a braceless cfg(test) on the SAME line survives', () => {
  // The braceless strip used to drop the whole physical line, taking the inline
  // production fn with it. rustfmt would split this, but the strip must be correct
  // in the dangerous (under-count) direction without relying on that.
  const src = ['let kept = mk();', '#[cfg(test)] use crate::y; fn prod() { go(); }'].join('\n');
  assert.equal(prodLoc(src), 2); // both lines count; the cfg+use part over-counts (safe)
});

test('unbalanced strip is reported, not silently dropped to EOF', () => {
  // A genuinely unclosed block (no real `}`): keep the lines + warn.
  const warnings = [];
  const masked = maskNonCode(['#[cfg(test)]', 'mod tests {', '    fn t() {', '        a();']);
  markCfgTestItems(masked, warnings);
  assert.equal(warnings.length, 1, 'expected one unbalanced-block warning');
});

// --- classify: the dead-band fixes -------------------------------------------

test('a small file may grow freely (no ratchet below warn)', () => {
  assert.equal(classify('f.rs', 210, 200).level, 'ok');
});

test('a file frozen at/above warn errors when it grows past baseline', () => {
  assert.equal(classify('f.rs', WARN_LOC + 100, WARN_LOC + 1).level, 'error');
});

test('REGRESSION: crossing the warn line via growth errors (was only a warn)', () => {
  // baseline 1400 (below warn), grows to 1600 (above warn) - previously slid by
  // with a non-fatal warning because the gate keyed on `base >= warn`.
  assert.equal(classify('f.rs', WARN_LOC + 100, WARN_LOC - 100).level, 'error');
});

test('REGRESSION: a NEW file born at/above warn errors (no new god-files)', () => {
  assert.equal(classify('new.rs', WARN_LOC + 400, undefined).level, 'error'); // ~1900, was a warn
});

test('a NEW file below warn is fine', () => {
  assert.equal(classify('new.rs', WARN_LOC - 1, undefined).level, 'ok');
});

test('a new/grown file over the hard cap reports the budget error', () => {
  const v = classify('big.rs', FAIL_LOC + 500, undefined);
  assert.equal(v.level, 'error');
  assert.match(v.message, new RegExp(`hard ${FAIL_LOC}`));
});

test('a grandfathered over-cap file only warns while it is not growing', () => {
  assert.equal(classify('project.rs', 7174, 7174).level, 'warn');
  assert.equal(classify('project.rs', 7000, 7174).level, 'warn'); // shrank - still just a warn
});

// --- report ------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`✗ check-rust-file-size.test: ${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ check-rust-file-size.test: ${passed} assertions passed.`);
