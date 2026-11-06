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
  redactCorpusText,
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
    // A marker as the panic hook writes it: serde_json (a marker that is not
    // JSON is withheld whole, #576 RV16-2).
    const marker = path.join(markerDir, 'crash-9-9-0.json');
    fs.writeFileSync(marker, JSON.stringify({ message: `thread 'main' panicked: could not read ${copyPath}` }));
    const target: OracleTarget = { ...webviewLogging('INFO nothing to see'), findCrashMarkers: () => [marker] };
    const recorder = new Recorder('run-markers', sessionsRoot);
    await runSweep(target, newOracleState(), { recorder });

    const findings = path.join(sessionsRoot, 'run-markers', 'findings');
    const copied = fs
      .readdirSync(findings, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name === 'crash-9-9-0.json');
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

  /**
   * #576 RV16-1: Rust's `{:?}` escapes a quote or a backslash in a path one level
   * INSIDE the text (`qz \"quoted\"`): a tracing field `path = ?path` in a log
   * line, a PathBuf in an unwrapped error's panic payload. Parsing a marker
   * removes only the JSON layer, so the Debug form was left in the value and
   * neither fold found it.
   */
  it.each([
    ['a quote', 'rv16q', 'qzrv16q "quoted" trip.dmp', 'qzrv16q'],
    ['a backslash', 'rv16b', 'qzrv16b back\\slash trip.dmp', 'qzrv16b'],
  ])('keeps a Debug-formatted name with %s out of a log finding, a marker copy and report.md (#576 RV16-1)', async (_what, id, name, token) => {
    const destination = path.join(scratch, 'copies', id);
    registerCorpusRedactions(id, destination, [name]);
    // `{:?}` of a str or a PathBuf: quoted, with `"` and `\` escaped, which is
    // exactly what JSON.stringify writes for these names.
    const debugPath = JSON.stringify(path.join(destination, name));
    const markerDir = path.join(scratch, `markers-${id}`);
    fs.mkdirSync(markerDir, { recursive: true });
    const marker = path.join(markerDir, 'crash-5-6-0.json');
    const payload = { message: `called \`Result::unwrap()\` on an \`Err\` value: Parse { path: ${debugPath} }` };
    fs.writeFileSync(marker, JSON.stringify(payload, null, 2));
    const line = `ERROR stalagmight_core::core::state::project_load: Failed to load project {path=${debugPath}}`;
    expect(line).toContain(token); // the input really does carry the name
    const target: OracleTarget = { ...webviewLogging(line), findCrashMarkers: () => [marker] };
    const session = path.join(sessionsRoot, `run-${id}`);
    const sweep = await runSweep(target, newOracleState(), { recorder: new Recorder(`run-${id}`, sessionsRoot) });
    execFileSync('node', [path.join(REPO, 'scripts', 'generate-repro-report.mjs'), session], { encoding: 'utf8' });

    expect(sweep.newFindings.map((f) => f.kind)).toEqual(['crash-marker', 'log-error']);
    const leaks = {
      findings: JSON.stringify(sweep.findings).includes(token),
      session: allText(path.join(session, 'findings')).includes(token),
      actions: fs.readFileSync(path.join(session, 'actions.jsonl'), 'utf8').includes(token),
      reportMd: fs.readFileSync(path.join(session, 'report.md'), 'utf8').includes(token),
    };
    expect(leaks).toEqual({ findings: false, session: false, actions: false, reportMd: false });
    // Folded to the entry's tag inside the Debug quotes, which stay as written.
    expect(sweep.findings.find((f) => f.kind === 'log-error')?.message).toContain(`{path="<corpus #${id}>/<corpus #${id}>/file"}`);
  });

  /**
   * #576 RV17-1: Rust's `{:?}` writes more than ASCII controls as `\u{hex}` - a
   * combining mark (an NFD accent, as file names from macOS carry them), a
   * no-break or zero-width space, a C1 control - and one such character left the
   * rest of the name in the finding. An encoder that writes ASCII-only JSON
   * spells every non-ASCII character `\uXXXX`, past U+FFFF as a surrogate pair.
   * The Debug bodies are what rustc 1.97 printed for `format!("{:?}", path)`.
   */
  it.each([
    ['a combining acute (NFD)', 'rv17a', 'qzrv17a Café sump.dmp', 'qzrv17a Cafe\\u{301} sump.dmp'],
    ['a no-break space', 'rv17b', 'qzrv17b nbsp cave.dmp', 'qzrv17b nbsp\\u{a0}cave.dmp'],
    ['a zero-width space', 'rv17c', 'qzrv17c x​y.dmp', 'qzrv17c x\\u{200b}y.dmp'],
    ['a C1 control', 'rv17d', 'qzrv17d c1\u0085x.dmp', 'qzrv17d c1\\u{85}x.dmp'],
    ['an emoji', 'rv17e', 'qzrv17e emoji \u{1F600} cave.dmp', 'qzrv17e emoji \u{1F600} cave.dmp'],
    [
      'a quote, a backslash and two escaped marks',
      'rv17f',
      'qzrv17f "q" back\\slash é .dmp',
      'qzrv17f \\"q\\" back\\\\slash e\\u{301}\\u{a0}.dmp',
    ],
  ])('keeps a name with %s out of a {:?} log line, a crash marker and a finding (#576 RV17-1)', async (_what, id, name, debugBody) => {
    const token = `qz${id}`;
    const destination = path.join(scratch, 'copies', id);
    registerCorpusRedactions(id, destination, [name]);
    // JSON as an ASCII-only encoder writes it: every non-ASCII UTF-16 unit as \uXXXX.
    const asciiJson = (value: unknown): string =>
      JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    const debugPath = `"${destination}/${debugBody}"`;
    const line =
      `ERROR stalagmight_lib::commands::import_runner: Failed to parse DMP file for import ` +
      `{path=${debugPath}, purpose=import, reason=not a dump} args=${asciiJson({ path: path.join(destination, name) })}`;
    expect(line).toContain(token); // the input really does carry the name
    const markerDir = path.join(scratch, `markers-${id}`);
    fs.mkdirSync(markerDir, { recursive: true });
    const marker = path.join(markerDir, 'crash-17-1-0.json');
    fs.writeFileSync(marker, asciiJson({ message: `called \`Result::unwrap()\` on an \`Err\` value: Parse { path: ${debugPath} }` }));
    const target: OracleTarget = { ...webviewLogging(line), findCrashMarkers: () => [marker] };
    const session = path.join(sessionsRoot, `run-${id}`);
    const sweep = await runSweep(target, newOracleState(), { recorder: new Recorder(`run-${id}`, sessionsRoot) });
    execFileSync('node', [path.join(REPO, 'scripts', 'generate-repro-report.mjs'), session], { encoding: 'utf8' });

    expect(sweep.newFindings.map((f) => f.kind)).toEqual(['crash-marker', 'log-error']);
    const leaks = {
      text: redactCorpusText(line).includes(token),
      findings: JSON.stringify(sweep.findings).includes(token),
      session: allText(path.join(session, 'findings')).includes(token),
      actions: fs.readFileSync(path.join(session, 'actions.jsonl'), 'utf8').includes(token),
      reportMd: fs.readFileSync(path.join(session, 'report.md'), 'utf8').includes(token),
    };
    expect(leaks).toEqual({ text: false, findings: false, session: false, actions: false, reportMd: false });
    // Both spellings fold to the entry's tag, inside quotes that stay as written.
    const message = sweep.findings.find((f) => f.kind === 'log-error')?.message ?? '';
    expect(message).toContain(`{path="<corpus #${id}>/<corpus #${id}>/file", purpose=import`);
    expect(message).toContain(`args={"path":"<corpus #${id}>/<corpus #${id}>/file"}`);
  });

  it('folds a name escaped twice, and U+FFFD written as the bytes it stands for (#576 RV17-1)', () => {
    const destination = path.join(scratch, 'copies', 'rv17g');
    registerCorpusRedactions('rv17g', destination, ['qzrv17g Café \u{1F600}.dmp', 'qzrv17h bad� name.dmp']);
    const tag = '<corpus #rv17g>/file';
    // `{:?}` inside JSON, and that inside JSON again; JSON's \uXXXX inside JSON.
    expect(redactCorpusText('a qzrv17g Cafe\\\\u{301} \\\\uD83D\\\\uDE00.dmp b')).toBe(`a ${tag} b`);
    expect(redactCorpusText('a qzrv17g Cafe\\\\\\\\u{301} \u{1F600}.dmp b')).toBe(`a ${tag} b`);
    expect(redactCorpusText('a qzrv17g Cafe\\\\u0301 \\ud83d\\ude00.dmp b')).toBe(`a ${tag} b`);
    // Node reads a file name that is not UTF-8 with U+FFFD in its place; Rust's
    // `{:?}` of the path writes the bytes. (Discovery and materialization skip
    // such a name today - its lossy spelling does not stat - so this is a guard.)
    expect(redactCorpusText('p="qzrv17h bad\\xFF\\xFE name.dmp"')).toBe(`p="${tag}"`);
    expect(redactCorpusText('p="qzrv17h bad\\u{fffd} name.dmp"')).toBe(`p="${tag}"`);
  });

  it('withholds every torn crash marker, a plain name cut mid-way included (#576 RV16-2)', async () => {
    const id = 'rv16p';
    const name = 'qzrv16plain secret cave.dmp';
    const destination = path.join(scratch, 'copies', id);
    registerCorpusRedactions(id, destination, [name]);
    const markerDir = path.join(scratch, `markers-${id}`);
    fs.mkdirSync(markerDir, { recursive: true });
    const marker = path.join(markerDir, 'crash-7-8-0.json');
    // Cut off six characters into the name's second word: no fold can match
    // the partial name, and nothing in the text needs escaping.
    const whole = JSON.stringify({ message: `could not read ${path.join(destination, name)}` });
    fs.writeFileSync(marker, whole.slice(0, whole.indexOf('secret') + 6));
    const target: OracleTarget = { ...webviewLogging('INFO nothing to see'), findCrashMarkers: () => [marker] };
    await runSweep(target, newOracleState(), { recorder: new Recorder(`run-${id}`, sessionsRoot) });

    const copied = fs.readFileSync(path.join(sessionsRoot, `run-${id}`, 'findings', '001', 'crash-7-8-0.json'), 'utf8');
    expect({ withheld: copied.includes('withheld'), leaksPrefix: copied.includes('qzrv16plain') }).toEqual({
      withheld: true,
      leaksPrefix: false,
    });
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
        // A log line is withheld from the report whole (#576 HFI2-F2), so the
        // path fold is exercised by a finding the report still quotes.
        {
          type: 'event',
          v: 1,
          seq: 1,
          ts: '2026-01-01T00:00:02Z',
          event: 'finding',
          detail: { severity: 'warning', kind: 'sweep-probe-failed', message: `oracle probe failed: could not read ${quoted}` },
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
