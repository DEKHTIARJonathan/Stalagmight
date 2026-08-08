/**
 * import-dialog-fuzz: a seeded random walk over the DMP import flow.
 *
 * It generates `.dmp` files, hands them to the real app through the real entry
 * points, and then clicks the import UI at random - selection dialog, zero-datum
 * pair, the placement wizard, the shot-table grid, the map placement, the
 * receipt - asserting after every move that the app is still coherent, and after
 * every FLOW that the import kept its contract.
 *
 * ## The shape of a run
 *
 *   EPISODE (= one iteration)
 *     open a fresh copy of the fixture with NO inherited undo history
 *     turn auto-save off
 *     K = randInt(1, STALAGMIGHT_FUZZ_IMPORT_FLOWS_PER_EPISODE) FLOWS, with NO
 *       reload between them - state accumulates on purpose, because a second
 *       import into a project the first one changed is where the overlap, merge
 *       and renumbering paths live
 *     teardown: close, assert nothing survived, delete this episode's files
 *
 *   FLOW (= one file, from an entry point to whatever ends it)
 *     draw a starter at `idle`, then walk until the screen comes back to `idle`
 *     or the step budget runs out (`STALAGMIGHT_FUZZ_IMPORT_MAX_FLOW_STEPS`,
 *     default 140 - exhausting the cap is a METRIC, not a failure)
 *
 * ## What is asserted
 *
 * Per STEP:
 *   S1 the screen is one this build's table names (`unknown` FAILS)
 *   S2 no React error boundary
 *   S3 no project invariant breach (`fuzzOracleCore.ts`'s checker)
 *   S4 no error dialog from a move that has no business raising one
 *   S5 WEDGE: a non-idle screen with zero actionable controls
 *   plus `check_project_integrity` after any step that pushed an undo entry -
 *   `save_blocked`, or a non-finite-geometry message, is a hard failure
 *
 * Three inline expected-behaviour checks ride along with the moves that provoke
 * them, because each one is only meaningful against the state immediately
 * before its own move:
 *   RACE          a DISABLED `continue-button` must not advance the flow
 *   FROZEN DELETE an all-frozen selection must survive, and must say so
 *   IMPORT GATE   a second file routed into a screen an import owns must be
 *                 refused (#411's `importFlowOwnsScreen`)
 *
 * Per FLOW (`lib/importFlowOracles.ts`): F1 undo roundtrip, F2 residue,
 * F3 receipt-vs-project accounting, F4 receipt rendering, F5 temp files.
 *
 * Per EPISODE: E1 teardown leaves no project, dialog, placement, context or
 * generated file; E2 the next episode's fixture opens integrity-clean; E3 DOM
 * growth is recorded as a metric.
 *
 * ## Progress forcing
 *
 * A random walk over a wizard does not terminate: `toggle-alternatives` is
 * always legal and never advances anything. So a screen sat on for 8 steps gets
 * its advancing move played and one sat on for 16 gets abandoned - see
 * `importDialogModel.ts`, which also owns the ESCAPE and WEDGE oracles.
 *
 * ## Impossible moves are skipped, never asserted
 *
 * Every generator returns `null` when its control is not there, and the bridge
 * reports `absent` / `not-actionable` / `option-absent` rather than throwing.
 * That is what keeps a ddmin-cut trace RUNNABLE: a shrunk trace reaches states
 * the original run never had, and half its moves become impossible there.
 *
 * ## Record, replay, shrink
 *
 * Every executed move is recorded as a trace step (`lib/fuzzTrace.ts`, v2). A
 * failing run drops the trace beside the session artifacts and names it in the
 * failure message; `pnpm agent:scenario import-dialog-fuzz --trace FILE` replays
 * it through the same bridge and the same oracles, and `pnpm agent:fuzz-shrink`
 * minimizes it. Replay is a MODE of this scenario, never a second scenario.
 *
 * CLEANUP IS PART OF THE CONTRACT, not tidiness. `fuzz-shrink` reuses ONE live
 * app session for every ddmin candidate, so a candidate that leaves a project
 * open, a dialog up or a generated file on disk poisons the verdict of every
 * candidate after it - and ddmin would then minimize toward the leak rather than
 * toward the bug. That is why E1 ASSERTS the teardown rather than merely
 * performing it.
 *
 * A trace never carries an absolute path. Generated files travel as their SPEC
 * plus a session-relative `rel`; the one move that needs a writable directory
 * (the new-project save path) records a PLACEHOLDER that this file substitutes
 * at dispatch time. Both are the same rule `fuzzTrace.ts` states: a trace is a
 * file from wherever the reader got it, and it does not get to choose where this
 * process writes.
 *
 * ## Knobs (all read at CALL time, so a replay's restored env reaches them)
 *
 *   STALAGMIGHT_FUZZ_FIXTURE                    which `.stalx` to open
 *   STALAGMIGHT_FUZZ_IMPORT_FLOWS_PER_EPISODE   default 3
 *   STALAGMIGHT_FUZZ_IMPORT_MAX_FLOW_STEPS      default 140
 *   STALAGMIGHT_FUZZ_IMPORT_MALFORMED_P         default 0.2
 *   STALAGMIGHT_FUZZ_IMPORT_INTERJECT_P         default 0.08
 *   STALAGMIGHT_FUZZ_IMPORT_SETTLE_MS           default 12000
 *   STALAGMIGHT_FUZZ_TRACE / _REPLAY            record / replay a trace
 *
 * ## Findings
 *
 * This is the RECORD, not a to-do list, and it follows `undoRedoFuzz.ts`'s
 * conventions: every repro line is kept verbatim and stays runnable, and when a
 * finding is fixed its entry names the commit and becomes that fix's regression
 * check. Do NOT add a classifier or a tolerance to turn a red green - this file
 * has neither, and that is the whole discipline it inherits.
 *
 * 1. OPEN. THE IMPORT WIZARD BECOMES AN INVISIBLE MODAL, PERMANENTLY.
 *
 *        pnpm agent:scenario import-dialog-fuzz --seed 7 --iterations 8
 *
 *    Found on the scenario's first real run, and `pnpm agent:fuzz-shrink` cut
 *    the 124-step trace to FIVE steps (83 replays, 1-minimal, 0 divergent):
 *
 *        1. generate a VALID .dmp                (no malformed input involved)
 *        2. import it                            (router or toolbar, either)
 *        3. continue                             (the default whole-file selection)
 *        4. skip zero datum
 *        5. accept the first suggestion          (confirm-button)
 *
 *    What is then true, and stays true: `activeDialog` is `'dmp-import-new'`,
 *    the wizard subtree is MOUNTED with `wizard-manual-placing` rendered, and
 *    the whole thing sits under a `display:none` ancestor - the digest measures
 *    `display=flex visibility=visible 0x0` on the dialog root, which is what a
 *    `display:none` PARENT produces on a descendant. `DialogWrapper` sets
 *    `display:none` in exactly one place, its `hidden` prop, and
 *    `DmpNewImportDialog` passes `hidden={autoStartManualPlacementPending}`.
 *
 *    So the flag never clears. It is set true at the `manual_placing`
 *    transition and cleared in exactly ONE place - inside
 *    `handleStartSegmentPlacement`, AFTER two early returns - and the effect
 *    that calls it (`autoStartManualPlacementPending && phase === 'manual_placing'
 *    && currentSegment && segmentAnchor && !isImporting`, via `setTimeout(0)`)
 *    has no dependency that changes on a refusal, so it never retries.
 *
 *    NOT the documented incomplete-shots refusal. That was the first suspect -
 *    `handleStartSegmentPlacement` opens with `if (refuseIncompleteShots()) return;`
 *    and the fuzzer's grid generators produce blank rows - but the minimal trace
 *    contains NO grid edit, and the failure payload records `toasts: []` where
 *    that path would have raised `dmp-wizard-incomplete`. The remaining
 *    candidate is the effect's own cleanup: `handleStartSegmentPlacement` is in
 *    its dependency array, so if that callback's identity changes on every
 *    render the cleanup clears the pending `setTimeout(0)` before it can fire,
 *    and the placement is starved rather than refused.
 *
 *    Why it matters: this is not a cosmetic hidden dialog. `activeDialog` stays
 *    set, so `useKeyboardShortcuts` swallows every shortcut; `DialogWrapper`'s
 *    Escape handler is an `onKeyDown` on the `display:none` container, which
 *    nothing inside can focus, so Escape cannot reach it either. The user sees
 *    the map, cannot import, cannot use a shortcut, and has no control to click.
 *    The only way out is to kill the app.
 *
 *    Verified permanent, not slow: replaying the minimal trace with
 *    `STALAGMIGHT_FUZZ_IMPORT_SETTLE_MS=60000` fails identically, so the app had
 *    a full minute to finish the transition.
 *
 * 2. OPEN. A COMPLETED DMP IMPORT LEAVES `importContext` SET.
 *
 *        pnpm agent:scenario import-dialog-fuzz --seed 1 --iterations 2
 *
 *    Shrunk from 37 steps to SEVEN (30 replays, budget-bounded, 0 divergent):
 *
 *        1. generate a VALID .dmp
 *        2. import it via the toolbar
 *        3. continue
 *        4. skip zero datum
 *        5. Escape                      (leaves the auto-started placement)
 *        6. place segment on map
 *        7. click the map               (the placement completes the import)
 *
 *    F2 then reports `importContext="existing-project" after a COMPLETED
 *    import`, and that is the app's own contract being broken rather than this
 *    oracle inventing one. `completeImportToSingleView` (`utils/saveFeedback.ts`)
 *    says so in as many words - "This is also where the import flow ENDS, so it
 *    is where `importContext` is dropped. Left set, it outlives its flow" - and
 *    every other importer (TML, Compass, Walls, GPX, and both failure paths via
 *    `surfaceImportFailure`) goes through it.
 *
 *    The DMP wizard does not. Its `onComplete` in `App.tsx` hand-rolls the same
 *    exit sequence inline - `closeDialog(); setView('single');
 *    triggerFitToBounds(); presentImportReceipt(...)` - and omits the one line
 *    that drops the context.
 *
 *    That this is a defect and not a choice is settled by the sibling branch:
 *    `OrphanPlacementDialog.finish()` calls `setImportContext(null)` explicitly,
 *    with a comment saying it "never reaches completeImportToSingleView, which
 *    drops the context on the other one", spelling out the consequence, and
 *    pointing at #435 for the duplicated exit sequence itself. So the leak was
 *    identified and fixed on the ORPHAN branch and left in place on the branch
 *    taken when there are no orphan suggestions - which is the common one.
 *
 *    Blast radius, stated honestly: `routeOpenedFile` resets the context at the
 *    entry of every import flow, so the "next import inherits it" scenario its
 *    own comment describes is largely headed off by the router. What is left is
 *    a stale value visible to anything that reaches `saveAfterImport` WITHOUT
 *    going through the router - which is exactly the situation the orphan branch
 *    was fixed for.
 *
 *    F2 stays strict. This scenario is consequently RED on seeds that complete a
 *    DMP import, and that is the delete-when-fixed contract working: the oracle
 *    does not move, the app does.
 */
import * as fs from 'fs';
import * as path from 'path';

import { mulberry32, type Scenario, type ScenarioContext } from './framework';
import { DEFAULT_FIXTURE, disableAutoSave, loadFixtureWithoutUndoHistory } from './common';
import { ORACLE_GLOBAL, oracleInjectionSource } from '../lib/fuzzOracleCore';
import { mapClick } from '../lib/controls';
import {
  defaultTracePath,
  readTrace,
  TraceRecorder,
  writeTrace,
  type FuzzTrace,
  type TraceStep,
} from '../lib/fuzzTrace';
import { materializeSurveyFile, randomDmpSpec, type GeneratedFileSpec } from '../lib/surveyFileSpecs';
import type { ImportScreenDigest } from '../lib/importScreenDigest';
import {
  checkAccounting,
  checkPushed,
  checkReceipt,
  checkResidue,
  checkRoundtripState,
  checkTempFiles,
  ImportOracleError,
  leftoverTempNames,
  receiptClaimFrom,
  type FlowBounds,
  type FlowShape,
  type ReceiptClaim,
} from '../lib/importFlowOracles';
import {
  ADVANCE_MOVE,
  ESCAPE_BUDGET,
  ESCAPE_PATH,
  isEscaped,
  progressMode,
  WEDGE_EXEMPT_SCREENS,
  type ScreenId,
} from './importDialogModel';
import {
  answerFileDialogInPage,
  dismissFirstRunModal,
  injectScreenDigest,
  observeScreen,
  routeFile,
  runUiStep,
  type Move,
} from './importDialogBridge';
import {
  buildInterjection,
  drawInterjection,
  interjectProbability,
  INTERJECT_STREAM_SALT,
  PROJECT_DIR_PLACEHOLDER,
  weightedFor,
  type FileSource,
  type FuzzMove,
  type GenEnv,
} from './importDialogGenerators';

const SCENARIO = 'import-dialog-fuzz';
/** Session-relative homes for what a run writes. Both are wiped per episode. */
const FILES_REL = 'fuzz-files';
const PROJECTS_REL = 'fuzz-projects';
/** Attempts to leave `idle` before a flow gives up and is counted as skipped. */
const START_ATTEMPTS = 4;
/** Failure messages print this many trailing moves. */
const HISTORY_TAIL = 25;
/** Specs the writer/parser drift detector pushes through `import_dmp`. */
const SELF_CHECK_SPECS = 6;
/**
 * Share of episodes that run with NO project open.
 *
 * Fixed rather than a knob: it is a coverage split, not something a repro would
 * want to vary, and every seed's trajectory depends on it.
 */
const NO_PROJECT_EPISODE_P = 0.3;

// ---------------------------------------------------------------------------
// Knobs. Read at CALL time, never frozen at import: a replay restores the
// recording's environment AFTER this module is loaded (see scenario-run.ts).
// ---------------------------------------------------------------------------

function fixtureName(): string {
  return process.env.STALAGMIGHT_FUZZ_FIXTURE || DEFAULT_FIXTURE;
}
function flowsPerEpisode(): number {
  const raw = Number(process.env.STALAGMIGHT_FUZZ_IMPORT_FLOWS_PER_EPISODE);
  return Number.isInteger(raw) && raw > 0 ? raw : 3;
}
function maxFlowSteps(): number {
  const raw = Number(process.env.STALAGMIGHT_FUZZ_IMPORT_MAX_FLOW_STEPS);
  return Number.isInteger(raw) && raw > 0 ? raw : 140;
}
function replayTracePath(): string {
  return process.env.STALAGMIGHT_FUZZ_REPLAY ?? '';
}
function traceOutPath(): string {
  return process.env.STALAGMIGHT_FUZZ_TRACE ?? '';
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Clicks that may legitimately raise the error dialog, so S4 exempts them.
 *
 * Every one of them re-enters the open/import ROUTER (or creates a project),
 * and a malformed file or an unwritable path there is a reported error, not a
 * defect. Nothing else on the flow has any business producing one.
 */
const ERROR_PRODUCING: ReadonlySet<string> = new Set([
  'create-and-continue-button',
  'import-blocked-switch',
  'import-as-new-project-confirm',
  'retry-button',
]);

function mayRaiseError(move: FuzzMove): boolean {
  if (move.kind === 'openFile' || move.kind === 'cancelDialog') return true;
  if (move.kind === 'ui') return ERROR_PRODUCING.has(move.testid);
  return false;
}

/** `mutate` actions a REPLAYED trace may drive - the DOM allowlist's twin. */
const REPLAYABLE_UI_ACTIONS: ReadonlySet<string> = new Set(['ui:confirmPlacement']);

function actionableCount(digest: ImportScreenDigest): number {
  let count = 0;
  for (const state of Object.values(digest.live)) if (state === 2) count += 1;
  return count;
}

/** Bounds a flow is measured between. */
interface Bounds extends FlowBounds {
  /** The project's own file path, so a flow that SWAPPED projects is visible. */
  projectFile: string | null;
}

// ---------------------------------------------------------------------------

export const importDialogFuzz: Scenario = {
  name: SCENARIO,
  description:
    'Generates .dmp files and walks the real DMP import UI at random, asserting per-step coherence ' +
    'and a per-flow undo roundtrip, residue, accounting, receipt and temp-file contract.',
  defaultIterations: 3,

  async run(ctx: ScenarioContext, { iterations }): Promise<void> {
    const fixture = fixtureName();
    const sessionDir = ctx.artifactsDir;
    if (!sessionDir) {
      throw new Error(`${SCENARIO} needs a session artifacts dir to write its generated files into`);
    }
    const filesDir = path.join(sessionDir, FILES_REL);
    const projectsDir = path.join(sessionDir, PROJECTS_REL);

    const replayPath = replayTracePath();
    const traceOut = traceOutPath();
    const replay: FuzzTrace | null = replayPath ? readTrace(replayPath) : null;
    if (replay && replay.scenario !== SCENARIO) {
      throw new Error(`trace ${replayPath} was recorded by ${replay.scenario}; run it with that scenario`);
    }
    // The recorded steps carry ids and rels resolved against THAT project, so
    // replaying them elsewhere drives moves at things that do not exist there:
    // an invented failure, or a green run, either way not the recorded bug.
    if (replay && replay.fixture !== fixture) {
      throw new Error(
        `trace ${replayPath} was recorded on ${replay.fixture} but this run is on ${fixture}; ` +
          `re-run with STALAGMIGHT_FUZZ_FIXTURE=${replay.fixture} ` +
          `(pnpm agent:scenario --trace restores it for you).`,
      );
    }

    const recorder = new TraceRecorder();
    const history: string[] = [];
    let inFlight: string | null = null;
    let fileSeq = 0;
    let lastUndoDepth = -1;

    const dumpTrace = (failure: { message: string } | null): string | null => {
      const target = traceOut || defaultTracePath(sessionDir, SCENARIO, ctx.seed);
      try {
        return writeTrace(
          target,
          recorder.build({
            scenario: SCENARIO,
            seed: ctx.seed,
            iterations,
            fixture,
            stream: 'dmp-v1',
            failure,
          }),
        );
      } catch {
        return null;
      }
    };

    /**
     * Annotated on the CONST so TypeScript treats a `fail(...)` call as
     * never-returning - the same form `undoRedoFuzz.ts` uses, for the same
     * reason (a caller ending in one needs no dead `return` after it).
     */
    const fail: (headline: string, detail?: string) => never = (headline, detail = '') => {
      const tail = history.slice(-HISTORY_TAIL).map((line) => `    ${line}`);
      // A move that has not RETURNED has no history line yet, so name it here:
      // without this the tail ends on the move BEFORE the one that failed, which
      // reads as an attribution and is one.
      if (inFlight !== null) tail.push(`    ${inFlight} -> IN FLIGHT (had not returned)`);
      const message = [
        headline,
        `  reproduce: pnpm agent:scenario ${SCENARIO} --seed ${ctx.seed} --iterations ${iterations}` +
          `${fixture === DEFAULT_FIXTURE ? '' : ` with STALAGMIGHT_FUZZ_FIXTURE=${fixture}`}` +
          `${replayPath ? ` (REPLAY of ${replayPath})` : ''}`,
        `  fixture=${fixture} flowsPerEpisode=${flowsPerEpisode()} maxFlowSteps=${maxFlowSteps()}`,
        ...(detail ? [detail] : []),
        `  last ${tail.length} move(s):`,
        ...tail,
      ].join('\n');
      // The trace carries the message VERBATIM, so a shrink compares signatures
      // taken from the same text a human reads.
      const written = dumpTrace({ message });
      throw new Error(written ? `${message}\n  trace: ${written}` : message);
    };

    // ---- paths -----------------------------------------------------------

    /**
     * A session-relative `rel` as an absolute path.
     *
     * A tracked fixture is named by `fixtures/<basename>` and resolved through
     * `ctx.fixturePath`, which materializes a COPY into exactly that directory.
     * So one rel means the same file on any machine, without the trace carrying
     * a fixture (which the repo forbids) or an absolute path.
     */
    const resolveRel = (rel: string): string =>
      rel.startsWith('fixtures/') ? ctx.fixturePath(path.basename(rel)) : path.join(sessionDir, rel);

    const materialize = (spec: GeneratedFileSpec, rel: string): string => {
      const target = resolveRel(rel);
      const named: GeneratedFileSpec = { ...spec, name: path.basename(target) };
      materializeSurveyFile(path.dirname(target), named);
      return target;
    };

    /** Absolute path of a source's file, or null when it is not on disk. */
    const sourceOnDisk = (source: FileSource): string | null => {
      if (source.origin === 'gen') return materialize(source.spec, source.rel);
      if (source.origin === 'fixture') return ctx.fixturePath(source.name);
      const target = resolveRel(source.rel);
      return fs.existsSync(target) ? target : null;
    };

    /**
     * Substitute the real projects directory for the placeholder a generator
     * emits. Applied at DISPATCH, never before recording, so the trace keeps
     * the placeholder and a replayed file cannot pick where a `.stalx` lands.
     */
    const dispatchable = (move: FuzzMove): FuzzMove => {
      if (move.kind !== 'input' || move.value !== PROJECT_DIR_PLACEHOLDER) return move;
      fs.mkdirSync(projectsDir, { recursive: true });
      return { ...move, value: path.join(projectsDir, `import-${ctx.seed}-${fileSeq}.stalx`) };
    };

    /** The map's current centre, so a placement click lands on the survey. */
    const mapCentre = async (): Promise<[number, number] | null> =>
      ctx.eval<[number, number] | null>(`
        const map = window.__stalagmight_map__;
        if (!map || typeof map.getCenter !== 'function') return null;
        const centre = map.getCenter();
        return [centre.lng, centre.lat];
      `);

    // ---- move execution --------------------------------------------------

    interface Executed {
      digest: ImportScreenDigest;
      performed: boolean;
      skip: string | null;
    }

    /** Run one move, record it if it happened, and report the screen after. */
    const execute = async (move: FuzzMove, record: boolean): Promise<Executed> => {
      inFlight = move.label;
      let performed = false;
      let skip: string | null = null;
      let digest: ImportScreenDigest;

      if (move.kind === 'ui') {
        const outcome = await runUiStep(ctx, move as Move);
        performed = outcome.performed;
        skip = outcome.reason;
        digest = outcome.digest;
        ctx.metric('bridgeActionMs', outcome.timing.actionMs);
        ctx.metric('bridgeSettleMs', outcome.timing.settleMs);
        ctx.metric('bridgeDigestMs', outcome.timing.digestMs);
        if (record && performed) {
          recorder.record(
            move.double === true
              ? { kind: 'ui', testid: move.testid, double: true, label: move.label }
              : { kind: 'ui', testid: move.testid, label: move.label },
          );
        }
      } else if (move.kind === 'input') {
        // The dispatched value may carry a substituted path; the RECORDED one
        // never does - see `dispatchable`.
        const outcome = await runUiStep(ctx, dispatchable(move) as Move);
        performed = outcome.performed;
        skip = outcome.reason;
        digest = outcome.digest;
        ctx.metric('bridgeActionMs', outcome.timing.actionMs);
        ctx.metric('bridgeSettleMs', outcome.timing.settleMs);
        ctx.metric('bridgeDigestMs', outcome.timing.digestMs);
        if (record && performed) {
          recorder.record({
            kind: 'input',
            testid: move.testid,
            value: move.value,
            mode: move.mode,
            label: move.label,
          });
        }
      } else if (move.kind === 'openFile') {
        const live = move;
        const absolute = sourceOnDisk(live.source);
        if (absolute === null) {
          // Only reachable on a REPLAY whose `genFile` step ddmin cut away.
          skip = 'file-missing';
          digest = await observeScreen(ctx, false);
        } else {
          if (record && live.source.origin === 'gen') {
            recorder.record({
              kind: 'genFile',
              spec: live.source.spec,
              rel: live.source.rel,
              label: `${live.source.spec.profile} ${live.source.spec.format}`,
            });
          }
          const rel = live.source.rel;
          if (live.via === 'route') {
            const routed = await routeFile(ctx, absolute);
            if (!routed) fail('the E2E routeOpenedFile hook is missing; rebuild with VITE_E2E=1');
            performed = true;
            if (record) recorder.record({ kind: 'route', rel, label: move.label });
            digest = await observeScreen(ctx);
          } else {
            const answered = await answerFileDialogInPage(ctx, live.trigger, 'open', absolute);
            performed = answered.performed;
            skip = answered.reason;
            digest = answered.digest;
            if (performed && !answered.consumed) ctx.metric('dialogAnswerUnconsumed');
            if (record && performed) {
              recorder.record({ kind: 'fileDialog', trigger: live.trigger, dialog: 'open', rel, label: move.label });
            }
          }
        }
      } else if (move.kind === 'cancelDialog') {
        const live = move;
        const answered = await answerFileDialogInPage(ctx, live.trigger, 'open', null);
        performed = answered.performed;
        skip = answered.reason;
        digest = answered.digest;
        if (record && performed) {
          recorder.record({ kind: 'fileDialog', trigger: live.trigger, dialog: 'open', rel: null, label: move.label });
        }
      } else if (move.kind === 'mapClick') {
        const live = move;
        // A relative draw is resolved HERE and recorded ABSOLUTE: replay must
        // click the same geographic point, not the same offset from whatever
        // camera the replay happens to have.
        const centre = live.relative === true ? await mapCentre() : [0, 0];
        const at: [number, number] =
          centre === null
            ? live.lngLat
            : [live.lngLat[0] + (centre[0] as number), live.lngLat[1] + (centre[1] as number)];
        try {
          await ctx.exclusive(() => mapClick(ctx.browser, at));
          performed = true;
          if (record) recorder.record({ kind: 'mapClick', lngLat: at, label: move.label });
        } catch (err) {
          // Outside the viewport, or no map on this screen. Both are ordinary
          // impossible moves - skipped and counted, exactly like an absent
          // testid - because a shrunk trace reaches states with a different
          // camera and would otherwise die at the first recorded click.
          skip = 'map-unavailable';
          ctx.metric(`mapSkip:${err instanceof Error ? err.message.slice(0, 32) : 'unknown'}`);
        }
        digest = await observeScreen(ctx);
      } else if (move.kind === 'confirmPlacement') {
        const res = await ctx.callAction('ui', 'confirmPlacement', []);
        performed = res.ok;
        if (!res.ok) skip = 'confirm-refused';
        if (record && performed) {
          recorder.record({ kind: 'mutate', action: 'ui:confirmPlacement', args: [], label: move.label });
        }
        digest = await observeScreen(ctx);
      } else if (move.kind === 'undo' || move.kind === 'redo') {
        const which = move.kind;
        const res = await ctx.callAction('project', which, []);
        performed = res.ok;
        if (!res.ok) skip = `${which}-refused`;
        if (record && performed) recorder.record(which === 'undo' ? { kind: 'undo' } : { kind: 'redo' });
        digest = await observeScreen(ctx);
      } else {
        fs.mkdirSync(projectsDir, { recursive: true });
        const target = path.join(projectsDir, `flow-save-${ctx.seed}.stalx`);
        const res = await ctx.callAction('project', 'saveProject', [target]);
        performed = res.ok;
        if (!res.ok) skip = 'save-refused';
        if (record && performed) recorder.record({ kind: 'save' });
        digest = await observeScreen(ctx);
      }

      inFlight = null;
      history.push(`${move.label}${performed ? '' : ` -> SKIPPED (${skip ?? 'unknown'})`} [${digest.screen}]`);
      ctx.metric(performed ? 'movesPerformed' : `skip:${skip ?? 'unknown'}`);
      return { digest, performed, skip };
    };

    // ---- per-step oracles ------------------------------------------------

    const stepOracles = async (move: FuzzMove, digest: ImportScreenDigest): Promise<void> => {
      if (digest.boundary) {
        fail('S2 ERROR BOUNDARY: the React tree crashed', `  after: ${move.label}`);
      }
      if (digest.screen === 'unknown') {
        fail(
          // The dialog name is IN THE HEADLINE, not in the detail, because
          // `failureSignature` builds a shrink's target from the first line: a
          // generic "unknown screen" headline matches every unknown screen, and
          // ddmin then accepts a candidate that fails on a different one.
          `S1 UNKNOWN SCREEN ${JSON.stringify(digest.dialog)}: a dialog is up that this build's ` +
            'screen table does not name',
          `  activeDialog=${JSON.stringify(digest.dialog)} after: ${move.label}\n` +
            `  dom: ${digest.why}\n` +
            // Toast KEYS, not text: they are i18n-independent, and a refusal
            // toast is usually the whole explanation for a screen that stopped
            // moving (the wizard's guards refuse silently apart from these).
            `  toasts: ${JSON.stringify(digest.toast)}`,
        );
      }
      if (digest.inv.length > 0) {
        fail(
          'S3 INVARIANT: the project is not well-formed',
          [`  after: ${move.label}`, ...digest.inv.map((line) => `  INVARIANT: ${line}`)].join('\n'),
        );
      }
      if (digest.screen === 'error' && !mayRaiseError(move)) {
        fail(
          'S4 UNEXPECTED ERROR DIALOG: a move with no business failing raised one',
          `  after: ${move.label}\n  error: ${digest.err ?? '(no text)'}`,
        );
      }
      if (digest.screen !== 'idle' && !WEDGE_EXEMPT_SCREENS.has(digest.screen) && actionableCount(digest) === 0) {
        fail(
          `S5 WEDGE on "${digest.screen}": no actionable control anywhere in the inventory`,
          `  screen=${digest.screen} activeDialog=${JSON.stringify(digest.dialog)} after: ${move.label}`,
        );
      }
      ctx.metric(`screen:${digest.screen}`);

      // An import commits through `import_sections`, which pushes exactly one
      // undo entry per call - so a rise in depth is the cheap signal that
      // something landed, and the moment to pay for the structural check.
      if (digest.undo >= 0 && lastUndoDepth >= 0 && digest.undo > lastUndoDepth) {
        ctx.metric('undoEntriesPushed', digest.undo - lastUndoDepth);
        const verdict = (await ctx.ipc('check_project_integrity')) as {
          save_blocked?: boolean;
          messages?: string[];
        } | null;
        const messages = verdict?.messages ?? [];
        const nonFinite = messages.filter((line) => line.includes('non-finite'));
        if (verdict?.save_blocked === true || nonFinite.length > 0) {
          fail(
            'INTEGRITY: an import left the project in a state the app refuses to save',
            [
              `  after: ${move.label}`,
              `  save_blocked=${verdict?.save_blocked === true}`,
              ...messages.slice(0, 8).map((line) => `  ${line}`),
            ].join('\n'),
          );
        }
      }
      if (digest.undo >= 0) lastUndoDepth = digest.undo;
    };

    /**
     * Run a FLOW oracle through `fail`.
     *
     * The oracles in `lib/importFlowOracles.ts` throw on their own, which is
     * right - they are the contract - but a raw throw loses the three things
     * that make a failure actionable: the `reproduce:` line, the tail of moves
     * that produced it, and the dropped trace. Every F-check goes through here
     * so a flow failure reads exactly like a step failure.
     */
    const guarded = <T>(what: () => T): T => {
      try {
        return what();
      } catch (err) {
        if (err instanceof ImportOracleError) fail(err.message);
        throw err;
      }
    };

    /**
     * Play a screen's escape path until the walk is back at `idle`.
     *
     * The budget is absolute. A user who cannot leave a dialog has no other
     * recourse, so neither does this: an escape that has not landed inside
     * `ESCAPE_BUDGET` forced moves FAILS the run.
     */
    const escapeFrom = async (from: ImportScreenDigest): Promise<ImportScreenDigest> => {
      let digest = from;
      for (let attempt = 0; attempt < ESCAPE_BUDGET; attempt += 1) {
        if (isEscaped(digest.screen, digest.placement)) return digest;
        const route = ESCAPE_PATH[digest.screen] ?? ['key:Escape'];
        const testid =
          route.find((candidate) => candidate.startsWith('key:') || digest.live[candidate] === 2) ?? 'key:Escape';
        const move: FuzzMove = { kind: 'ui', testid, label: `ESCAPE ${digest.screen} via ${testid}` };
        ctx.metric('escapeMoves');
        const outcome = await execute(move, true);
        digest = outcome.digest;
        await stepOracles(move, digest);
      }
      if (isEscaped(digest.screen, digest.placement)) return digest;
      fail(
        `ESCAPE: could not leave "${digest.screen}" in ${ESCAPE_BUDGET} forced move(s)`,
        `  activeDialog=${JSON.stringify(digest.dialog)} placement=${digest.placement}\n` +
          `  path tried: ${JSON.stringify(ESCAPE_PATH[digest.screen] ?? [])}`,
      );
    };

    // ---- flow bookkeeping ------------------------------------------------

    const canonicalNow = async (has: boolean): Promise<string | null> => {
      if (!has) return null;
      return ctx.eval<string | null>(`
        const O = globalThis.${ORACLE_GLOBAL};
        if (!O) throw new Error('fuzz oracle is not injected');
        const core = window.__TAURI__ && window.__TAURI__.core;
        const state = await core.invoke('get_project_state');
        return state === null || state === undefined ? null : O.canonical(state, false);
      `);
    };

    const projectFilePath = async (): Promise<string | null> =>
      ctx.eval<string | null>(
        'const p = window.__E2E_TEST__.projectStore.getState().project; return p && p.file_path ? p.file_path : null;',
      );

    const boundsNow = async (digest: ImportScreenDigest): Promise<Bounds> => {
      const file = await projectFilePath();
      const leftovers = leftoverTempNames(file);
      return {
        snapshot: await canonicalNow(digest.hasProject),
        undoDepth: digest.undo,
        sections: digest.sections,
        shots: digest.shots,
        projectDir: leftovers.dir,
        leftovers: leftovers.names,
        projectFile: file,
      };
    };

    // ---- move sources ----------------------------------------------------

    const interjectRng = mulberry32((ctx.seed ^ INTERJECT_STREAM_SALT) >>> 0);

    const genEnv = (digest: ImportScreenDigest): GenEnv => ({ ctx, digest, filesRel: FILES_REL, fileSeq });

    const drawMove = (digest: ImportScreenDigest, mode: 'draw' | 'advance'): FuzzMove | null => {
      if (mode === 'advance') {
        const testid = ADVANCE_MOVE[digest.screen];
        if (testid !== undefined && digest.live[testid] === 2) {
          ctx.metric('forcedAdvance');
          return { kind: 'ui', testid, label: `FORCED advance on ${digest.screen}` };
        }
        ctx.metric('forcedAdvanceUnavailable');
      }
      // Interjections come off their OWN stream, so adding one later does not
      // shift the trajectory every existing repro line depends on.
      if (interjectRng() < interjectProbability()) {
        const kind = drawInterjection(interjectRng);
        const move = buildInterjection(kind, genEnv(digest));
        if (move !== null) {
          ctx.metric(`interject:${kind}`);
          if (move.kind === 'openFile') fileSeq += 1;
          return move;
        }
      }
      const pool = weightedFor(digest.screen);
      if (pool.length === 0) {
        ctx.metric(`noGenerators:${digest.screen}`);
        return null;
      }
      // Up to 8 draws before giving up: on a screen whose controls are mostly
      // absent most generators legitimately return null, and one draw would
      // report a screen as generator-less when it is not.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const generator = pool[Math.floor(ctx.rng() * pool.length)];
        if (!generator) continue;
        const move = generator.build(genEnv(digest));
        if (move === null) continue;
        ctx.metric(`gen:${generator.name}`);
        if (move.kind === 'openFile') fileSeq += 1;
        return move;
      }
      ctx.metric(`noMove:${digest.screen}`);
      return null;
    };

    /** A replayed file reference: the bytes are already on disk at `rel`. */
    const replaySource = (rel: string): FileSource =>
      rel.startsWith('fixtures/')
        ? { origin: 'fixture', name: path.basename(rel), rel }
        : { origin: 'disk', rel };

    /** Turn a recorded step back into a move, or null when it is not one. */
    const moveFromStep = (step: TraceStep): FuzzMove | null => {
      switch (step.kind) {
        case 'ui':
          return step.double === true
            ? { kind: 'ui', testid: step.testid, double: true, label: step.label }
            : { kind: 'ui', testid: step.testid, label: step.label };
        case 'input':
          return { kind: 'input', testid: step.testid, value: step.value, mode: step.mode, label: step.label };
        case 'route':
          return {
            kind: 'openFile',
            source: replaySource(step.rel),
            via: 'route',
            trigger: 'routeOpenedFile',
            label: step.label,
          };
        case 'fileDialog':
          if (step.rel === null) return { kind: 'cancelDialog', trigger: step.trigger, label: step.label };
          return {
            kind: 'openFile',
            source: replaySource(Array.isArray(step.rel) ? (step.rel[0] as string) : step.rel),
            via: 'dialog',
            trigger: step.trigger,
            label: step.label,
          };
        case 'mapClick':
          return { kind: 'mapClick', lngLat: step.lngLat, label: step.label };
        case 'undo':
          return { kind: 'undo', label: 'replay undo' };
        case 'redo':
          return { kind: 'redo', label: 'replay redo' };
        case 'save':
          return { kind: 'save', label: 'replay save' };
        case 'mutate':
          // The store-action twin of the DOM allowlist: a trace names an action,
          // and only the one this scenario produces may be dispatched.
          if (!REPLAYABLE_UI_ACTIONS.has(step.action)) {
            throw new Error(
              `refusing to replay mutate "${step.action}": ${SCENARIO} only replays ` +
                `${[...REPLAYABLE_UI_ACTIONS].join(', ')}`,
            );
          }
          return { kind: 'confirmPlacement', label: step.label };
        default:
          return null;
      }
    };

    // ---- injection + generator self-check ---------------------------------

    await ctx.eval<boolean>(`${oracleInjectionSource()}\nreturn true;`);
    await injectScreenDigest(ctx);
    // A fresh profile opens behind the first-run telemetry modal, which is
    // rendered outside `activeDialog` and covers the toolbar. Clear it once here
    // rather than spending a flow on it; the model still knows the screen, so a
    // reappearance mid-run is handled rather than mistaken for `idle`.
    if (await dismissFirstRunModal(ctx)) ctx.setMetric('dismissedFirstRunModal', 1);

    /**
     * WRITER/PARSER DRIFT DETECTOR.
     *
     * `surveyFileWriters.ts` encodes what the Rust parser decodes. If the two
     * ever disagree, every generated file is rejected at the door and the whole
     * scenario passes GREEN having exercised nothing but the error dialog. So
     * valid-biased specs are written and pushed through the REAL `import_dmp`
     * command before any fuzzing starts, and a disagreement is the scenario's
     * own failure rather than a quiet loss of coverage.
     */
    {
      const probeDir = path.join(filesDir, 'selfcheck');
      const probeRng = mulberry32((ctx.seed ^ 0x5bd1e995) >>> 0);
      for (let i = 0; i < SELF_CHECK_SPECS; i += 1) {
        const spec: GeneratedFileSpec = {
          format: 'dmp',
          name: `selfcheck-${i}.dmp`,
          profile: 'valid',
          dmp: randomDmpSpec(probeRng, 'valid'),
        };
        const { path: written } = materializeSurveyFile(probeDir, spec);
        const parsed = (await ctx.ipc('import_dmp', { path: written })) as { sections?: unknown[] } | null;
        const found = parsed && Array.isArray(parsed.sections) ? parsed.sections.length : -1;
        if (found !== spec.dmp.sections.length) {
          throw new Error(
            `GENERATOR SELF-CHECK failed on ${written}: the writer emitted ` +
              `${spec.dmp.sections.length} section(s) and import_dmp read ${found}. ` +
              'surveyFileWriters.ts has drifted from the Rust parser; every generated file would be ' +
              'rejected at the door and this run would pass green having exercised nothing.',
          );
        }
      }
      ctx.setMetric('selfCheckSpecs', SELF_CHECK_SPECS);
      fs.rmSync(probeDir, { recursive: true, force: true });
    }

    /**
     * Put the app and the disk back to a usable state, whatever happened.
     *
     * Best-effort and unconditional, and it is what makes `fuzz-shrink` sound.
     * The shrinker reuses ONE live session for every ddmin candidate, and a
     * candidate that FAILS never reaches its episode teardown - so without this
     * it leaves the project open, a dialog up and its generated `.dmp` files on
     * disk, and the next candidate inherits all of it. That is not a tidiness
     * problem: it makes later candidates fail (or pass) for reasons their own
     * trace does not contain, and ddmin then minimizes toward the leak instead
     * of toward the bug. Measured, not theorised - the first shrink of the
     * wizard-hidden finding cut 124 steps to 1, and that survivor passed
     * cleanly when replayed on its own.
     */
    const forceClean = async (): Promise<void> => {
      await ctx.callAction('ui', 'cancelPlacementMode', []).catch(() => undefined);
      await ctx.callAction('ui', 'closeDialog', []).catch(() => undefined);
      await ctx.callAction('ui', 'setImportContext', [null]).catch(() => undefined);
      await ctx.callAction('project', 'closeProject', []).catch(() => undefined);
      for (const dir of [filesDir, projectsDir]) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // A file the app still holds open is not worth failing a cleanup for.
        }
      }
    };

    // ---- the run ----------------------------------------------------------

    const replaySteps = replay ? replay.steps : null;
    let replayAt = 0;

    /** The episode loop. Extracted so `forceClean` can wrap it in a finally. */
    const runEpisodes = async (): Promise<void> => {
    for (let episode = 0; episode < iterations; episode += 1) {
      await loadFixtureWithoutUndoHistory(ctx, fixture);
      if (!(await disableAutoSave(ctx))) {
        throw new Error('could not turn auto-save off; a timer firing mid-run would change unmodelled state');
      }
      // E2: the fixture this episode starts from must itself be sound, or every
      // integrity verdict inside it is measured from a broken floor.
      const opening = (await ctx.ipc('check_project_integrity')) as {
        save_blocked?: boolean;
        messages?: string[];
      } | null;
      if (opening?.save_blocked === true) {
        throw new Error(
          `E2 INTEGRITY: ${fixture} opened SAVE-BLOCKED at the start of episode ${episode + 1}: ` +
            JSON.stringify(opening.messages ?? []),
        );
      }
      const domBefore = await ctx.eval<number>('return document.querySelectorAll("*").length;');

      // Some episodes run with NO project open, which is a different import
      // flow, not a smaller one: a `.dmp` with nothing loaded routes to
      // `new-project-for-import` instead of the selection dialog, so it is the
      // only way to reach `importContext='new-project'` and the DEFERRED
      // initial save that context selects. The fixture is still opened first,
      // so E2's integrity check on it runs either way.
      const headless = !replaySteps && ctx.rng() < NO_PROJECT_EPISODE_P;
      if (headless) {
        await ctx.callAction('project', 'closeProject', []).catch(() => undefined);
        ctx.metric('episodeWithoutProject');
      }

      let digest = await observeScreen(ctx, false);
      lastUndoDepth = digest.undo;

      // A replay is ONE pass over the recorded steps; the recording's own flow
      // boundaries are not replayed, they are re-derived from the screen.
      const flows = replaySteps ? 1 : ctx.randInt(1, flowsPerEpisode());
      for (let flow = 0; flow < flows; flow += 1) {
        const before = await boundsNow(digest);
        let receipt: ReceiptClaim | null = null;
        let sawCommit = false;
        let historyTouched = false;
        let leftIdle = false;
        let steps = 0;
        let stepsOnScreen = 0;
        let previousScreen: ScreenId = digest.screen;
        let startAttempts = 0;
        const budget = maxFlowSteps();

        /** Everything both walks do after a move lands. */
        const afterMove = async (move: FuzzMove, outcome: Executed): Promise<void> => {
          digest = outcome.digest;
          await stepOracles(move, digest);
          if (move.kind === 'undo' || move.kind === 'redo' || move.kind === 'save') historyTouched = true;
          if (digest.screen !== 'idle') leftIdle = true;
          if (digest.receipt && receipt === null) {
            receipt = receiptClaimFrom(digest);
            if (receipt) guarded(() => checkReceipt(receipt as ReceiptClaim));
          }
          if (digest.undo > before.undoDepth) sawCommit = true;
        };

        for (;;) {
          if (replaySteps) {
            if (replayAt >= replaySteps.length) break;
            const step = replaySteps[replayAt] as TraceStep;
            replayAt += 1;
            if (step.kind === 'genFile') {
              materialize(step.spec as GeneratedFileSpec, step.rel);
              ctx.metric('replay:genFile');
              continue;
            }
            const move = moveFromStep(step);
            if (move === null) {
              ctx.metric(`replay:unsupported:${step.kind}`);
              continue;
            }
            await afterMove(move, await execute(move, false));
            continue;
          }

          if (steps >= budget) {
            ctx.metric('flowBudgetExhausted');
            break;
          }
          if (digest.screen === 'idle') {
            if (leftIdle) break;
            if (startAttempts >= START_ATTEMPTS) {
              ctx.metric('flowNeverStarted');
              break;
            }
            startAttempts += 1;
          }

          stepsOnScreen = digest.screen === previousScreen ? stepsOnScreen + 1 : 0;
          previousScreen = digest.screen;
          const mode = digest.screen === 'idle' ? 'draw' : progressMode(stepsOnScreen);
          if (mode === 'escape') {
            digest = await escapeFrom(digest);
            stepsOnScreen = 0;
            previousScreen = digest.screen;
            break;
          }

          const move = drawMove(digest, mode);
          if (move === null) {
            // Nothing to draw here. At idle there is nothing to leave either, so
            // the flow is simply not startable this time round.
            if (digest.screen === 'idle') {
              ctx.metric('idleHadNoMove');
              break;
            }
            digest = await escapeFrom(digest);
            break;
          }

          // Snapshots taken BEFORE the move, for the three inline checks: each
          // is only meaningful against the state its own move acted on.
          const screenBefore = digest.screen;
          const rowsBefore = digest.rows;
          const raceMove = move.kind === 'ui' && move.testid === 'continue-button' && digest.live[move.testid] === 1;
          const frozenDelete =
            move.kind === 'ui' &&
            move.testid === 'shot-editor-context-delete-rows' &&
            digest.selRows.length > 0 &&
            digest.selRows.every((row) => digest.frozen.includes(row));
          const interjectRoute = move.kind === 'openFile' && move.label.startsWith('INTERJECT:') && screenBefore !== 'idle';

          const outcome = await execute(move, true);
          steps += 1;
          await afterMove(move, outcome);

          if (raceMove && outcome.performed) {
            ctx.metric('raceContinue');
            if (digest.screen !== screenBefore) {
              fail(
                'RACE: a DISABLED continue-button advanced the flow',
                `  screen ${screenBefore} -> ${digest.screen}; a disabled control must not act`,
              );
            }
          }
          if (frozenDelete && outcome.performed) {
            ctx.metric('frozenDeleteRefused');
            if (digest.rows !== rowsBefore) {
              fail(
                'FROZEN DELETE: an all-frozen selection was deleted anyway',
                `  rendered rows ${rowsBefore} -> ${digest.rows}; the wizard must refuse and say so`,
              );
            }
            if (!digest.toast.includes('dmp-wizard-frozen-delete')) {
              fail(
                'FROZEN DELETE: the refusal was SILENT',
                `  no dmp-wizard-frozen-delete toast; toasts=${JSON.stringify(digest.toast)}`,
              );
            }
          }
          if (interjectRoute && outcome.performed) {
            ctx.metric('interjectRouteGuarded');
            if (digest.screen !== screenBefore) {
              fail(
                'IMPORT GATE: a second file was routed into a screen an import already owned',
                `  screen ${screenBefore} -> ${digest.screen}; routeOpenedFile must refuse (#411)`,
              );
            }
          }
        }

        if (!leftIdle) {
          ctx.metric('flowSkipped');
          continue;
        }

        // The flow is over. Make sure it really is before measuring it.
        if (!isEscaped(digest.screen, digest.placement)) digest = await escapeFrom(digest);
        const after = await boundsNow(digest);
        ctx.metric('flows');

        const what = `flow ${flow + 1} of episode ${episode + 1}`;
        const shape: FlowShape = sawCommit || receipt !== null ? 'imported' : 'cancelled';
        ctx.metric(`flowShape:${shape}`);
        guarded(() => checkResidue(digest, shape, what));
        guarded(() => checkTempFiles(before, after, what));
        // Counted, not asserted, and only for a CANCELLED flow: see
        // `checkResidue` for the two source comments that make that asymmetry
        // the app's contract rather than a tolerance.
        if (digest.ctx !== null) ctx.metric(`residualImportContext:${digest.ctx}`);
        if (receipt) guarded(() => checkAccounting(receipt as ReceiptClaim, before, after));

        // F1 needs a flow whose only history effect was the import itself, and
        // whose project did not change identity underneath it. An undo/redo/save
        // interjection is a deliberate part of the walk and a real thing to do;
        // a flow that created or swapped the project (importContext
        // 'new-project', or `import-as-new-project`) writes an initial `.stalx`
        // with `save_project`'s healing mutations and no undo entry. Both make
        // "undo exactly what this flow pushed" meaningless, so those flows are
        // COUNTED rather than measured - never tolerated inside the oracle.
        if (historyTouched) {
          ctx.metric('f1Skipped:historyTouched');
        } else if (before.projectFile !== after.projectFile) {
          ctx.metric('f1Skipped:projectSwapped');
        } else if (before.undoDepth < 0 || after.undoDepth < 0) {
          ctx.metric('f1Skipped:noProject');
        } else {
          const pushed = guarded(() => checkPushed(shape, before, after, what));
          ctx.metric(`f1Pushed:${shape}:${pushed}`);
          if (pushed > 0) {
            for (let i = 0; i < pushed; i += 1) await ctx.callAction('project', 'undo', []);
            const unwound = await canonicalNow(true);
            guarded(() => checkRoundtripState('pre-flow', before.snapshot, unwound, `undoing ${what}`));
            for (let i = 0; i < pushed; i += 1) await ctx.callAction('project', 'redo', []);
            const rewound = await canonicalNow(true);
            guarded(() => checkRoundtripState('post-flow', after.snapshot, rewound, `redoing ${what}`));
            ctx.metric('f1Roundtrips');
          }
        }

        digest = await observeScreen(ctx, false);
        lastUndoDepth = digest.undo;
      }

      // ---- E1 teardown ---------------------------------------------------
      await ctx.callAction('project', 'closeProject', []).catch(() => undefined);
      const closed = await observeScreen(ctx, false);
      const residue: string[] = [];
      if (closed.hasProject) residue.push('a project is still open');
      if (closed.dialog !== null) residue.push(`activeDialog=${JSON.stringify(closed.dialog)}`);
      if (closed.placement) residue.push('placementMode is still set');
      // NOT importContext. `closeProject` does not touch it and is not meant
      // to: `routeOpenedFile` resets it at the entry of every import flow, and
      // `checkResidue` cites the two source comments that make that the
      // contract. Counted above per flow, asserted only for a completed import.
      if (residue.length > 0) {
        fail(`E1 TEARDOWN: episode ${episode + 1} did not close cleanly`, residue.map((line) => `  ${line}`).join('\n'));
      }
      for (const dir of [filesDir, projectsDir]) fs.rmSync(dir, { recursive: true, force: true });
      for (const dir of [filesDir, projectsDir]) {
        if (fs.existsSync(dir)) fail(`E1 TEARDOWN: ${dir} survived its own deletion`);
      }

      const domAfter = await ctx.eval<number>('return document.querySelectorAll("*").length;');
      ctx.metric('domNodeDelta', domAfter - domBefore);
      ctx.setMetric('domNodes', domAfter);
      ctx.metric('episodes');
    }
    };

    try {
      await runEpisodes();
    } finally {
      await forceClean();
    }

    if (traceOut) {
      const written = dumpTrace(null);
      if (written) ctx.log(`trace written to ${written}`);
    }
  },
};

export default importDialogFuzz;
