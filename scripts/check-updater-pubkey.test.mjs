// Fixture tests for the updater pubkey/endpoint tripwire
// (scripts/check-updater-pubkey.mjs).
//
// The `plugins.updater` block is absent from tauri.conf.json today (see
// docs/releasing.md); these fixtures pin what happens the day it lands: a
// placeholder or malformed pubkey, an empty or non-https/non-GitHub
// endpoint, and the current (block-absent) pass state.
//
// Pure Node, no test framework (mirrors scripts/check-third-party-licenses.test.mjs).
// Run: node scripts/check-updater-pubkey.test.mjs  (also a CI check step).

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkUpdaterConfig, REPO_ROOT } from './check-updater-pubkey.mjs';

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

function makeTree(conf) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-pubkey-gate-'));
  fs.mkdirSync(path.join(root, 'src-tauri'));
  fs.writeFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify(conf));
  return root;
}

const VALID_PUBKEY = Buffer.from('a valid minisign-style key body').toString('base64');
const VALID_ENDPOINT = 'https://github.com/Stalagmight/Stalagmight/releases/download/updater/latest-stable.json';

test('no plugins.updater block passes (pending state)', () => {
  const root = makeTree({});
  assert.deepEqual(checkUpdaterConfig(root), []);
});

test('valid pubkey and https GitHub endpoint pass', () => {
  const root = makeTree({ plugins: { updater: { pubkey: VALID_PUBKEY, endpoints: [VALID_ENDPOINT] } } });
  assert.deepEqual(checkUpdaterConfig(root), []);
});

test('placeholder pubkey fails', () => {
  const root = makeTree({
    plugins: { updater: { pubkey: 'UPDATER-PUBKEY-PENDING-SEE-ISSUE-579', endpoints: [VALID_ENDPOINT] } },
  });
  const problems = checkUpdaterConfig(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /pubkey is not a valid/);
});

test('empty pubkey fails', () => {
  const root = makeTree({ plugins: { updater: { pubkey: '', endpoints: [VALID_ENDPOINT] } } });
  assert.match(checkUpdaterConfig(root)[0], /pubkey is not a valid/);
});

test('non-https endpoint fails and names it', () => {
  const root = makeTree({
    plugins: { updater: { pubkey: VALID_PUBKEY, endpoints: ['http://github.com/x/y'] } },
  });
  const problems = checkUpdaterConfig(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not https/);
});

test('non-github endpoint fails and names it', () => {
  const root = makeTree({
    plugins: { updater: { pubkey: VALID_PUBKEY, endpoints: ['https://evil.example.com/x'] } },
  });
  const problems = checkUpdaterConfig(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not a github\.com URL/);
});

test('empty endpoints list fails', () => {
  const root = makeTree({ plugins: { updater: { pubkey: VALID_PUBKEY, endpoints: [] } } });
  assert.match(checkUpdaterConfig(root)[0], /endpoints is empty/);
});

test('missing/invalid tauri.conf.json fails loudly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-pubkey-gate-'));
  const problems = checkUpdaterConfig(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /missing or not valid JSON/);
});

// The gate must pass against the real repo right now - the block is absent.
test('live repo config passes (block absent)', () => {
  assert.deepEqual(checkUpdaterConfig(REPO_ROOT), []);
});

if (failures.length > 0) {
  console.error(`✗ ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`✓ ${passed} updater-pubkey gate tests passed`);
