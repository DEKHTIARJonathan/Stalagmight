/**
 * Per-run plumbing the four fuzz scenarios used to carry one copy each of:
 * opening a replay trace, the move log a failure message ends on, writing the
 * run's trace, and the shape of the failure itself.
 *
 * `undoRedoFuzz`, `undoPersistenceFuzz`, `exportRoundtripFuzz` and
 * `importDialogFuzz` each had their own, every copy naming another as the place
 * its form came from. The texts, the order of operations and the files written
 * are unchanged; only the home moved.
 *
 * NOTHING HERE DRAWS. No helper takes a PRNG or a `ScenarioContext.rng`, and
 * none of them decides a move: they run after the decision they describe (the
 * log, the trace) or before any move is drawn (the replay check). That is the
 * property every recorded repro line depends on - a seed has to keep producing
 * the same action sequence - and it is why this could be shared at all.
 *
 * The undo-model half the two undo fuzzers share (the fused step, the model and
 * stack assertions, the epoch attribution, the save/reload boundary) is in
 * `undoFuzzHarness.ts`, because it speaks the in-page bridge's protocol and the
 * other two scenarios do not.
 */
import type { ScenarioContext } from '../scenarios/framework';
import { TraceRecorder, defaultTracePath, readTrace, writeTrace, type FuzzTrace } from './fuzzTrace';
import { replayTracePath, traceOutPath } from './fuzzKnobs';

/** What a scenario needs to know about replay, resolved once per run (or cycle). */
export interface ReplaySetup {
  /** `STALAGMIGHT_FUZZ_REPLAY`, or '' when the run draws its own moves. */
  replayPath: string;
  /** `STALAGMIGHT_FUZZ_TRACE`, or '' when a passing run writes no trace. */
  traceOut: string;
  /** The trace being replayed, already checked against this scenario and fixture. */
  replay: FuzzTrace | null;
}

/**
 * Read the replay/record knobs and, when replaying, the trace - refusing one
 * recorded by another scenario or on another fixture.
 *
 * Both refusals matter for the same reason: a trace's steps carry ids and
 * session-relative paths RESOLVED against the recording's project, so replaying
 * them elsewhere drives moves at things that do not exist there - an invented
 * failure, or a green run, either way not the recorded bug.
 *
 * `rerunWith` is the text between "...this run is on <fixture>; " and
 * `STALAGMIGHT_FUZZ_FIXTURE=` in the fixture refusal. The undo fuzzers explain
 * the ids there and the UI fuzzers do not, and both wordings are kept exactly.
 */
export function openReplay(scenario: string, fixture: string, rerunWith: string): ReplaySetup {
  const replayPath = replayTracePath();
  const traceOut = traceOutPath();
  const replay: FuzzTrace | null = replayPath ? readTrace(replayPath) : null;
  if (replay && replay.scenario !== scenario) {
    throw new Error(`trace ${replayPath} was recorded by ${replay.scenario}; run it with that scenario`);
  }
  if (replay && replay.fixture !== fixture) {
    throw new Error(
      `trace ${replayPath} was recorded on ${replay.fixture} but this run is on ${fixture}; ` +
        `${rerunWith}STALAGMIGHT_FUZZ_FIXTURE=${replay.fixture} ` +
        `(pnpm agent:scenario --trace restores it for you).`,
    );
  }
  return { replayPath, traceOut, replay };
}

/** The `rerunWith` the two undo fuzzers use. */
export const RERUN_WITH_IDS = 'its steps carry ids resolved against that project. Re-run with ';
/** The `rerunWith` the import/export UI fuzzers use. */
export const RERUN_WITH = 're-run with ';

/**
 * The run's move history, and the move that is RUNNING RIGHT NOW.
 *
 * A history line reports what a move DID, so it can only be written once the
 * move RETURNS. A move that throws instead - the step never comes back, or an
 * assertion inside it fires - then left the tail ending on the PREVIOUS move,
 * which reads as an attribution and is one: it names the wrong move. The same
 * gotcha in the Rust tier mis-read two of issue #464's defects during triage.
 * So a move is armed before it runs and disarmed after, and `tail` names an
 * armed one. Rendered on failure only, so a run that does not fail behaves
 * exactly as before and its trace is untouched.
 *
 * The three members are arrow properties so a scenario can destructure them and
 * keep calling `note(...)` / `startingMove(...)` / `finishedMove()` bare.
 */
export class MoveLog {
  readonly history: string[] = [];
  private current: string | null = null;

  readonly note = (line: string): void => {
    this.history.push(line);
  };

  readonly startingMove = (label: string): void => {
    this.current = label;
  };

  readonly finishedMove = (): void => {
    this.current = null;
  };

  /**
   * The last `limit` lines (every line when `full`), indented for a failure
   * message, plus the armed move if one had not returned.
   */
  tail(limit: number, full = false): string[] {
    const tail = (full ? this.history : this.history.slice(-limit)).map((line) => `    ${line}`);
    if (this.current !== null) tail.push(`    ${this.current} -> IN FLIGHT (had not returned)`);
    return tail;
  }
}

/** What a trace header records about the run, beyond what `ctx` already knows. */
export interface RunTraceMeta {
  scenario: string;
  iterations: number;
  fixture: string;
  stream: string;
  /** Episode indices that ran with no project open (the import fuzzer only). */
  noProjectEpisodes?: readonly number[];
}

/**
 * Write the run's trace, best-effort: a failed write must not mask the failure
 * it was written for, so it answers null instead of throwing.
 *
 * `explicitPath` wins (`STALAGMIGHT_FUZZ_TRACE`); otherwise the trace goes to
 * the session artifacts dir under a timestamped name, and with neither there is
 * nowhere to write it. Returns the path written.
 */
export function writeRunTrace(
  ctx: Pick<ScenarioContext, 'artifactsDir' | 'seed'>,
  recorder: TraceRecorder,
  meta: RunTraceMeta,
  failure: { message: string } | null,
  explicitPath: string,
): string | null {
  const target =
    explicitPath || (ctx.artifactsDir ? defaultTracePath(ctx.artifactsDir, meta.scenario, ctx.seed) : '');
  if (!target) return null;
  try {
    return writeTrace(
      target,
      recorder.build({
        scenario: meta.scenario,
        seed: ctx.seed,
        iterations: meta.iterations,
        fixture: meta.fixture,
        stream: meta.stream,
        failure,
        noProjectEpisodes: meta.noProjectEpisodes,
      }),
    );
  } catch {
    return null;
  }
}

/**
 * A failure message in the shape the undo and import fuzzers share: the
 * headline, the scenario's context lines (the `reproduce:` line first), the
 * detail block when there is one, then `  last N <tailHeading>:` and the tail.
 */
export function failureText(
  headline: string,
  context: readonly string[],
  detail: string,
  tailHeading: string,
  tail: readonly string[],
): string {
  return [headline, ...context, ...(detail ? [detail] : []), `  last ${tail.length} ${tailHeading}:`, ...tail].join(
    '\n',
  );
}

/**
 * Throw `message`, after handing it to `dumpTrace`.
 *
 * The trace carries the message VERBATIM, so a shrink compares signatures taken
 * from the same text a human reads. The trace path is appended afterwards,
 * which is why it is not part of what was recorded.
 */
export function throwFailure(message: string, dumpTrace: (failure: { message: string }) => string | null): never {
  const written = dumpTrace({ message });
  throw new Error(written ? `${message}\n  trace: ${written}` : message);
}
