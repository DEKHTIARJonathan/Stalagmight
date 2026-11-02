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
import { checkBundle, REPO_ROOT, MAX_BUNDLE_BYTES } from './check-third-party-licenses.mjs';

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

const GEN_V1 = 'generator-script-v1';
const ABOUT_V1 = 'about-toml-v1';

// Every fixture tree is recorded and removed at the end of the run (#576
// E18(b): the 13 trees, one of them 33 MB, used to stay behind in TMPDIR -
// RAM, where /tmp is a tmpfs - on every leak-scan run and every checklist run).
const roots = [];

function makeTree({ cargo = 'cargo-lock-v1', pnpm = 'pnpm-lock-v1', gen = GEN_V1, about = ABOUT_V1, bundle } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-gate-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'src-tauri'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'src-tauri', 'Cargo.lock'), cargo);
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), pnpm);
  fs.writeFileSync(path.join(root, 'scripts', 'gen-third-party-licenses.mjs'), gen);
  fs.writeFileSync(path.join(root, 'src-tauri', 'about.toml'), about);
  if (bundle !== undefined) fs.writeFileSync(path.join(root, 'THIRD-PARTY-LICENSES.md'), bundle);
  return root;
}

// Mirrors the generator's layout: hashes comment (all four inputs + body),
// then the body it hashes (every byte after the comment's closing `-->\n`).
const currentBundle = (cargo, pnpm, body = '\n## npm packages\n\nfixture body\n') =>
  `# Third-party licenses\n\n<!-- lockfile-hashes\nCargo.lock=${sha256(cargo)}\npnpm-lock.yaml=${sha256(pnpm)}\ngen-third-party-licenses.mjs=${sha256(GEN_V1)}\nabout.toml=${sha256(ABOUT_V1)}\nbundle-body=${sha256(body)}\n-->\n${body}`;

test('current bundle passes', () => {
  const root = makeTree({ bundle: currentBundle('cargo-lock-v1', 'pnpm-lock-v1') });
  assert.deepEqual(checkBundle(root), []);
});

test('a CRLF checkout of lockfiles and bundle still passes (autocrlf)', () => {
  const toCrlf = (s) => s.replace(/\n/g, '\r\n');
  const root = makeTree({
    cargo: toCrlf('cargo-lock-v1\n'),
    pnpm: toCrlf('pnpm-lock-v1\n'),
    bundle: toCrlf(currentBundle('cargo-lock-v1\n', 'pnpm-lock-v1\n')),
  });
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
  const good = currentBundle('cargo-lock-v1', 'pnpm-lock-v1');
  const root = makeTree({ bundle: good.replace(/^bundle-body=[0-9a-f]{64}\n/m, '') });
  const problems = checkBundle(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /records no bundle-body hash/);
});

test('oversized bundle fails with the cap message, not "missing"', () => {
  // A small bundle against a small cap exercises the same branch as 33 MB
  // against the real 32 MiB default, without writing 33 MB per run.
  const root = makeTree({ bundle: 'x'.repeat(4096) });
  const problems = checkBundle(root, { maxBytes: 1024 });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /4096 bytes \(> 1024 cap\)/);
  assert.match(checkBundle(root, { maxBytes: 8192 })[0], /no lockfile-hashes comment/, 'under the cap it is read normally');
  assert.equal(MAX_BUNDLE_BYTES, 32 * 1024 * 1024, 'the default cap is unchanged');
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
  const good = currentBundle('cargo-lock-v1', 'pnpm-lock-v1');
  const root = makeTree({ bundle: good.replace(/^pnpm-lock\.yaml=[0-9a-f]{64}\n/m, '') });
  const problems = checkBundle(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /records no hash for pnpm-lock\.yaml/);
});

test('an edited generator script or about.toml fails', () => {
  const bundle = currentBundle('cargo-lock-v1', 'pnpm-lock-v1');
  const genRoot = makeTree({ bundle, gen: 'generator-script-v2' });
  assert.match(checkBundle(genRoot)[0], /gen-third-party-licenses\.mjs changed/);
  const aboutRoot = makeTree({ bundle, about: 'about-toml-v2' });
  assert.match(checkBundle(aboutRoot)[0], /about\.toml changed/);
});

// The gate must pass against the real repo right now - a committed stale
// bundle should never survive to CI to begin with.
test('live repo bundle is current', () => {
  assert.deepEqual(checkBundle(REPO_ROOT), []);
});

for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
test('every fixture tree is removed again', () => {
  assert.ok(roots.length > 0);
  for (const root of roots) assert.equal(fs.existsSync(root), false, `${root} left behind`);
});

if (failures.length > 0) {
  console.error(`✗ ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`✓ ${passed} third-party-license gate tests passed`);
