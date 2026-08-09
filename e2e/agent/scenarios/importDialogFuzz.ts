/**
 * import-dialog-fuzz: a seeded random walk over EVERY import flow.
 *
 * It generates survey files in the five formats the app imports - mNemo `.dmp`,
 * Ariane `.tml`/`.tmlu`, Compass `.dat`/`.mak`, Walls `.srv`/`.wpj`, GPX - hands
 * them to the real app through the real entry points, and then clicks the import
 * UI at random - selection dialog, zero-datum pair, the placement wizard, the
 * shot-table grid, the map placement, the four options screens, GPX placement,
 * orphan placement, the receipt - asserting after every move that the app is
 * still coherent, and after every FLOW that the import kept its contract.
 *
 * ## Formats, and why the flow shape follows from the extension
 *
 * `.dmp` is the ONLY additive import. Every other extension routes to
 * `new-project-for-import` whether or not a project is open
 * (`src/utils/openOrImport.ts`), and with a project open it goes through
 * `import-as-new-project` first, whose confirm CLOSES the project and re-enters
 * the router. So a non-DMP flow always creates a project in the middle of
 * itself, which is why those flows are the ones that reach the deferred initial
 * save, the TML residue choice, and `f1Skipped:projectSwapped`.
 *
 * ## Three input sources
 *
 * A generated spec (valid-biased, or corrupted with probability
 * `STALAGMIGHT_FUZZ_IMPORT_MALFORMED_P`), a tracked `.dmp` fixture, or an entry
 * from a PRIVATE corpus of real survey files when one is configured
 * (`STALAGMIGHT_FUZZ_CORPUS_DIR`). Generated files reach the parsers' edges;
 * real files reach the shapes nobody would think to generate. A run with no
 * corpus counts `corpus:absent` and is exactly as valid, just narrower.
 *
 * NOTHING THIS RUN WRITES EVER NAMES A CORPUS FILE. A corpus entry is
 * identified everywhere by `corpusFileId` - a 5-hex fold of its relative path -
 * because a survey filename can name a cave, a landowner or an unreleased
 * project, and a metric key, a log line, a failure payload and a recorded trace
 * are all things that end up attached to an issue. The real path stays inside
 * `lib/fixtureCorpus.ts`, which states the full rule; the `corpusFile` trace
 * step carries the id, and `fuzzTrace.ts` refuses to write anything else.
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
 * Four inline expected-behaviour checks ride along with the moves that provoke
 * them, because each one is only meaningful against the state immediately
 * before its own move:
 *   FROZEN DELETE an all-frozen selection must survive, and must say so
 *   IMPORT GATE   a second file routed into a screen an import owns must be
 *                 refused (#411's `importFlowOwnsScreen`)
 *   EXPORT CHORD  Ctrl+E must be inert while a dialog owns the screen - judged
 *                 on the dialog the DISPATCHER saw, not the one the digest did
 *   CLOSE         closing the project at idle must leave nothing behind
 *
 * The `RACE_TARGETS` generators still play (clicking a confirm the digest saw
 * disabled is a real thing to do to a wizard), but what they produce is COUNTED
 * rather than asserted: see the `raceMove` branch for why neither end of that
 * race is a contract this harness can hold the app to.
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
 *   STALAGMIGHT_FUZZ_IMPORT_FORMAT              csv of families, default all
 *                                               (dmp,tml,compass,walls,gpx)
 *   STALAGMIGHT_FUZZ_IMPORT_FLOWS_PER_EPISODE   default 3
 *   STALAGMIGHT_FUZZ_IMPORT_MAX_FLOW_STEPS      default 140
 *   STALAGMIGHT_FUZZ_IMPORT_MALFORMED_P         default 0.2
 *   STALAGMIGHT_FUZZ_IMPORT_INTERJECT_P         default 0.08
 *   STALAGMIGHT_FUZZ_IMPORT_AUX_INTERJECT_P     default 0.04 (wave-3 stream)
 *   STALAGMIGHT_FUZZ_IMPORT_SETTLE_MS           default 12000
 *   STALAGMIGHT_FUZZ_CORPUS_DIR                 optional private corpus root
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
 * WAVE 3 MOVED THE TRAJECTORIES, and the entries below say so rather than
 * implying otherwise. Findings 1 and 3 were recorded on the DMP-only walk; the
 * five-format draw and the auxiliary interjection stream change which moves a
 * seed makes, so those repro lines no longer replay the exact sequence that
 * found the bug. They are still run as regression checks and are still expected
 * green - and the SHRUNK five-step sequence in finding 1 is the durable form of
 * that check, because it is a trace rather than a seed. The auxiliary stream is
 * deliberately a SECOND stream (`AUX_INTERJECT_STREAM_SALT`) so that the
 * original interjection stream's own draws are bit-identical; that bounds the
 * change to inserted moves rather than a re-partitioned distribution.
 *
 * 1. FIXED (95155c51), issue #476. THE IMPORT WIZARD BECAME AN INVISIBLE
 *    MODAL, PERMANENTLY. This is now that fix's regression check - a red here
 *    again is a NEW bug.
 *
 *        pnpm agent:scenario import-dialog-fuzz --seed 7 --iterations 8
 *
 *    Found on this scenario's first real run; `pnpm agent:fuzz-shrink` cut the
 *    124-step trace to FIVE steps (83 replays, 1-minimal, 0 divergent):
 *
 *        1. generate a VALID .dmp                (no malformed input involved)
 *        2. import it                            (router or toolbar, either)
 *        3. continue                             (the default whole-file selection)
 *        4. skip zero datum
 *        5. accept the first suggestion          (confirm-button)
 *
 *    `activeDialog` stayed `'dmp-import-new'` with the wizard mounted under a
 *    `display:none` ancestor - the digest measured `display=flex
 *    visibility=visible 0x0`, which is what a `display:none` PARENT produces on
 *    a descendant. `DialogWrapper` sets it in one place, its `hidden` prop, fed
 *    by `autoStartManualPlacementPending`.
 *
 *    Mechanism: the flag is set at the `manual_placing` transition and was
 *    cleared in exactly ONE place, inside `handleStartSegmentPlacement`, behind
 *    two early returns - the first of which is `refuseIncompleteShots()`. The
 *    auto-start effect has no dependency that changes on a refusal, so it never
 *    retried. The incompleteness is FILE-BORNE: the parser clamps a negative
 *    raw length to exactly 0.0 (`parsers/dmp.rs:370`), the shot survives
 *    `isImportableDmpShot`, and `editableShotStatus.ts:66` marks `length <= 0`
 *    missing. Fixed by moving ownership of the hidden window into the effect
 *    that opens it, and taking the payload guard off a transition that submits
 *    nothing.
 *
 *    A NOTE ON THIS FILE'S FIRST DIAGNOSIS, because it was wrong and the way it
 *    was wrong is reusable. It blamed the effect's cleanup starving the
 *    `setTimeout(0)`, and ruled the refusal out on `toasts: []` in the payload.
 *    That evidence was worthless: the settle loop treats "wizard mounted but
 *    hidden" as busy, so on this very wedge it burns the whole settle cap
 *    (12 s, or 60 s in the verification run) before the digest is taken, and a
 *    warning toast dwells 7 s. The toast had always expired. An oracle that
 *    waits for quiescence cannot then use the ABSENCE of a transient as
 *    evidence.
 *
 * 2. FIXED (3595b151), issue #477. A COMPLETED DMP IMPORT LEFT `importContext`
 *    SET.
 *
 *    `completeImportToSingleView` states the contract - "This is also where the
 *    import flow ENDS, so it is where `importContext` is dropped" - and every
 *    other importer routes through it, as do both failure paths via
 *    `surfaceImportFailure`. The DMP wizard's `onComplete` in `App.tsx`
 *    hand-rolled the same exit sequence and omitted that line. The sibling
 *    branch settles that it was an oversight: `OrphanPlacementDialog.finish()`
 *    clears it explicitly and points at #435 for the duplication. Fixed by
 *    routing the wizard's completion through the shared helper.
 *
 *    NOT VERIFIED BY THIS SCENARIO, and the entry says so rather than implying
 *    otherwise. #477 was established by READING the code. The red that first
 *    drew attention to it was F2 asserting "a flow whose undo depth grew must
 *    end with a null context", and that premise is false: the DMP wizard commits
 *    EARLY and mid-flow, so a user can land sections and then walk back and
 *    cancel, and a retained context on the cancel path is by design
 *    (`routeOpenedFile` resets it at the next flow's entry). Re-checked with the
 *    fix reverted, the corrected oracle does not fire - measured: no flow on
 *    that seed presented a receipt in either surface. The assertion is gone and
 *    the value is counted instead (`residualImportContext:*`); see
 *    `checkResidue` for the full argument.
 *
 * 3. FIXED (caaa1847), issue #478. A CLEARED DATE MADE THE WIZARD SEND
 *    `date: ""`, AND TAURI REJECTED THE WHOLE `import_sections` CALL.
 *
 *        pnpm agent:scenario import-dialog-fuzz --seed 7 --iterations 8
 *
 *    By hand: import a `.dmp`, continue, skip the zero datum, CLEAR the date
 *    field on the section being placed, and complete the placement. The call
 *    fails at Tauri's argument layer with `invalid args \`sections\` for command
 *    \`import_sections\`: premature end of input`, so the placement does not
 *    import and the wizard reopens showing serde's message.
 *
 *    `ImportSectionConfig.date` is `Option<NaiveDate>`
 *    (`src-tauri/src/models/section.rs:253`), and chrono parses `""` as
 *    TOO_SHORT, whose Display is literally `premature end of input`.
 *    `buildBatchImport` normalised `surveyor` and not `date`, one line apart.
 *
 *    HOW THIS ONE WAS FOUND is the part worth keeping. It was first recorded
 *    here as a log line the oracle sweep reported at severity `error` - which
 *    does not fail a run - so the scenario was GREEN while the app was telling
 *    it that a command had been rejected. The gap was the oracle's, not the
 *    app's: S6 now asserts the IPC contract directly, and the distinction it
 *    draws is in `checkIpcContract`. A command that RAN and returned
 *    `success: false` is the app reporting a problem properly, and this
 *    scenario provokes plenty of those on purpose; a command whose ARGUMENTS
 *    could not be deserialized never ran at all, and that is a wire-format
 *    disagreement, always a defect, whatever the command or the content. That
 *    is what makes it an oracle rather than a classifier for this bug.
 *
 *    The root cause was measured rather than guessed, because the message
 *    points nowhere near it. `e2e/agent/ipc-payload-probe.ts` (kept, and the
 *    evidence behind the issue) ruled out the three things it suggests: payload
 *    SIZE (32 MiB of one string argument arrives intact), CHARACTER CLASS (NUL,
 *    SOH, BS, TAB, LF, CR, ESC, DEL, U+200B, U+202E and U+FFFD all arrive; lone
 *    surrogates fail with a DIFFERENT message), and SERIALIZATION refusals
 *    (BigInt and cyclic structures fail in the webview with their own errors,
 *    never as a truncated body). `date: ""` is the only probed input that
 *    reproduces it.
 *
 *    A note for whoever next wants the failing PAYLOAD rather than the failing
 *    line: you cannot get it by patching `invoke`. Tauri ships
 *    `window.__TAURI_INTERNALS__.invoke` NON-CONFIGURABLE and non-writable, and
 *    the global object itself resists replacement, so a spy wrapped around it
 *    silently records nothing - which looks exactly like a spy that saw
 *    nothing. That was tried, measured (zero rejections recorded on a run whose
 *    log had two) and removed; the log ring is the source S6 uses.
 *
 * 4. FIXED (64f6a525), issue #479. A COMPASS `.DAT` WITH AN IMPOSSIBLE
 *    `SURVEY DATE:` PANICKED THE BACKEND, AND THE IMPORT PROMISE NEVER SETTLED.
 *
 *    NOT FOUND BY A RUN, and the entry says so rather than implying otherwise.
 *    It was found while transcribing the Compass grammar for this wave's
 *    writers - `NaiveDate::from_ymd_opt(..).unwrap()` in the vendored survey
 *    parser, with `digit1.parse::<u32>().unwrap()` beside it - and then
 *    measured against the real parser. `parse_compass` is a synchronous
 *    `#[tauri::command]`, so the panic unwinds out of the command and the
 *    frontend's promise never resolves: the dialog sits on its spinner with no
 *    error and no way back except restarting the app.
 *
 *    It is now this scenario's coverage rather than only a Rust test: the
 *    `dat:impossible-date` and `dat:date-field-overflow` catalog entries emit
 *    exactly those six shapes, so a malformed-heavy Compass run walks the fix.
 *
 *        STALAGMIGHT_FUZZ_IMPORT_MALFORMED_P=0.6 pnpm agent:scenario \
 *          import-dialog-fuzz --seed 3 --iterations 6
 *
 * ## Observations that are NOT findings
 *
 * `closeProject` does not clear `activeDialog`. It nulls the project and the
 * derived state (`clearOpenProjectState`) and never touches the dialog, so
 * every import dialog stays mounted over a project that is gone - the ones
 * gated on `dialogData.<x>File` because that survives the close, and
 * `new-project-for-import` / `orphan-placement` because they are gated on
 * `activeDialog` alone.
 *
 * This scenario does NOT report it, and the reason is the discipline rather
 * than the severity: NOTHING IN THE UI CAN REACH IT. No control binds
 * `handleCloseProject` while a dialog is open, both keyboard dispatchers return
 * early for every non-Escape key in that state, and the mode carousel and the
 * toolbar sit behind the modal backdrop. Driving the raw store action there
 * reaches a state no user can, and a bug found in one of those is a fabricated
 * bug - the same argument this file already makes for `uiStore.confirmPlacement()`.
 * So the interjection plays `closeProject` at `idle` only, where it IS
 * reachable, and asserts the contract there. If a future change gives the user
 * a way to close a project mid-import, this becomes a finding on the spot.
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
import {
  materializeSurveyFile,
  randomSurveyFileSpec,
  selfCheckClaim,
  type GeneratedFileSpec,
  type SurveyFileFormat,
} from '../lib/surveyFileSpecs';
import {
  CORPUS_DIR_ENV,
  corpusEntryFor,
  corpusLookup,
  describeCorpus,
  discoverCorpus,
  materializeCorpusEntry,
  type CorpusEntry,
} from '../lib/fixtureCorpus';
import type { ImportScreenDigest } from '../lib/importScreenDigest';
import { LogCursor } from '../lib/logs';
import {
  checkAccounting,
  checkIpcContract,
  checkPushed,
  checkReceipt,
  checkResidue,
  checkRoundtripState,
  checkTempFiles,
  ImportOracleError,
  leftoverTempNames,
  receiptClaimFrom,
  type CountedProject,
  type FlowBounds,
  type FlowShape,
  type ReceiptClaim,
} from '../lib/importFlowOracles';
import {
  ADVANCE_MOVE,
  ESCAPE_BUDGET,
  ESCAPE_PATH,
  IMPORT_GUARDED_SCREENS,
  isEscaped,
  NON_FLOW_SCREENS,
  progressMode,
  WEDGE_EXEMPT_SCREENS,
  type ScreenId,
} from './importDialogModel';
import {
  answerFileDialogInPage,
  answerKeyboardFileDialog,
  dismissFirstRunModal,
  injectScreenDigest,
  observeScreen,
  routeFile,
  runUiStep,
  type Move,
} from './importDialogBridge';
import {
  AUX_INTERJECT_STREAM_SALT,
  auxInterjectProbability,
  buildAuxInterjection,
  buildInterjection,
  describeSource,
  drawAuxInterjection,
  drawInterjection,
  enabledFamilies,
  enabledFormats,
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
 * `TOAST_KEYS.IMPORT_RECEIPT` (`src/utils/toastKeys.ts`). A clean receipt is a
 * toast rather than the modal, and both surfaces prove the completion path ran.
 */
const RECEIPT_TOAST_KEY = 'import-receipt';
/**
 * `TOAST_KEYS.IMPORT_IN_PROGRESS` (`src/utils/toastKeys.ts`). What
 * `routeOpenedFile` raises when `importFlowOwnsScreen` refuses a second file.
 */
const IMPORT_GATE_TOAST_KEY = 'import-in-progress';
/** Times an `idle` screen is re-observed before a flow is called finished. */
const IDLE_CONFIRMATIONS = 3;
/** Grace between those observations. One IPC round trip is tens of ms. */
const IDLE_CONFIRM_MS = 200;
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
 *
 * The four import confirms are here for the same reason a `route` is: they hand
 * a file the parser accepted to the command that actually imports it, and a
 * file whose CONTENT the importer then refuses is a reported error.
 */
const ERROR_PRODUCING: ReadonlySet<string> = new Set([
  'create-and-continue-button',
  'import-blocked-switch',
  'import-as-new-project-confirm',
  'retry-button',
  'tml-import-confirm',
  'tml-import-residue-discard',
  'compass-import-confirm',
  'walls-import-confirm',
  'gpx-import-confirm',
  'gpx-continue-button',
]);

function mayRaiseError(move: FuzzMove): boolean {
  if (move.kind === 'openFile' || move.kind === 'cancelDialog' || move.kind === 'keyFile') return true;
  if (move.kind === 'ui') return ERROR_PRODUCING.has(move.testid);
  return false;
}

/**
 * Confirms that are DISABLED while a duplicate-hash probe is in flight.
 *
 * The window is short and real, and clicking into it asserts that the disabled
 * state is HONEST: a disabled control must not advance the flow. Each screen's
 * `race-*` generator aims at exactly these, and the shell checks the outcome
 * inline, because the check is only meaningful against the state its own move
 * acted on.
 */
const RACE_TARGETS: ReadonlySet<string> = new Set([
  'continue-button',
  'tml-import-confirm',
  'compass-import-confirm',
  'walls-import-confirm',
  'gpx-continue-button',
  'gpx-import-confirm',
]);

/**
 * `mutate` actions a REPLAYED trace may drive - the DOM allowlist's twin.
 *
 * One entry: `closeProject`, which the wave-3 auxiliary interjection plays at
 * `idle`. The set REFUSES anything else loudly, which is the point - a trace
 * naming `loadProject` or `deleteProject` must not be quietly skipped inside a
 * privileged webview with the `__E2E_TEST__` hooks live.
 *
 * `ui:confirmPlacement` is deliberately still absent: that store action
 * ABANDONS a placement rather than completing one (see the note in
 * `importDialogGenerators.ts`), so it reaches a state no user can.
 */
const REPLAYABLE_UI_ACTIONS: ReadonlySet<string> = new Set(['closeProject']);

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
    'Generates DMP/Ariane/Compass/Walls/GPX files and walks the real import UI at random, asserting ' +
    'per-step coherence and a per-flow undo roundtrip, residue, accounting, receipt and temp-file contract.',
  defaultIterations: 3,

  async run(ctx: ScenarioContext, { iterations }): Promise<void> {
    const fixture = fixtureName();
    const sessionDir = ctx.artifactsDir;
    if (!sessionDir) {
      throw new Error(`${SCENARIO} needs a session artifacts dir to write its generated files into`);
    }
    const filesDir = path.join(sessionDir, FILES_REL);
    const projectsDir = path.join(sessionDir, PROJECTS_REL);

    // ---- input sources ---------------------------------------------------
    //
    // The format axis and the private corpus are both resolved ONCE: discovery
    // walks a directory, and a generator runs once per step. Neither is ever
    // named in a log line - `describeCorpus` prints counts per format, and a
    // corpus file is identified downstream by `corpusFileId`.
    const formats = enabledFormats();
    // ONE walk, shared by every format: `discoverCorpus` reads a directory tree
    // that can hold thousands of files, and this runs at the start of every
    // session (and of every ddmin candidate under `fuzz-shrink`).
    const inventory = discoverCorpus();
    const corpus: Partial<Record<SurveyFileFormat, readonly CorpusEntry[]>> = {};
    let corpusUsable = 0;
    for (const format of formats) {
      const entries = inventory.byFormat[format] ?? [];
      corpus[format] = entries;
      corpusUsable += entries.length;
    }
    ctx.log(`formats: ${enabledFamilies().join(',')} (${formats.join(',')})`);
    ctx.log(describeCorpus(inventory));
    ctx.setMetric('corpusEntriesUsable', corpusUsable);
    if (inventory.tooDeep > 0) {
      // The inventory above is a LOWER bound: this many directories sat past the
      // discovery walk's depth limit and were never opened. A metric as well as
      // the log line, because the log scrolls and the metric block is what a
      // run's summary and an issue carry - and a corpus the fuzzer can only half
      // see is a coverage claim wrong by an unknown amount. It names a count,
      // never a path, like everything else corpus-shaped that leaves this run.
      ctx.setMetric('corpusDirsTooDeep', inventory.tooDeep);
    }
    if (corpusUsable === 0) {
      // Not a failure and never one: a corpus is optional by design, and a run
      // without one is exactly as valid, just narrower. Counted so a run that
      // MEANT to use one can tell that it did not.
      ctx.metric('corpus:absent');
      if (!inventory.available) ctx.log(`corpus: set ${CORPUS_DIR_ENV} to widen this run's inputs`);
    }

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
    /**
     * Substrings a failure payload must never contain, and what to say instead.
     *
     * `describeSource` keeps a corpus file's NAME out of every label this run
     * writes, but the app puts it back: an import that fails quotes the path it
     * was given, and the copy under `fuzz-files/corpus-N/` keeps the original
     * basename because a `.mak` names its sibling `.dat` files and a `.wpj`
     * names its `.srv` tree - renaming them would break the very files the
     * corpus exists to exercise. So the file names are real, and a failure
     * message that echoes one would carry it into the issue the failure gets
     * attached to. Filled in as entries are materialized; applied by `fail`.
     */
    const redactions: { find: string; say: string }[] = [];
    const redact = (text: string): string => {
      let out = text;
      for (const entry of redactions) out = out.split(entry.find).join(entry.say);
      return out;
    };
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
            // v3 = the five-format vocabulary: corpus sources, the armed
            // keyboard picker, and the auxiliary interjection stream.
            stream: 'import-v3',
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
      // REDACTED, because this text is what goes into an issue: the app quotes
      // the path it was handed, and a corpus copy keeps its original file name.
      const message = redact(
        [
          headline,
          `  reproduce: pnpm agent:scenario ${SCENARIO} --seed ${ctx.seed} --iterations ${iterations}` +
            `${fixture === DEFAULT_FIXTURE ? '' : ` with STALAGMIGHT_FUZZ_FIXTURE=${fixture}`}` +
            `${replayPath ? ` (REPLAY of ${replayPath})` : ''}`,
          `  fixture=${fixture} flowsPerEpisode=${flowsPerEpisode()} maxFlowSteps=${maxFlowSteps()}`,
          ...(detail ? [detail] : []),
          `  last ${tail.length} move(s):`,
          ...tail,
        ].join('\n'),
      );
      // The trace carries the message VERBATIM, so a shrink compares signatures
      // taken from the same text a human reads.
      const written = dumpTrace({ message });
      throw new Error(written ? `${message}\n  trace: ${written}` : message);
    };

    // ---- paths -----------------------------------------------------------

    /**
     * A session-relative `rel` as an absolute path, refusing anything that
     * leaves the run's own directory.
     *
     * A tracked fixture is named by `fixtures/<basename>` and resolved through
     * `ctx.fixturePath`, which materializes a COPY into exactly that directory.
     * So one rel means the same file on any machine, without the trace carrying
     * a fixture (which the repo forbids) or an absolute path. `path.basename` is
     * the containment rule on that branch.
     *
     * `readTrace` already applies the same rule to every file-bearing step, so on
     * the replay path this is belt and braces - but the GENERATOR path never goes
     * through `readTrace`, and a containment rule that only one of two callers
     * enforces is a convention rather than a boundary.
     */
    const resolveRel = (rel: string): string => {
      if (rel.startsWith('fixtures/')) return ctx.fixturePath(path.basename(rel));
      const root = path.resolve(sessionDir);
      const target = path.resolve(root, rel);
      if (target !== root && !target.startsWith(root + path.sep)) {
        throw new Error(`generated file path ${JSON.stringify(rel)} escapes ${root}`);
      }
      return target;
    };

    const materialize = (spec: GeneratedFileSpec, rel: string): string => {
      const target = resolveRel(rel);
      const named: GeneratedFileSpec = { ...spec, name: path.basename(target) };
      materializeSurveyFile(path.dirname(target), named);
      return target;
    };

    /**
     * Absolute path of a source's file, or null when it is not on disk.
     *
     * A CORPUS source is the one that can legitimately come back null on a
     * machine that is not the recorder's: the trace names the file by id, and a
     * replayer with no corpus (or a different one) simply does not have it. That
     * is skipped-and-counted like any other impossible move - never a failure,
     * because a corpus is optional by design.
     */
    const sourceOnDisk = (source: FileSource): string | null => {
      if (source.origin === 'gen') return materialize(source.spec, source.rel);
      if (source.origin === 'fixture') return ctx.fixturePath(source.name);
      if (source.origin === 'corpus') {
        const entry = corpusEntryFor(source.corpusRel);
        if (entry === null) {
          ctx.metric('corpus:absent');
          return null;
        }
        const destination = resolveRel(source.dirRel);
        const copied = materializeCorpusEntry(entry, destination);
        if (copied.skipped) {
          // WHICH bound, because they mean different things: `bytes`/`files`
          // is a directory too big to copy per iteration, `depth` is a tree
          // shape nobody expected, and `io` is a copy that failed and was
          // undone. A half-copied project would look like a corrupt one from
          // inside the app, which is why none of them copies anything.
          ctx.metric(`corpus:notMaterialized:${copied.reason ?? 'unknown'}`);
          return null;
        }
        ctx.metric('corpus:materialized');
        ctx.metric('corpus:copiedBytes', copied.bytes);
        ctx.metric('corpus:copiedFiles', copied.copied);
        // Both halves, and the directory FIRST so a full path is redacted whole
        // rather than leaving `<corpus #id>/<basename>` behind. `names` is every
        // segment the copy created AT ANY DEPTH - a Walls project's `.PATH`
        // subfolder can name a cave system exactly as well as a file can, and a
        // single-level readdir here used to miss all of them.
        const tag = `<corpus #${source.id}>`;
        redactions.unshift({ find: destination, say: tag });
        for (const name of copied.names) {
          redactions.push({ find: name, say: `${tag}/file` });
        }
        return copied.path;
      }
      const target = resolveRel(source.rel);
      return fs.existsSync(target) ? target : null;
    };

    /**
     * Record the step that PUT a file on disk, before the step that opens it.
     *
     * A generated file travels as its spec; a corpus file travels as its
     * `corpusFileId` and nothing else - never its name, which is the rule
     * `lib/fixtureCorpus.ts` states and `fuzzTrace.ts` enforces. Both are
     * resolved against a directory the REPLAYER chooses.
     */
    const recordFileSource = (source: FileSource, record: boolean): void => {
      if (!record) return;
      if (source.origin === 'gen') {
        recorder.record({
          kind: 'genFile',
          spec: source.spec,
          rel: source.rel,
          label: describeSource(source),
        });
        return;
      }
      if (source.origin === 'corpus') {
        recorder.record({
          kind: 'corpusFile',
          corpusId: source.id,
          // The resolution key. `corpusId` is 20 bits and labels the file in
          // everything a human reads; this is what a replay looks it up by, so
          // a corpus holding a second file that folds to the same id cannot be
          // materialized in its place.
          corpusHash: source.hash,
          // The DIRECTORY the copy lands in; the `route`/`fileDialog` step that
          // follows names the file inside it.
          rel: source.dirRel,
          label: describeSource(source),
        });
      }
    };

    /**
     * A run must never write a `.stalx` outside its own session directory.
     *
     * `NewProjectForImportDialog` defaults the save path to the user's
     * Documents folder and the project NAME to the imported file's basename, so
     * a `create-and-continue-button` clicked before the path was redirected
     * creates a project there - and on a corpus run that file is NAMED AFTER A
     * PRIVATE SURVEY, in a directory nothing here ever cleans up. Measured: a
     * Walls run left `~/Documents/stalagmight/fuzz_3.stalx` behind, and the app
     * auto-renamed around the previous run's copy of it.
     *
     * So the create click is REPLACED by the move that fixes the path, and the
     * walk gets to it on its next step. The substitution is recorded, so a
     * replay is faithful; and it is done here rather than in a generator
     * because progress forcing plays the same click from the model's table
     * without asking a generator at all.
     */
    const enforceSavePath = (move: FuzzMove, digest: ImportScreenDigest): FuzzMove => {
      if (move.kind !== 'ui' || move.testid !== 'create-and-continue-button') return move;
      if (digest.savePath !== null && digest.savePath.startsWith(projectsDir)) return move;
      ctx.metric('savePathRedirected');
      return {
        kind: 'input',
        testid: 'project-save-path-input',
        value: PROJECT_DIR_PLACEHOLDER,
        mode: 'type',
        label: 'redirect the save path into the session directory',
      };
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
      /**
       * The target's disabled state as the BRIDGE read it, one round trip after
       * the digest that chose the move. Null for every move that is not a click
       * or an edit on a live element. See `StepOutcome.offAtDispatch`.
       */
      offAtDispatch: boolean | null;
      /**
       * The dialog the KEYBOARD DISPATCHER saw, for a `key:` chord. Null for
       * every other move, and for a chord pressed at idle.
       */
      dialogAtDispatch: string | null;
    }

    /** Run one move, record it if it happened, and report the screen after. */
    const execute = async (move: FuzzMove, record: boolean): Promise<Executed> => {
      inFlight = move.label;
      let performed = false;
      let skip: string | null = null;
      let offAtDispatch: boolean | null = null;
      let dialogAtDispatch: string | null = null;
      let digest: ImportScreenDigest;

      if (move.kind === 'ui') {
        const outcome = await runUiStep(ctx, move as Move);
        performed = outcome.performed;
        skip = outcome.reason;
        offAtDispatch = outcome.offAtDispatch;
        dialogAtDispatch = outcome.dialogAtDispatch;
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
        offAtDispatch = outcome.offAtDispatch;
        dialogAtDispatch = outcome.dialogAtDispatch;
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
          // A REPLAY whose `genFile` step ddmin cut away, or a corpus entry
          // this machine does not have.
          skip = live.source.origin === 'corpus' ? 'corpus-missing' : 'file-missing';
          digest = await observeScreen(ctx, false);
        } else {
          recordFileSource(live.source, record);
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
      } else if (move.kind === 'keyFile') {
        const live = move;
        const absolute = sourceOnDisk(live.source);
        if (absolute === null) {
          skip = live.source.origin === 'corpus' ? 'corpus-missing' : 'file-missing';
          digest = await observeScreen(ctx, false);
        } else {
          recordFileSource(live.source, record);
          const answered = await answerKeyboardFileDialog(ctx, live.chord, absolute);
          performed = answered.performed;
          skip = answered.reason;
          digest = answered.digest;
          // A chord the dispatcher swallowed (it returns early whenever a
          // dialog is open) leaves the answer unconsumed. That is the app's
          // documented gate, so it is counted rather than asserted.
          ctx.metric(answered.consumed ? 'keyPickerConsumed' : 'keyPickerSwallowed');
          if (record && performed) {
            recorder.record({
              kind: 'fileDialog',
              trigger: `key:${live.chord}`,
              dialog: 'open',
              rel: live.source.rel,
              label: move.label,
            });
          }
        }
      } else if (move.kind === 'closeProject') {
        const res = await ctx.callAction('project', 'closeProject', []);
        performed = res.ok;
        if (!res.ok) skip = 'close-refused';
        if (record && performed) recorder.record({ kind: 'mutate', action: 'closeProject', args: [], label: move.label });
        digest = await observeScreen(ctx);
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
      return { digest, performed, skip, offAtDispatch, dialogAtDispatch };
    };

    // ---- per-step oracles ------------------------------------------------

    const stepOracles = async (
      move: FuzzMove,
      digest: ImportScreenDigest,
      screenBefore: ScreenId,
    ): Promise<void> => {
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
      // RAISED one, which is not the same as "was on screen while one was up".
      // A move that legitimately raises the error dialog (a malformed file
      // routed in) leaves it there, and every move after it - an undo, an
      // Escape, a click that missed - would otherwise be blamed for it.
      // Measured, on the seed-2 matrix cell: `import via router` produced "No
      // valid sections found in DMP file", which is the app reporting a problem
      // properly, and the NEXT interjection was reported as the defect.
      if (digest.screen === 'error' && screenBefore !== 'error' && !mayRaiseError(move)) {
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

      // S6 IPC CONTRACT. `checkIpcContract` documents the distinction it draws.
      // Through `guarded`, like every other oracle that lives in the oracle
      // module: its own `fail` throws a bare ImportOracleError, which would lose
      // the reproduce line, the move history and the dropped trace.
      const fresh = await ctx.exclusive(() => logs.read('error'));
      guarded(() => checkIpcContract(fresh.newEntries, move.label));

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
     * Wait until `idle` is REST, not just a gap between two macrotasks.
     *
     * Completing a map placement runs `void handlePlacementComplete()` - an
     * async chain that imports the segment and then REOPENS the wizard. Between
     * the store update that ends the placement and the reopen, `activeDialog` is
     * null and `placementMode` is null, so the screen reads `idle` while the
     * import is still in flight. A flow that ended there measured its residue
     * mid-completion and reported a context the app was about to clear.
     *
     * So an idle screen is re-observed a few times before it is believed. The
     * settle loop already waits for a stable marker; this adds the "and it is
     * still idle a moment later" half, which is what distinguishes finished from
     * between-two-ticks. Anything that comes back non-idle hands the walk back
     * its screen and the flow continues.
     */
    const settleToRest = async (from: ImportScreenDigest): Promise<ImportScreenDigest> => {
      let digest = from;
      for (let attempt = 0; attempt < IDLE_CONFIRMATIONS; attempt += 1) {
        if (digest.screen !== 'idle' || digest.placement) return digest;
        await ctx.sleep(IDLE_CONFIRM_MS);
        digest = await observeScreen(ctx);
      }
      return digest;
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
        const screenBefore = digest.screen;
        const outcome = await execute(move, true);
        digest = outcome.digest;
        await stepOracles(move, digest, screenBefore);
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
    const auxRng = mulberry32((ctx.seed ^ AUX_INTERJECT_STREAM_SALT) >>> 0);

    const genEnv = (digest: ImportScreenDigest): GenEnv => ({
      ctx,
      digest,
      filesRel: FILES_REL,
      fileSeq,
      corpus,
    });

    const drawMove = (digest: ImportScreenDigest, mode: 'draw' | 'advance'): FuzzMove | null => {
      if (mode === 'advance') {
        const route = ADVANCE_MOVE[digest.screen] ?? [];
        const testid = route.find((candidate) => digest.live[candidate] === 2);
        if (testid !== undefined) {
          ctx.metric('forcedAdvance');
          return { kind: 'ui', testid, label: `FORCED advance on ${digest.screen}` };
        }
        ctx.metric('forcedAdvanceUnavailable');
      }
      // Interjections come off their OWN stream, so adding one later does not
      // shift the trajectory every existing repro line depends on. Wave 3's
      // additions get a SECOND stream for the same reason, rather than being
      // folded into `drawInterjection`'s partition.
      if (interjectRng() < interjectProbability()) {
        const kind = drawInterjection(interjectRng);
        const move = buildInterjection(kind, genEnv(digest));
        if (move !== null) {
          ctx.metric(`interject:${kind}`);
          if (move.kind === 'openFile') fileSeq += 1;
          return move;
        }
      }
      if (auxRng() < auxInterjectProbability()) {
        const kind = drawAuxInterjection(auxRng);
        const move = buildAuxInterjection(kind, genEnv(digest));
        if (move !== null) {
          ctx.metric(`interject:${kind}`);
          if (move.kind === 'keyFile') fileSeq += 1;
          return move;
        }
        ctx.metric(`interjectSkipped:${kind}`);
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
        case 'fileDialog': {
          if (step.rel === null) return { kind: 'cancelDialog', trigger: step.trigger, label: step.label };
          const rel = Array.isArray(step.rel) ? (step.rel[0] as string) : step.rel;
          // A `key:<chord>` trigger is the ARMED-KEYBOARD picker, not a click on
          // an element - it has no testid, so it cannot go through the click
          // path at all.
          if (step.trigger.startsWith('key:')) {
            return {
              kind: 'keyFile',
              chord: step.trigger.slice('key:'.length),
              source: replaySource(rel),
              label: step.label,
            };
          }
          return {
            kind: 'openFile',
            source: replaySource(rel),
            via: 'dialog',
            trigger: step.trigger,
            label: step.label,
          };
        }
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
          // and only the ones this scenario produces may be dispatched.
          if (step.action === 'closeProject') return { kind: 'closeProject', label: step.label };
          throw new Error(
            `refusing to replay mutate "${step.action}": ${SCENARIO} replays ` +
              `${REPLAYABLE_UI_ACTIONS.size === 0 ? 'no store actions' : [...REPLAYABLE_UI_ACTIONS].join(', ')}`,
          );
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
    const logs = new LogCursor(ctx.browser);
    await ctx.exclusive(() => logs.checkpoint());

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
      let probes = 0;
      // EVERY format this run may draw, not just the first: a drift in one
      // writer would otherwise hide behind the others passing.
      for (const format of formats) {
        for (let i = 0; i < SELF_CHECK_SPECS; i += 1) {
          const drawn = randomSurveyFileSpec(probeRng, 'valid', format);
          const spec: GeneratedFileSpec = { ...drawn, name: `selfcheck-${format}-${i}.${format}` };
          const { path: written } = materializeSurveyFile(probeDir, spec);
          const claim = selfCheckClaim(spec);
          const parsed = await ctx.ipc(claim.command, { path: written });
          const found = claim.read(parsed);
          const withinBounds = found >= claim.min && (claim.max === null || found <= claim.max);
          if (!withinBounds) {
            throw new Error(
              `GENERATOR SELF-CHECK failed on ${written}: the writer emitted a spec claiming ` +
                `${claim.min}${claim.max === null ? '+' : claim.max === claim.min ? '' : `..${claim.max}`} ` +
                `${claim.what}(s) and ${claim.command} read ${found}. ` +
                'The writer has drifted from the Rust parser; every generated file of this format would be ' +
                'rejected at the door and this run would pass green having exercised nothing.',
            );
          }
          probes += 1;
        }
      }
      ctx.setMetric('selfCheckSpecs', probes);
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
        /**
         * The project as it was WHEN THE RECEIPT WAS PRESENTED - read off the
         * receipt's own digest, so it costs no extra IPC and cannot describe a
         * different moment than the claim it will be compared against.
         *
         * F3 needs this rather than the end-of-flow bounds because the walk goes
         * on after a receipt appears: the interjection stream plays `undo`, the
         * next file gets imported, the flow ends somewhere else entirely. A
         * delta measured across those is a measurement of the WALK.
         */
        let atReceipt: CountedProject | null = null;
        /**
         * Had an undo/redo/save/close already landed when the receipt appeared?
         *
         * Then `before` describes a project the interjection has since rewritten,
         * and the subtraction has no meaning in EITHER direction - so the flow is
         * counted rather than measured, exactly as F1 does with `historyTouched`.
         */
        let historyTouchedBeforeReceipt = false;
        /**
         * Did the completion path present a receipt, in EITHER of its surfaces?
         * The modal carries a decision; a clean receipt is a toast. Both come
         * from `presentImportReceipt`, so either one proves the flow finished
         * through the path that owes the `importContext` clear.
         */
        let sawReceipt = false;
        /**
         * Was the receipt TOAST already on screen when this flow began?
         *
         * `TOAST_KEYS.IMPORT_RECEIPT` dwells for seconds, and a flow starts the
         * moment the previous one reaches `idle` - so the previous flow's
         * receipt is routinely still up. Counting it would classify the next
         * flow as `imported`, and F1 would then demand an undo entry from a
         * flow that did nothing. Measured, on the seed-7 five-format run: a
         * Walls import's receipt toast outlived its flow and failed the NEXT
         * one, which had only opened and cancelled the as-new-project dialog.
         *
         * When it is already up, this flow's evidence is the receipt MODAL and
         * the undo depth, both of which are unambiguous.
         */
        const receiptToastAtStart = digest.toast.includes(RECEIPT_TOAST_KEY);
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
          const screenBefore = digest.screen;
          digest = outcome.digest;
          await stepOracles(move, digest, screenBefore);
          if (move.kind === 'undo' || move.kind === 'redo' || move.kind === 'save') historyTouched = true;
          if (move.kind === 'closeProject') historyTouched = true;
          // The export modal is not an import screen, so opening it must not
          // make an idle walk look like a flow that imported nothing - see
          // NON_FLOW_SCREENS.
          if (digest.screen !== 'idle' && !NON_FLOW_SCREENS.has(digest.screen)) leftIdle = true;
          if (digest.receipt && receipt === null) {
            receipt = receiptClaimFrom(digest);
            if (receipt) {
              atReceipt = { sections: digest.sections, shots: digest.shots };
              historyTouchedBeforeReceipt = historyTouched;
              guarded(() => checkReceipt(receipt as ReceiptClaim));
            }
          }
          if (digest.receipt !== null) sawReceipt = true;
          if (!receiptToastAtStart && digest.toast.includes(RECEIPT_TOAST_KEY)) sawReceipt = true;
          // `-1` is the digest's "no project open" sentinel, so a flow that
          // CREATES a project would otherwise read the new project's empty undo
          // stack (depth 0) as a commit. An import pushes an entry; creating a
          // project does not.
          if (digest.undo > Math.max(0, before.undoDepth)) sawCommit = true;
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
            if (step.kind === 'corpusFile') {
              // The replayer's OWN corpus, or none. A trace carries a reference
              // and no content, so resolving one means scanning the corpus THIS
              // machine configured; a machine without that file replays
              // everything else and the move that would have opened it is
              // skipped and counted. That is a narrower replay, not a failed one.
              //
              // THE HASH IS PREFERRED AND THERE IS NO FALLBACK TO THE ID. Both
              // resolve the same file when the replayer has it, and when the
              // hash misses, the id is precisely the thing that might match a
              // DIFFERENT file - 20 bits over a few thousand entries - which
              // would materialize somebody else's survey and open it under the
              // recorded file's name. A miss is a skip; a wrong file is a lie.
              const lookup = corpusLookup(step.corpusHash ?? step.corpusId);
              if (lookup.entry === null) {
                // `ambiguous` is a v3-shaped step (id only) landing on a corpus
                // whose crc20 collides. Counted apart from a plain absence
                // because it says something about the corpus, not the trace.
                ctx.metric(lookup.outcome === 'ambiguous' ? 'corpus:ambiguousId' : 'corpus:absent');
                continue;
              }
              const copied = materializeCorpusEntry(lookup.entry, resolveRel(step.rel));
              ctx.metric(
                copied.skipped ? `corpus:notMaterialized:${copied.reason ?? 'unknown'}` : 'replay:corpusFile',
              );
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

          const drawn = drawMove(digest, mode);
          const move = drawn === null ? null : enforceSavePath(drawn, digest);
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
          const raceMove = move.kind === 'ui' && RACE_TARGETS.has(move.testid) && digest.live[move.testid] === 1;
          const exportChord = move.kind === 'ui' && move.testid === 'key:Ctrl+E';
          const closeMove = move.kind === 'closeProject';
          const frozenDelete =
            move.kind === 'ui' &&
            move.testid === 'shot-editor-context-delete-rows' &&
            digest.selRows.length > 0 &&
            digest.selRows.every((row) => digest.frozen.includes(row));
          const interjectRoute =
            move.kind === 'openFile' && move.label.startsWith('INTERJECT:') && IMPORT_GUARDED_SCREENS.has(screenBefore);

          const outcome = await execute(move, true);
          steps += 1;
          await afterMove(move, outcome);

          if (raceMove) {
            // COUNTED, never asserted - and the reason is the same one that took
            // the screen-equality check out of the IMPORT GATE branch below.
            //
            // The generator picks a confirm the DIGEST saw disabled. The bridge
            // then refuses a disabled element at dispatch with byte-identical
            // predicates, so a race move that was performed is a move whose
            // target was ENABLED when it was clicked, and clicking an enabled
            // confirm is not a defect - it is the app having finished the async
            // work the digest caught it in the middle of (`WallsImportDialog`
            // holds Import behind `!hashChecked` while a hash and a
            // duplicate-check round trip run). Asserting on it reported that
            // legal click as "a DISABLED control advanced the flow" on four
            // campaign cells; `raceContinue` never once fired for another reason.
            //
            // And the other branch cannot be asserted either. When the target IS
            // still disabled the bridge does not click it, so nothing the app did
            // can be attributed to the move: any screen change belongs to work
            // that was already in flight, which is precisely the shape that made
            // this scenario abandon screen-equality once already. The contract
            // "a disabled control must not act" is not reachable through a
            // synthetic dispatch that respects `disabled` - and one that did not
            // respect it would be testing the harness, since `dispatchEvent`
            // bypasses the browser's own gate and would run React's onClick on a
            // button no user could press.
            if (outcome.offAtDispatch === true) {
              ctx.metric('raceRefused');
              if (digest.screen !== screenBefore) ctx.metric('raceRefusedScreenMoved');
            } else if (outcome.performed) {
              ctx.metric('raceEnabledBeforeClick');
              if (digest.screen !== screenBefore) ctx.metric('raceEnabledAdvanced');
            } else {
              // Gone from the DOM between the digest and the dispatch - the
              // dialog closed under the race. Same window, other end.
              ctx.metric(`raceVanished:${outcome.skip ?? 'unknown'}`);
            }
          }
          if (exportChord && outcome.performed) {
            ctx.metric(`exportChord:${screenBefore}`);
            // The app's own gate: both keyboard dispatchers read
            // `useUIStore.getState().activeDialog` INSIDE the keydown handler and
            // return early for every non-Escape key while one is open, so Ctrl+E
            // must be inert on top of an import screen. An export modal that
            // opened there would sit over a flow that still owns the state under
            // it.
            //
            // Judged on `dialogAtDispatch` - the value that gate read - and not
            // on `screenBefore`, which is a round trip older. An import that
            // completes in that gap closes its dialog, and the chord then lands
            // at idle and is entitled to open the modal. Measured, on the corpus
            // campaign's seed-117 retry: `walls import` left the screen on
            // `walls` with the import still running, the next move was the Ctrl+E
            // interjection, and the failure blamed the dispatcher for a chord it
            // had swallowed correctly - the dialog was simply gone by then.
            if (outcome.dialogAtDispatch !== null && digest.screen === 'export-modal') {
              fail(
                `EXPORT CHORD: Ctrl+E opened the export modal on top of "${outcome.dialogAtDispatch}"`,
                `  screen ${screenBefore} -> ${digest.screen}; that dialog was up when the keydown was ` +
                  'dispatched, so the shortcut dispatcher must swallow the chord',
              );
            } else if (screenBefore !== 'idle' && digest.screen === 'export-modal') {
              ctx.metric('exportChordAfterDialogClosed');
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
          if (closeMove && outcome.performed) {
            ctx.metric('closeProjectInterjections');
            // Only ever played at `idle` (see `buildAuxInterjection`), so this
            // is E1's contract applied mid-run: closing must leave no project,
            // no dialog and no placement behind it.
            const residue = [
              digest.hasProject ? 'a project is still open' : null,
              digest.dialog !== null ? `activeDialog=${JSON.stringify(digest.dialog)}` : null,
              digest.placement ? 'placementMode is still set' : null,
            ].filter((line): line is string => line !== null);
            if (residue.length > 0) {
              fail('CLOSE: closing the project at idle left state behind', residue.map((line) => `  ${line}`).join('\n'));
            }
          }
          if (interjectRoute && outcome.performed) {
            ctx.metric('interjectRouteGuarded');
            // The REFUSAL TOAST, not the screen, is the guard's observable
            // effect - and the screen is not a sound test of it. Measured, on
            // the seed-7 five-format run: `create-and-continue-button` starts
            // an async chain (create the project, then open the format's own
            // dialog) that the settle loop cannot wait for, because
            // `activeDialog` does not change until it lands. So the screen can
            // move from `new-project` to `tml-config` three moves later, for a
            // reason that has nothing to do with the routed file, and a
            // screen-equality check reports the guard as broken when it worked.
            if (!digest.toast.includes(IMPORT_GATE_TOAST_KEY)) {
              fail(
                'IMPORT GATE: a second file was routed into a screen an import already owned',
                `  screen ${screenBefore} -> ${digest.screen}; routeOpenedFile must refuse and SAY so (#411)\n` +
                  `  toasts: ${JSON.stringify(digest.toast)}`,
              );
            }
          }
        }

        if (!leftIdle) {
          ctx.metric('flowSkipped');
          continue;
        }

        // The flow is over. Make sure it really is before measuring it - both
        // that nothing is still on screen, and that `idle` is rest rather than
        // a gap in an async completion.
        digest = await settleToRest(digest);
        if (!isEscaped(digest.screen, digest.placement)) {
          digest = await escapeFrom(digest);
          digest = await settleToRest(digest);
        }
        const after = await boundsNow(digest);
        ctx.metric('flows');

        const what = `flow ${flow + 1} of episode ${episode + 1}`;
        const shape: FlowShape = sawCommit || sawReceipt ? 'imported' : 'cancelled';
        ctx.metric(`flowShape:${shape}`);
        guarded(() => checkResidue(digest, what));
        guarded(() => checkTempFiles(before, after, what));
        // Counted, never asserted: `checkResidue` documents why this scenario
        // cannot tell a completion from an abandonment, and #477 - the real
        // completion-path defect - was established by reading the code.
        if (digest.ctx !== null) ctx.metric(`residualImportContext:${digest.ctx}`);
        if (sawReceipt) ctx.metric('flowPresentedReceipt');
        // F3 measures the receipt against the delta the import made, so it needs
        // both measurements to describe the same project. A flow that started
        // with a project and ended with a DIFFERENT one - `import-as-new-project`
        // confirms by closing the current project and re-entering the router -
        // has bounds taken from two unrelated projects, and the difference
        // between them is not an accounting error, it is a subtraction with no
        // meaning. A flow that CREATED the project it ended with is still
        // measured: `before` is then simply empty.
        //
        // The measured end is `atReceipt`, not `after` - see `checkAccounting`.
        if (receipt && atReceipt) {
          if (before.projectFile !== null && before.projectFile !== after.projectFile) {
            ctx.metric('f3Skipped:projectSwapped');
          } else if (historyTouchedBeforeReceipt) {
            ctx.metric('f3Skipped:historyTouched');
          } else {
            guarded(() => checkAccounting(receipt as ReceiptClaim, before, atReceipt as CountedProject));
          }
        }

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
