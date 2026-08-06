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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  TRACE_VERSION,
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
      const file = path.join(dir, 'old.json');
      fs.writeFileSync(file, JSON.stringify({ v: TRACE_VERSION + 1, steps: [] }));
      expect(() => readTrace(file)).toThrow(/schema v/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
