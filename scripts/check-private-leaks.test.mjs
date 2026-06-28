// Fixture tests for the private-reference leak guard (scripts/check-private-leaks.mjs).
//
// A guard that never fires proves nothing — so each rule is pinned with a planted
// leak it MUST catch, and the load-bearing safety properties are pinned with the
// exact inputs that must NOT fire: the functional self-hosted-runner tokens kept
// in ci.yml (`i5-nuc-runner`, `NUC_RUNNER_READ_PAT`), the genericized placeholder
// paths, name lookalikes (Danielle/Nicobar/unicode), substring-boundary cases,
// and root-only public attribution.
//
// Pure Node, no test framework (mirrors scripts/check-rust-file-size.test.mjs).
// Run: node scripts/check-private-leaks.test.mjs  (also a CI leak-scan step).

import assert from 'node:assert/strict';
import { findLeaks, isExcluded, isAttributionFile, RULES, gateFails } from './check-private-leaks.mjs';

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

// --- maintainer-name: must fire -----------------------------------------------

test('maintainer-name fires on a name in a code comment', () => {
  assert.ok(firedIds('// ask Nico before changing this').has('maintainer-name'));
  assert.ok(firedIds('# Daniel owns the geometry layer').has('maintainer-name'));
});

test('maintainer-name fires on a name-bearing personal path (the #229 form)', () => {
  assert.ok(firedIds('const p = "/home/daniel/surveys/x.stalx";').has('maintainer-name'));
  assert.ok(firedIds('cp ~/build /Users/ndh/out').has('maintainer-name'));
  assert.ok(firedIds('C:\\Users\\ndh\\spring.stalx').has('maintainer-name'));
});

test('maintainer-name fires on the GitHub handle', () => {
  assert.ok(firedIds('see github.com/ndhailey/dev-tools').has('maintainer-name'));
});

test('maintainer-name fires on `_`- and digit-adjacent forms (the widened boundary)', () => {
  // `\b` missed these; the letter-lookaround catches them.
  assert.ok(firedIds('user daniel_saska pushed').has('maintainer-name'));
  assert.ok(firedIds('handle nico_dev').has('maintainer-name'));
  assert.ok(firedIds('account nico2 logged in').has('maintainer-name'));
});

// --- maintainer-name: must NOT fire (load-bearing negatives) -------------------

test('maintainer-name does NOT fire on letter-adjacent lookalikes', () => {
  // Danielle/Nicobar/unicode each contain a name substring but are letter-adjacent.
  assert.equal(firedIds('Danielle ran the unicode parser near Nicobar').size, 0);
});

test('maintainer-name `ndh` is path-anchored: /Users/ndh fires, a bare token does not', () => {
  assert.ok(firedIds('saved to /Users/ndh/out').has('maintainer-name'));
  // A standalone 3-char `ndh` token (column header, i18n key, hash) must NOT fire.
  assert.equal(firedIds('the ndh column maps to ndh_total').size, 0);
});

// --- private-cloud-infra: must fire / must not --------------------------------

test('private-cloud-infra fires on provider, env prefix (incl. digit-led), alias, host', () => {
  assert.ok(firedIds('# build runs on Scaleway').has('private-cloud-infra'));
  assert.ok(firedIds('export SCW_SECRET_KEY=abc').has('private-cloud-infra'));
  assert.ok(firedIds('SCW_2FA enabled').has('private-cloud-infra')); // digit-led, was missed by SCW_[A-Za-z]
  assert.ok(firedIds('ssh -i anzu remote').has('private-cloud-infra'));
  assert.ok(firedIds('rsync -avzP ./build cog:~/out').has('private-cloud-infra'));
  assert.ok(firedIds('scp file cog:/srv/x').has('private-cloud-infra'));
});

test('private-cloud-infra does NOT fire on boundary lookalikes / bare "cog"', () => {
  // `\b` boundary on scaleway, and `cog:` requires a path char — a bare cog is fine.
  assert.equal(firedIds('the descaleway helper turns a cog in the machine').size, 0);
});

// --- private-doc-or-tool: every alternative fires -----------------------------

test('private-doc-or-tool fires on each coordination doc / tool marker', () => {
  for (const marker of [
    'personaldocs', 'workingnotes', 'stalagmight-inflight', 'stalagmight-project-notes',
    'coord_board', 'ns-CLAUDE', 'stag-private', 'nico_sm_prioritized', 'nuc-i5',
  ]) {
    assert.ok(firedIds(`ref ~/x/${marker}/y`).has('private-doc-or-tool'), `expected ${marker} to fire`);
  }
});

// --- private-tracker ----------------------------------------------------------

test('private-tracker fires on the Plane references but not bare "plane"', () => {
  assert.ok(firedIds('tracked at app.plane.so/issue').has('private-tracker'));
  assert.ok(firedIds('| Plane ID | 1234 |').has('private-tracker'));
  assert.ok(!firedIds('project the point onto the survey plane').has('private-tracker'));
});

// --- the load-bearing SAFETY negatives ----------------------------------------

test('SAFETY: functional self-hosted-runner tokens kept in ci.yml do not fire', () => {
  // Intentionally retained in .github/workflows/ci.yml (the picker). `nuc-i5` is the
  // REVERSED tool-dir name, so neither token matches any rule. If a future rule edit
  // breaks this, the gate would red-CI on its own workflow file — this is the tripwire.
  assert.equal(findLeaks('name=="i5-nuc-runner" and status', 'ci.yml').length, 0);
  assert.equal(findLeaks('GH_TOKEN: ${{ secrets.NUC_RUNNER_READ_PAT }}', 'ci.yml').length, 0);
});

test('SAFETY: genericized placeholder paths do not fire', () => {
  assert.equal(firedIds("ensureExtension('/home/v1.0/myfile', 'stalx')").size, 0);
  assert.equal(firedIds('save to /home/user/out and /Users/x/in').size, 0);
});

// --- attribution exemption is ROOT-ONLY ---------------------------------------

test('maintainer-name is suppressed only in ROOT attribution files', () => {
  // Root README/AUTHORS may credit a maintainer by name...
  assert.equal(findLeaks('Built by Nico and Daniel.', 'README.md').length, 0);
  assert.equal(findLeaks('Maintainers: Nico, Daniel.', 'AUTHORS.md').length, 0);
  // ...but a NESTED code-adjacent README is NOT an attribution file — name fires.
  assert.ok(
    findLeaks('// TODO(daniel): fix this', 'src/components/SpreadsheetGrid/README.md')
      .some((v) => v.ruleId === 'maintainer-name'),
  );
  // ...and a docs/ AUTHORS is nested, so root-only means it is NOT exempt either.
  assert.ok(findLeaks('Thanks Nico!', 'docs/AUTHORS.md').some((v) => v.ruleId === 'maintainer-name'));
  // Non-name rules still fire even in a root attribution file.
  assert.ok(
    findLeaks('credits — built on Scaleway', 'README.md').some((v) => v.ruleId === 'private-cloud-infra'),
  );
});

test('isAttributionFile matches ROOT basenames only, case-insensitively', () => {
  assert.ok(isAttributionFile('README.md'));
  assert.ok(isAttributionFile('AUTHORS.md'));
  assert.ok(isAttributionFile('CHANGELOG.md'));
  assert.ok(!isAttributionFile('docs/AUTHORS.md')); // nested — not exempt
  assert.ok(!isAttributionFile('src/components/SpreadsheetGrid/README.md'));
  assert.ok(!isAttributionFile('src/store/uiStore.ts'));
});

// --- exclusions ---------------------------------------------------------------

test('isExcluded covers vendor, lockfiles, generated, binary, and self', () => {
  assert.ok(isExcluded('src-tauri/vendor/compass_data/MODIFICATIONS.md'));
  assert.ok(isExcluded('src-tauri/Cargo.lock'));
  assert.ok(isExcluded('pnpm-lock.yaml'));
  assert.ok(isExcluded('src/types/ipc.generated.ts'));
  assert.ok(isExcluded('src/types/ipc/Project.ts'));
  assert.ok(isExcluded('docs/screenshot.png'));
  assert.ok(isExcluded('docs/SCREENSHOT.PNG')); // extension lowercased
  assert.ok(isExcluded('scripts/check-private-leaks.mjs'));
  assert.ok(isExcluded('scripts/check-private-leaks.test.mjs'));
});

test('isExcluded does NOT skip text formats that can carry a leak', () => {
  assert.ok(!isExcluded('src/assets/icon.svg')); // text — now scanned
  assert.ok(!isExcluded('e2e-playwright/__snapshots__/x.snap')); // text — now scanned
  assert.ok(!isExcluded('Makefile')); // extensionless — scanned
  assert.ok(!isExcluded('src/store/uiStore.ts'));
  assert.ok(!isExcluded('docs/roadmap.md'));
});

// --- fail closed on an unscannable file (Copilot review, #232) ----------------

test('gateFails: clean only with zero violations AND zero skips', () => {
  assert.equal(gateFails([], []), false);
  // An unscanned (oversized/unreadable) file fails the gate even with no markers —
  // else a marker could be smuggled inside a file the scanner declines to read.
  assert.equal(gateFails([], [{ rel: 'big.md', reason: '9.0 MB > 5 MB cap' }]), true);
  assert.equal(gateFails([{ ruleId: 'maintainer-name' }], []), true);
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
console.log(`✓ check-private-leaks.test: ${passed} checks passed.`);
