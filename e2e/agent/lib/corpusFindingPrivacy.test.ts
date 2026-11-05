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
