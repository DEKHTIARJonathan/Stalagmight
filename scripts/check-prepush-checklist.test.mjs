// Fixture tests for the pre-push checklist drift gate (scripts/check-prepush-checklist.mjs).
//
// A drift gate that never fires proves nothing, so each normalisation rule is
// pinned with a synthetic workflow + checklist pair that MUST fail, next to the
// matching pair that must pass. The reader is injected, so no case touches the
// real tree except the last one, which runs the gate on the live repo.
//
// Pure Node, no test framework (mirrors scripts/check-no-em-dash.test.mjs).
// Run: node scripts/check-prepush-checklist.test.mjs  (also a CI leak-scan step).

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  checkDrift, extractSteps, splitCommands, normalize, scriptIndex, parseChecklist, REPO_ROOT,
  PLUMBING_STEPS, SHELL_GATE_STEPS,
} from './check-prepush-checklist.mjs';

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

const WF = '.github/workflows/fixture.yml';
const PKG = JSON.stringify({
  scripts: {
    'lint:foo': 'node scripts/check-foo.mjs',
    'lint:foo:test': 'node scripts/check-foo.test.mjs',
    'test:ui:smoke': 'playwright test --grep @smoke',
    'typecheck:agent': 'tsc -p tsconfig.agent.json',
    test: 'vitest',
  },
});

const workflow = (steps) => `name: Fixture
on:
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
${steps}
`;
const checklist = (lines) => `# Rules

### Pre-Push Checklist

All must pass before pushing:

\`\`\`bash
${lines.join('\n')}
\`\`\`

Prose after the block.
`;

// Run the gate over an in-memory tree with empty plumbing/shell tables unless
// a case passes its own.
function run(files, opts = {}) {
  const tree = { 'package.json': PKG, ...files };
  const read = (rel) => {
    if (!(rel in tree)) throw Object.assign(new Error(`ENOENT ${rel}`), { code: 'ENOENT' });
    return tree[rel];
  };
  return checkDrift(read, { workflows: [WF], plumbingSteps: [], shellGateSteps: [], aliases: [], ...opts });
}

// --- the gate fires on a missing command -----------------------------------------

test('a CI gate command that the checklist lacks fails and is named', () => {
  const r = run({
    [WF]: workflow('      - run: pnpm lint:foo\n      - run: pnpm typecheck:agent'),
    'CLAUDE.md': checklist(['pnpm lint:foo']),
  });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /missing from the checklist: pnpm typecheck:agent/);
});

test('the same pair passes once the checklist carries the command', () => {
  const r = run({
    [WF]: workflow('      - run: pnpm lint:foo\n      - run: pnpm typecheck:agent'),
    'CLAUDE.md': checklist(['pnpm lint:foo', 'pnpm typecheck:agent   # trailing comment is fine']),
  });
  assert.deepEqual(r.problems, []);
  assert.equal(r.gates, 2);
});

test('a :test sibling CI runs first is required too (the drift E6 found)', () => {
  const steps = '      - name: Foo\n        run: |\n          pnpm lint:foo:test\n          pnpm lint:foo';
  const r = run({ [WF]: workflow(steps), 'CLAUDE.md': checklist(['pnpm lint:foo']) });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /pnpm lint:foo:test/);
  assert.deepEqual(run({ [WF]: workflow(steps), 'CLAUDE.md': checklist(['pnpm lint:foo:test && pnpm lint:foo']) }).problems, []);
});

test('a command named only in a checklist COMMENT does not count', () => {
  const r = run({
    [WF]: workflow('      - run: pnpm lint:foo'),
    'CLAUDE.md': checklist(['pnpm tsc --noEmit   # and pnpm lint:foo']),
  });
  assert.equal(r.problems.length, 1);
});

// --- normalisation ------------------------------------------------------------------

test('`node scripts/X.mjs` in CI matches the pnpm script name in the checklist', () => {
  const r = run({
    [WF]: workflow('      - run: node scripts/check-foo.test.mjs\n      - run: node scripts/check-foo.mjs'),
    'CLAUDE.md': checklist(['pnpm lint:foo:test && pnpm lint:foo']),
  });
  assert.deepEqual(r.problems, []);
});

test('`pnpm exec playwright test --grep @smoke --reporter=...` is `pnpm test:ui:smoke`', () => {
  const steps = '      - run: pnpm exec playwright test --grep @smoke --reporter=github,./scripts/x.mjs';
  assert.deepEqual(run({ [WF]: workflow(steps), 'CLAUDE.md': checklist(['pnpm test:ui:smoke']) }).problems, []);
  const bare = run({ [WF]: workflow(steps), 'CLAUDE.md': checklist(['pnpm exec playwright test']) });
  assert.match(bare.problems[0], /pnpm test:ui:smoke/);
});

test('cargo flags compare as a set: order and an env prefix do not matter', () => {
  const steps = '      - run: cargo clippy --workspace --manifest-path src-tauri/Cargo.toml --features telemetry --all-targets\n'
    + '        env:\n          TELEMETRY_ENDPOINT: "https://test.invalid"';
  const line = 'TELEMETRY_ENDPOINT=http://localhost/dummy cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features telemetry --workspace';
  assert.deepEqual(run({ [WF]: workflow(steps), 'CLAUDE.md': checklist([line]) }).problems, []);
});

test('a cargo flag CI passes and the checklist omits (--locked, --release) fails', () => {
  const locked = '      - run: cargo test --locked --manifest-path vendor/x/Cargo.toml';
  assert.equal(run({ [WF]: workflow(locked), 'CLAUDE.md': checklist(['cargo test --manifest-path vendor/x/Cargo.toml']) }).problems.length, 1);
  const release = '      - run: cargo check --release --workspace --manifest-path src-tauri/Cargo.toml';
  assert.equal(run({ [WF]: workflow(release), 'CLAUDE.md': checklist(['cargo check --workspace --manifest-path src-tauri/Cargo.toml']) }).problems.length, 1);
});

test('a for-loop body in the checklist matches the loop body CI runs', () => {
  const steps = '      - name: fmt\n        run: |\n          for m in crates/*/Cargo.toml; do\n            [ -e "$m" ] || continue\n'
    + '            cargo fmt --manifest-path "$m" --check\n          done';
  const r = run({ [WF]: workflow(steps), 'CLAUDE.md': checklist(['for m in crates/*/Cargo.toml; do cargo fmt --manifest-path "$m" --check; done']) });
  assert.deepEqual(r.problems, []);
});

test('an alias row maps the CI spelling to the local one', () => {
  const opts = { aliases: [{ ci: 'pnpm test', checklist: 'pnpm exec vitest run', why: 'x' }] };
  assert.deepEqual(run({ [WF]: workflow('      - run: pnpm test'), 'CLAUDE.md': checklist(['pnpm exec vitest run']) }, opts).problems, []);
  assert.equal(run({ [WF]: workflow('      - run: pnpm test'), 'CLAUDE.md': checklist(['pnpm exec vitest run']) }).problems.length, 1);
});

test('plumbing commands (pnpm install, playwright install) are not gates', () => {
  const steps = '      - run: pnpm install --frozen-lockfile\n      - run: pnpm exec playwright install --with-deps chromium';
  const r = run({ [WF]: workflow(steps), 'CLAUDE.md': checklist(['pnpm tsc --noEmit']) });
  assert.deepEqual(r.problems, []);
  assert.equal(r.gates, 0);
});

// --- steps that run no recognised gate command ------------------------------------------

const SHELL_STEP = '      - name: Bindings clean\n        run: |\n          if ! git diff --exit-code bindings; then\n            exit 1\n          fi';

test('a pure-shell step nobody classified fails (a new shell gate cannot hide)', () => {
  const r = run({ [WF]: workflow(SHELL_STEP), 'CLAUDE.md': checklist(['pnpm tsc --noEmit']) });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /runs no recognised gate command/);
});

test('a PLUMBING_STEPS row clears it; a SHELL_GATE_STEPS row demands its checklist command', () => {
  const plumbing = { plumbingSteps: [{ workflow: WF, step: 'Bindings clean', why: 'x' }] };
  assert.deepEqual(run({ [WF]: workflow(SHELL_STEP), 'CLAUDE.md': checklist(['pnpm tsc --noEmit']) }, plumbing).problems, []);
  const shell = { shellGateSteps: [{ workflow: WF, step: 'Bindings clean', checklist: 'git status --porcelain bindings', why: 'x' }] };
  assert.match(run({ [WF]: workflow(SHELL_STEP), 'CLAUDE.md': checklist(['pnpm tsc --noEmit']) }, shell).problems[0], /git status --porcelain bindings/);
  assert.deepEqual(run({ [WF]: workflow(SHELL_STEP), 'CLAUDE.md': checklist(['git status --porcelain bindings']) }, shell).problems, []);
});

test('a classification row whose step no longer exists is reported stale', () => {
  const opts = { plumbingSteps: [{ workflow: WF, step: 'Renamed away', why: 'x' }] };
  const r = run({ [WF]: workflow('      - run: pnpm lint:foo'), 'CLAUDE.md': checklist(['pnpm lint:foo']) }, opts);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /stale PLUMBING_STEPS row/);
});

// --- reverse direction: checklist names a script package.json does not define -------------

test('a checklist `pnpm <script>` that package.json lacks fails (renamed script)', () => {
  const r = run({ [WF]: workflow('      - run: pnpm lint:foo'), 'CLAUDE.md': checklist(['pnpm lint:foo', 'pnpm lint:pw-timing:test']) });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /"pnpm lint:pw-timing:test"/);
});

// --- fail closed ------------------------------------------------------------------------------

test('no checklist heading, no code block, or an empty block each fail', () => {
  const wf = { [WF]: workflow('      - run: pnpm lint:foo') };
  assert.match(run({ ...wf, 'CLAUDE.md': '# nothing here\n' }).problems[0], /no "### Pre-Push Checklist" heading/);
  assert.match(run({ ...wf, 'CLAUDE.md': '### Pre-Push Checklist\n\njust prose\n' }).problems[0], /no fenced code block/);
  assert.match(run({ ...wf, 'CLAUDE.md': checklist(['# only a comment']) }).problems[0], /has no commands/);
});

test('a missing workflow file or one the parser reads no steps from fails', () => {
  assert.match(run({ 'CLAUDE.md': checklist(['pnpm lint:foo']) }).problems[0], /unreadable/);
  assert.match(run({ [WF]: 'name: x\n', 'CLAUDE.md': checklist(['pnpm lint:foo']) }).problems[0], /no run steps found/);
});

// --- parser units -----------------------------------------------------------------------------

test('extractSteps reads named, unnamed and block-scalar run steps with their job', () => {
  const steps = extractSteps(workflow('      - name: A\n        run: |\n          one\n          two\n      - run: three\n        env:\n          X: y'));
  assert.deepEqual(steps.map((s) => [s.job, s.name, s.run]), [['check', 'A', 'one\ntwo'], ['check', 'three', 'three']]);
});

test('splitCommands keeps quoted separators and $(...) together', () => {
  assert.deepEqual(splitCommands('a && b || c; d | e'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(splitCommands('echo "x && y" && z'), ['echo "x && y"', 'z']);
  assert.deepEqual(splitCommands('v=$(p | q) && r'), ['v=$(p | q)', 'r']);
  assert.deepEqual(splitCommands('one \\\n  two'), ['one    two']);
});

test('normalize ignores shell plumbing and assignments', () => {
  const by = scriptIndex(JSON.parse(PKG));
  for (const c of ['echo hi', 'if [ -n "$x" ]', 'fi', 'untracked=$(git ls-files x)', 'sudo apt-get install y', 'exit 1']) {
    assert.equal(normalize(c, by), null, c);
  }
  assert.equal(normalize('./scripts/test-release.sh', by), './scripts/test-release.sh');
});

test('parseChecklist only reads the block under the heading', () => {
  const md = `\`\`\`bash\npnpm before-heading\n\`\`\`\n${checklist(['pnpm lint:foo'])}\n\`\`\`bash\npnpm after-block\n\`\`\`\n`;
  const r = parseChecklist(md, new Map());
  assert.deepEqual(r.commands.map((c) => c.key), ['pnpm lint:foo']);
});

// --- the live repo -------------------------------------------------------------------------------

test('the live tree passes: every CI gate is in the CLAUDE.md checklist', () => {
  const r = checkDrift((rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
  assert.deepEqual(r.problems, []);
  assert.ok(r.gates >= 25, `only ${r.gates} gates seen - the parser stopped reading a workflow?`);
});

test('every live classification row carries a written reason', () => {
  for (const row of [...PLUMBING_STEPS, ...SHELL_GATE_STEPS]) assert.ok(row.why && row.why.trim(), row.step);
});

// --- report -------------------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`✗ check-prepush-checklist.test: ${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ check-prepush-checklist.test: ${passed} checks passed.`);
