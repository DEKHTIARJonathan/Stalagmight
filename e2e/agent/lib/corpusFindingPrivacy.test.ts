/**
 * #576 RV12-F1: a corpus file that fails to import names nothing in what a run
 * leaves behind.
 *
 * The backend logs a failed parse with the path it was handed - the copy of the
 * corpus entry, real names and all - and the oracle sweep turns that log line
 * into a `log-error` finding whose message IS the line. The sweep recorded it to
 * the session's action log and `findings/<n>/finding.json` as it came, and the
 * repro report printed it with only the session folder and $HOME folded, so a
 * corpus run's report quoted the private file name. The MCP server's error
 * outcome in the action log did the same for a thrown message.
 *
 * Everything here is synthetic: a token-named corpus entry built in a temp
 * directory, and the log line the backend writes for it.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CORPUS_DIR_ENV,
  corpusEntryFor,
  discoverCorpus,
  materializeCorpusEntry,
  publishableErrorMessage,
  registerCorpusRedactions,
} from './fixtureCorpus';
import { newOracleState, runSweep, type OracleTarget } from './oracles';
import { Recorder } from './recorder';

const MARK = 'qzmarkname';
const TRIP = `${MARK}-trip`;
const FILE = `${MARK}-broken.dmp`;
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

let scratch = '';
let sessionsRoot = '';
let copyPath = '';
const savedCorpusDir = process.env[CORPUS_DIR_ENV];

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-corpus-finding-'));
  const corpusRoot = path.join(scratch, 'corpus');
  sessionsRoot = path.join(scratch, 'sessions');
  fs.mkdirSync(path.join(corpusRoot, TRIP), { recursive: true });
  // Not a dump: the parser refuses it, which is what makes the backend log it.
  fs.writeFileSync(path.join(corpusRoot, TRIP, FILE), 'not an mnemo dump\n');
  process.env[CORPUS_DIR_ENV] = corpusRoot;
  const inventory = discoverCorpus();
  const relPath = inventory.entries[0]?.relPath ?? '';
  const entry = corpusEntryFor(relPath);
  if (entry === null) throw new Error('the synthetic corpus entry was not discovered');
  // Materialized and registered exactly as the import-dialog fuzzer does it.
  const destination = path.join(sessionsRoot, 'run-1', 'fuzz-files', 'corpus-0');
  const copied = materializeCorpusEntry(entry, destination);
  registerCorpusRedactions(entry.id, destination, copied.names);
  copyPath = copied.path;
});

afterAll(() => {
  if (savedCorpusDir === undefined) delete process.env[CORPUS_DIR_ENV];
  else process.env[CORPUS_DIR_ENV] = savedCorpusDir;
  fs.rmSync(scratch, { recursive: true, force: true });
});

/**
 * A webview whose log ring holds the backend's line for the failed parse
 * (`commands/import.rs`, `tracing::error!(path = ?path, ...)`), and no error
 * boundary. `invokeInApp` passes the command name first; `evalInApp` passes its
 * argument array.
 */
function webviewLogging(line: string): OracleTarget {
  const browser = {
    executeAsync: async (_fn: unknown, first: unknown) => {
      if (first === 'get_recent_logs_since') {
        return { value: { entries: [{ seq: 1, ts_ms: 0, line }], latest_seq: 1, dropped: false } };
      }
      return { value: { errorBoundary: false } };
    },
    takeScreenshot: async () => {
      throw new Error('no screen in a unit test');
    },
  };
  return {
    browser: browser as unknown as OracleTarget['browser'],
    exclusive: (fn) => fn(),
    findCrashMarkers: () => [],
  };
}

/** Every file under `dir`, as text. */
function allText(dir: string): string {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => fs.readFileSync(path.join(e.parentPath, e.name), 'utf8'))
    .join('\n');
}

describe('a corpus file that fails to import names nothing a run leaves behind (#576 RV12-F1)', () => {
  it('keeps the name out of the findings, the action log, finding.json and the repro report', async () => {
    const line = `ERROR stalagmight_lib::commands::import: Failed to parse DMP file for import preview path="${copyPath}" reason="not a dump"`;
    expect(line).toContain(MARK); // the input really does carry the name
    const recorder = new Recorder('run-1', sessionsRoot);
    const sweep = await runSweep(webviewLogging(line), newOracleState(), { recorder });

    // The finding is still there, and still says which entry failed.
    expect(sweep.newFindings.map((f) => f.kind)).toEqual(['log-error']);
    expect(sweep.newFindings[0]?.message).toContain('<corpus #');
    expect(JSON.stringify(sweep)).not.toContain(MARK);

    const session = path.join(sessionsRoot, 'run-1');
    const report = execFileSync('node', [path.join(REPO, 'scripts', 'generate-repro-report.mjs'), session], {
      encoding: 'utf8',
    });
    expect(fs.readFileSync(path.join(session, 'actions.jsonl'), 'utf8')).toContain('"finding"');
    expect(fs.readFileSync(path.join(session, 'report.md'), 'utf8')).toContain('log-error');
    // The action log, finding.json, report.md - nothing outside the copy itself.
    expect(allText(path.join(session, 'findings')) + fs.readFileSync(path.join(session, 'actions.jsonl'), 'utf8')).not.toContain(MARK);
    expect(fs.readFileSync(path.join(session, 'report.md'), 'utf8')).not.toContain(MARK);
    expect(report).not.toContain(MARK);
  });

  it('keeps the name out of a crash marker copied into a finding (#576 NF-W17-2)', async () => {
    const markerDir = path.join(scratch, 'markers');
    fs.mkdirSync(markerDir, { recursive: true });
    const marker = path.join(markerDir, 'panic.log');
    fs.writeFileSync(marker, `thread 'main' panicked: could not read ${copyPath}\n`);
    const target: OracleTarget = { ...webviewLogging('INFO nothing to see'), findCrashMarkers: () => [marker] };
    const recorder = new Recorder('run-markers', sessionsRoot);
    await runSweep(target, newOracleState(), { recorder });

    const findings = path.join(sessionsRoot, 'run-markers', 'findings');
    const copied = fs
      .readdirSync(findings, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name === 'panic.log');
    expect(copied.length).toBeGreaterThan(0); // the marker really was copied
    expect(allText(findings)).toContain('<corpus #');
    expect(allText(findings)).not.toContain(MARK);
  });

  /**
   * #576 RV15-1: a marker is serde_json text, where a quote in a name reads `\"`
   * and a backslash `\\`. Folding the TEXT never found such a name, in the copied
   * marker or in the finding's detail (the parsed marker, folded over its JSON
   * text too), and report.md prints the detail.
   */
  it.each([
    ['a quote', 'rv15q', 'qzrv15q "quoted" trip.dmp', 'qzrv15q'],
    ['a backslash', 'rv15b', 'qzrv15b back\\slash trip.dmp', 'qzrv15b'],
  ])('keeps a name with %s out of a copied crash marker, finding.json and report.md (#576 RV15-1)', async (_what, id, name, token) => {
    // A copy directory the report's own path fold does not recognise, so only
    // the corpus fold can keep the name out.
    const destination = path.join(scratch, 'copies', id);
    registerCorpusRedactions(id, destination, [name]);
    const markerDir = path.join(scratch, `markers-${id}`);
    fs.mkdirSync(markerDir, { recursive: true });
    const marker = path.join(markerDir, 'crash-1-2-0.json');
    const payload = { message: `could not read ${path.join(destination, name)}`, location: 'src/lib.rs:1:1' };
    fs.writeFileSync(marker, JSON.stringify(payload, null, 2));
    expect(fs.readFileSync(marker, 'utf8')).not.toContain(name); // the marker text escapes the name
    const target: OracleTarget = { ...webviewLogging('INFO nothing to see'), findCrashMarkers: () => [marker] };
    const session = path.join(sessionsRoot, `run-${id}`);
    const recorder = new Recorder(`run-${id}`, sessionsRoot);
    const sweep = await runSweep(target, newOracleState(), { recorder });
    execFileSync('node', [path.join(REPO, 'scripts', 'generate-repro-report.mjs'), session], { encoding: 'utf8' });

    expect(sweep.newFindings.map((f) => f.kind)).toEqual(['crash-marker']);
    const finding = fs.readFileSync(path.join(session, 'findings', '001', 'finding.json'), 'utf8');
    const copied = fs.readFileSync(path.join(session, 'findings', '001', 'crash-1-2-0.json'), 'utf8');
    const report = fs.readFileSync(path.join(session, 'report.md'), 'utf8');
    // Where the name still is, all at once.
    const leaks = { marker: copied.includes(token), findingJson: finding.includes(token), reportMd: report.includes(token) };
    expect(leaks).toEqual({ marker: false, findingJson: false, reportMd: false });
    // Still a readable marker and finding, naming the entry by its tag.
    expect(JSON.parse(copied)).toEqual({ message: `could not read <corpus #${id}>/<corpus #${id}>/file`, location: 'src/lib.rs:1:1' });
    expect(finding).toContain(`<corpus #${id}>`);
    expect(report).toContain('crash-marker');
  });

  it('withholds a torn crash marker that may hide an escaped name (#576 RV15-1)', async () => {
    const id = 'rv15t';
    const name = 'qzrv15t "torn" trip.dmp';
    const destination = path.join(scratch, 'copies', id);
    registerCorpusRedactions(id, destination, [name]);
    const markerDir = path.join(scratch, `markers-${id}`);
    fs.mkdirSync(markerDir, { recursive: true });
    const marker = path.join(markerDir, 'crash-3-4-0.json');
    // A marker cut off mid-write: not JSON, but escaped as JSON.
    const whole = JSON.stringify({ message: `could not read ${path.join(destination, name)}`, location: 'src/lib.rs:1:1' });
    fs.writeFileSync(marker, whole.slice(0, whole.indexOf('location')));
    const target: OracleTarget = { ...webviewLogging('INFO nothing to see'), findCrashMarkers: () => [marker] };
    const recorder = new Recorder(`run-${id}`, sessionsRoot);
    await runSweep(target, newOracleState(), { recorder });

    const copied = fs.readFileSync(path.join(sessionsRoot, `run-${id}`, 'findings', '001', 'crash-3-4-0.json'), 'utf8');
    expect(copied).toContain('withheld');
    expect(copied).not.toContain('qzrv15t');
  });

  it('keeps the name out of an MCP error outcome', () => {
    const message = publishableErrorMessage(new Error(`import failed: no sections in ${copyPath}`));
    expect(message).toContain('<corpus #');
    expect(message).not.toContain(MARK);
    // The MCP server words every error it records or returns through it.
    const server = fs.readFileSync(path.join(REPO, 'e2e', 'agent', 'mcp', 'server.ts'), 'utf8');
    expect(server).toMatch(/function asMessage\(err: unknown\): string \{\s*return publishableErrorMessage\(err\);\s*\}/);
  });

  it('folds a corpus copy path the run did not register, in a report of an older action log', () => {
    const session = path.join(sessionsRoot, 'older');
    fs.mkdirSync(session, { recursive: true });
    const quoted = `${session}/fuzz-files/corpus-7/${MARK} north/${MARK}.srv`;
    fs.writeFileSync(
      path.join(session, 'actions.jsonl'),
      [
        { type: 'session-start', v: 1, sessionId: 'older', startedAt: '2026-01-01T00:00:00Z' },
        {
          type: 'event',
          v: 1,
          seq: 0,
          ts: '2026-01-01T00:00:01Z',
          event: 'finding',
          detail: { severity: 'error', kind: 'log-error', message: `ERROR import failed path="${quoted}" reason="x"` },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
    const out = execFileSync('node', [path.join(REPO, 'scripts', 'generate-repro-report.mjs'), session], { encoding: 'utf8' });
    const report = fs.readFileSync(path.join(session, 'report.md'), 'utf8');
    expect(report).toContain('corpus-7/<corpus file>');
    expect(report + out).not.toContain(MARK);
  });
});
