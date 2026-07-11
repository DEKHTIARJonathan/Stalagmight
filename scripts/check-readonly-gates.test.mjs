// Fixture tests for the canonical read-only gating tripwire (scripts/check-readonly-gates.mjs).
//
// Pure Node, no test framework (mirrors scripts/check-private-leaks.test.mjs).
// Run: node scripts/check-readonly-gates.test.mjs  (also a CI step, #275).

import assert from 'node:assert/strict';
import {
  countClosureAdjustedComparisons,
  usesIsMapReadOnly,
  usesSpeleoReadOnly,
  CLOSURE_ADJUSTED_ALLOWLIST,
  MAP_READ_ONLY_EXEMPT,
} from './check-readonly-gates.mjs';

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

// --- countClosureAdjustedComparisons --------------------------------------------

test('counts a raw equality comparison against closureAdjusted', () => {
  assert.equal(countClosureAdjustedComparisons("const x = geometryMode === 'closureAdjusted';"), 1);
  assert.equal(countClosureAdjustedComparisons('const x = geometryMode === "closureAdjusted";'), 1);
});

test('counts multiple comparisons across lines', () => {
  const text = [
    "if (mode === 'closureAdjusted') a();",
    "if (mode === 'closureAdjusted') b();",
  ].join('\n');
  assert.equal(countClosureAdjustedComparisons(text), 2);
});

test('does not count a comparison inside a // line comment', () => {
  assert.equal(countClosureAdjustedComparisons("// geometryMode === 'closureAdjusted' is read-only"), 0);
});

test('does not count an assignment (not an equality check)', () => {
  assert.equal(countClosureAdjustedComparisons("geometryMode: 'closureAdjusted',"), 0);
});

test('does not count an unrelated equality comparison', () => {
  assert.equal(countClosureAdjustedComparisons("if (mode === 'measured') a();"), 0);
});

// --- usesIsMapReadOnly / usesSpeleoReadOnly -------------------------------------

test('detects isMapReadOnly as a bare identifier or a call', () => {
  assert.ok(usesIsMapReadOnly('useUIStore(isMapReadOnly)'));
  assert.ok(usesIsMapReadOnly('isMapReadOnly(useUIStore.getState())'));
  assert.ok(!usesIsMapReadOnly('const geometryReadOnly = false;'));
});

test('detects either the local speleoReadOnly variable or the selector import', () => {
  assert.ok(usesSpeleoReadOnly('const geometryReadOnly = isMapReadOnly(s) || speleoReadOnly;'));
  assert.ok(usesSpeleoReadOnly("import { selectSpeleoReadOnly } from '../store/speleoStore';"));
  assert.ok(!usesSpeleoReadOnly('const geometryReadOnly = isMapReadOnly(s);'));
});

// --- regression proof: this is the exact bug class #275 fixed ------------------

test('the pre-#275 DataTable.tsx pattern would have been flagged (regression proof)', () => {
  const buggy = "const geometryReadOnly = useUIStore((s) => s.geometryMode === 'closureAdjusted');";
  assert.equal(countClosureAdjustedComparisons(buggy), 1);
  assert.ok(!usesIsMapReadOnly(buggy)); // it didn't even reach for the canonical predicate
});

test('the fixed composed pattern passes both checks', () => {
  const fixed = 'const geometryReadOnly = useUIStore(isMapReadOnly) || useSpeleoStore(selectSpeleoReadOnly);';
  assert.equal(countClosureAdjustedComparisons(fixed), 0);
  assert.ok(usesIsMapReadOnly(fixed));
  assert.ok(usesSpeleoReadOnly(fixed));
});

// --- allowlist hygiene -----------------------------------------------------------

test('the exemption set only ever names the uiStore definition module', () => {
  // A growing exemption set silently defeats rule (B) — keep it deliberately tiny
  // and reviewed; this pins the accepted baseline so a new entry is a visible diff.
  assert.deepEqual([...MAP_READ_ONLY_EXEMPT], ['src/store/uiStore.ts']);
});

test('every allowlisted count is a positive integer (no stray zero entries)', () => {
  for (const [file, count] of Object.entries(CLOSURE_ADJUSTED_ALLOWLIST)) {
    assert.ok(Number.isInteger(count) && count > 0, `${file}: allowlist count must be > 0`);
  }
});

// --- report -----------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`✗ check-readonly-gates.test: ${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ check-readonly-gates.test: ${passed} checks passed.`);
