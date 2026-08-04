/**
 * Trace record/replay for the undo fuzzers: the artefact that turns "seed 16,
 * 40 iterations, somewhere in there" into a list of commands you can read,
 * replay, shrink and transcribe into a Rust test.
 *
 * ## Why a trace and not just a seed
 *
 * A seed already reproduces a run exactly - that was designed in from the start.
 * What a seed does NOT give you is the ability to change the run. Triage is
 * mostly "which of these 37 mutations actually matter", and with only a seed the
 * answer costs a sweep of other seeds and a human bisecting by eye. A trace is
 * the run's RESOLVED decisions - every generator draw already collapsed into a
 * concrete `projectStore` action and its arguments - so a subset of it is still
 * a runnable scenario. That is what makes automatic minimization possible
 * (`fuzzShrink.ts`), and it is why the trace stores resolved args rather than the
 * rng state: replay needs neither the generators nor the PRNG, so a shrunk trace
 * is not tied to the generator version that produced it.
 *
 * ## What is recorded, and what is deliberately not
 *
 * One entry per MOVE the scenario made, in order: mutations with their action
 * and args, single-step and multi-step history moves, save/reload boundary
 * crossings, and Repair.
 *
 * The final unwind/rewind is NOT recorded. It is a function of the state the run
 * ends in ("undo to 0, redo to the top"), so recording it would pin a depth that
 * a shrunk trace no longer has. The replayer always regenerates it instead - see
 * `fuzzShrink.ts` for why that is also what makes removal a sound shrink step.
 *
 * ## Recording is observe-only
 *
 * `TraceRecorder` draws nothing, reads no app state and is called AFTER the
 * decision it records. Recording therefore cannot move a seed's trajectory, and
 * the two faithfulness repros (bug 1 at fractal seed 1 x40 strict, bug 8 at
 * fractal seed 14 x6 tolerant) are re-verified with recording active.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

/** Current trace schema. Bumped when a step shape changes incompatibly. */
export const TRACE_VERSION = 1;

/**
 * One replayable move.
 *
 * `save` is the whole boundary crossing (save to a temp path, close, reopen), not
 * just the write: the three are one atomic thing as far as the model is
 * concerned, and splitting them would let a shrink produce a trace that saved
 * without reopening.
 */
export type TraceStep =
  | { kind: 'mutate'; action: string; args: unknown[]; label: string }
  | { kind: 'undo' | 'redo' }
  | { kind: 'undoTo' | 'redoTo'; steps: number }
  | { kind: 'save' }
  | { kind: 'repair' };

/** A failure, reduced to the parts that identify it across a shrink. */
export interface FailureSignature {
  /** First line of the failure, with every run of digits replaced by `N`. */
  headline: string;
  /** First differing path, with array indices normalized (`shots[3]` -> `shots[*]`). */
  path: string | null;
  /** The `error:` line of a move that failed outright, digits normalized. */
  error: string | null;
  /** Every classifier id the message named, sorted and deduped. */
  classifiers: string[];
}

export interface FuzzTrace {
  v: number;
  scenario: string;
  /** The seed that produced it. Replay does not need it; triage does. */
  seed: number;
  iterations: number;
  fixture: string;
  /** Generator stream the recording ran on (`v1` / `v2`), for the header only. */
  stream: string;
  /** The `STALAGMIGHT_FUZZ_*` / `STALAGMIGHT_PERSIST_FUZZ_*` knobs that were set. */
  env: Record<string, string>;
  gitRev: string;
  recordedAt: string;
  /** Null when the run passed and the trace was written because of the env var. */
  failure: { message: string; signature: FailureSignature } | null;
  steps: TraceStep[];
}

/** Env knobs that change what a run does, and so belong in a trace header. */
const RECORDED_ENV_PREFIXES = ['STALAGMIGHT_FUZZ_', 'STALAGMIGHT_PERSIST_FUZZ_'];

function recordedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    // The trace's own path is not part of what the run DOES, and carrying it
    // would make a replayed trace overwrite the file it came from.
    if (key === 'STALAGMIGHT_FUZZ_TRACE') continue;
    if (RECORDED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) out[key] = value;
  }
  return out;
}

function gitRev(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Collects the resolved move list for one run (or, for a per-cycle scenario, one
 * cycle). Observe-only: it never draws, never reads app state and never decides
 * anything.
 */
export class TraceRecorder {
  private steps: TraceStep[] = [];

  record(step: TraceStep): void {
    this.steps.push(step);
  }

  /** Drop everything recorded so far. Used by scenarios whose iterations are independent. */
  reset(): void {
    this.steps = [];
  }

  get length(): number {
    return this.steps.length;
  }

  snapshot(): TraceStep[] {
    return this.steps.map((step) => ({ ...step }));
  }

  build(meta: {
    scenario: string;
    seed: number;
    iterations: number;
    fixture: string;
    stream: string;
    failure: { message: string } | null;
  }): FuzzTrace {
    return {
      v: TRACE_VERSION,
      scenario: meta.scenario,
      seed: meta.seed,
      iterations: meta.iterations,
      fixture: meta.fixture,
      stream: meta.stream,
      env: recordedEnv(),
      gitRev: gitRev(),
      recordedAt: new Date().toISOString(),
      failure: meta.failure
        ? { message: meta.failure.message, signature: failureSignature(meta.failure.message) }
        : null,
      steps: this.snapshot(),
    };
  }
}

export function writeTrace(filePath: string, trace: FuzzTrace): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
  return filePath;
}

export function readTrace(filePath: string): FuzzTrace {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as FuzzTrace;
  if (parsed.v !== TRACE_VERSION) {
    throw new Error(`trace ${filePath} is schema v${parsed.v}; this build reads v${TRACE_VERSION}`);
  }
  if (!Array.isArray(parsed.steps)) throw new Error(`trace ${filePath} has no steps array`);
  return parsed;
}

/** Where a run drops its trace when it fails. */
export function defaultTracePath(artifactsDir: string, scenario: string, seed: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(artifactsDir, 'traces', `${scenario}-seed${seed}-${stamp}.json`);
}

/**
 * Everything in a failure message that must survive a shrink, and nothing that
 * must not.
 *
 * Digits are normalized out of the headline and the error line, and array
 * indices out of the path, for one reason: removing a mutation MOVES things. The
 * depth a failure happens at, the iteration number, the section index in a diff
 * path - all of them shift when an earlier action goes away, while the defect is
 * the same defect. A signature that pinned them would reject every genuine
 * reduction and the shrinker would never make progress.
 *
 * What is NOT normalized is the shape of the sentence, the field at the end of
 * the diff path, and every classifier id the message named. Those are what say
 * WHICH bug it is, so a shrink that lands on a different defect - which smaller
 * traces genuinely do - fails the comparison and is rejected, exactly as ddmin
 * requires.
 */
export function failureSignature(message: string): FailureSignature {
  const lines = message.split('\n');
  const headline = normalizeNumbers(lines[0] ?? '');

  let firstPath: string | null = null;
  let error: string | null = null;
  const classifiers = new Set<string>();
  for (const line of lines) {
    const pathMatch = /^\s+at (\S+)$/.exec(line);
    if (pathMatch && firstPath === null) firstPath = normalizeIndices(pathMatch[1] ?? '');
    const errorMatch = /^\s+error: (.+)$/.exec(line);
    if (errorMatch && error === null) error = normalizeNumbers(errorMatch[1] ?? '');
    for (const found of line.matchAll(/(?:KNOWN OPEN APP BUG|ATTRIBUTED) \[([a-z0-9-]+)\]/g)) {
      const id = found[1];
      if (id !== undefined) classifiers.add(id);
    }
    // An absolute-invariant breach has no diff path; its text is the identity.
    const invariant = /^\s+INVARIANT: (.+)$/.exec(line);
    if (invariant && firstPath === null) firstPath = `INVARIANT:${normalizeNumbers(invariant[1] ?? '')}`;
  }

  return { headline, path: firstPath, error, classifiers: [...classifiers].sort() };
}

function normalizeNumbers(text: string): string {
  return text.replace(/\d+(\.\d+)?/g, 'N');
}

function normalizeIndices(text: string): string {
  return text.replace(/\[\d+\]/g, '[*]').replace(/\.\d+(\b|$)/g, '.N');
}

/** Do two failures name the same defect? */
export function sameSignature(a: FailureSignature, b: FailureSignature): boolean {
  return (
    a.headline === b.headline &&
    a.path === b.path &&
    a.error === b.error &&
    a.classifiers.length === b.classifiers.length &&
    a.classifiers.every((id, index) => id === b.classifiers[index])
  );
}

export function describeSignature(signature: FailureSignature): string {
  return [
    `  headline:    ${signature.headline}`,
    `  path:        ${signature.path ?? '(none)'}`,
    `  error:       ${signature.error ?? '(none)'}`,
    `  classifiers: ${signature.classifiers.length > 0 ? signature.classifiers.join(', ') : '(none)'}`,
  ].join('\n');
}

/** One line per step, for a human reading a shrunk trace. */
export function describeSteps(steps: readonly TraceStep[]): string {
  return steps
    .map((step, index) => {
      const n = String(index + 1).padStart(3, ' ');
      if (step.kind === 'mutate') return `${n}. ${step.label}`;
      if (step.kind === 'undoTo' || step.kind === 'redoTo') {
        return `${n}. ${step.kind}(${step.steps} step(s))`;
      }
      return `${n}. ${step.kind}`;
    })
    .join('\n');
}
