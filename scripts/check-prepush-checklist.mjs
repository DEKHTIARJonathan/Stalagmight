// Pre-push checklist drift gate (#576 E6).
//
// The Pre-Push Checklist in CLAUDE.md (AGENTS.md is a symlink to it) is the
// list every contributor and agent runs before pushing. It is hand-written, and
// it has been re-synced with the workflows by hand at least four times; each
// time it had silently fallen behind (the release-profile `cargo check` that
// cost rc4 prep nine hours, #530, was missing from it). This gate makes the
// drift a CI failure instead of a surprise.
//
// WHAT IT CHECKS - every gate command a PR workflow runs (WORKFLOWS below) must
// appear in the checklist's ```bash block, after normalisation:
//   - `node scripts/X.mjs` counts as `pnpm <name>` when package.json maps a
//     script to exactly that command (CI calls the scripts directly where it
//     has no `pnpm install`, the checklist uses the pnpm names);
//   - `pnpm exec <cmd>` counts as `pnpm <name>` when a script is exactly
//     `<cmd>` (reporter flags dropped - they change output, not the verdict);
//   - cargo commands compare as a SET of flags, so argument order and a
//     leading `TELEMETRY_ENDPOINT=...` do not matter, but a missing `--locked`
//     or `--release` does;
//   - ALIASES covers the one command CI and a local shell spell differently.
// A step that runs no recognised gate command (apt installs, cache stats, a
// pure-shell check) must be classified in PLUMBING_STEPS or SHELL_GATE_STEPS,
// so a NEW shell-only gate cannot slip past by not looking like one. Rows in
// either table that match no step are themselves a failure (stale allowlist).
// The reverse direction is checked for names only: a `pnpm <script>` in the
// checklist that package.json does not define (a renamed script) fails too.
//
// WHAT IT DOES NOT CHECK - the hand-written comments, ordering, or commands the
// checklist adds on top of CI (e.g. the touched-specs Playwright line). The
// checklist may say MORE than CI; it may not say less.
//
// WHERE IT RUNS - the leak-scan workflow, the only one with no paths-ignore:
// `check` and `smoke` both ignore `**/*.md`, so a CLAUDE.md-only edit would
// never run a gate placed there. Pure Node, no dependencies (leak-scan has no
// `pnpm install`), so the YAML is read with a small line-based step parser
// that understands exactly the subset the workflows use (list-item steps with
// `name:` / `run:` keys, `run: |` block scalars).
//
// Usage:  node scripts/check-prepush-checklist.mjs   (or: pnpm lint:prepush-checklist)

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The workflows that gate a PR. release.yml's verify job repeats a subset of
// `check`, nightly-e2e.yml is the full Playwright suite (deliberately not a
// pre-push item, see the checklist's Playwright line) and agent-harness.yml is
// on-demand, so none of those define what a contributor must run.
export const WORKFLOWS = [
  '.github/workflows/ci.yml',
  '.github/workflows/e2e-smoke.yml',
  '.github/workflows/leak-scan.yml',
];
export const CHECKLIST_FILE = 'CLAUDE.md';
export const CHECKLIST_HEADING = '### Pre-Push Checklist';

// Gate commands that are CI plumbing, not something a contributor runs.
export const PLUMBING_COMMANDS = [
  { re: /^pnpm install(\s|$)/, why: 'dependency install' },
  { re: /^pnpm exec playwright install(-deps)?(\s|$)/, why: 'browser / system-dependency install' },
  { re: /^node scripts\/pw-timing-summary\.mjs(\s|$)/, why: 'run-page timing table; it cannot fail the job' },
];

// Steps that run no gate command at all, keyed by workflow + step name.
export const PLUMBING_STEPS = [
  { workflow: '.github/workflows/ci.yml', step: 'Install tauri apt deps (hosted only)', why: 'runner setup' },
  { workflow: '.github/workflows/ci.yml', step: 'sccache zero-stats (self-hosted only)', why: 'cache observability' },
  { workflow: '.github/workflows/ci.yml', step: 'sccache stats (self-hosted only)', why: 'cache observability' },
  { workflow: '.github/workflows/e2e-smoke.yml', step: 'Resolve Playwright version', why: 'browser-cache key' },
];

// Pure-shell gate steps, each paired with the checklist command that stands
// in for it locally.
export const SHELL_GATE_STEPS = [
  {
    workflow: '.github/workflows/ci.yml',
    step: 'ts-rs bindings tree matches the checkout',
    checklist: 'git status --porcelain src-tauri/bindings',
    why: 'the bindings tree is a side effect of cargo test; CI fails on modified or untracked files under it',
  },
];

// CI spelling -> checklist spelling, for commands that differ only because CI
// runs with CI=true.
export const ALIASES = [
  { ci: 'pnpm test', checklist: 'pnpm exec vitest run', why: 'vitest runs once under CI=true; locally `pnpm test` watches' },
];

// `git` counts so a checklist stand-in like `git status --porcelain <dir>` is a
// command, and a bare `git diff --exit-code` CI step would be a gate.
const GATE_TOOLS = new Set(['pnpm', 'node', 'npx', 'cargo', 'git']);
// Value-taking cargo flags, so `--manifest-path X` compares as one unit.
const CARGO_VALUE_FLAGS = new Set(['--manifest-path', '--features', '-p', '--package', '--target-dir', '--bin', '--example', '--test', '-F']);
// pnpm first words that are not package.json scripts (built-ins and the one
// binary the checklist calls through pnpm).
const PNPM_NON_SCRIPTS = new Set(['exec', 'install', 'run', 'dlx', 'tsc']);

// --- YAML step extraction ------------------------------------------------------

const indentOf = (line) => line.length - line.trimStart().length;

// Returns [{job, name, run, line}] for every list-item step that has `run:`.
// `name` falls back to the run body's first line for unnamed steps.
export function extractSteps(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const steps = [];
  let job = null;
  let inJobs = false;
  let cur = null;
  const flush = () => {
    if (cur && cur.run !== undefined) {
      steps.push({ job: cur.job, name: cur.name ?? cur.run.split('\n')[0].trim(), run: cur.run, line: cur.line });
    }
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const ind = indentOf(line);
    if (ind === 0) {
      flush();
      inJobs = /^jobs:\s*$/.test(line);
      continue;
    }
    if (inJobs && ind === 2 && /^\s{2}[\w-]+:\s*$/.test(line)) {
      flush();
      job = line.trim().slice(0, -1);
      continue;
    }
    const item = /^(\s*)-\s+(.*)$/.exec(line);
    let keyText = null;
    if (item) {
      if (cur && ind <= cur.dashIndent) flush();
      if (!cur) {
        cur = { job, dashIndent: ind, keyIndent: ind + 2, line: i + 1 };
        keyText = item[2];
      }
    } else if (cur && ind === cur.keyIndent) {
      keyText = line.trim();
    } else if (cur && ind <= cur.dashIndent) {
      flush();
    }
    if (keyText === null || !cur) continue;
    const kv = /^([\w-]+):\s?(.*)$/.exec(keyText);
    if (!kv) continue;
    const [, key, rawVal] = kv;
    const val = rawVal.trim();
    if (key === 'name' && cur.name === undefined) cur.name = unquote(val);
    if (key === 'run') {
      if (/^[|>][-+]?$/.test(val)) {
        const body = [];
        let j = i + 1;
        let blockIndent = null;
        for (; j < lines.length; j++) {
          const l = lines[j];
          if (!l.trim()) { body.push(''); continue; }
          const li = indentOf(l);
          if (li <= cur.keyIndent) break;
          if (blockIndent === null) blockIndent = li;
          body.push(l.slice(Math.min(li, blockIndent)));
        }
        cur.run = body.join('\n').replace(/\n+$/, '');
        i = j - 1;
      } else {
        cur.run = unquote(val);
      }
    }
  }
  flush();
  return steps;
}

function unquote(s) {
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) return s.slice(1, -1);
  return s;
}

// --- shell-ish splitting -------------------------------------------------------

// Split a run body / checklist block into logical commands: join `\` line
// continuations, drop `#` comments (outside quotes), and split at top-level
// `&&`, `||`, `;` and `|`. Quote- and `$(...)`-aware, nothing more.
export function splitCommands(body) {
  const joined = body.replace(/\\\r?\n/g, ' ');
  const out = [];
  for (const rawLine of joined.split(/\r?\n/)) {
    let cur = '';
    let quote = null;
    let depth = 0;
    const push = () => {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    };
    for (let i = 0; i < rawLine.length; i++) {
      const c = rawLine[i];
      const n = rawLine[i + 1];
      if (quote) {
        cur += c;
        if (c === '\\' && quote === '"') { cur += n ?? ''; i++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; continue; }
      if (c === '$' && n === '(') { depth++; cur += '$('; i++; continue; }
      if (depth > 0) {
        if (c === '(') depth++;
        if (c === ')') depth--;
        cur += c;
        continue;
      }
      if (c === '#' && (i === 0 || /\s/.test(rawLine[i - 1]))) break; // comment to end of line
      if ((c === '&' && n === '&') || (c === '|' && n === '|')) { push(); i++; continue; }
      if (c === ';' || c === '|') { push(); continue; }
      cur += c;
    }
    push();
  }
  return out;
}

// Whitespace tokenizer that keeps quoted strings and `$(...)` whole.
export function tokenize(cmd) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let depth = 0;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; continue; }
    if (c === '$' && cmd[i + 1] === '(') { depth++; cur += '$('; i++; continue; }
    if (depth > 0) { if (c === '(') depth++; if (c === ')') depth--; cur += c; continue; }
    if (/\s/.test(c)) { if (cur) tokens.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

// --- normalisation -------------------------------------------------------------

// Build the reverse map "exact script command" -> script name.
export function scriptIndex(packageJson) {
  const byCommand = new Map();
  for (const [name, cmd] of Object.entries(packageJson?.scripts ?? {})) {
    if (!byCommand.has(cmd)) byCommand.set(cmd, name);
  }
  return byCommand;
}

// Normalise one command to a comparison key, or null if it is not a gate
// command (shell control flow, echo, assignments, apt, ...).
export function normalize(cmd, byCommand) {
  let tokens = tokenize(cmd);
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift(); // env prefix
  while (tokens.length && ['do', 'then', 'else'].includes(tokens[0])) tokens.shift();
  if (tokens.length === 0) return null;
  const head = tokens[0];
  if (/^(\.\/)?scripts\/[\w.-]+\.(sh|mjs|js)$/.test(head)) {
    return [head.startsWith('./') ? head : `./${head}`, ...tokens.slice(1)].join(' ');
  }
  if (!GATE_TOOLS.has(head)) return null;
  if (head === 'cargo') {
    const sub = tokens[1] ?? '';
    const flags = [];
    const positional = [];
    for (let i = 2; i < tokens.length; i++) {
      const t = tokens[i];
      if (CARGO_VALUE_FLAGS.has(t) && i + 1 < tokens.length) { flags.push(`${t}=${tokens[++i]}`); continue; }
      if (t.startsWith('-')) flags.push(t);
      else positional.push(t);
    }
    return ['cargo', sub, ...flags.sort(), ...positional].join(' ');
  }
  if (head === 'node' && tokens.length === 2) {
    const name = byCommand.get(`node ${tokens[1]}`);
    if (name) return `pnpm ${name}`;
  }
  if (head === 'pnpm' && tokens[1] === 'run') tokens = ['pnpm', ...tokens.slice(2)];
  if (head === 'pnpm' && tokens[1] === 'exec') {
    const rest = tokens.slice(2).filter((t) => !t.startsWith('--reporter'));
    const name = byCommand.get(rest.join(' '));
    if (name) return `pnpm ${name}`;
    return ['pnpm', 'exec', ...rest].join(' ');
  }
  return tokens.join(' ');
}

// --- checklist parsing ---------------------------------------------------------

// Returns {commands: [{key, raw}], error}. The block is the first ```bash fence
// after CHECKLIST_HEADING.
export function parseChecklist(md, byCommand) {
  const lines = md.split(/\r?\n/);
  const h = lines.findIndex((l) => l.trim() === CHECKLIST_HEADING);
  if (h < 0) return { commands: [], error: `${CHECKLIST_FILE} has no "${CHECKLIST_HEADING}" heading` };
  const open = lines.findIndex((l, i) => i > h && /^```(bash|sh)?\s*$/.test(l.trim()));
  if (open < 0) return { commands: [], error: `no fenced code block after "${CHECKLIST_HEADING}"` };
  const close = lines.findIndex((l, i) => i > open && l.trim() === '```');
  if (close < 0) return { commands: [], error: `unterminated code block after "${CHECKLIST_HEADING}"` };
  const commands = [];
  for (const raw of splitCommands(lines.slice(open + 1, close).join('\n'))) {
    const key = normalize(raw, byCommand);
    if (key !== null) commands.push({ key, raw });
  }
  if (commands.length === 0) return { commands, error: `the checklist block under "${CHECKLIST_HEADING}" has no commands` };
  return { commands, error: null };
}

// --- the check -----------------------------------------------------------------

// `read(rel)` returns file text or throws. `opts` overrides the tables (the
// fixture test drives small synthetic workflows). Returns {problems, gates}.
export function checkDrift(read, opts = {}) {
  const {
    workflows = WORKFLOWS,
    plumbingSteps = PLUMBING_STEPS,
    shellGateSteps = SHELL_GATE_STEPS,
    aliases = ALIASES,
  } = opts;
  const problems = [];
  let packageJson;
  try {
    packageJson = JSON.parse(read('package.json'));
  } catch (e) {
    return { problems: [`package.json unreadable: ${e.message}`], gates: 0 };
  }
  const byCommand = scriptIndex(packageJson);
  let md;
  try {
    md = read(CHECKLIST_FILE);
  } catch (e) {
    return { problems: [`${CHECKLIST_FILE} unreadable: ${e.message}`], gates: 0 };
  }
  const checklist = parseChecklist(md, byCommand);
  if (checklist.error) return { problems: [checklist.error], gates: 0 };
  const have = new Set(checklist.commands.map((c) => c.key));
  const aliasOf = new Map(aliases.map((a) => [normalize(a.ci, byCommand), normalize(a.checklist, byCommand)]));
  const usedPlumbing = new Set();
  const usedShell = new Set();
  let gates = 0;

  for (const wf of workflows) {
    let text;
    try {
      text = read(wf);
    } catch (e) {
      problems.push(`${wf} unreadable: ${e.message}`);
      continue;
    }
    const steps = extractSteps(text);
    if (steps.length === 0) {
      problems.push(`${wf}: no run steps found - the step parser no longer understands this file`);
      continue;
    }
    for (const step of steps) {
      const where = `${wf} (${step.job ?? '?'}) step "${step.name}"`;
      const shell = shellGateSteps.find((s) => s.workflow === wf && s.step === step.name);
      if (shell) {
        usedShell.add(shell);
        gates++;
        if (!have.has(normalize(shell.checklist, byCommand))) {
          problems.push(`${where} is a shell gate; the checklist must carry: ${shell.checklist}`);
        }
        continue;
      }
      const cmds = splitCommands(step.run)
        .map((raw) => ({ raw, key: normalize(raw, byCommand) }))
        .filter((c) => c.key !== null);
      if (cmds.length === 0) {
        const plumbing = plumbingSteps.find((s) => s.workflow === wf && s.step === step.name);
        if (plumbing) usedPlumbing.add(plumbing);
        else problems.push(`${where} runs no recognised gate command - classify it in PLUMBING_STEPS or SHELL_GATE_STEPS (scripts/check-prepush-checklist.mjs)`);
        continue;
      }
      for (const c of cmds) {
        if (PLUMBING_COMMANDS.some((p) => p.re.test(c.key) || p.re.test(c.raw))) continue;
        gates++;
        const key = aliasOf.get(c.key) ?? c.key;
        if (!have.has(key)) problems.push(`missing from the checklist: ${key}   (CI: ${where}: ${c.raw})`);
      }
    }
  }
  for (const s of plumbingSteps) if (!usedPlumbing.has(s)) problems.push(`stale PLUMBING_STEPS row: ${s.workflow} step "${s.step}" no longer exists`);
  for (const s of shellGateSteps) if (!usedShell.has(s)) problems.push(`stale SHELL_GATE_STEPS row: ${s.workflow} step "${s.step}" no longer exists`);

  const scripts = packageJson.scripts ?? {};
  for (const c of checklist.commands) {
    const t = tokenize(c.key);
    if (t[0] === 'pnpm' && t[1] && !PNPM_NON_SCRIPTS.has(t[1]) && !(t[1] in scripts)) {
      problems.push(`the checklist runs "pnpm ${t[1]}", which package.json does not define (renamed or removed?)`);
    }
  }
  return { problems, gates };
}

export function main(read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')) {
  const { problems, gates } = checkDrift(read);
  if (problems.length === 0) {
    console.log(`✓ pre-push checklist: all ${gates} CI gate commands in ${WORKFLOWS.length} workflows are in ${CHECKLIST_FILE}.`);
    return 0;
  }
  console.error(`\n✗ pre-push checklist drift - ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    `\nAdd the command to the "${CHECKLIST_HEADING}" block in ${CHECKLIST_FILE} (CI's gates are the\n` +
      'floor of that list), or classify a non-gate step in scripts/check-prepush-checklist.mjs.\n',
  );
  return 1;
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) process.exit(main());
