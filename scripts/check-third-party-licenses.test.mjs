// Fixture tests for the third-party license bundle gate
// (scripts/check-third-party-licenses.mjs).
//
// The gate is a hash comparison, so the inputs it could get WRONG are pinned:
// a missing bundle, a bundle without the hashes comment, a stale hash for
// either lockfile, and the current pass state. Fixtures are built in a temp
// tree with hashes computed the same way the generator writes them, so the
// test does not depend on the repo's live lockfiles.
//
// Pure Node, no test framework (mirrors scripts/check-private-leaks.test.mjs).
// Run: node scripts/check-third-party-licenses.test.mjs  (also a CI check step).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkBundle, REPO_ROOT } from './check-third-party-licenses.mjs';

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

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function makeTree({ cargo = 'cargo-lock-v1', pnpm = 'pnpm-lock-v1', bundle } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-gate-'));
  fs.mkdirSync(path.join(root, 'src-tauri'));
  fs.writeFileSync(path.join(root, 'src-tauri', 'Cargo.lock'), cargo);
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), pnpm);
  if (bundle !== undefined) fs.writeFileSync(path.join(root, 'THIRD-PARTY-LICENSES.md'), bundle);
  return root;
}

// Mirrors the generator's layout: hashes comment, then the body it hashes
// (every byte after the comment's closing `-->\n`).
const currentBundle = (cargo, pnpm, body = '\n## npm packages\n\nfixture body\n') =>
  `# Third-party licenses\n\n<!-- lockfile-hashes\nCargo.lock=${sha256(cargo)}\npnpm-lock.yaml=${sha256(pnpm)}\nbundle-body=${sha256(body)}\n-->\n${body}`;

test('current bundle passes', () => {
  const root = makeTree({ bundle: currentBundle('cargo-lock-v1', 'pnpm-lock-v1') });
  assert.deepEqual(checkBundle(root), []);
});

test('hand-edited body fails and says so', () => {
  const good = currentBundle('cargo-lock-v1', 'pnpm-lock-v1');
  const root = makeTree({ bundle: good.replace('fixture body', 'edited body') });
  const problems = checkBundle(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /edited by hand/);
});

test('bundle without a bundle-body hash fails', () => {
  const body = '\nbody\n';
  const bundle = `# x\n\n<!-- lockfile-hashes\nCargo.lock=${sha256('cargo-lock-v1')}\npnpm-lock.yaml=${sha256('pnpm-lock-v1')}\n-->\n${body}`;
  const root = makeTree({ bundle });
  const problems = checkBundle(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /records no bundle-body hash/);
});

test('oversized bundle fails with the cap message, not "missing"', () => {
  const root = makeTree({ bundle: 'x'.repeat(33 * 1024 * 1024) });
  const problems = checkBundle(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /cap/);
});

test('missing bundle fails', () => {
  const root = makeTree();
  const problems = checkBundle(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /missing/);
});

test('bundle without a hashes comment fails', () => {
  const root = makeTree({ bundle: '# Third-party licenses\n\nhand-written\n' });
  assert.match(checkBundle(root)[0], /no lockfile-hashes comment/);
});

test('stale Cargo.lock hash fails and names the lockfile', () => {
  const root = makeTree({ bundle: currentBundle('OLD-cargo-lock', 'pnpm-lock-v1') });
  const problems = checkBundle(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /src-tauri\/Cargo\.lock changed/);
});

test('stale pnpm-lock hash fails and names the lockfile', () => {
  const root = makeTree({ bundle: currentBundle('cargo-lock-v1', 'OLD-pnpm-lock') });
  const problems = checkBundle(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /pnpm-lock\.yaml changed/);
});

test('both lockfiles stale reports both', () => {
  const root = makeTree({ bundle: currentBundle('OLD', 'ALSO-OLD') });
  assert.equal(checkBundle(root).length, 2);
});

test('a hash entry missing from the comment fails', () => {
  const cargo = 'cargo-lock-v1';
  const body = '\nbody\n';
  const bundle = `# x\n\n<!-- lockfile-hashes\nCargo.lock=${sha256(cargo)}\nbundle-body=${sha256(body)}\n-->\n${body}`;
  const root = makeTree({ bundle });
  const problems = checkBundle(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /records no hash for pnpm-lock\.yaml/);
});

// The gate must pass against the real repo right now - a committed stale
// bundle should never survive to CI to begin with.
test('live repo bundle is current', () => {
  assert.deepEqual(checkBundle(REPO_ROOT), []);
});

if (failures.length > 0) {
  console.error(`✗ ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`✓ ${passed} third-party-license gate tests passed`);
