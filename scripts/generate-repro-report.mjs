// Turn an agent session into a paste-ready repro report (report.md in the
// session dir). Aggregates the action log, oracle findings, and evidence paths
// into a bug-report skeleton. Absolute $HOME-bearing paths are rewritten to
// artifact-relative / $HOME placeholders because reports get pasted into public
// GitHub issues.
//
// Usage:
//   node scripts/generate-repro-report.mjs <sessionDir> [--title "..."] [--summary "..."]
//
// Then (after human review) file it:
//   gh issue create --title "..." --body-file <sessionDir>/report.md

import * as fs from 'fs';
import * as path from 'path';

const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith('--')) {
  process.stderr.write('usage: node scripts/generate-repro-report.mjs <sessionDir> [--title ...] [--summary ...]\n');
  process.exit(2);
}
const sessionDir = args[0];
const getFlag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const jsonlPath = path.join(sessionDir, 'actions.jsonl');
if (!fs.existsSync(jsonlPath)) {
  process.stderr.write(`no actions.jsonl at ${jsonlPath}\n`);
  process.exit(1);
}

const home = process.env.HOME || '';
const absSession = path.resolve(sessionDir);
const scrub = (s) => {
  if (typeof s !== 'string') return s;
  let out = s;
  if (absSession) out = out.split(absSession).join('<artifacts>');
  if (home) out = out.split(home).join('$HOME');
  return out;
};

const records = fs
  .readFileSync(jsonlPath, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const start = records.find((r) => r.type === 'session-start') ?? {};
const end = records.find((r) => r.type === 'session-end');
const actions = records.filter((r) => r.type === 'action');
const findingEvents = records.filter((r) => r.type === 'event' && r.event === 'finding');

// Findings captured to disk (finding.json under findings/*/).
const findingsDir = path.join(sessionDir, 'findings');
let capturedFindings = [];
try {
  capturedFindings = fs
    .readdirSync(findingsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const fp = path.join(findingsDir, e.name, 'finding.json');
      try {
        return { dir: e.name, ...JSON.parse(fs.readFileSync(fp, 'utf8')) };
      } catch {
        return { dir: e.name };
      }
    });
} catch {
  // No findings dir.
}

let version = '?';
try {
  version = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version;
} catch {
  // Best-effort.
}

const title = getFlag('--title') || `Agent-found issue in session ${start.sessionId ?? path.basename(sessionDir)}`;
const summary = getFlag('--summary') || '_Describe the bug in one or two sentences._';

// Compact step list: mutating actions only.
const MUTATING = new Set(['click', 'type_text', 'press_keys', 'eval', 'ipc', 'store_action', 'map_click', 'map_view']);
const steps = actions
  .filter((a) => MUTATING.has(a.tool))
  .map((a) => {
    const detail = describeAction(a);
    const flag = a.outcome?.ok === false ? ' **(failed)**' : '';
    return `${a.seq}. \`${a.tool}\` ${detail}${flag}`;
  });

const md = [];
const P = (s = '') => md.push(s);

P(`# ${title}`);
P('');
P(summary);
P('');
P('## Environment');
P('');
P(`- Commit: \`${start.gitHead ?? '?'}\``);
P(`- App version: \`${version}\``);
P(`- Platform: \`${process.platform}\``);
P(`- Display: \`${start.display ?? '?'}\`  headed: \`${Boolean(start.headed)}\``);
P(`- Fresh profile: \`${Boolean(start.freshProfile)}\``);
P(`- Session: \`${start.sessionId ?? path.basename(sessionDir)}\`  actions: \`${end?.actions ?? actions.length}\``);
P('');
P('## Steps to reproduce');
P('');
if (steps.length) steps.forEach((s) => P(scrub(s)));
else P('_No mutating actions recorded._');
P('');
P('Automated replay (regenerate + run):');
P('');
P('```bash');
P(`node scripts/generate-replay.mjs <artifacts>`);
P('REPLAY_SPEC=<artifacts>/replay.spec.ts pnpm test:e2e:replay');
P('```');
P('');
P('## Expected vs actual');
P('');
P('- Expected: _what should have happened._');
P('- Actual: _what happened (see findings below)._');
P('');
P('## Oracle findings');
P('');
const allFindings = capturedFindings.length ? capturedFindings : findingEvents.map((e) => e.detail);
if (allFindings.length) {
  for (const f of allFindings) {
    if (!f) continue;
    P(`- **[${f.severity ?? '?'}] ${f.kind ?? '?'}** ${scrub(f.message ?? '')}`);
    if (f.detail !== undefined) {
      P('  ```json');
      P('  ' + scrub(JSON.stringify(f.detail, null, 2)).split('\n').join('\n  '));
      P('  ```');
    }
    if (f.dir) P(`  evidence: \`findings/${f.dir}/\``);
  }
} else {
  P('_No findings recorded (add the failure detail manually)._');
}
P('');
P('## Evidence');
P('');
P('- Action log: `actions.jsonl`');
P('- Screenshots: `screenshots/`');
if (capturedFindings.length) P('- Findings (screenshot + finding.json + crash markers): `findings/`');
P('- Driver log: `tauri-driver.log`');
P('');
P('## Notes');
P('');
P('_Paths above are relative to the session artifact directory. Attach it or the relevant files when filing._');
P('');

const outPath = path.join(sessionDir, 'report.md');
fs.writeFileSync(outPath, md.join('\n'));
process.stdout.write(`wrote ${outPath}\n`);

function describeAction(a) {
  const p = a.params ?? {};
  switch (a.tool) {
    case 'click':
    case 'map_click':
      return p.testid ? `testid=${p.testid}` : p.selector ? `selector=${p.selector}` : p.lngLat ? `lngLat=${JSON.stringify(p.lngLat)}` : `coords=(${p.x},${p.y})`;
    case 'type_text':
      return `"${String(p.text ?? '').slice(0, 40)}"${p.testid ? ` into ${p.testid}` : ''}`;
    case 'press_keys':
      return JSON.stringify(p.keys ?? []);
    case 'eval':
      return `\`${String(p.script ?? '').slice(0, 60).replace(/\n/g, ' ')}\``;
    case 'ipc':
      return `${p.command}(${JSON.stringify(p.args ?? {})})`;
    case 'store_action':
      return `${p.store}.${p.action}(${JSON.stringify(p.args ?? [])})`;
    case 'map_view':
      return p.set ? JSON.stringify(p.set) : 'read';
    default:
      return '';
  }
}
