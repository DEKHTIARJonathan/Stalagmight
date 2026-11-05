/**
 * #576 RV13-4: no line of the session's action log names a corpus file.
 *
 * The MCP server recorded a successful tool call's params and result as they
 * came: `file_dialog_answer` carries the path of the corpus copy it picks, and
 * the `logs` tool returns the backend's line for a failed parse, which quotes
 * that path, real names and all. Only findings and error outcomes went through
 * the corpus redaction (RV12-F1). Now the recorder folds every line it writes,
 * and the server caps a result only after redacting it.
 *
 * Everything here is synthetic: a token-named corpus entry built in a temp
 * directory, and the lines the app would echo back for it.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CORPUS_DIR_ENV,
  corpusEntryFor,
  discoverCorpus,
  materializeCorpusEntry,
  redactCorpusText,
  redactCorpusValue,
  registerCorpusRedactions,
} from './fixtureCorpus';
import { capJson } from './page';
import { Recorder } from './recorder';

const MARK = 'qzactionlogmark';
const TRIP = `${MARK}-trip`;
const FILE = `${MARK}-broken.dmp`;
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

let scratch = '';
let sessionsRoot = '';
let copyPath = '';
const savedCorpusDir = process.env[CORPUS_DIR_ENV];

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-corpus-actionlog-'));
  const corpusRoot = path.join(scratch, 'corpus');
  sessionsRoot = path.join(scratch, 'sessions');
  fs.mkdirSync(path.join(corpusRoot, TRIP), { recursive: true });
  fs.writeFileSync(path.join(corpusRoot, TRIP, FILE), 'not an mnemo dump\n');
  process.env[CORPUS_DIR_ENV] = corpusRoot;
  const entry = corpusEntryFor(discoverCorpus().entries[0]?.relPath ?? '');
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

/** The backend's line for a failed parse (`commands/import.rs`), quoting the copy. */
const failedParseLine = () =>
  `ERROR stalagmight_lib::commands::import: Failed to parse DMP file for import preview path="${copyPath}" reason="not a dump"`;

describe('the action log names no corpus file (#576 RV13-4)', () => {
  it('folds the copy path out of params, results, resolved targets, events and keys', () => {
    expect(copyPath).toContain(MARK); // the input really does carry the name
    const recorder = new Recorder('run-1', sessionsRoot);
    recorder.sessionStart({
      sessionId: 'run-1',
      startedAt: '2026-01-01T00:00:00Z',
      gitHead: 'abc',
      binaryPath: '/bin/app',
      binaryMtime: 0,
      display: ':99',
      headed: false,
      profileDir: '/profile',
      freshProfile: true,
    });
    // A file dialog answered with the copy, then the `logs` tool reading the failure.
    recorder.action({
      seq: recorder.nextSeq(),
      ts: '2026-01-01T00:00:01Z',
      tool: 'file_dialog_answer',
      mutating: true,
      params: { paths: [copyPath] },
      resolved: { [copyPath]: 'picked' },
      outcome: { ok: true, durationMs: 3 },
      result: { answered: copyPath },
    });
    recorder.action({
      seq: recorder.nextSeq(),
      ts: '2026-01-01T00:00:02Z',
      tool: 'logs',
      params: { level: 'error' },
      outcome: { ok: true, durationMs: 1 },
      result: { newEntries: [failedParseLine()], errorCount: 1 },
    });
    recorder.action({
      seq: recorder.nextSeq(),
      ts: '2026-01-01T00:00:03Z',
      tool: 'file_dialog_answer',
      mutating: true,
      params: { paths: [copyPath] },
      outcome: { ok: false, durationMs: 2, error: 'refused' },
    });
    recorder.event('scenario-log', { message: `opened ${copyPath}` });

    const log = fs.readFileSync(path.join(sessionsRoot, 'run-1', 'actions.jsonl'), 'utf8');
    const lines = log.trim().split('\n');
    expect(lines).toHaveLength(5);
    // Every line is still JSON, and still says which entry it was.
    const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(records.map((r) => r.type)).toEqual(['session-start', 'action', 'action', 'action', 'event']);
    expect(log).not.toContain(MARK);
    expect(log).toContain('<corpus #');
  });

  it('redacts a value string by string, so a name JSON would escape is folded too', () => {
    const odd = `${copyPath}"\\`;
    const redacted = redactCorpusValue({ list: [odd, 3, null, true], [copyPath]: { nested: copyPath } });
    expect(JSON.stringify(redacted)).not.toContain(MARK);
    expect(redacted).toEqual({
      list: [redactCorpusText(odd), 3, null, true],
      [redactCorpusText(copyPath)]: { nested: redactCorpusText(copyPath) },
    });
  });

  it('caps a recorded result only after redacting it: a cut through the name leaks no part of it', () => {
    // A result whose 4096-byte cap falls right after the name's first token.
    const line = failedParseLine();
    const opening = JSON.stringify({ newEntries: [''] }).indexOf('""') + 1; // `{"newEntries":["`
    // The line's JSON form up to the end of the first token, escapes included.
    const head = JSON.stringify(line.slice(0, line.indexOf(MARK) + MARK.length)).slice(1, -1);
    const result = { newEntries: [`${'x'.repeat(4096 - opening - head.length)}${line}`] };
    // Capping first leaves a stub the folding cannot recognise.
    expect(redactCorpusText(String(capJson(result, 4096).value))).toContain(MARK);
    expect(JSON.stringify(capJson(redactCorpusValue(result), 4096).value)).not.toContain(MARK);
    // ...and the MCP server records it in that order.
    const server = fs.readFileSync(path.join(REPO, 'e2e', 'agent', 'mcp', 'server.ts'), 'utf8');
    expect(server).toContain('result: capJson(redactCorpusValue(result), 4096).value,');
  });

  it('the MCP server folds every tool result it returns, as it does its errors (the `logs` tool quotes the copy)', () => {
    const server = fs.readFileSync(path.join(REPO, 'e2e', 'agent', 'mcp', 'server.ts'), 'utf8');
    expect(server).toMatch(
      /function textResult\(value: unknown\): ToolResult \{\s*return \{ content: \[\{ type: 'text', text: JSON\.stringify\(redactCorpusValue\(value\) \?\? null\) \}\] \};/,
    );
  });
});
