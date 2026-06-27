// Fixture tests for the private-reference leak guard (scripts/check-private-leaks.mjs).
//
// A guard that never fires proves nothing — so each rule is pinned with a planted
// leak it MUST catch, and the load-bearing safety properties are pinned with the
// exact inputs that must NOT fire: the functional self-hosted-runner tokens kept
// in ci.yml (`i5-nuc-runner`, `NUC_RUNNER_READ_PAT`), the genericized placeholder
// paths, name lookalikes (Danielle/Nicobar/unicode), and public attribution.
//
// Pure Node, no test framework (mirrors scripts/check-rust-file-size.test.mjs).
// Run: node scripts/check-private-leaks.test.mjs  (also a CI leak-scan step).

import assert from 'node:assert/strict';
import { findLeaks, isExcluded, isAttributionFile, RULES } from './check-private-leaks.mjs';

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

// Helper: rule ids that fire on `text` for a given (non-attribution) file.
function firedIds(text, rel = 'src/example.ts') {
  return new Set(findLeaks(text, rel).map((v) => v.ruleId));
}

// --- each rule catches its target ---------------------------------------------

test('maintainer-name fires on a name in a code comment', () => {
  assert.ok(firedIds('// ask Nico before changing this').has('maintainer-name'));
  assert.ok(firedIds('# Daniel owns the geometry layer').has('maintainer-name'));
});

test('maintainer-name fires on a personal home path (the #229 form)', () => {
  assert.ok(firedIds('const p = "/home/daniel/surveys/x.stalx";').has('maintainer-name'));
  assert.ok(firedIds('cp ~/build /Users/ndh/out').has('maintainer-name'));
});

test('maintainer-name fires on the GitHub handle', () => {
  assert.ok(firedIds('see github.com/ndhailey/dev-tools').has('maintainer-name'));
});

test('private-cloud-infra fires on provider, env prefix, and key alias', () => {
  assert.ok(firedIds('# build runs on Scaleway').has('private-cloud-infra'));
  assert.ok(firedIds('export SCW_SECRET_KEY=abc').has('private-cloud-infra'));
  assert.ok(firedIds('ssh -i anzu remote').has('private-cloud-infra'));
});

test('private-doc-or-tool fires on the coordination docs and tool dir', () => {
  assert.ok(firedIds('see ~/personaldocs/notes.md').has('private-doc-or-tool'));
  assert.ok(firedIds('per stalagmight-inflight.md').has('private-doc-or-tool'));
  assert.ok(firedIds('run coord_board.py').has('private-doc-or-tool'));
  assert.ok(firedIds('imported via ns-CLAUDE.md').has('private-doc-or-tool'));
  assert.ok(firedIds('rsync ~/tools/nuc-i5 cog:~/').has('private-doc-or-tool'));
});

test('private-tracker fires on the Plane references', () => {
  assert.ok(firedIds('tracked at app.plane.so/issue').has('private-tracker'));
  assert.ok(firedIds('| Plane ID | 1234 |').has('private-tracker'));
});

// --- the load-bearing NEGATIVES (must NOT fire) -------------------------------

test('SAFETY: functional self-hosted-runner tokens kept in ci.yml do not fire', () => {
  // These are intentionally retained in .github/workflows/ci.yml (the picker).
  // The `nuc-i5` marker is the REVERSED personal tool-dir name, so neither token
  // matches any rule. If a future rule edit breaks this, the gate would red-CI on
  // its own workflow file — this test is the tripwire for that.
  assert.equal(findLeaks('name=="i5-nuc-runner" and status', 'ci.yml').length, 0);
  assert.equal(findLeaks('GH_TOKEN: ${{ secrets.NUC_RUNNER_READ_PAT }}', 'ci.yml').length, 0);
});

test('SAFETY: name lookalikes do not false-fire', () => {
  // Danielle/Nicobar/unicode all contain a name substring but lack the boundary.
  assert.equal(firedIds('Danielle ran the unicode parser near Nicobar').size, 0);
});

test('SAFETY: genericized placeholder paths do not fire', () => {
  assert.equal(firedIds("ensureExtension('/home/v1.0/myfile', 'stalx')").size, 0);
  assert.equal(firedIds('save to /home/user/out and /Users/x/in').size, 0);
});

test('SAFETY: bare "plane" (geometry) does not fire the tracker rule', () => {
  assert.ok(!firedIds('project the point onto the survey plane').has('private-tracker'));
});

// --- attribution exemption (names allowed where public credit is legitimate) --

test('maintainer-name is suppressed in attribution files but other rules are not', () => {
  // README may credit a maintainer by name...
  assert.equal(findLeaks('Built by Nico and Daniel.', 'README.md').length, 0);
  assert.equal(findLeaks('Thanks Nico!', 'docs/AUTHORS.md').length, 0);
  // ...but Scaleway must never appear, even in an attribution file.
  assert.ok(
    findLeaks('credits — built on Scaleway', 'README.md').some((v) => v.ruleId === 'private-cloud-infra'),
  );
});

test('isAttributionFile matches by basename, case-insensitively', () => {
  assert.ok(isAttributionFile('README.md'));
  assert.ok(isAttributionFile('docs/AUTHORS.md'));
  assert.ok(isAttributionFile('CHANGELOG.md'));
  assert.ok(!isAttributionFile('src/store/uiStore.ts'));
  assert.ok(!isAttributionFile('docs/roadmap.md'));
});

// --- exclusions ---------------------------------------------------------------

test('isExcluded covers vendor, lockfiles, generated, binary, and self', () => {
  assert.ok(isExcluded('src-tauri/vendor/compass_data/MODIFICATIONS.md'));
  assert.ok(isExcluded('src-tauri/Cargo.lock'));
  assert.ok(isExcluded('pnpm-lock.yaml'));
  assert.ok(isExcluded('src/types/ipc.generated.ts'));
  assert.ok(isExcluded('src/types/ipc/Project.ts'));
  assert.ok(isExcluded('docs/screenshot.png'));
  assert.ok(isExcluded('scripts/check-private-leaks.mjs'));
  assert.ok(isExcluded('scripts/check-private-leaks.test.mjs'));
  assert.ok(!isExcluded('src/store/uiStore.ts'));
  assert.ok(!isExcluded('docs/roadmap.md'));
});

// --- rule hygiene -------------------------------------------------------------

test('every rule regex carries the global flag (required by the exec loop)', () => {
  for (const r of RULES) assert.ok(r.re.global, `${r.id} regex must be /g`);
});

// --- report -------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`✗ check-private-leaks.test: ${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ check-private-leaks.test: ${passed} assertions passed.`);
