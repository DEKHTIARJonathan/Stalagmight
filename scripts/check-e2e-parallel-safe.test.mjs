// Fixture tests for the Playwright parallel-safety guard (scripts/check-e2e-parallel-safe.mjs).
//
// It was the one gate nothing pinned (#576 E7): a bare `process.exit(main())`
// with nothing exported, so a regression in its comment stripping could switch
// it off without any test noticing - and one did exist: a quoted `/*` opened a
// block comment that blanked the rest of the file. Every rule is pinned here
// with a planted pattern that MUST fire, next to the negatives that must not.
//
// Pure Node, no test framework (mirrors scripts/check-no-em-dash.test.mjs).
// Run: node scripts/check-e2e-parallel-safe.test.mjs  (also a CI smoke step).

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scan, stripComments, checkPremise, main, RULES, ALLOW } from './check-e2e-parallel-safe.mjs';

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

const SPEC = 'e2e-playwright/x.spec.ts';
const ids = (text, rel = SPEC) => scan([rel], () => text).map((v) => v.ruleId);

// --- every rule fires on its pattern ---------------------------------------------

test('own-server and port-listen fire', () => {
  assert.deepEqual(ids('const s = http.createServer(handler);'), ['own-server']);
  assert.deepEqual(ids('server.listen(0);'), ['port-listen']);
});

test('disk-write fires on the original write calls', () => {
  for (const call of ['fs.writeFileSync(p, x)', 'await writeFile(p, x)', 'fs.appendFileSync(p, x)', 'fs.createWriteStream(p)', 'fs.copyFileSync(a, b)', 'fs.cpSync(a, b)', 'fs.renameSync(a, b)']) {
    assert.deepEqual(ids(call), ['disk-write'], call);
  }
});

test('disk-write now also fires on create / delete / link calls (#576 E7)', () => {
  for (const call of ['fs.mkdirSync(d)', 'await fsp.mkdir(d)', 'fs.unlinkSync(p)', 'await unlink(p)', 'fs.rmSync(d, { recursive: true })',
    'await fs.rm(d)', 'fs.rmdirSync(d)', 'fs.symlinkSync(a, b)', 'fs.truncateSync(p)', 'await fsp.rename(a, b)', 'await fs.cp(a, b)']) {
    assert.deepEqual(ids(call), ['disk-write'], call);
  }
});

test('disk-write fires on open-for-write, write, hard-link and chmod calls (#576 RV3-FE-12)', () => {
  for (const call of ["const fd = fs.openSync(p, 'w')", 'fs.writeSync(fd, buf)', 'fs.linkSync(a, b)', 'await fsp.link(a, b)',
    "await fs.promises.open(p, 'w')", 'fs.chmodSync(p, 0o644)', 'await fsp.chmod(p, 0o644)']) {
    assert.deepEqual(ids(call), ['disk-write'], call);
  }
});

test('the async open / link / chmod names need an fs receiver: window.open and a menu helper do not fire', () => {
  assert.deepEqual(ids("await page.evaluate(() => window.open('about:blank'));"), []);
  assert.deepEqual(ids('await menu.open();'), []);
  assert.deepEqual(ids("await link(page, 'Station A1');"), []);
});

test('disk-write does NOT fire on a mock label, a UI helper named rename, or mkdtemp', () => {
  assert.deepEqual(ids("handlers['plugin:fs|writeFile'] = () => null;"), []);
  assert.deepEqual(ids("await rename(page, 'Section B');"), []);
  assert.deepEqual(ids("const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));"), []);
});

test('foreign-host-port fires on a literal or template port, not on :1420', () => {
  assert.deepEqual(ids("await page.goto('http://localhost:5173/');"), ['foreign-host-port']);
  assert.deepEqual(ids('await page.goto(`http://127.0.0.1:${port}/`);'), ['foreign-host-port']);
  assert.deepEqual(ids("await page.goto('http://localhost:1420/');"), []);
});

test('own-server fires on a WebSocket server too (#576 NF-FIX3B-1)', () => {
  assert.deepEqual(ids('const wss = new WebSocketServer({ port: 0 });'), ['own-server']);
  assert.deepEqual(ids('const wss = new WebSocket.Server({ noServer: true });'), ['own-server']);
  // A client socket to the shared server binds nothing.
  assert.deepEqual(ids("const ws = new WebSocket('ws://127.0.0.1:1420/');"), []);
});

test('foreign-host-port fires on 0.0.0.0 and on a concatenated port (#576 NF-FIX3B-1)', () => {
  assert.deepEqual(ids("await page.goto('http://0.0.0.0:5173/');"), ['foreign-host-port']);
  assert.deepEqual(ids('await page.goto(`http://0.0.0.0:${port}/`);'), ['foreign-host-port']);
  assert.deepEqual(ids("await page.goto('http://localhost:' + port);"), ['foreign-host-port']);
  assert.deepEqual(ids('await page.goto("http://127.0.0.1:" + server.port + "/");'), ['foreign-host-port']);
  assert.deepEqual(ids("await page.goto('http://localhost:' + 1420);"), []);
  assert.deepEqual(ids("await page.goto('http://0.0.0.0:1420/');"), []);
});

test('serial fires on both spellings', () => {
  assert.deepEqual(ids('test.describe.serial("x", () => {});'), ['serial']);
  assert.deepEqual(ids("test.describe.configure({ mode: 'serial' });"), ['serial']);
  assert.deepEqual(ids("test.describe.configure({ mode: 'parallel' });"), []);
});

// --- comment stripping -------------------------------------------------------------

test('REGRESSION: a quoted /* no longer blanks the rest of the file', () => {
  const text = ["const pattern = 'fixtures/*.dmp';", "fs.writeFileSync('/tmp/fixed-path.txt', 'x');", "test.describe.configure({ mode: 'serial' });"].join('\n');
  assert.deepEqual(ids(text), ['disk-write', 'serial']);
});

test('a // inside a string is not a comment (URL), a real trailing // is', () => {
  assert.deepEqual(ids("await page.goto('http://localhost:5173/'); // other"), ['foreign-host-port']);
  assert.deepEqual(ids("const ok = 1; // fs.writeFileSync('/tmp/x', 'y')"), []);
});

test('block comments are stripped across lines; a pattern in prose does not fire', () => {
  const text = ['/* never do this:', "  fs.writeFileSync('/tmp/x', 'y');", '  test.describe.serial() */', "fs.rmSync('/tmp/d');"].join('\n');
  const v = scan([SPEC], () => text);
  assert.deepEqual(v.map((x) => [x.ruleId, x.lineNo]), [['disk-write', 4]]);
});

test('REGRESSION (#576 RV3-FE-12): a /* inside a regex literal opens no block comment', () => {
  const text = ['const LEADING = /^\\/*/;', "fs.writeFileSync('/tmp/fixed-path.txt', 'x');", '/* end */'].join('\n');
  assert.deepEqual(scan([SPEC], () => text).map((x) => [x.ruleId, x.lineNo]), [['disk-write', 2]]);
  // Division and a regex after `=>` / `(` / `return` are told apart.
  const kept = stripComments(['const half = a / 2 / b; // note', 'xs.filter((s) => /\\/*x/.test(s));', 'return /"/.test(q); // q']);
  assert.deepEqual(kept, ['const half = a / 2 / b; ', 'xs.filter((s) => /\\/*x/.test(s));', 'return /"/.test(q); ']);
});

test('a multi-line template literal keeps a // inside it', () => {
  const lines = stripComments(['const html = `', '  <a href="http://localhost:5173/">', '`;']);
  assert.ok(lines[1].includes('localhost:5173'), lines[1]);
});

test('reports the original line as the snippet, and the 1-based line number', () => {
  const [v] = scan([SPEC], () => "\n\n  fs.rmSync('/tmp/d'); // cleanup");
  assert.equal(v.lineNo, 3);
  assert.equal(v.snippet, "fs.rmSync('/tmp/d'); // cleanup");
});

// --- allowlist ---------------------------------------------------------------------

test('the coverage fixture is allowlisted for disk-write only', () => {
  assert.deepEqual(ALLOW.map((a) => [a.file, a.rule]), [['e2e-playwright/fixtures/coverage.ts', 'disk-write']]);
  assert.deepEqual(ids("fs.mkdirSync(coverageDir, { recursive: true });", 'e2e-playwright/fixtures/coverage.ts'), []);
  assert.deepEqual(ids("test.describe.serial('x', () => {});", 'e2e-playwright/fixtures/coverage.ts'), ['serial']);
  assert.ok(ALLOW.every((a) => a.reason && a.reason.length > 10));
});

// --- the fullyParallel premise -------------------------------------------------------

test('the premise holds only when the config sets fullyParallel: true in code', () => {
  assert.equal(checkPremise('export default defineConfig({ fullyParallel: true });'), null);
  assert.match(checkPremise('export default defineConfig({ fullyParallel: false });'), /fullyParallel: true/);
  assert.match(checkPremise('export default defineConfig({ /* fullyParallel: true */ });'), /fullyParallel: true/);
  assert.match(checkPremise(null), /not found/);
});

// --- main(): fail closed, on a real temp tree ---------------------------------------

test('main fails when e2e-playwright/ is missing, and on a symlinked spec', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-parallel-'));
  const quiet = () => {};
  try {
    assert.equal(main(root, quiet, quiet), 1, 'missing scan dir');
    fs.mkdirSync(path.join(root, 'e2e-playwright'));
    fs.writeFileSync(path.join(root, 'playwright.config.ts'), 'export default { fullyParallel: true };');
    fs.writeFileSync(path.join(root, 'e2e-playwright', 'a.spec.ts'), "test('a', () => {});");
    assert.equal(main(root, quiet, quiet), 0, 'clean tree');
    fs.writeFileSync(path.join(root, 'outside.ts'), "fs.writeFileSync('/tmp/x', 'y');");
    fs.symlinkSync('../outside.ts', path.join(root, 'e2e-playwright', 'b.spec.ts'));
    const lines = [];
    assert.equal(main(root, quiet, (m) => lines.push(m)), 1, 'symlinked spec');
    assert.ok(lines.some((l) => l.includes('[symlink] e2e-playwright/b.spec.ts')), lines.join('\n'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the live tree passes', () => {
  assert.equal(main(undefined, () => {}, () => {}), 0);
});

test('every rule has an id, a regex and a reason', () => {
  for (const r of RULES) assert.ok(r.id && r.re instanceof RegExp && r.why, r.id);
});

// --- report --------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`✗ check-e2e-parallel-safe.test: ${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ check-e2e-parallel-safe.test: ${passed} checks passed.`);
