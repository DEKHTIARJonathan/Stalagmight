// Fixture tests for the ESLint gate (scripts/check-eslint.mjs, eslint.config.js).
//
// Two halves:
//   - the ratchet arithmetic, on synthetic counts (a grown count, a new file, a
//     new rule and a loosened count all fail; an exact match passes);
//   - the REAL config, driven with in-memory snippets at paths inside the gate
//     scope, so a config edit that silently drops a rule (or the scope that
//     carries it) fails here. Each rule is pinned with a planted violation it
//     MUST report and a near miss it must NOT.
//
// No test framework (mirrors the sibling scripts/check-*.test.mjs files).
// Run: node scripts/check-eslint.test.mjs   (pnpm lint:eslint:test; CI check job)

import assert from 'node:assert/strict';
import * as path from 'node:path';
import { ESLint } from 'eslint';
import { REPO_ROOT, LINT_TARGETS, ratchet, summarize, total, baselinePayload } from './check-eslint.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
}

// --- ratchet arithmetic ----------------------------------------------------------

const R = 'react-hooks/exhaustive-deps';

await test('an exact match passes', () => {
  const { grown, loosened } = ratchet({ [R]: { 'src/a.tsx': 2 } }, { [R]: { 'src/a.tsx': 2 } });
  assert.deepEqual([grown, loosened], [[], []]);
});

await test('a grown count fails', () => {
  const { grown } = ratchet({ [R]: { 'src/a.tsx': 3 } }, { [R]: { 'src/a.tsx': 2 } });
  assert.deepEqual(grown, [{ rule: R, file: 'src/a.tsx', have: 3, allowed: 2 }]);
});

await test('a warning in an unrecorded file fails', () => {
  const { grown } = ratchet({ [R]: { 'src/new.tsx': 1 } }, { [R]: { 'src/a.tsx': 1 } });
  assert.equal(grown.length, 1);
  assert.equal(grown[0].file, 'src/new.tsx');
  assert.equal(grown[0].allowed, 0);
});

await test('a warning from an unrecorded rule fails', () => {
  const { grown } = ratchet({ 'some/other-rule': { 'src/a.tsx': 1 } }, { [R]: { 'src/a.tsx': 1 } });
  assert.equal(grown.length, 1);
  assert.equal(grown[0].rule, 'some/other-rule');
});

await test('moving a warning between files is caught (per-file, not a global total)', () => {
  const { grown, loosened } = ratchet({ [R]: { 'src/a.tsx': 2 } }, { [R]: { 'src/a.tsx': 1, 'src/b.tsx': 1 } });
  assert.equal(grown.length, 1);
  assert.equal(loosened.length, 1);
});

await test('a count below its baseline is reported as loosened (the ratchet must be tightened)', () => {
  const { grown, loosened } = ratchet({ [R]: { 'src/a.tsx': 1 } }, { [R]: { 'src/a.tsx': 2, 'src/gone.tsx': 1 } });
  assert.deepEqual(grown, []);
  assert.deepEqual(loosened.map((l) => [l.file, l.have, l.allowed]), [['src/a.tsx', 1, 2], ['src/gone.tsx', 0, 1]]);
});

await test('summarize splits errors (and fatal parse errors) from per-file warning counts', () => {
  const results = [
    { filePath: 'A', messages: [{ ruleId: R, severity: 1, line: 1, column: 1, message: 'w' }, { ruleId: R, severity: 1, line: 2, column: 1, message: 'w' }] },
    { filePath: 'B', messages: [{ ruleId: null, severity: 2, fatal: true, line: 3, column: 1, message: 'Parsing error' }] },
  ];
  const { errors, warnings } = summarize(results, (f) => `src/${f}.tsx`);
  assert.deepEqual(warnings, { [R]: { 'src/A.tsx': 2 } });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, 'src/B.tsx');
  assert.equal(total(warnings), 2);
});

await test('the baseline payload is sorted and carries its total', () => {
  const p = baselinePayload({ [R]: { 'src/b.tsx': 1, 'src/a.tsx': 2 } });
  assert.equal(p.total, 3);
  assert.deepEqual(Object.keys(p.warnings[R]), ['src/a.tsx', 'src/b.tsx']);
});

// --- the real config ------------------------------------------------------------

const eslint = new ESLint({ cwd: REPO_ROOT });
async function lint(rel, code) {
  const [result] = await eslint.lintText(code, { filePath: path.join(REPO_ROOT, rel) });
  return result.messages.map((m) => ({ ruleId: m.ruleId, severity: m.severity, line: m.line, message: m.message }));
}
const ruleHits = (msgs, rule) => msgs.filter((m) => m.ruleId === rule);
const SRC = 'src/components/__eslint_fixture__/Fixture.tsx';

await test('the gate scope is src', () => {
  assert.ok(LINT_TARGETS.includes('src'));
});

await test('rules-of-hooks: a hook behind || is an error', async () => {
  const msgs = await lint(SRC, `
    import { useState } from 'react';
    function useA() { return useState(0)[0]; }
    function useB() { return useState(1)[0]; }
    export function Probe() {
      const v = useA() || useB();
      return <span>{v}</span>;
    }
  `);
  const hits = ruleHits(msgs, 'react-hooks/rules-of-hooks');
  assert.equal(hits.length, 1, JSON.stringify(msgs));
  assert.equal(hits[0].severity, 2);
  assert.match(hits[0].message, /useB/);
});

await test('rules-of-hooks: a hook after an early return is an error', async () => {
  const msgs = await lint(SRC, `
    import { useState } from 'react';
    export function Probe({ on }: { on: boolean }) {
      if (!on) return null;
      const [v] = useState(0);
      return <span>{v}</span>;
    }
  `);
  assert.equal(ruleHits(msgs, 'react-hooks/rules-of-hooks').length, 1, JSON.stringify(msgs));
});

await test('rules-of-hooks: hooks at the top level are clean', async () => {
  const msgs = await lint(SRC, `
    import { useState } from 'react';
    export function Probe({ on }: { on: boolean }) {
      const [v] = useState(0);
      if (!on) return null;
      return <span>{v}</span>;
    }
  `);
  assert.deepEqual(msgs, []);
});

await test('exhaustive-deps: a missing dependency is a warning, a complete list is clean', async () => {
  const missing = await lint(SRC, `
    import { useEffect } from 'react';
    export function Probe({ id }: { id: number }) {
      useEffect(() => { console.log(id); }, []);
      return null;
    }
  `);
  const hits = ruleHits(missing, 'react-hooks/exhaustive-deps');
  assert.equal(hits.length, 1, JSON.stringify(missing));
  assert.equal(hits[0].severity, 1);
  const complete = await lint(SRC, `
    import { useEffect } from 'react';
    export function Probe({ id }: { id: number }) {
      useEffect(() => { console.log(id); }, [id]);
      return null;
    }
  `);
  assert.deepEqual(complete, []);
});

await test('an unused eslint-disable directive is an error', async () => {
  const msgs = await lint(SRC, `
    import { useEffect } from 'react';
    export function Probe({ id }: { id: number }) {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- nothing to suppress here
      useEffect(() => { console.log(id); }, [id]);
      return null;
    }
  `);
  assert.equal(msgs.length, 1, JSON.stringify(msgs));
  assert.equal(msgs[0].severity, 2);
  assert.match(msgs[0].message, /Unused eslint-disable directive/);
});

await test('a directive naming a rule that is not loaded is an error', async () => {
  const msgs = await lint(SRC, `
    // eslint-disable-next-line react/no-danger
    export const x = 1;
  `);
  assert.equal(msgs.length, 1, JSON.stringify(msgs));
  assert.equal(msgs[0].severity, 2);
  assert.match(msgs[0].message, /Definition for rule 'react\/no-danger' was not found/);
});

await test('test files under src are in scope', async () => {
  const msgs = await lint('src/components/__eslint_fixture__/__tests__/Fixture.test.tsx', `
    import { useState } from 'react';
    export function Probe({ on }: { on: boolean }) {
      if (!on) return null;
      const [v] = useState(0);
      return <span>{v}</span>;
    }
  `);
  assert.equal(ruleHits(msgs, 'react-hooks/rules-of-hooks').length, 1, JSON.stringify(msgs));
});

await test('generated IPC types are ignored', async () => {
  assert.equal(await eslint.isPathIgnored(path.join(REPO_ROOT, 'src/types/ipc/Fixture.ts')), true);
  assert.equal(await eslint.isPathIgnored(path.join(REPO_ROOT, 'src/types/ipc.generated.ts')), true);
  assert.equal(await eslint.isPathIgnored(path.join(REPO_ROOT, 'src/types/project.ts')), false);
});

if (failures.length > 0) {
  console.error(`\n✗ check-eslint fixtures: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`✓ check-eslint fixtures: ${passed} passed`);
