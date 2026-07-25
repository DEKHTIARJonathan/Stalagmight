// Fixture tests for the Unicode-dash guard (scripts/check-no-em-dash.mjs).
//
// A guard that never fires proves nothing - so each banned code point is pinned
// with a planted dash it MUST catch, and the load-bearing negatives are pinned
// with the exact inputs that must NOT fire: the ASCII hyphen the sweep produces,
// the box-drawing characters that ASCII diagrams in docs/ depend on, and the
// vendored / generated paths the scan never reads.
//
// Every banned character is built with String.fromCharCode so this file, like
// the scanner it tests, stays pure ASCII and does not trip the very scan it
// pins. Deriving the fixtures from the scanner's own BANNED table would let a
// dropped entry pass silently, so the code points are re-declared here by hand.
//
// Pure Node, no test framework (mirrors scripts/check-private-leaks.test.mjs).
// Run: node scripts/check-no-em-dash.test.mjs  (also a CI leak-scan step).

import assert from 'node:assert/strict';
import { findDashes, isExcluded, BANNED, gateFails, looksBinary } from './check-no-em-dash.mjs';

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

const ch = (code) => String.fromCharCode(code);

// --- must fire: every banned code point ---------------------------------------

test('fires on the em dash (U+2014), the character CLAUDE.md names', () => {
  const hits = findDashes(`// the survey graph ${ch(0x2014)} not the raw shots`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, 'U+2014 em dash');
  assert.equal(hits[0].lineNo, 1);
});

test('fires on every other banned code point', () => {
  for (const { code, name } of [
    [0x2012, 'U+2012 figure dash'],
    [0x2013, 'U+2013 en dash'],
    [0x2015, 'U+2015 horizontal bar'],
    [0x2212, 'U+2212 minus sign'],
  ].map(([code, name]) => ({ code, name }))) {
    const hits = findDashes(`value ${ch(code)} other`);
    assert.equal(hits.length, 1, `${name} did not fire`);
    assert.equal(hits[0].name, name);
  }
});

test('the en dash fires even in a numeric range (issue #293 q6-B)', () => {
  // En dash IS correct typography for a range, but the house rule is a strictly
  // ASCII tree, so `0-360` is the accepted cost. Pinned so a future "ranges are
  // fine" carve-out cannot land silently.
  assert.equal(findDashes(`azimuth 0${ch(0x2013)}360`).length, 1);
});

test('BANNED covers exactly the five code points this test pins', () => {
  assert.deepEqual(
    BANNED.map((b) => b.code).sort(),
    [0x2012, 0x2013, 0x2014, 0x2015, 0x2212],
  );
});

// --- must fire: position and multiplicity -------------------------------------

test('reports every occurrence, with line and column', () => {
  const text = `first line is clean\nsecond ${ch(0x2014)} has ${ch(0x2013)} two`;
  const hits = findDashes(text);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => h.lineNo), [2, 2]);
  assert.ok(hits[0].col < hits[1].col);
});

test('fires inside a quoted string, not just a comment', () => {
  // The i18n display strings and the hardcoded UI N/A glyphs were swept too
  // (q1, q7), so a dash in a string literal must not get a free pass.
  assert.equal(findDashes(`const naGlyph = "${ch(0x2014)}";`).length, 1);
  assert.equal(findDashes(`  "gasMode": "Half ${ch(0x2014)} minus IN",`).length, 1);
});

// --- must NOT fire: load-bearing negatives -------------------------------------

test('does NOT fire on the ASCII hyphen the sweep produces', () => {
  assert.equal(findDashes('// the survey graph - not the raw shots').length, 0);
  assert.equal(findDashes('azimuth 0-360, see client.rs:30-103').length, 0);
});

test('does NOT fire on box-drawing characters (ASCII diagrams stay intact)', () => {
  // docs/SPEC.md and friends draw tables/trees with these; substituting them
  // would wreck the alignment, so they are deliberately out of scope.
  const box = [0x2500, 0x2502, 0x250c, 0x2510, 0x2514, 0x2518, 0x251c, 0x2524, 0x252c, 0x253c];
  assert.equal(findDashes(box.map(ch).join(' ')).length, 0);
});

test('does NOT fire on adjacent non-dash punctuation', () => {
  // Neighbours of the banned block that carry no dash meaning.
  assert.equal(findDashes(`quote ${ch(0x2018)}x${ch(0x2019)} and ${ch(0x2026)} ellipsis`).length, 0);
  // Hyphen (U+2010) and non-breaking hyphen (U+2011) are NOT in the banned set:
  // neither appears in the tree and neither is the em-dash problem this guards.
  assert.equal(findDashes(`${ch(0x2010)}${ch(0x2011)}`).length, 0);
});

test('does NOT fire on an empty file or a file with no dashes at all', () => {
  assert.equal(findDashes('').length, 0);
  assert.equal(findDashes('plain ascii prose, nothing to see').length, 0);
});

// --- exclusions ----------------------------------------------------------------

test('excludes the vendored crate and generated IPC types', () => {
  assert.ok(isExcluded('src-tauri/vendor/compass_data/src/survey/parser/mod.rs'));
  assert.ok(isExcluded('src/types/ipc.generated.ts'));
  assert.ok(isExcluded('src/types/ipc/Shot.ts'));
});

test('excludes lockfiles and binary extensions', () => {
  assert.ok(isExcluded('pnpm-lock.yaml'));
  assert.ok(isExcluded('src-tauri/Cargo.lock'));
  assert.ok(isExcluded('docs/branding/png/icon_512.png'));
  assert.ok(isExcluded('e2e-playwright/fixtures/sample.stalx'));
});

test('does NOT exclude ordinary source, prose, or scanned text fixtures', () => {
  // .md and docs/ are the whole reason this runs in leak-scan rather than check.
  assert.ok(!isExcluded('CLAUDE.md'));
  assert.ok(!isExcluded('docs/SPEC.md'));
  assert.ok(!isExcluded('src/components/Map/MapCanvas.tsx'));
  assert.ok(!isExcluded('src-tauri/src/export/image.rs'));
  assert.ok(!isExcluded('src/i18n/locales/en.json'));
  // Snapshots are scanned on purpose (q9-A): a fixture is swept in lockstep with
  // the source it pins, so a dash reappearing there must fail the gate.
  assert.ok(!isExcluded('e2e-playwright/__snapshots__/dialog.spec.ts.snap'));
  assert.ok(!isExcluded('src-tauri/src/parsers/fixtures/survey.txt'));
});

test('this scanner and its own test are scanned, not excluded (they are pure ASCII)', () => {
  // No self-exclusion: the code points are written as escapes precisely so the
  // guard can scan itself. If someone pastes a literal dash in here, CI says so.
  assert.ok(!isExcluded('scripts/check-no-em-dash.mjs'));
  assert.ok(!isExcluded('scripts/check-no-em-dash.test.mjs'));
});

// --- gate semantics ------------------------------------------------------------

test('gate passes only on a clean, fully-scanned tree', () => {
  assert.equal(gateFails([], []), false);
});

test('gate fails closed on an unscannable file, even with zero violations', () => {
  // A file the scanner declines to read must not pass as clean.
  assert.equal(gateFails([], [{ rel: 'big.md', reason: 'over cap' }]), true);
  assert.equal(gateFails([{ rel: 'a.ts', lineNo: 1 }], []), true);
});

test('looksBinary detects a NUL byte and clears plain UTF-8 text', () => {
  assert.equal(looksBinary(Buffer.from([0x61, 0x00, 0x62])), true);
  assert.equal(looksBinary(Buffer.from('ordinary text, no NUL', 'utf8')), false);
});

// --- report --------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n✗ check-no-em-dash fixture tests: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error('');
  process.exit(1);
}
console.log(`✓ check-no-em-dash fixture tests: ${passed} passed`);
