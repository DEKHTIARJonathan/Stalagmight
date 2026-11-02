// Fixture tests for the Playwright no-unannotated-sleep gate (scripts/check-e2e-no-sleep.mjs).
//
// Pins what counts as a sleep, what counts as an annotation, and that prose,
// strings and in-page timers do not count. Pure Node, no test framework
// (mirrors scripts/check-e2e-parallel-safe.test.mjs).
// Run: node scripts/check-e2e-no-sleep.test.mjs  (also a CI smoke step).

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findSleeps, settleReason, scan, main, MIN_REASON } from './check-e2e-no-sleep.mjs';

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

const bad = (text) => scan(['e2e-playwright/x.spec.ts'], () => text).violations.map((v) => v.lineNo);

test('an unannotated waitForTimeout fails, with its line', () => {
  assert.deepEqual(bad(["await page.click('#a');", 'await page.waitForTimeout(300);'].join('\n')), [2]);
});

test('every call counts, including two on one line and a non-page receiver', () => {
  assert.deepEqual(bad('await page.waitForTimeout(1); await frame.waitForTimeout(2);'), [1, 1]);
  assert.deepEqual(bad('await p.waitForTimeout (5)'), [1]);
});

test('a "// settle: <reason>" block directly above passes, even as the first line of a longer comment', () => {
  const one = ['// settle: proves the tool does NOT change back', 'await page.waitForTimeout(200);'].join('\n');
  assert.deepEqual(bad(one), []);
  const multi = ['    // settle: proves no dialog opens; its absence', '    // holds on the first read either way.', '    await page.waitForTimeout(300);'].join('\n');
  assert.deepEqual(bad(multi), []);
  assert.equal(settleReason(multi.split('\n'), 2), 'proves no dialog opens; its absence');
});

test('an annotation that is too short, misspelled, or not directly above does NOT count', () => {
  assert.deepEqual(bad(['// settle: wait', 'await page.waitForTimeout(200);'].join('\n')), [2], `reason < ${MIN_REASON} chars`);
  assert.deepEqual(bad(['// Settle first: the compat mousedown arrives later', 'await page.waitForTimeout(200);'].join('\n')), [2]);
  assert.deepEqual(bad(['// settle: proves nothing changes here', '', 'await page.waitForTimeout(200);'].join('\n')), [3], 'a blank line ends the block');
  assert.deepEqual(bad(['// settle: proves nothing changes here', 'await page.click("#a");', 'await page.waitForTimeout(200);'].join('\n')), [3]);
  assert.deepEqual(bad('await page.waitForTimeout(200); // settle: trailing comments are not the contract'), [1]);
});

test('a waitForTimeout in a comment or a string is not a call', () => {
  assert.deepEqual(bad('// Use polling assertion instead of waitForTimeout'), []);
  assert.deepEqual(bad(['/**', ' * Helper to poll (more stable than waitForTimeout(100)).', ' */'].join('\n')), []);
  assert.deepEqual(bad("const label = 'page.waitForTimeout(100)';"), []);
});

test('in-page timers and the test budget are out of scope', () => {
  assert.deepEqual(bad('await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));'), []);
  assert.deepEqual(bad('test.setTimeout(60000);'), []);
});

test('scan counts annotated settles separately from violations', () => {
  const r = scan(['a.ts', 'b.ts'], (rel) => (rel === 'a.ts' ? '// settle: proves nothing moved here\nawait page.waitForTimeout(1);' : 'await page.waitForTimeout(1);'));
  assert.equal(r.settles, 1);
  assert.deepEqual(r.violations, [{ rel: 'b.ts', lineNo: 1 }]);
});

test('findSleeps reports the reason it accepted', () => {
  assert.deepEqual(findSleeps('// settle: proves the menu never opens\nawait page.waitForTimeout(50);'), [{ lineNo: 2, reason: 'proves the menu never opens' }]);
});

test('main fails without e2e-playwright/ and on a symlinked spec; passes a clean tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'no-sleep-'));
  const quiet = () => {};
  try {
    assert.equal(main(root, quiet, quiet), 1);
    fs.mkdirSync(path.join(root, 'e2e-playwright'));
    fs.writeFileSync(path.join(root, 'e2e-playwright', 'a.spec.ts'), "await expect(page.getByTestId('x')).toBeVisible();\n");
    assert.equal(main(root, quiet, quiet), 0);
    fs.writeFileSync(path.join(root, 'outside.ts'), 'await page.waitForTimeout(100);\n');
    fs.symlinkSync('../outside.ts', path.join(root, 'e2e-playwright', 'b.spec.ts'));
    const lines = [];
    assert.equal(main(root, quiet, (m) => lines.push(m)), 1);
    assert.ok(lines.some((l) => l.includes('b.spec.ts  is a symlink')), lines.join('\n'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the live tree passes', () => {
  assert.equal(main(undefined, () => {}, () => {}), 0);
});

if (failures.length > 0) {
  console.error(`✗ check-e2e-no-sleep.test: ${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ check-e2e-no-sleep.test: ${passed} checks passed.`);
