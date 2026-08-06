/**
 * undo-persistence-fuzz: hunts bug 8's SIBLINGS across the save/reload boundary.
 *
 * Where `undo-redo-fuzz` draws random moves and crosses the persistence boundary
 * occasionally, this scenario does one thing on purpose, every iteration:
 * build an undo stack that carries EVERY UndoData variant a live command can
 * produce, make the shot ids diverge from positional order, leave the redo stack
 * non-empty, save/close/reopen, and then walk the whole RESTORED history down to
 * depth 0 and all the way back up - including through the restored REDO entries,
 * which nothing else in the harness has ever exercised.
 *
 * ## Why
 *
 * Bug 8 (issue #413, the data-corruption one) is three facts stacked:
 *
 *   1. shots are RENUMBERED on load to `section_id * FEATURE_ID_STRIDE +
 *      sequence_order` (persistence/sqlite/read.rs:372);
 *   2. undo entries are persisted and reloaded as OPAQUE JSON with no remapping
 *      anywhere on the restore path (persistence/sqlite/undo.rs); and
 *   3. the in-session allocator (`Section::take_shot_id`) hands out ids from the
 *      SAME space, so a stale id does not miss - it COLLIDES.
 *
 * Nothing about that reasoning is specific to `CreatedShotSnapshot`. Every
 * variant that names a shot by id is exposed, and so is every redo that
 * re-executes the ORIGINAL command (`redo_inner`'s catch-all arm,
 * core/state/undo.rs, re-runs `entry.command` for `PreviousValues`,
 * `InverseCommand` and `ZeroDatumInfo`). The main fuzzer rarely unwinds deep into
 * a restored stack and NEVER redoes a restored redo entry, so those siblings were
 * unreachable. This scenario reaches them by construction.
 *
 * ## What one iteration does
 *
 * 1. Open a fresh copy of the fixture with its persisted undo history DELETED
 *    (`loadFixtureWithoutUndoHistory`), so depth is measured from a known floor.
 *    `STALAGMIGHT_FUZZ_FIXTURE` picks the fixture, exactly as the main fuzzer.
 * 2. Run the COVERAGE PLAN (`undoPersistenceCoverage.ts`): a fixed sequence of
 *    mutations, with seeded targets and values, that puts every reachable
 *    `UndoData` variant on the stack. The plan is then CHECKED against
 *    `get_undo_stack`, not assumed.
 * 3. Assert the id-vs-position divergence really happened. A section whose ids
 *    still equal `section_id * STRIDE + position` would survive the reload
 *    unchanged, and the whole collision precondition would be absent.
 * 4. Undo a few entries, so the REDO stack is non-empty when the save runs (both
 *    stacks are persisted, and the redo half restores too).
 * 5. Save to a temp path, close, reopen. Both stack lengths must come back
 *    exactly; the model switches to id-agnostic comparison here, because
 *    `Shot::id` is not persisted.
 * 6. Unwind through EVERY restored undo entry to depth 0, then redo back to the
 *    top - through the restored redo entries as well - verifying the snapshot
 *    recorded at every depth in both directions.
 *
 * Iterations are independent: each one re-opens the fixture and resets the
 * in-page model, because the persisted window (`undo_persist_limit`, 20) means a
 * stack deeper than the plan could not round trip intact.
 *
 * ## Oracles
 *
 * The same three the main fuzzer runs, through the same in-page bridge
 * (`undoRedoFuzzBridge.ts`): the exact canonical-state ROUNDTRIP per depth, the
 * ABSOLUTE invariant suite on every observed state, and the INTEGRITY DELTA.
 * Plus two this scenario adds:
 *
 *   - COVERAGE. Every variant a guaranteed plan step promises must be present on
 *     the restored stack, or the run fails: a coverage claim that is not checked
 *     is not a coverage claim.
 *   - STACK SURVIVAL. `undoLen` and `redoLen` after the reopen must equal what
 *     they were at save time.
 *
 * ## Known bugs that fire here by construction
 *
 * Two, and both are handled by classification rather than by weakening anything.
 * Neither is tolerated unless `STALAGMIGHT_FUZZ_ALLOW_KNOWN_BUGS=1` is set;
 * strict mode still fails on the first hit of either.
 *
 *   - FINDING 11 (`pre-save-snapshot-undo-reverts-save-heals`). A
 *     `ProjectSnapshotPair` recorded BEFORE the save holds the pre-heal project
 *     in both halves, so redoing one reverts the save's gauge-anchor capture.
 *     This scenario saves with a stack of pre-save entries under it and then
 *     redoes all of them, so it fires every iteration. The classifier is narrow:
 *     `gauge_shot_uuid` / `gauge_neighbour_uuid` going value -> null and nothing
 *     else. Documented at
 *     <https://github.com/Stalagmight/Stalagmight/issues/413> and pinned red by
 *     `undo_of_a_pre_save_entry_keeps_the_saves_gauge_anchors`.
 *
 *     It shares its path and value shape with bug 1's second half
 *     (`create-section-redo-drops-gauge-anchors`), and the two are told apart by
 *     WHICH entry the move consumed: a `create_section` entry is bug 1, anything
 *     else is finding 11. `classifierFor` does exactly that, so the failure
 *     message names the right one.
 *
 *   - BUG 8 itself (`bug-8-wrong-shot-delete`). It is deliberately NOT in
 *     `KNOWN_UNDO_ASYMMETRIES` - it is data corruption, and the main fuzzer
 *     should stop dead on it. Here that would defeat the point: bug 8 fires on
 *     the unwind, near the top of the stack, and everything beneath it - the
 *     siblings this scenario exists to find - would never be reached. So a
 *     bug-8-SHAPED mismatch is counted, logged, resynced and walked past, under
 *     three conditions that are checked, not assumed:
 *
 *       a. tolerant mode only (`STALAGMIGHT_FUZZ_ALLOW_KNOWN_BUGS=1`);
 *       b. the comparison is after a reload (`reloadsDone > 0`); and
 *       c. the entry the move consumed is a `create_shot`, which is the only
 *          command whose undo is `delete_shot(section_id, stale_shot_id)`
 *          (`UndoData::CreatedShotSnapshot`, core/state/undo.rs:126-133) - the
 *          exact mechanism bug 8 names.
 *
 *     and only for the exact SIGNATURE `isBug8ShotSwapOnly` recognises: ONE
 *     section holding the right NUMBER of shots with exactly one of them the
 *     wrong shot, AND every remaining unexplained diff accounted for by that
 *     swap (inside the swapped section, or in the geometry its shots feed). A
 *     count change, a one-sided loss, more than one section, more than one swap,
 *     a difference that leaves the uuid sets equal, or ANY unrelated damage
 *     riding along is NOT bug 8 and still fails. A wrong-shot swap on any other
 *     entry type is a NEW finding, by construction.
 *
 *   - FINDINGS 12 and 13, this scenario's own (see below). Same treatment and
 *     the same three conditions: 12 (`stale-id-writes-to-the-wrong-shot` plus its
 *     three derived-geometry siblings) applies only to a `set_shot_kind` or
 *     `update_shot` entry after a reload, and only over the SCALAR shot fields
 *     and the geometry derived from them - a shot count change, a uuid change or
 *     anything structural is not covered and still fails. 13 is an undo that
 *     FAILS OUTRIGHT with the exact error `Shot N not found in section S`; it is
 *     counted and the unwind stops there, because the entry is pushed back and
 *     the history really is wedged.
 *
 *   - CONTAMINATION. Once a stale-id defect has fired, the live project no longer
 *     matches any snapshot recorded before the save, so every remaining
 *     comparison in that walk is re-measuring the same defect. From that point
 *     the finding-12 classifiers apply regardless of entry type
 *     (`classifierFor`'s `contaminated` argument) and, if a mismatch still cannot
 *     be classified, the ROUNDTRIP and INTEGRITY-DELTA oracles are downgraded to
 *     counters for the rest of that walk.
 *
 *     That is a real reduction in what the walk can prove, and the alternative -
 *     stopping at the first defect - proves strictly less, because these oracles
 *     stay HARD throughout: the ABSOLUTE INVARIANT suite, an undo or redo that
 *     fails outright (bar the one documented wedge signature), a stack-shape
 *     change, and every crash / error-log oracle the sweep runs afterwards. So
 *     the walk still exercises every restore path in the stack, against a project
 *     the app itself corrupted - which is a harder input than any it would see
 *     otherwise.
 *
 *     How much it actually gives up is measured, not guessed. Over 60 iterations
 *     on the fractal fixture the roundtrip downgrade fired ZERO times
 *     (`contaminatedMismatch` = 0): every one of the 1054 tolerated mismatches
 *     was still explained by a NAMED classifier. The integrity downgrade fired
 *     twice per iteration (`contaminatedIntegrityDelta` = 120), always on the
 *     closure entries, because a wrongly-deleted shot dangles the merge anchored
 *     to it and the checker rightly says so. Those two counters are the thing to
 *     watch: if `contaminatedMismatch` ever climbs, the classifiers have stopped
 *     covering what the walk is seeing and something new is hiding in it.
 *
 * ## Findings
 *
 * Two, both new, both root-caused and pinned red in
 * `src-tauri/src/core/state/open_undo_bugs_tests.rs`, both written up at
 * <https://github.com/Stalagmight/Stalagmight/issues/413>. They are the same
 * root cause as bug 8 - no id remapping on the undo restore path - in variants
 * and directions nothing had reached before.
 *
 * 12. DATA CORRUPTION, quiet. After a save/reload, undo (or redo) of
 *     `SetShotKind` or `UpdateShot` applies to the WRONG SHOT.
 *     `UndoData::InverseCommand(Command::SetShotKind { shot_id })` and
 *     `UndoData::PreviousValues { shot_id }` both name a shot by its in-session
 *     id (undo_capture.rs:172-185 and :94-135); undo re-executes them against the
 *     live project (undo.rs:60-62, :65-88) and `redo_inner`'s catch-all arm
 *     re-executes `entry.command` verbatim (undo.rs:696), which carries the same
 *     id. Nothing is deleted, no uuid changes, no count moves and
 *     `check_project_integrity` is silent: one shot keeps an edit the undo should
 *     have taken away and another gains one it never had.
 *
 *     Needs no delete, unlike bug 8 - one insert-before is enough.
 *
 *     STRICT repro: `--seed 1 --iterations 1` on fractal (what the
 *     `agent:scenarios` smoke entry runs), which fails on the first id-bearing
 *     entry it unwinds:
 *
 *         undo did not restore the state recorded at depth 16
 *           (the entry it consumed was set_shot_kind)
 *           at project.sections[32].shots[0].kind
 *             expected: "Normal"   actual: "Jump"
 *
 *     What is NOT affected, which bounds the fix: `SegmentMoveInfo` and
 *     `ZeroDatumInfo` name sections and section ids ARE persisted; `ClosureInfo`
 *     and every stored station reference use `StationKey`
 *     (`SectionStart` / `AfterShot(uuid)`, models/station.rs), which is
 *     uuid-anchored on purpose. Six further variants have restore arms but no
 *     live producer at all - see `UNREACHABLE_VARIANTS`.
 *
 * 13. WEDGED HISTORY. Same mechanism, opposite outcome. A section that has had a
 *     shot DELETED has handed out more ids than it has shots, so the newest
 *     persisted id runs PAST `section_id * STRIDE + (len - 1)` and misses
 *     everything: `delete_shot` / `update_shot` / `set_shot_kind` return
 *     "Shot N not found in section S", the undo fails, and `undo_inner`'s
 *     epilogue (undo.rs:439-444) pushes the entry back - so it fails identically
 *     forever and every entry beneath it is unreachable for good.
 *
 *     Bug 8's write-up says a stale id "does not miss - it COLLIDES". True only
 *     while the section still has as many shots as ids were handed out; a delete
 *     breaks that and switches the whole defect into this regime.
 *
 *     Repro: `STALAGMIGHT_PERSIST_FUZZ_DELETE_IN_TARGET=1 --seed 1 --iterations 3`
 *     on fractal. That flag is off by default because the wedge is terminal - the
 *     unwind cannot get past it, so the lower two thirds of the stack goes
 *     unwalked. With the delete on the plan's SPARE section instead, the target's
 *     ids stay in range, a stale id collides rather than misses, and the walk
 *     runs to the bottom.
 *
 * A structural fact worth keeping, found while reaching these: a
 * `ProjectSnapshotPair` entry is a WALL. `Shot::id` is serialized inside a
 * project snapshot (models/shot.rs, no `skip`), so restoring one puts the project
 * back into the PRE-SAVE id space and every stale id beyond it becomes valid
 * again. The exposed window is exactly "from the depth the reload lands on, down
 * to the first `ProjectSnapshotPair` beneath it" - which is why a random fuzzer
 * missed all of this, and why `COVERAGE_STEPS` puts every snapshot-pair step as
 * low in the stack as its preconditions allow.
 *
 * ## Trace record / replay
 *
 * Each iteration records its resolved move list and, on failure, writes it to the
 * session artifacts dir (path named in the message). The recorder RESETS per
 * iteration, because the cycles are independent - so the trace is of the cycle
 * that failed, already minimal in that dimension.
 *
 * `--trace <file>` replays one and `pnpm agent:fuzz-shrink` minimizes it. On a
 * replay the PLAN's own preconditions are skipped - id divergence, the
 * renumbering check, variant coverage, "the plan pushed no entries" - because a
 * shrunk trace is by construction not the plan. Every APP oracle still runs:
 * roundtrip, absolute invariants, integrity delta and stack survival.
 *
 * ## Determinism
 *
 * Every value and every target is drawn from `ctx.rng()`; the plan's order is
 * fixed. There are no secondary streams, because there is no legacy stream to
 * preserve: this scenario is new, and nothing outside it depends on its draws.
 * Equally, it draws from its OWN context and its own generators - it imports no
 * generator from `undoRedoFuzzActions.ts` - so it cannot move `undo-redo-fuzz`'s
 * stream or invalidate any repro seed recorded there.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Scenario, ScenarioContext } from './framework';
import { DEFAULT_FIXTURE, disableAutoSave, loadFixtureWithoutUndoHistory } from './common';
import {
  KNOWN_UNDO_ASYMMETRIES,
  PRE_SAVE_SNAPSHOT_HEAL_REVERT,
  RELOAD_RESOLVED_GEOMETRY,
  SAVE_HEALING_MUTATIONS,
  classifyDiffs,
  describeDiffs,
  describeShotSetDelta,
  diffSnapshots,
  maxNumericDelta,
  isBug8ShotSwapOnly,
  shotSetDelta,
  type KnownAsymmetry,
  type SnapshotDiff,
} from '../lib/projectSnapshot';
import type { TargetingDigest } from '../lib/fuzzOracleCore';
import {
  COVERAGE_STEPS,
  FEATURE_ID_STRIDE,
  GUARANTEED_VARIANTS,
  PLANNED_VARIANTS,
  UNREACHABLE_VARIANTS,
  VARIANT_BY_COMMAND_TYPE,
  idsDivergeFromPosition,
  newCoverageMemo,
  type CoverageAction,
  type UndoVariant,
} from './undoPersistenceCoverage';
import {
  TraceRecorder,
  defaultTracePath,
  readTrace,
  writeTrace,
  type FuzzTrace,
  type TraceStep,
} from '../lib/fuzzTrace';
import {
  REPLAYABLE_MUTATIONS,
  bumpEpoch,
  enableIdAgnosticModel,
  fetchMismatch,
  initModel,
  injectOracle,
  observeOnly,
  resyncModel,
  runStep,
  type IntegrityVerdict,
  type StepResponse,
} from './undoRedoFuzzBridge';

/** Opt in to surviving a mismatch that is entirely a documented open app bug. */
const ALLOW_KNOWN_BUGS = process.env.STALAGMIGHT_FUZZ_ALLOW_KNOWN_BUGS === '1';

/** Which `.stalx` under `e2e/fixtures/` to fuzz. Basename only, as the main fuzzer. */
const FIXTURE = process.env.STALAGMIGHT_FUZZ_FIXTURE || DEFAULT_FIXTURE;

/** Diffs shown in a failure message (more are counted, not printed). */
const SHOWN_DIFFS = 6;
/**
 * Differences the slow re-compare collects before it gives up.
 *
 * A capped list can only ever support a NEGATIVE conclusion. `checkSnapshot`
 * asks for one more than this and refuses to tolerate anything - including a
 * bug-8-shaped swap - when the extra one comes back.
 */
const DIFF_LIMIT = 400;
/** Actions shown in the failure message's history tail. */
const HISTORY_TAIL = 14;
/** `STALAGMIGHT_FUZZ_DUMP_HISTORY=1` prints the WHOLE iteration history instead. */
const DUMP_FULL_HISTORY = process.env.STALAGMIGHT_FUZZ_DUMP_HISTORY === '1';

/** Most entries undone before the save, so the redo stack is non-empty there. */
const MAX_PRE_SAVE_UNDOS = 4;

/**
 * Replay a recorded trace instead of running the coverage plan, and where to
 * force-write the trace of a run that passed.
 *
 * Read at RUN time, not at import time: `pnpm agent:scenario --trace` parses its
 * flags inside `main()`, after this module is imported, so a module-level const
 * would capture the empty string and silently fall back to generating.
 *
 * Replay is a MODE of this scenario, never a separate one - the fused step, the
 * three oracles, the classification and the contamination rules are all the same
 * code on both paths.
 */
function replayTracePath(): string {
  return process.env.STALAGMIGHT_FUZZ_REPLAY ?? '';
}

function traceOutPath(): string {
  return process.env.STALAGMIGHT_FUZZ_TRACE ?? '';
}

/** The bug-8 signature, as a classifier so it can be named in a message. */
const BUG_8_WRONG_SHOT: KnownAsymmetry = {
  id: 'bug-8-wrong-shot-delete',
  // Recognised structurally (shot identity), never by path.
  pathPattern: /^(?!)/,
  description:
    'Bug 8 (DATA CORRUPTION): after a save/reload, undo of a CreateShot deletes the WRONG shot. ' +
    'UndoData::CreatedShotSnapshot { section_id, shot_id } undoes via delete_shot with the ' +
    'PERSISTED id, which the loaders renumbering has since reassigned to a different shot. ' +
    'Walked past here (tolerant mode only) because this scenario exists to find the SIBLINGS ' +
    'underneath it; undo-redo-fuzz still stops dead on it.',
};

/**
 * FINDING 12: bug 8's mechanism is not confined to `CreatedShotSnapshot`. The
 * same stale id in an `InverseCommand(SetShotKind)` or a
 * `PreviousValues { shot_id }` entry makes the undo (and the redo, through
 * `redo_inner`'s catch-all re-execution of `entry.command`) write to the WRONG
 * SHOT after a reload. Nothing is deleted, no uuid changes and no count moves:
 * one shot silently keeps an edit it should have lost, and another silently
 * gains one it never had.
 *
 * Applied ONLY when the entry the move consumed is a `set_shot_kind` or an
 * `update_shot`, which are exactly the two commands whose undo data names a shot
 * by id and whose restore path re-executes against the live project. The path
 * list is the SCALAR shot fields plus the geometry derived from them - so a shot
 * COUNT change, a uuid change, or anything structural is not covered and still
 * fails, which is what keeps this from becoming a general "shots differ"
 * tolerance.
 */
const SHOT_SCALAR_FIELDS =
  'azimuth_in|azimuth_out|length|depth_in|depth_out|pitch_in|pitch_out|left|right|up|down|' +
  'comment|kind|marker_index|temperature';

const STALE_ID_WRONG_SHOT_WRITE: readonly KnownAsymmetry[] = [
  {
    id: 'stale-id-writes-to-the-wrong-shot',
    pathPattern: new RegExp(`^project\\.sections\\[\\d+\\]\\.shots\\[\\d+\\]\\.(${SHOT_SCALAR_FIELDS})$`),
    description:
      'Finding 12: after a save/reload, undo or redo of SetShotKind / UpdateShot applies to the ' +
      'WRONG shot. UndoData::InverseCommand and UndoData::PreviousValues { shot_id } both name a ' +
      'shot by its in-session id; the loader renumbers to section_id * FEATURE_ID_STRIDE + ' +
      'sequence_order (persistence/sqlite/read.rs) and nothing remaps the persisted entries, so ' +
      'the id addresses whichever shot now occupies that slot. Same root cause as bug 8, ' +
      'different variants and a quieter symptom: no shot is lost, one just keeps an edit it ' +
      'should have lost while another gains one it never had.',
  },
  {
    id: 'stale-id-wrong-shot-derived-coordinates',
    pathPattern: /^stations\[\d+\]\.coordinates\.[xyz]$/,
    description: 'Station coordinates are derived from shot geometry, so they move with finding 12s write.',
  },
  {
    id: 'stale-id-wrong-shot-derived-offsets',
    pathPattern: /^project\.section_offsets\.\d+(\[\d+\])?$/,
    description: 'Section offsets are re-solved from shot geometry, so they move with finding 12s write.',
  },
  {
    id: 'stale-id-wrong-shot-derived-stats',
    // Counts are NOT here: a shot/section/station count change is structural and
    // is not what a wrong-target field write does.
    pathPattern: /^stats\.(total_length|min_depth|max_depth|penetration_distance)$/,
    description: 'Aggregate stats are derived from shot geometry, so they move with finding 12s write.',
  },
];

interface SnapshotCheck {
  equal: boolean;
  floatNoise: boolean;
  attributed: KnownAsymmetry[];
  text: string;
  onlyKnown: boolean;
  asymmetries: KnownAsymmetry[];
}

const EQUAL: SnapshotCheck = {
  equal: true,
  floatNoise: false,
  attributed: [],
  text: '',
  onlyKnown: false,
  asymmetries: [],
};

/**
 * Which classifiers apply to a mismatch produced by consuming `entryType`.
 *
 * Finding 11 and bug 1's second half are indistinguishable by path and value -
 * both are a gauge anchor going value -> null - and are separated only by the
 * entry the move consumed. `create_section` is bug 1 (`restore_section` rebuilds
 * through `Section::new`, which hardcodes the anchors to None); every other entry
 * type reaching that shape is a pre-save snapshot pair reverting the save's heal,
 * which is finding 11. Ordering the list decides which one `classifyDiffs`
 * reports, since it takes the first match.
 */
function classifierFor(
  entryType: string | null,
  afterReload: boolean,
  contaminated: boolean,
): readonly KnownAsymmetry[] {
  // Finding 12's paths are in scope once the loader has renumbered AND either the
  // entry being consumed is one of the two whose undo data names a shot by id, or
  // a stale-id defect has ALREADY fired in this walk.
  //
  // The second half is CONTAMINATION, and it is not a loosening. A wrong-target
  // write is not undone by continuing to unwind: the value landed on a shot no
  // entry below knows about, so from that moment the live project disagrees with
  // every snapshot recorded before the save and every remaining comparison is
  // re-measuring the same defect. Reporting each of them as a fresh mystery would
  // be noise. What stays strict is the SHAPE: only the scalar shot fields and the
  // geometry derived from them are absorbed, so anything structural still fails.
  const staleId = afterReload
    ? entryType === 'set_shot_kind' || entryType === 'update_shot' || contaminated
      ? STALE_ID_WRONG_SHOT_WRITE
      : []
    : [];
  if (entryType === 'create_section') return [...KNOWN_UNDO_ASYMMETRIES, ...staleId];
  return [PRE_SAVE_SNAPSHOT_HEAL_REVERT, ...KNOWN_UNDO_ASYMMETRIES, ...staleId];
}

/**
 * The SLOW path, reached only after the page reported a mismatch: re-compare with
 * numeric tolerance, subtract the documented save/reload families when the
 * comparison crosses an epoch, then classify what is left.
 */
function checkSnapshot(
  expected: string,
  actual: string,
  attributable: readonly KnownAsymmetry[],
  known: readonly KnownAsymmetry[],
  bug8Allowed: boolean,
): SnapshotCheck {
  if (expected === actual) return EQUAL;
  // ONE MORE than we report: `truncated` is what tells "exactly DIFF_LIMIT
  // differences" from "at least that many, and the rest were never looked at".
  // The walk visits root keys in sorted order, so a wide `project.*` difference
  // can spend the whole budget before `stations` or `stats` is examined once -
  // and every tolerance below reads "nothing unexplained is left" off this list.
  const all = diffSnapshots(expected, actual, DIFF_LIMIT + 1);
  if (all.length === 0) return { ...EQUAL, floatNoise: true };
  const truncated = all.length > DIFF_LIMIT;
  if (truncated) all.length = DIFF_LIMIT;

  let diffs = all;
  let attributed: KnownAsymmetry[] = [];
  let absorbed: SnapshotDiff[] = [];
  if (attributable.length > 0) {
    const split = classifyDiffs(all, attributable);
    if (split.known.length > 0) {
      diffs = split.unknown;
      attributed = split.asymmetries;
      absorbed = split.known.map((hit) => hit.diff);
    }
  }
  if (diffs.length === 0) {
    // The ATTRIBUTED shape is what the caller RESYNCS on, so it may only be
    // returned for a complete list. Every path we saw was attributable, but on
    // a truncated diff the ones past the cap were never looked at.
    if (truncated) {
      return {
        equal: false,
        floatNoise: false,
        attributed,
        text:
          `  every path in the first ${DIFF_LIMIT} was a documented save/reload change, but the\n` +
          '  diff was CAPPED there - so this is a statement about a PREFIX, not about the mismatch.',
        onlyKnown: false,
        asymmetries: [],
      };
    }
    // The absorbed MAGNITUDE goes on the record. The re-derived-geometry
    // families are bounded by shape, not by size (see RELOAD_RESOLVED_GEOMETRY),
    // which is only defensible while the number is visible.
    const worst = maxNumericDelta(absorbed);
    return {
      equal: false,
      floatNoise: false,
      attributed,
      text: attributed
        .map((entry) => `  ATTRIBUTED [${entry.id}]: ${entry.description}`)
        .concat(worst === null ? [] : [`  largest absorbed numeric change: ${worst.toExponential(3)}`])
        .join('\n'),
      onlyKnown: false,
      asymmetries: [],
    };
  }

  const lines = [describeDiffs(diffs.slice(0, SHOWN_DIFFS))];
  if (diffs.length > SHOWN_DIFFS) lines.push(`  ...and ${diffs.length - SHOWN_DIFFS} more differing path(s)`);
  if (truncated) {
    lines.push(
      `  THE DIFF WAS CAPPED at ${DIFF_LIMIT} path(s): everything above is a PREFIX and nothing`,
      '  past it was examined, so no classifier can speak for this mismatch and none is allowed to.',
    );
  }

  // Shot identity by uuid, which survives the renumbering, is the only thing
  // that can tell "the same shots moved" from "a different shot was deleted".
  const deltas = shotSetDelta(expected, actual);
  if (deltas.length > 0) {
    lines.push('  SHOT IDENTITY DELTA (by uuid, which survives save/reload):');
    lines.push(describeShotSetDelta(deltas));
  }
  for (const entry of attributed) {
    lines.push(`  (plus attributable change(s) [${entry.id}], subtracted before this diff)`);
  }

  const classified = classifyDiffs(diffs, known);
  for (const asymmetry of classified.asymmetries) {
    lines.push(`  KNOWN OPEN APP BUG [${asymmetry.id}]: ${asymmetry.description}`);
  }

  // Bug 8 LAST, and only over what the path classifiers could not explain. It is
  // recognised STRUCTURALLY (one shot swapped for another in one section), never
  // by path, because the wrong shot being deleted rewrites every derived
  // coordinate and a path rule broad enough to cover that would hide real drift.
  //
  // Order matters and was found the hard way: bug 1 re-mints EVERY shot uuid in
  // the section it redoes, which also reads as "different shots are present", so
  // a structural check running first swallowed bug 1 and reported it as bug 8.
  // `isShotIdentitySwap` is now narrow enough to reject that shape on its own,
  // and this ordering makes the classification unambiguous regardless.
  //
  // `isBug8ShotSwapOnly`, not `isShotIdentitySwap`: the swap has to explain the
  // WHOLE remaining mismatch. The uuid predicate alone says nothing about the
  // other unknown diffs, so a lost comment in another section riding along with
  // a genuine swap was tolerated, resynced away and never seen again.
  if (
    bug8Allowed &&
    !truncated &&
    classified.unknown.length > 0 &&
    isBug8ShotSwapOnly(classified.unknown, deltas, expected, actual)
  ) {
    lines.push(`  KNOWN OPEN APP BUG [${BUG_8_WRONG_SHOT.id}]: ${BUG_8_WRONG_SHOT.description}`);
    return {
      equal: false,
      floatNoise: false,
      attributed,
      text: lines.join('\n'),
      onlyKnown: true,
      asymmetries: [...classified.asymmetries, BUG_8_WRONG_SHOT],
    };
  }

  return {
    equal: false,
    floatNoise: false,
    attributed,
    text: lines.join('\n'),
    onlyKnown: !truncated && classified.unknown.length === 0,
    asymmetries: classified.asymmetries,
  };
}

/** `get_undo_stack` / `get_redo_stack` rows, as the frontend sees them. */
interface HistoryItem {
  index: number;
  description: string;
  commandType: string;
}

async function readStack(ctx: ScenarioContext, which: 'getUndoStack' | 'getRedoStack'): Promise<HistoryItem[]> {
  const res = (await ctx.callAction('project', which, [])) as { ok: boolean; result?: unknown };
  return Array.isArray(res.result) ? (res.result as HistoryItem[]) : [];
}

export const undoPersistenceFuzz: Scenario = {
  name: 'undo-persistence-fuzz',
  description:
    'Builds an undo stack covering every reachable UndoData variant, saves/reopens it, then ' +
    'walks the whole restored history down and back up - hunting bug 8s stale-id siblings.',
  defaultIterations: 12,
  async run(ctx, { iterations }) {
    ctx.setMetric(`fixture:${FIXTURE}`, 1);
    ctx.setMetric('plannedVariants', PLANNED_VARIANTS.length);
    const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-persist-fuzz-'));

    // Not reachable from a stripped project, so out of scope by construction.
    // Logged once per run rather than asserted: the day a command starts
    // producing one of these again, the coverage report is where it will show up.
    ctx.log(
      `UndoData variants no live command produces (out of scope): ` +
        Object.entries(UNREACHABLE_VARIANTS)
          .map(([name, why]) => `${name} (${why})`)
          .join('; '),
    );

    const seen = new Map<UndoVariant, number>();
    let totalEntries = 0;

    try {
      for (let iteration = 1; iteration <= iterations; iteration++) {
        const covered = await runIteration(ctx, iteration, iterations, saveDir);
        for (const [variant, count] of covered) {
          seen.set(variant, (seen.get(variant) ?? 0) + count);
          totalEntries += count;
        }
      }
    } finally {
      try {
        fs.rmSync(saveDir, { recursive: true, force: true });
      } catch {
        // Best-effort: a leftover temp dir is not a scenario failure.
      }
    }

    for (const [variant, count] of seen) ctx.setMetric(`variant:${variant}`, count);
    ctx.log(
      `fixture=${FIXTURE} seed=${ctx.seed}: ${iterations} save/reload cycle(s), ` +
        `${totalEntries} persisted undo entries walked in both directions; variant coverage ` +
        `${[...seen.entries()].map(([v, c]) => `${v}=${c}`).sort().join(' ')}`,
    );
  },
};

/**
 * One complete cycle: open, build, diverge, undo a few, save/reopen, unwind,
 * rewind. Returns how many entries of each variant the restored stack held.
 */
async function runIteration(
  ctx: ScenarioContext,
  iteration: number,
  iterations: number,
  saveDir: string,
): Promise<Map<UndoVariant, number>> {
  const tag = `#${iteration}`;
  const history: string[] = [];
  const note = (line: string): void => {
    history.push(line);
  };

  /**
   * The resolved move list for THIS cycle. Reset per iteration on purpose: the
   * iterations are independent (each re-opens the fixture from a known floor), so
   * a trace of the failing cycle is already minimal in that dimension and a
   * replay reproduces it without replaying the ones before it.
   *
   * Observe-only - `record` runs after the decision, draws nothing and reads no
   * app state.
   */
  const recorder = new TraceRecorder();
  const replayPath = replayTracePath();
  const traceOut = traceOutPath();
  const replay: FuzzTrace | null = replayPath ? readTrace(replayPath) : null;
  if (replay && replay.scenario !== 'undo-persistence-fuzz') {
    throw new Error(
      `trace ${replayPath} was recorded by ${replay.scenario}; run it with that scenario`,
    );
  }
  // The recorded steps carry RESOLVED section and shot ids, so replaying them
  // against a different project drives moves at ids that do not exist there:
  // an invented failure, or a green run, either way not the recorded bug.
  if (replay && replay.fixture !== FIXTURE) {
    throw new Error(
      `trace ${replayPath} was recorded on ${replay.fixture} but this run is on ${FIXTURE}; ` +
        `its steps carry ids resolved against that project. Re-run with ` +
        `STALAGMIGHT_FUZZ_FIXTURE=${replay.fixture} (pnpm agent:scenario --trace restores it for you).`,
    );
  }

  const dumpTrace = (failure: { message: string } | null, explicitPath: string): string | null => {
    const target =
      explicitPath ||
      (ctx.artifactsDir ? defaultTracePath(ctx.artifactsDir, 'undo-persistence-fuzz', ctx.seed) : '');
    if (!target) return null;
    try {
      return writeTrace(
        target,
        recorder.build({
          scenario: 'undo-persistence-fuzz',
          seed: ctx.seed,
          iterations,
          fixture: FIXTURE,
          stream: 'plan',
          failure,
        }),
      );
    } catch {
      return null;
    }
  };

  const { stripped } = await loadFixtureWithoutUndoHistory(ctx, FIXTURE);
  if (!(await disableAutoSave(ctx))) {
    throw new Error(
      'could not disable auto-save; a save mutates live state with no undo entry and would ' +
        'desync the model (see disableAutoSave in scenarios/common.ts)',
    );
  }

  const persistLimit = await ctx.eval<number>(`
    const config = window.__E2E_TEST__.projectStore.getState().config;
    return config && config.general && typeof config.general.undo_persist_limit === 'number'
      ? config.general.undo_persist_limit
      : 20;
  `);

  await injectOracle(ctx);
  const init = await initModel(ctx);
  const strippedRows = Object.values(stripped.cleared).reduce((sum, n) => sum + n, 0);
  ctx.setMetric('strippedUndoRows', strippedRows);

  let cursor = 0;
  let top = 0;
  let undoLen = init.undoLen;
  let redoLen = init.redoLen;
  let digest: TargetingDigest = init.digest;
  let savesDone = 0;
  let reloadsDone = 0;
  /**
   * Set once a stale-id defect (bug 8 or finding 12) has been tolerated in this
   * walk. From then on the live project no longer matches any snapshot recorded
   * before the save, so the same tolerance is extended to the rest of the walk -
   * see `classifierFor`.
   */
  let staleIdContaminated = false;
  /**
   * `entryType[d]` is the commandType of the entry whose execution took the
   * project from depth d-1 to depth d. Read once off both restored stacks, so a
   * failure can name the entry the move consumed - which is what separates bug 1
   * from finding 11, and what narrows the bug-8 tolerance to its own mechanism.
   */
  const entryType: (string | null)[] = [null];

  /**
   * Index the two stacks by DEPTH. Index 0 of each is the entry the next undo /
   * redo would consume, so the undo stack counts down from the current depth and
   * the redo stack counts up from it.
   */
  const fillEntryTypes = (undo: readonly HistoryItem[], redo: readonly HistoryItem[]): void => {
    for (let i = 0; i < undo.length; i++) entryType[cursor - i] = undo[i]?.commandType ?? null;
    for (let i = 0; i < redo.length; i++) entryType[cursor + 1 + i] = redo[i]?.commandType ?? null;
  };

  // Explicitly typed so TypeScript's control-flow analysis treats a call as
  // never-returning and narrows what follows it (an inferred `never` return on a
  // const arrow does not).
  const fail: (headline: string, detail?: string) => never = (headline, detail = '') => {
    const tail = (DUMP_FULL_HISTORY ? history : history.slice(-HISTORY_TAIL)).map((line) => `    ${line}`);
    const message = [
      headline,
      `  reproduce: pnpm agent:scenario undo-persistence-fuzz --seed ${ctx.seed} ` +
        `--iterations ${iterations} --release` +
        `${FIXTURE === DEFAULT_FIXTURE ? '' : ` (STALAGMIGHT_FUZZ_FIXTURE=${FIXTURE})`}` +
        `${ALLOW_KNOWN_BUGS ? ' (STALAGMIGHT_FUZZ_ALLOW_KNOWN_BUGS=1)' : ''}` +
        `${replayPath ? ` (REPLAY of ${replayPath})` : ''}`,
      `  iteration=${iteration} fixture=${FIXTURE} depth=${cursor} top=${top} ` +
        `saves=${savesDone} reloads=${reloadsDone}`,
      ...(detail ? [detail] : []),
      `  last ${tail.length} action(s) this iteration:`,
      ...tail,
    ].join('\n');
    const written = dumpTrace({ message }, traceOut);
    throw new Error(written ? `${message}\n  trace: ${written}` : message);
  };

  if (init.undoLen !== 0 || init.redoLen !== 0) {
    fail(
      `${FIXTURE} opened with inherited history after stripping ${strippedRows} row(s)`,
      `  undoLen=${init.undoLen} redoLen=${init.redoLen} ` +
        `(cleared ${JSON.stringify(stripped.cleared)}, absent ${JSON.stringify(stripped.missing)})`,
    );
  }
  if (init.invariants.length > 0) {
    fail(
      `${FIXTURE} violates project invariants BEFORE any mutation`,
      init.invariants.map((violation) => `  INVARIANT: ${violation}`).join('\n'),
    );
  }

  const step = async (
    kind: 'mutate' | 'undo' | 'redo' | 'save' | 'reload',
    action: string,
    args: unknown[],
  ): Promise<StepResponse> => {
    const started = Date.now();
    const res = await runStep(ctx, { kind, action, args, cursor, undo0: undoLen, steps: 1 });
    ctx.metric('fusedStepMs', Date.now() - started);
    ctx.metric('actionMs', res.timing.actionMs);
    ctx.metric('observeMs', res.timing.observeMs);
    ctx.metric('canonicalMs', res.timing.canonicalMs);
    ctx.metric('integrityMs', res.timing.integrityMs);
    ctx.metric('steps');
    return res;
  };

  const record = (res: StepResponse): void => {
    undoLen = res.undoLen;
    redoLen = res.redoLen;
    digest = res.digest;
  };

  const assertModel = (res: StepResponse, headline: string): void => {
    if (res.cursorAfter !== cursor || res.top !== top) {
      fail(
        headline,
        `  page model says cursor=${res.cursorAfter} top=${res.top}, Node says cursor=${cursor} top=${top}`,
      );
    }
  };

  const assertInvariants = (res: StepResponse, what: string): void => {
    if (res.invariants.length === 0) return;
    fail(
      `project invariant(s) violated after ${what}`,
      res.invariants.map((violation) => `  INVARIANT: ${violation}`).join('\n'),
    );
  };

  const assertStacks = (headline: string, res: StepResponse): void => {
    const wantRedo = top - cursor;
    if (res.undoLen !== cursor || res.redoLen !== wantRedo) {
      fail(
        headline,
        `  expected undoLen=${cursor} redoLen=${wantRedo}, got undoLen=${res.undoLen} redoLen=${res.redoLen}`,
      );
    }
  };

  const sameIntegrity = (a: IntegrityVerdict, b: IntegrityVerdict): boolean =>
    a.saveBlocked === b.saveBlocked && a.messages.join('\u0000') === b.messages.join('\u0000');

  const assertIntegrityDelta = (res: StepResponse, what: string, resynced = false): void => {
    const expected = res.integrityExpected;
    if (expected === null) return;
    // `resolveMismatch` just replaced the model's snapshot at this depth, and
    // `resyncModel` moves the recorded integrity verdict with it. `expected`
    // was computed IN THE PAGE at step time, i.e. against the snapshot that has
    // since been superseded, so comparing it now would fail on precisely the
    // difference the resync accepted.
    if (resynced) {
      ctx.metric('integrityResynced');
      return;
    }
    ctx.metric('integrityCompared');
    if (sameIntegrity(expected, res.integrity)) return;
    // See `staleIdContaminated`: past the first stale-id defect the project no
    // longer matches any pre-save snapshot, so its integrity verdict does not
    // either. Counted rather than asserted, and only in tolerant mode.
    if (ALLOW_KNOWN_BUGS && staleIdContaminated) {
      ctx.metric('contaminatedIntegrityDelta');
      return;
    }
    const format = (verdict: IntegrityVerdict): string =>
      `saveBlocked=${verdict.saveBlocked} messages=${JSON.stringify(verdict.messages)}`;
    fail(
      `${what} restored the state but NOT the integrity verdict recorded at depth ${cursor}`,
      `  expected: ${format(expected)}\n  actual:   ${format(res.integrity)}`,
    );
  };

  /**
   * Resolve a mismatch the page reported. `consumed` is the commandType of the
   * entry the move applied (null for a save, a reload or a mutation), and it is
   * what picks the classifier order and gates the bug-8 tolerance.
   *
   * Returns true when the model was RESYNCED, which the caller has to know:
   * every expectation the page computed for this step - the integrity verdict
   * included - was computed against the snapshot the resync replaced.
   */
  const resolveMismatch = async (
    headline: string,
    res: StepResponse,
    consumed: string | null,
  ): Promise<boolean> => {
    const pair = await fetchMismatch(ctx);
    // Only an epoch-crossing comparison may subtract the documented undo-less
    // changes. Within an epoch the oracle stays strict.
    const attributable = res.crossesEpoch
      ? [
          ...(savesDone > 0 ? SAVE_HEALING_MUTATIONS : []),
          ...(reloadsDone > 0 ? RELOAD_RESOLVED_GEOMETRY : []),
        ]
      : [];
    const bug8Allowed =
      ALLOW_KNOWN_BUGS && reloadsDone > 0 && (consumed === 'create_shot' || staleIdContaminated);
    const check = checkSnapshot(
      pair.expected ?? '',
      pair.actual ?? '',
      attributable,
      classifierFor(consumed, reloadsDone > 0, staleIdContaminated),
      bug8Allowed,
    );
    if (check.equal) {
      if (check.floatNoise) ctx.metric('floatNoise');
      return false;
    }
    if (check.attributed.length > 0 && check.text.startsWith('  ATTRIBUTED')) {
      ctx.metric('resyncs');
      for (const entry of check.attributed) ctx.metric(`resync:${entry.id}`);
      top = await resyncModel(ctx, pair.index, res.integrity);
      return true;
    }
    if (ALLOW_KNOWN_BUGS && check.onlyKnown) {
      ctx.metric('knownAsymmetry');
      for (const asymmetry of check.asymmetries) ctx.metric(`known:${asymmetry.id}`);
      const staleId = check.asymmetries.some(
        (asymmetry) => asymmetry.id.startsWith('stale-id-') || asymmetry.id === BUG_8_WRONG_SHOT.id,
      );
      if (staleId && !staleIdContaminated) {
        staleIdContaminated = true;
        ctx.setMetric('firstContaminationDepth', cursor);
      } else if (staleId) {
        ctx.metric('staleIdContaminationInherited');
      }
      ctx.log(
        `${tag} tolerated known asymmetry at depth ${cursor} (entry ${consumed ?? 'n/a'}): ` +
          check.asymmetries.map((a) => a.id).join(', '),
      );
      top = await resyncModel(ctx, pair.index, res.integrity);
      return true;
    }
    // CONTAMINATED. A stale-id defect has already fired in this walk, so the live
    // project is not the project any pre-save snapshot describes and the
    // roundtrip comparison can no longer make a meaningful statement about the
    // depths beneath it. Two ways to handle that: stop the walk, or carry on with
    // the roundtrip oracle downgraded. Carrying on is strictly MORE coverage than
    // stopping - the oracles that do not depend on history stay HARD, namely the
    // absolute invariant suite, an undo/redo that fails outright (bar the one
    // documented wedge signature), a stack-shape change and every crash/log
    // oracle the sweep runs afterwards - so the walk still exercises every
    // restore path in the stack against a project the app itself corrupted.
    if (ALLOW_KNOWN_BUGS && staleIdContaminated) {
      ctx.metric('contaminatedMismatch');
      top = await resyncModel(ctx, pair.index, res.integrity);
      return true;
    }
    fail(headline, check.text);
  };

  /**
   * Apply ONE mutation and run the whole case analysis on what the stacks did.
   * Lifted out of the plan loop unchanged so a REPLAY can drive it with a
   * recorded action instead of a planned one; the plan path still hands it
   * exactly what `CoverageStep.build` returned.
   */
  const applyMutation = async (built: CoverageAction, stepName: string): Promise<number> => {
    recorder.record({
      kind: 'mutate',
      action: built.action,
      args: built.args,
      label: built.label,
    });
    const beforeUndo = undoLen;
    const beforeRedo = redoLen;
    const res = await step('mutate', built.action, built.args);
    const accepted = res.actionOk && res.commandSuccess !== false;
    const pushed = res.undoLen - beforeUndo;
    note(
      `${tag} ${stepName}: ${built.label} -> ${accepted ? 'ok' : 'rejected'} ` +
        `(undo ${beforeUndo}->${res.undoLen}, redo ${beforeRedo}->${res.redoLen})` +
        `${accepted ? '' : ` [${res.commandError ?? res.actionError ?? 'unknown'}]`}`,
    );
    assertInvariants(res, built.label);

    if (!accepted) {
      ctx.metric(`rejected:${stepName}`);
      if (pushed !== 0 || res.redoLen !== beforeRedo) {
        fail(
          'a REJECTED command changed the history stacks',
          `  error: ${res.commandError ?? res.actionError ?? 'unknown'}\n` +
            `  undo ${beforeUndo}->${res.undoLen}, redo ${beforeRedo}->${res.redoLen}`,
        );
      }
      assertModel(res, 'a rejected command moved the page model');
      if (res.verdict !== 'equal') {
        await resolveMismatch(
          `a REJECTED command (${built.action}) mutated the project: ` +
            `${res.commandError ?? res.actionError ?? 'unknown'}`,
          res,
          null,
        );
      }
      record(res);
      return pushed;
    }

    if (pushed === 0) {
      // Succeeded without pushing an entry. Permitted (a no-op command), but it
      // means the plan did not deliver this variant; the coverage assertion is
      // what reports that.
      ctx.metric(`noop:${stepName}`);
      if (res.redoLen === 0) top = cursor;
      assertModel(res, 'a no-op command moved the page model');
      if (res.verdict !== 'equal') {
        await resolveMismatch(`a no-op command (${built.action}) changed the project state`, res, null);
      }
      record(res);
      return pushed;
    }
    if (pushed !== 1) {
      fail(`${stepName} pushed ${pushed} undo entries (expected 0 or 1)`, `  after ${built.label}`);
    }
    if (res.redoLen !== 0) {
      fail('a successful command did not clear the redo stack', `  after ${built.label}`);
    }
    cursor += 1;
    top = cursor;
    entryType[cursor] = null; // filled from the restored stacks after the reload
    assertModel(res, 'the page recorded the new snapshot at a different depth than Node expected');
    if (res.verdict !== 'recorded') {
      fail(`the page did not record a snapshot for a pushed entry (verdict=${res.verdict})`);
    }
    record(res);
    ctx.metric(`step:${stepName}`);
    return pushed;
  };

  // -----------------------------------------------------------------------
  // 1. Build the covering stack.
  // -----------------------------------------------------------------------
  const memo = newCoverageMemo();
  // Empty when replaying: the trace supplies every move, and running the plan as
  // well would make the replay something other than the cycle it came from.
  for (const plan of replay ? [] : COVERAGE_STEPS) {
    const sectionIdsBefore = plan.remembers ? digest.s.map((entry) => entry[0]) : [];
    const built = plan.build(ctx, digest, memo);
    if (built === null) {
      note(`${tag} ${plan.name} -> NOT BUILDABLE`);
      ctx.metric(`unbuildable:${plan.name}`);
      if (plan.guaranteed) {
        fail(
          `coverage step ${plan.name} could not be built, so the plan cannot promise ` +
            `${plan.variant}`,
          `  purpose: ${plan.purpose}`,
        );
      }
      continue;
    }
    const pushed = await applyMutation(built, plan.name);

    // Only after a step that actually pushed an entry - which is what the
    // `continue`s in the extracted body used to guarantee positionally.
    if (plan.remembers && pushed === 1) {
      const fresh = digest.s.map((entry) => entry[0]).filter((id) => !sectionIdsBefore.includes(id));
      const created = fresh[0];
      if (fresh.length !== 1 || created === undefined) {
        fail(
          `${plan.name} added ${fresh.length} section(s); the plan needs exactly one to hold on to`,
          `  before=${JSON.stringify(sectionIdsBefore.slice(-8))} ` +
            `after=${JSON.stringify(digest.s.map((entry) => entry[0]).slice(-8))}`,
        );
      }
      if (plan.remembers === 'target') memo.createdSectionId = created;
      else memo.spareSectionId = created;
    }
  }

  if (!replay && top === 0) fail('the coverage plan pushed no undo entries at all');
  if (!replay && top > persistLimit) {
    fail(
      `the coverage plan built ${top} entries but only the newest ${persistLimit} are persisted ` +
        `(undo_persist_limit), so the restored stack could not be modelled`,
    );
  }

  // -----------------------------------------------------------------------
  // 2. Prove the collision precondition: ids must no longer equal positions.
  // -----------------------------------------------------------------------
  // Everything in this block asserts that the PLAN did its job. A replayed trace
  // is by construction not the plan - a shrink is allowed to remove the very
  // steps that produced the divergence - so these are skipped there. No app
  // oracle is skipped: the roundtrip, invariant, integrity and stack-survival
  // checks all run on both paths.
  const targetSection = memo.createdSectionId;
  if (!replay && targetSection === null) fail('the plan never identified its target section');
  const targetShots =
    targetSection === null ? [] : digest.s.find((entry) => entry[0] === targetSection)?.[1] ?? [];
  if (!replay && targetSection !== null && !idsDivergeFromPosition(targetSection, targetShots)) {
    fail(
      'the plan did not make shot ids diverge from positional order, so a stale persisted id ' +
        'would address the same shot after the reload and the whole precondition is absent',
      `  section ${targetSection} ids=${JSON.stringify(targetShots)} (the loader will renumber ` +
        `them to ${JSON.stringify(targetShots.map((_, i) => targetSection * FEATURE_ID_STRIDE + i))})`,
    );
  }
  if (!replay) ctx.metric('divergedSections');

  // -----------------------------------------------------------------------
  // 3. Undo a few, so the REDO stack is non-empty when the save runs.
  // -----------------------------------------------------------------------
  // Read the live stack first, so the pre-save undos can also name the entry they
  // consumed; the authoritative read is the one after the reload.
  fillEntryTypes(await readStack(ctx, 'getUndoStack'), []);
  const wanted = replay ? 0 : ctx.randInt(1, Math.max(1, Math.min(MAX_PRE_SAVE_UNDOS, top - 1)));

  /**
   * One history move, verified against the snapshot recorded at the depth it
   * lands on. Returns false when the move FAILED OUTRIGHT and was tolerated as
   * the known stale-id wedge (finding 12); it throws on anything else.
   */
  const walk = async (direction: 'undo' | 'redo', label: string): Promise<boolean> => {
    const back = direction === 'undo';
    const consumed = entryType[back ? cursor : cursor + 1] ?? null;
    const beforeUndo = undoLen;
    const beforeRedo = redoLen;
    const res = await step(direction, direction, []);
    if (!res.actionOk || res.commandSuccess === false) {
      const error = res.commandError ?? res.actionError ?? 'unknown';
      note(`${tag} ${label} ${direction}[${consumed ?? '?'}] -> FAILED [${error}]`);
      // FINDING 12, the same root cause as bug 8 with the opposite outcome. When
      // a section has had a shot deleted, the ids the allocator handed out run
      // PAST the renumbered range, so a persisted id does not collide - it
      // misses. `delete_shot` / `update_shot` / `set_shot_kind` then return
      // "Shot N not found in section S", the undo fails, `undo_inner`'s epilogue
      // pushes the entry back (core/state/undo.rs), and the history is WEDGED:
      // every entry beneath it is unreachable for the rest of the project's life.
      //
      // It is walked past for the same reason bug 8 is - this scenario is here
      // to find what lies underneath - but only in tolerant mode, only after a
      // reload, and only for that exact error shape. The unwind cannot continue
      // (the entry will fail identically forever), so the caller stops descending
      // and rewinds from here, which still exercises the restored redo entries.
      const staleIdMiss = /^Shot \d+ not found in section \d+$/.test(error);
      if (ALLOW_KNOWN_BUGS && reloadsDone > 0 && staleIdMiss) {
        ctx.metric('knownAsymmetry');
        ctx.metric('known:stale-id-miss-wedges-history');
        ctx.log(
          `${tag} tolerated a WEDGED history at depth ${cursor} (entry ${consumed ?? 'unknown'}): ${error}`,
        );
        assertStacks('a failed undo changed the history stacks', res);
        record(res);
        return false;
      }
      fail(
        `${direction} at depth ${cursor} failed outright (entry ${consumed ?? 'unknown'})`,
        `  error: ${error}`,
      );
    }
    cursor += back ? -1 : 1;
    note(
      `${tag} ${label} ${direction}[${consumed ?? '?'}] -> depth ${cursor} ` +
        `(undo ${beforeUndo}->${res.undoLen}, redo ${beforeRedo}->${res.redoLen})`,
    );
    assertInvariants(res, direction);
    assertModel(res, `${direction} left the page model where Node did not expect it`);
    assertStacks(`${direction} left the history stacks in an unexpected shape`, res);
    const resynced =
      res.verdict !== 'equal' &&
      (await resolveMismatch(
        `${direction} did not restore the state recorded at depth ${cursor} ` +
          `(the entry it consumed was ${consumed ?? 'unknown'})`,
        res,
        consumed,
      ));
    assertIntegrityDelta(res, direction, resynced);
    record(res);
    ctx.metric(direction === 'undo' ? 'undos' : 'redos');
    return true;
  };

  for (let i = 0; i < wanted; i++) {
    recorder.record({ kind: 'undo' });
    await walk('undo', 'pre-save');
  }
  if (!replay && redoLen === 0) {
    fail('the pre-save undos left the redo stack empty, so the reload could not restore one');
  }
  ctx.setMetric('preSaveRedoDepth', top - cursor);

  /**
   * Save to a temp path, close, reopen: the persistence boundary, as one
   * indivisible move. Splitting it would let a shrink produce a candidate that
   * saved without reopening, which is not a state the app can be in.
   */
  const crossBoundary = async (): Promise<void> => {
    const savePath = path.join(saveDir, `cycle-${iteration}.stalx`);
    await bumpEpoch(ctx);
    const saveRes = await step('save', 'saveProject', [savePath]);
    if (!saveRes.actionOk || saveRes.commandSuccess === false) {
      fail('saveProject failed', `  error: ${saveRes.commandError ?? saveRes.actionError ?? 'unknown'}`);
    }
    note(`${tag} save -> ok (depth ${cursor}, undo ${saveRes.undoLen}, redo ${saveRes.redoLen})`);
    assertInvariants(saveRes, 'save');
    assertStacks('save changed the history stacks', saveRes);
    savesDone += 1;
    if (saveRes.verdict !== 'equal') {
      await resolveMismatch(
        'save mutated the project in a way SAVE_HEALING_MUTATIONS does not account for',
        saveRes,
        null,
      );
    }
    record(saveRes);
    ctx.metric('saves');

    const closed = (await ctx.callAction('project', 'closeProject', [])) as {
      ok: boolean;
      error?: string;
      result?: { success?: boolean; error?: string };
    };
    if (!closed.ok || closed.result?.success === false) {
      fail('closeProject failed before reopen', `  error: ${closed.result?.error ?? closed.error ?? 'unknown'}`);
    }
    const opened = (await ctx.callAction('project', 'loadProject', [savePath])) as {
      ok: boolean;
      error?: string;
      result?: { success?: boolean; error?: string };
    };
    if (!opened.ok || opened.result?.success === false) {
      fail('reopening the saved project failed', `  error: ${opened.result?.error ?? opened.error ?? 'unknown'}`);
    }

    await enableIdAgnosticModel(ctx);
    await bumpEpoch(ctx);
    reloadsDone += 1;
    const reloaded = await observeOnly(ctx, cursor);
    note(`${tag} reload -> depth ${cursor} (undo ${reloaded.undoLen}, redo ${reloaded.redoLen})`);
    assertInvariants(reloaded, 'reload');
    assertStacks('the persisted history did not come back intact', reloaded);
    const resynced =
      reloaded.verdict !== 'equal' &&
      (await resolveMismatch(
        'reopening the saved project did not restore the state it was saved at',
        reloaded,
        null,
      ));
    assertIntegrityDelta(reloaded, 'reload', resynced);
    record(reloaded);
    ctx.metric('reloads');
  };

  // -----------------------------------------------------------------------
  // 4. Save, close, reopen.
  // -----------------------------------------------------------------------
  /**
   * Apply one recorded move. Same rule as `undo-redo-fuzz`: a history move whose
   * precondition no longer holds is SKIPPED and a save with nothing to persist is
   * skipped too, which is what makes an arbitrary subsequence of a trace runnable
   * - the property the shrinker needs. Skipping asserts nothing, so it cannot
   * turn a failing candidate green by hiding something.
   */
  const applyTraceStep = async (traceStep: TraceStep, label: string): Promise<void> => {
    if (traceStep.kind === 'mutate') {
      // A trace supplies both the action NAME and its arguments, so the replay
      // path is narrower than the dispatch path: only the mutations a generator
      // can produce, never a scenario-driven control action like `saveProject`
      // (which takes a path this file would then be choosing).
      if (!REPLAYABLE_MUTATIONS.has(traceStep.action)) {
        throw new Error(
          `trace step names ${traceStep.action}, which is not a replayable mutation. ` +
            `A recorded trace may only replay the actions the generators produce.`,
        );
      }
      await applyMutation(
        { action: traceStep.action, args: traceStep.args, label: traceStep.label },
        `replay:${traceStep.action}`,
      );
      return;
    }
    if (traceStep.kind === 'save') {
      if (top === 0 || top > persistLimit || savesDone > 0) {
        ctx.metric('replaySkipped:save');
        return;
      }
      recorder.record({ kind: 'save' });
      await crossBoundary();
      return;
    }
    if (traceStep.kind === 'repair') {
      ctx.metric('replaySkipped:repair');
      return;
    }
    const back = traceStep.kind === 'undo' || traceStep.kind === 'undoTo';
    const reach = back ? cursor : top - cursor;
    if (reach < 1) {
      ctx.metric(`replaySkipped:${traceStep.kind}`);
      return;
    }
    recorder.record(back ? { kind: 'undo' } : { kind: 'redo' });
    await walk(back ? 'undo' : 'redo', label);
  };

  if (replay) {
    ctx.setMetric('replaySteps', replay.steps.length);
    for (let index = 0; index < replay.steps.length; index++) {
      await applyTraceStep(replay.steps[index] as TraceStep, `T${index + 1}`);
    }
  } else {
    recorder.record({ kind: 'save' });
    await crossBoundary();
  }

  // The renumbering is what makes a stale id collide rather than miss. Prove it
  // happened, so a build that stopped renumbering would fail here loudly instead
  // of quietly turning this scenario into a no-op.
  const renumbered =
    targetSection === null ? [] : digest.s.find((entry) => entry[0] === targetSection)?.[1] ?? [];
  if (!replay && targetSection !== null && idsDivergeFromPosition(targetSection, renumbered)) {
    fail(
      'the reload did NOT renumber shot ids to section_id * FEATURE_ID_STRIDE + position, so the ' +
        'stale-id collision this scenario tests for cannot arise',
      `  section ${targetSection} ids after reload = ${JSON.stringify(renumbered)}`,
    );
  }
  if (!replay) ctx.metric('renumberedSections');

  // -----------------------------------------------------------------------
  // 5. Read the restored stacks: which entry sits at which depth.
  // -----------------------------------------------------------------------
  const restoredUndo = await readStack(ctx, 'getUndoStack');
  const restoredRedo = await readStack(ctx, 'getRedoStack');
  if (restoredUndo.length !== cursor || restoredRedo.length !== top - cursor) {
    fail(
      'the restored history items do not match the restored stack lengths',
      `  get_undo_stack=${restoredUndo.length} get_redo_stack=${restoredRedo.length}, ` +
        `expected ${cursor} and ${top - cursor}`,
    );
  }
  fillEntryTypes(restoredUndo, restoredRedo);

  const covered = new Map<UndoVariant, number>();
  const unmapped: string[] = [];
  for (let depth = 1; depth <= top; depth++) {
    const commandType = entryType[depth];
    if (!commandType) fail(`no restored history item for depth ${depth}`);
    const variant = VARIANT_BY_COMMAND_TYPE[commandType];
    if (!variant) {
      unmapped.push(commandType);
      continue;
    }
    covered.set(variant, (covered.get(variant) ?? 0) + 1);
  }
  if (unmapped.length > 0) {
    fail(
      `restored undo entries carry commandType(s) VARIANT_BY_COMMAND_TYPE does not know: ` +
        `${JSON.stringify([...new Set(unmapped)])}`,
      '  the map is transcribed from src-tauri/src/core/state/undo_capture.rs; re-check it',
    );
  }
  // The COVERAGE oracle asserts the PLAN's promise, so it does not apply to a
  // replayed subsequence - a shrink's whole job is to remove steps it can.
  const missingGuaranteed = replay
    ? []
    : GUARANTEED_VARIANTS.filter((variant) => !covered.has(variant));
  if (missingGuaranteed.length > 0) {
    fail(
      `the restored stack is missing UndoData variant(s) the plan guarantees: ` +
        `${JSON.stringify(missingGuaranteed)}`,
      `  present: ${JSON.stringify([...covered.keys()])}\n` +
        '  a guaranteed step either failed or no-opped; see the action history above',
    );
  }
  for (const variant of PLANNED_VARIANTS) {
    if (covered.has(variant)) continue;
    ctx.metric(`variantMissing:${variant}`);
    ctx.log(`${tag} variant ${variant} was not reachable on ${FIXTURE} this iteration`);
  }
  note(
    `${tag} restored stacks: undo=${restoredUndo.length} redo=${restoredRedo.length}, ` +
      `entries=${JSON.stringify(entryType.slice(1))}`,
  );

  // -----------------------------------------------------------------------
  // 6. Walk the whole RESTORED history: all the way down, all the way back up.
  // -----------------------------------------------------------------------
  const summit = top;
  while (cursor > 0) {
    if (!(await walk('undo', 'unwind'))) {
      // The history wedged (finding 12). Nothing below is reachable any more, so
      // record how far the unwind got and go straight to the rewind, which still
      // walks every restored REDO entry.
      ctx.metric('unwindWedged');
      ctx.setMetric('deepestWedge', cursor);
      break;
    }
  }
  const floor = cursor;
  while (cursor < summit) {
    if (!(await walk('redo', 'rewind'))) {
      ctx.metric('rewindWedged');
      break;
    }
  }
  if (cursor !== summit && ctx.metrics.rewindWedged === undefined) {
    fail(`the roundtrip ended at depth ${cursor}, expected ${summit}`);
  }
  ctx.metric('entriesUnwound', top - floor);
  ctx.metric('cycles');
  ctx.setMetric('traceSteps', recorder.length);
  // A cycle that PASSED only writes a trace when asked for by name. The path is
  // shared across iterations on purpose: the last cycle wins, and a run whose
  // cycles are independent has nothing useful in the earlier ones.
  if (traceOut) dumpTrace(null, traceOut);

  return covered;
}
