/**
 * The trace signature is what decides whether a shrink kept the bug it was
 * pointed at, so its normalization rules are the correctness boundary of the
 * whole shrinker: too strict and no reduction is ever accepted, too loose and a
 * shrink silently wanders onto a different defect. These pin both directions
 * against real failure messages the fuzzers emit.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { shortId } from './crc32';
import { corpusFileId } from './fixtureCorpus';
import {
  FILE_ARG_ACTIONS,
  TRACE_VERSION,
  type TraceStep,
  TraceRecorder,
  describeSteps,
  failureSignature,
  readTrace,
  restoreTraceEnv,
  sameSignature,
  writeTrace,
} from './fuzzTrace';

/** Verbatim shape of an undo-persistence-fuzz roundtrip failure (finding 12). */
const FINDING_12 = [
  'undo did not restore the state recorded at depth 16 (the entry it consumed was set_shot_kind)',
  '  reproduce: pnpm agent:scenario undo-persistence-fuzz --seed 1 --iterations 1 --release',
  '  iteration=1 fixture=fractal_plant_iter3.stalx depth=16 top=18 saves=1 reloads=1',
  '  at project.sections[32].shots[0].kind',
  '    expected: "Normal"',
  '    actual:   "Jump"',
  '  KNOWN OPEN APP BUG [stale-id-writes-to-the-wrong-shot]: Finding 12: after a save/reload...',
].join('\n');

/** The same defect one shrink step later: shallower depth, different section. */
const FINDING_12_SHRUNK = [
  'undo did not restore the state recorded at depth 4 (the entry it consumed was set_shot_kind)',
  '  reproduce: pnpm agent:scenario undo-persistence-fuzz --seed 1 --iterations 1 --release',
  '  iteration=1 fixture=fractal_plant_iter3.stalx depth=4 top=5 saves=1 reloads=1',
  '  at project.sections[7].shots[0].kind',
  '    expected: "Normal"',
  '    actual:   "Jump"',
  '  KNOWN OPEN APP BUG [stale-id-writes-to-the-wrong-shot]: Finding 12: after a save/reload...',
].join('\n');

/** A genuinely different bug, reachable from a smaller trace (bug 1). */
const BUG_1 = [
  'redo did not restore the state recorded at depth 2',
  '  at project.sections[32].gauge_neighbour_uuid',
  '    expected: "4f600456-db5e-498c-b774-7ece755fc7ab"',
  '    actual:   null',
  '  KNOWN OPEN APP BUG [create-section-redo-drops-gauge-anchors]: The SAME root cause...',
].join('\n');

describe('failureSignature', () => {
  it('normalizes the depths and indices a shrink is expected to move', () => {
    expect(sameSignature(failureSignature(FINDING_12), failureSignature(FINDING_12_SHRUNK))).toBe(true);
  });

  it('keeps the field at the end of the diff path', () => {
    expect(failureSignature(FINDING_12).path).toBe('project.sections[*].shots[*].kind');
  });

  it('separates two failures that name different classifiers', () => {
    expect(sameSignature(failureSignature(FINDING_12), failureSignature(BUG_1))).toBe(false);
  });

  it('separates two failures that differ only in the field they diverge on', () => {
    const other = FINDING_12.replace('.shots[0].kind', '.shots[0].length');
    expect(sameSignature(failureSignature(FINDING_12), failureSignature(other))).toBe(false);
  });

  it('separates a roundtrip failure from a move that failed outright', () => {
    const wedge = [
      'undo at depth 14 failed outright (entry create_shot)',
      '  error: Shot 3200004 not found in section 32',
    ].join('\n');
    const sig = failureSignature(wedge);
    expect(sig.error).toBe('Shot N not found in section N');
    expect(sig.path).toBeNull();
    expect(sameSignature(sig, failureSignature(FINDING_12))).toBe(false);
  });

  it('treats the same wedge at a different id as the same defect', () => {
    const a = 'undo at depth 14 failed outright\n  error: Shot 3200004 not found in section 32';
    const b = 'undo at depth 3 failed outright\n  error: Shot 7 not found in section 0';
    expect(sameSignature(failureSignature(a), failureSignature(b))).toBe(true);
  });

  it('uses an absolute-invariant breach as the identity when there is no diff path', () => {
    const invariant = [
      'project invariant(s) violated after undo',
      '  INVARIANT: section 3 has two shots with id 300004',
    ].join('\n');
    expect(failureSignature(invariant).path).toBe('INVARIANT:section N has two shots with id N');
  });

  it('collects every classifier the message named, sorted and deduped', () => {
    const many = [
      'undo did not restore the state recorded at depth 9',
      '  at project.sections[1].shots[0].length',
      '  KNOWN OPEN APP BUG [stale-id-writes-to-the-wrong-shot]: ...',
      '  KNOWN OPEN APP BUG [bug-8-wrong-shot-delete]: ...',
      '  ATTRIBUTED [save-captures-missing-gauge-anchors]: ...',
      '  KNOWN OPEN APP BUG [bug-8-wrong-shot-delete]: ...',
    ].join('\n');
    expect(failureSignature(many).classifiers).toEqual([
      'bug-8-wrong-shot-delete',
      'save-captures-missing-gauge-anchors',
      'stale-id-writes-to-the-wrong-shot',
    ]);
  });

  it('a classifier appearing on only one side breaks the match', () => {
    const withExtra = `${FINDING_12}\n  KNOWN OPEN APP BUG [bug-8-wrong-shot-delete]: ...`;
    expect(sameSignature(failureSignature(FINDING_12), failureSignature(withExtra))).toBe(false);
  });
});

describe('TraceRecorder', () => {
  it('records in order and round trips through the file', () => {
    const recorder = new TraceRecorder();
    recorder.record({ kind: 'mutate', action: 'createSection', args: [{ name: 'a' }], label: 'createSection' });
    recorder.record({ kind: 'undo' });
    recorder.record({ kind: 'undoTo', steps: 3 });
    recorder.record({ kind: 'save' });

    const trace = recorder.build({
      scenario: 'undo-redo-fuzz',
      seed: 7,
      iterations: 40,
      fixture: 'fractal_plant_iter3.stalx',
      stream: 'v2',
      failure: { message: FINDING_12 },
    });
    expect(trace.v).toBe(TRACE_VERSION);
    expect(trace.steps).toHaveLength(4);
    expect(trace.failure?.signature.classifiers).toEqual(['stale-id-writes-to-the-wrong-shot']);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-trace-test-'));
    try {
      const file = path.join(dir, 'nested', 'trace.json');
      writeTrace(file, trace);
      const read = readTrace(file);
      expect(read).toEqual(trace);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reset drops what was recorded, so per-cycle scenarios keep one cycle', () => {
    const recorder = new TraceRecorder();
    recorder.record({ kind: 'undo' });
    expect(recorder.length).toBe(1);
    recorder.reset();
    recorder.record({ kind: 'redo' });
    expect(recorder.snapshot()).toEqual([{ kind: 'redo' }]);
  });

  it('refuses a step whose kind or jump width this build cannot run', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-trace-test-'));
    try {
      const write = (steps: unknown[]): string => {
        const file = path.join(dir, `${steps.length}-${Math.abs(JSON.stringify(steps).length)}.json`);
        fs.writeFileSync(file, JSON.stringify({ v: TRACE_VERSION, steps }));
        return file;
      };

      // An unrecognised kind used to fall through the branch chain and replay
      // as a redo; a negative jump is not bounded by the `Math.min` clamp and
      // moved the model cursor the wrong way.
      expect(() => readTrace(write([{ kind: 'loadProject' }]))).toThrow(/does not run/);
      expect(() => readTrace(write([{ kind: 'undoTo', steps: -5 }]))).toThrow(/positive integer/);
      expect(() => readTrace(write([{ kind: 'redoTo', steps: 1.5 }]))).toThrow(/positive integer/);
      expect(() => readTrace(write([{ kind: 'mutate', args: [] }]))).toThrow(/no action name/);
      expect(() => readTrace(write([{ kind: 'mutate', action: 'createShot' }]))).toThrow(/not an array/);
      // ...and the shapes it DOES run still parse.
      expect(
        readTrace(write([{ kind: 'undo' }, { kind: 'undoTo', steps: 3 }, { kind: 'save' }])).steps,
      ).toHaveLength(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a trace written by a different schema version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-trace-test-'));
    try {
      // `readTrace` requires an EXACT match in BOTH directions - a v1 file is
      // refused by a v2 build just as a v3 file would be. That is what makes
      // the version bump the whole migration story: local v1 traces are session
      // artifacts under `.agent-artifacts/`, regenerated by re-running a seed.
      for (const version of [TRACE_VERSION - 1, TRACE_VERSION + 1]) {
        const file = path.join(dir, `v${version}.json`);
        fs.writeFileSync(file, JSON.stringify({ v: version, steps: [] }));
        expect(() => readTrace(file)).toThrow(/schema v/);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is at schema v2, the import/export vocabulary', () => {
    expect(TRACE_VERSION).toBe(2);
  });
});

/**
 * The v2 steps carry paths, and those paths are joined against a session
 * directory and then WRITTEN to or opened. A trace is a file that arrives from
 * wherever the reader got it, so the shape checks below are a boundary, not a
 * convenience - same argument the module makes for `NEVER_RESTORED`.
 */
describe('schema v2 steps', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-trace-v2-'));
  let counter = 0;

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (step: unknown): string => {
    const file = path.join(dir, `step-${counter++}.json`);
    fs.writeFileSync(file, JSON.stringify({ v: TRACE_VERSION, steps: [step] }));
    return file;
  };
  const accepts = (step: unknown): void => {
    expect(readTrace(write(step)).steps).toHaveLength(1);
  };
  const rejects = (step: unknown, pattern: RegExp): void => {
    expect(() => readTrace(write(step))).toThrow(pattern);
  };

  const GEN_FILE = { kind: 'genFile', spec: { format: 'dmp' }, rel: 'fuzz-files/a.dmp', label: 'gen dmp' };

  it('accepts each new kind in its intended shape', () => {
    accepts({ kind: 'ui', testid: 'import-confirm', label: 'confirm' });
    accepts({ kind: 'ui', testid: 'row-3', double: true, label: 'open row' });
    accepts({ kind: 'input', testid: 'name', value: '', mode: 'type', label: 'clear name' });
    accepts({ kind: 'input', testid: 'unit', value: 'ft', mode: 'select', label: 'feet' });
    accepts({ kind: 'input', testid: 'skip', value: 'true', mode: 'check', label: 'skip dupes' });
    accepts({ kind: 'fileDialog', trigger: 'open-btn', dialog: 'open', rel: 'in/a.dmp', label: 'open' });
    accepts({ kind: 'fileDialog', trigger: 'open-btn', dialog: 'open', rel: ['a.dmp', 'b.dmp'], label: 'multi' });
    accepts({ kind: 'fileDialog', trigger: 'save-btn', dialog: 'save', rel: null, label: 'cancelled' });
    accepts(GEN_FILE);
    accepts({ kind: 'corpusFile', corpusRel: 'device/x.dmp', rel: 'in/x.dmp', label: 'corpus dmp' });
    accepts({ kind: 'route', rel: 'in/a.tml', label: 'route tml' });
    accepts({ kind: 'mapClick', lngLat: [-83.5, 20.25], label: 'pick station' });
    accepts({ kind: 'export', format: 'tml', options: {}, rel: 'out/x.tml', label: 'export tml' });
    accepts({ kind: 'reload', fixture: 'fractal_plant_iter3.stalx' });
  });

  it('REFUSES an absolute rel, in every spelling a trace could carry one', () => {
    // `path.isAbsolute` on Linux does not consider the Windows forms absolute,
    // and a trace is portable - it gets attached to a bug report and read on
    // another machine.
    for (const rel of ['/etc/cron.d/x', '\\\\server\\share\\x', 'C:\\Windows\\x', '/tmp/pwn.dmp']) {
      rejects({ ...GEN_FILE, rel }, /absolute rel/);
      rejects({ kind: 'route', rel, label: 'route' }, /absolute rel/);
      rejects({ kind: 'export', format: 'tml', options: {}, rel, label: 'x' }, /absolute rel/);
      rejects({ kind: 'fileDialog', trigger: 't', dialog: 'open', rel, label: 'x' }, /absolute rel/);
      rejects({ kind: 'fileDialog', trigger: 't', dialog: 'open', rel: [rel], label: 'x' }, /absolute rel/);
      rejects({ kind: 'corpusFile', corpusRel: 'a.dmp', rel, label: 'x' }, /absolute rel/);
      rejects({ kind: 'corpusFile', corpusRel: rel, rel: 'in/a.dmp', label: 'x' }, /absolute corpusRel/);
    }
  });

  it('REFUSES a rel that traverses out of the session directory', () => {
    for (const rel of ['../out.dmp', 'a/../../b.dmp', '..', 'a\\..\\..\\b.dmp']) {
      rejects({ ...GEN_FILE, rel }, /escaping the session directory|absolute rel/);
      rejects({ kind: 'corpusFile', corpusRel: rel, rel: 'in/a.dmp', label: 'x' }, /escaping the session directory/);
    }
    // A `..` INSIDE a segment is a filename, not a traversal.
    accepts({ ...GEN_FILE, rel: 'fuzz-files/a..dmp' });
  });

  it('REFUSES the malformed shape of each new kind', () => {
    rejects({ kind: 'ui', testid: '', label: 'x' }, /testid/);
    rejects({ kind: 'ui', testid: 'a' }, /label/);
    rejects({ kind: 'ui', testid: 'a', label: 'x', double: 'yes' }, /double/);
    rejects({ kind: 'input', testid: 'a', value: 'v', mode: 'paste', label: 'x' }, /input mode/);
    rejects({ kind: 'input', testid: 'a', value: 7, mode: 'type', label: 'x' }, /value/);
    rejects({ kind: 'fileDialog', trigger: 'a', dialog: 'browse', rel: null, label: 'x' }, /dialog/);
    rejects({ kind: 'fileDialog', trigger: 'a', dialog: 'open', rel: [], label: 'x' }, /empty path list/);
    rejects({ kind: 'genFile', rel: 'a.dmp', label: 'x' }, /generator spec/);
    rejects({ kind: 'genFile', spec: null, rel: 'a.dmp', label: 'x' }, /generator spec/);
    rejects({ kind: 'mapClick', lngLat: [1], label: 'x' }, /lngLat/);
    rejects({ kind: 'mapClick', lngLat: [1, Number.NaN], label: 'x' }, /lngLat/);
    rejects({ kind: 'mapClick', lngLat: ['1', '2'], label: 'x' }, /lngLat/);
    rejects({ kind: 'export', format: '', options: {}, rel: 'a.tml', label: 'x' }, /format/);
    rejects({ kind: 'export', format: 'tml', options: 'none', rel: 'a.tml', label: 'x' }, /export options/);
    rejects({ kind: 'reload', fixture: '../../etc/passwd' }, /bare fixture name/);
    rejects({ kind: 'reload', fixture: 'sub/dir.stalx' }, /bare fixture name/);
    rejects({ kind: 'reload', fixture: '' }, /fixture/);
  });

  it('REFUSES a file-taking mutation whose args[0] leaves the session directory', () => {
    // The v3 import group drives store actions that take a PATH, so `args[0]`
    // reaches the filesystem instead of the model. Without this a hand-written
    // trace could have the app open and parse any file on the machine - the
    // same hole every `rel` field above is checked for.
    for (const action of FILE_ARG_ACTIONS) {
      for (const bad of ['/etc/shadow', 'C:\\Windows\\x', '../../../.ssh/id_rsa', '']) {
        rejects(
          { kind: 'mutate', action, args: [bad], label: action },
          /absolute args\[0\]|escaping the session directory|must be a non-empty string/,
        );
      }
      rejects({ kind: 'mutate', action, args: [], label: action }, /must be a non-empty string/);
      accepts({ kind: 'mutate', action, args: [`fuzz-files/a.dmp`, null], label: action });
    }
    // A mutation that does NOT take a path is untouched: its args are values.
    accepts({ kind: 'mutate', action: 'createSection', args: ['/not/a/path'], label: 'createSection' });
  });

  it('still validates every v1 step kind - only the FILE version moved', () => {
    const v1Steps: TraceStep[] = [
      { kind: 'mutate', action: 'createSection', args: [{}], label: 'createSection' },
      { kind: 'undo' },
      { kind: 'redo' },
      { kind: 'undoTo', steps: 2 },
      { kind: 'redoTo', steps: 3 },
      { kind: 'save' },
      { kind: 'repair' },
    ];
    const file = path.join(dir, 'v1-kinds.json');
    fs.writeFileSync(file, JSON.stringify({ v: TRACE_VERSION, steps: v1Steps }));
    expect(readTrace(file).steps).toEqual(v1Steps);
  });
});

describe('describeSteps', () => {
  it('renders one numbered line per step', () => {
    const text = describeSteps([
      { kind: 'mutate', action: 'createShot', args: [], label: 'createShot(s=3,append)' },
      { kind: 'undoTo', steps: 2 },
      { kind: 'save' },
    ]);
    expect(text.split('\n')).toEqual([
      '  1. createShot(s=3,append)',
      '  2. undoTo(2 step(s))',
      '  3. save',
    ]);
  });

  it('gives every v2 kind a line carrying what the label cannot', () => {
    const text = describeSteps([
      { kind: 'ui', testid: 'import-confirm', label: 'confirm import' },
      { kind: 'ui', testid: 'row-3', double: true, label: 'open row' },
      { kind: 'input', testid: 'name', value: 'x', mode: 'type', label: 'rename' },
      { kind: 'fileDialog', trigger: 'open-btn', dialog: 'open', rel: 'in/a.dmp', label: 'pick dmp' },
      { kind: 'fileDialog', trigger: 'open-btn', dialog: 'open', rel: ['a', 'b'], label: 'pick two' },
      { kind: 'fileDialog', trigger: 'save-btn', dialog: 'save', rel: null, label: 'cancel' },
      { kind: 'genFile', spec: {}, rel: 'in/a.dmp', label: 'v5 x2' },
      { kind: 'corpusFile', corpusRel: 'device/x.dmp', rel: 'in/x.dmp', label: 'corpus dmp' },
      { kind: 'route', rel: 'in/a.tml', label: 'route' },
      { kind: 'mapClick', lngLat: [-83.5, 20.25], label: 'pick station' },
      { kind: 'export', format: 'tml', options: {}, rel: 'out/x.tml', label: 'roundtrip' },
      { kind: 'reload', fixture: 'naharon.stalx' },
    ]);
    expect(text.split('\n')).toEqual([
      '  1. click import-confirm - confirm import',
      '  2. dblclick row-3 - open row',
      '  3. type name - rename',
      '  4. open-dialog via open-btn -> in/a.dmp - pick dmp',
      '  5. open-dialog via open-btn -> 2 file(s) - pick two',
      '  6. save-dialog via save-btn -> cancel - cancel',
      '  7. genFile in/a.dmp - v5 x2',
      `  8. corpusFile #${corpusFileId('device/x.dmp')} -> in/x.dmp - corpus dmp`,
      '  9. route in/a.tml - route',
      ' 10. mapClick -83.5,20.25 - pick station',
      ' 11. export tml -> out/x.tml - roundtrip',
      ' 12. reload naharon.stalx',
    ]);
  });

  it('prints the corpus TAG, never the corpus-relative path', () => {
    // A corpus path can name a cave, a landowner or an unpublished project, and
    // a shrunk trace is a thing people paste into issues.
    const line = describeSteps([
      { kind: 'corpusFile', corpusRel: 'a-very-identifying-name/survey.dmp', rel: 'in/x.dmp', label: 'x' },
    ]);
    expect(line).not.toContain('a-very-identifying-name');
    expect(line).not.toContain('survey.dmp');
    expect(line).toContain(shortId('a-very-identifying-name/survey.dmp'));
    // The trace's tag and the corpus module's id are the same function, so a
    // log line and a metric key never disagree about which file is meant.
    expect(corpusFileId('a-very-identifying-name/survey.dmp')).toBe(
      shortId('a-very-identifying-name/survey.dmp'),
    );
  });
});

describe('restoreTraceEnv', () => {
  const OWNED = ['STALAGMIGHT_FUZZ_TEST_KNOB', 'STALAGMIGHT_PERSIST_FUZZ_TEST_KNOB', 'STALAGMIGHT_OTHER_TEST'];
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of OWNED) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of OWNED) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('applies the knobs the recorder writes', () => {
    const { applied, refused } = restoreTraceEnv({
      STALAGMIGHT_FUZZ_TEST_KNOB: 'a',
      STALAGMIGHT_PERSIST_FUZZ_TEST_KNOB: 'b',
    });

    expect(process.env.STALAGMIGHT_FUZZ_TEST_KNOB).toBe('a');
    expect(process.env.STALAGMIGHT_PERSIST_FUZZ_TEST_KNOB).toBe('b');
    expect(applied).toHaveLength(2);
    expect(refused).toEqual([]);
  });

  it('REFUSES the two path knobs even though they match the prefix', () => {
    // These decide where THIS process writes its trace and what it replays
    // next. A file that could set them would pick the output path for the run
    // reading it - `writeTrace` does `mkdirSync(recursive) + writeFileSync`, so
    // that is an arbitrary create/overwrite with largely file-controlled
    // content. The recorder already refuses to emit `_TRACE`; this is the same
    // rule on the consuming side, where it is a boundary rather than a habit.
    const before = { trace: process.env.STALAGMIGHT_FUZZ_TRACE, replay: process.env.STALAGMIGHT_FUZZ_REPLAY };

    const { applied, refused } = restoreTraceEnv({
      STALAGMIGHT_FUZZ_TRACE: '/tmp/pwn/out.json',
      STALAGMIGHT_FUZZ_REPLAY: '/tmp/pwn/in.json',
      STALAGMIGHT_FUZZ_TEST_KNOB: 'kept',
    });

    expect(process.env.STALAGMIGHT_FUZZ_TRACE).toBe(before.trace);
    expect(process.env.STALAGMIGHT_FUZZ_REPLAY).toBe(before.replay);
    expect(applied.map(([key]) => key)).toEqual(['STALAGMIGHT_FUZZ_TEST_KNOB']);
    expect(refused).toEqual(['STALAGMIGHT_FUZZ_TRACE', 'STALAGMIGHT_FUZZ_REPLAY']);
  });

  it('REFUSES every key outside those prefixes, and says which', () => {
    // A trace is a file from wherever the user got it, and the process that
    // reads it goes on to invoke cargo and launch the app. The recorder's
    // prefix filter is a producer-side convention; this is the boundary.
    const before = { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS };

    const { applied, refused } = restoreTraceEnv({
      PATH: '/evil',
      NODE_OPTIONS: '--require /tmp/pwn.js',
      LD_PRELOAD: '/tmp/pwn.so',
      STALAGMIGHT_AGENT_RELEASE: '1',
      STALAGMIGHT_OTHER_TEST: 'x',
      STALAGMIGHT_FUZZ_TEST_KNOB: 'kept',
    });

    expect(process.env.PATH).toBe(before.PATH);
    expect(process.env.NODE_OPTIONS).toBe(before.NODE_OPTIONS);
    expect(process.env.LD_PRELOAD).toBeUndefined();
    expect(process.env.STALAGMIGHT_OTHER_TEST).toBeUndefined();
    expect(process.env.STALAGMIGHT_FUZZ_TEST_KNOB).toBe('kept');
    expect(applied.map(([key]) => key)).toEqual(['STALAGMIGHT_FUZZ_TEST_KNOB']);
    expect(refused).toEqual([
      'PATH',
      'NODE_OPTIONS',
      'LD_PRELOAD',
      'STALAGMIGHT_AGENT_RELEASE',
      'STALAGMIGHT_OTHER_TEST',
    ]);
  });
});
