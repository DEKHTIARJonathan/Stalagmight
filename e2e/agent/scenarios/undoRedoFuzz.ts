/**
 * undo-redo-fuzz: a seeded random-action undo/redo fuzzer.
 *
 * Loads a real `.stalx` fixture, then walks a randomized stream of REAL
 * mutating commands (through the projectStore actions, so the frontend store
 * stays in step with the backend) interleaved with random undo/redo moves, and
 * asserts after every single move that the project state is EXACTLY the state
 * previously recorded at that undo-stack depth.
 *
 * ## The starting point
 *
 * `STALAGMIGHT_FUZZ_FIXTURE` picks any `.stalx` in `e2e/fixtures/` (basename
 * only), defaulting to `DEFAULT_FIXTURE`. Whatever project is open is closed
 * first: the model measures depth from a known floor, so the scenario always
 * opens its own copy.
 *
 * That copy has its persisted undo history DELETED before the load
 * (`loadFixtureWithoutUndoHistory` -> `stripUndoHistory`), because tracked
 * fixtures ship with one - 20 rows in the fractal fixture, 2 in naharon - and
 * fuzzing on top of somebody else's entries both burns headroom below the
 * 100-entry limit and puts un-modelled state under `snapshots[0]`. The scenario
 * then asserts both stacks are empty as a HARD expectation.
 *
 * ## The model
 *
 * `snapshots[d]` is the expected canonical `get_project_state` at undo depth
 * `d` (`snapshots[0]` = the state right after the fixture opened). `cursor` is
 * the current depth; the ground truth for it is the backend's own
 * `get_undo_stack` / `get_redo_stack` lengths, re-read after every move, so the
 * model can never quietly drift away from the app.
 *
 * The snapshot array lives IN THE WEBVIEW and each step is a single fused
 * `executeAsync` - call the action, observe, canonicalize, compare - so a
 * ~60 KB (fractal) / ~277 KB (naharon) payload no longer crosses the bridge
 * twice per iteration. See `undoRedoFuzzBridge.ts` for the contract and
 * `fuzzOracleCore.ts` for the serializer, which is one self-contained function
 * injected into the page and called directly by Node, never two copies. Node
 * keeps `cursor`/`top` mirrors, re-derives them from the same rules, and asserts
 * the page agrees. Full canonical strings are fetched only when a comparison
 * has ALREADY failed.
 *
 *   - MUTATE: draw an action, run it, then reconcile with what the stacks did.
 *     A rejected command must change neither the stacks nor the state (that
 *     assertion is what catches a command that mutates and then fails). A
 *     command that succeeds without pushing an entry (`ReverseSection` on a
 *     shot-less section, `UnmergeStations` on an unmerged station) must leave
 *     the state alone; it may still clear the redo stack, which truncates the
 *     model's forward branch.
 *   - UNDO / REDO: the state must equal `snapshots[cursor +/- 1]` exactly, and
 *     both stack lengths must match the model.
 *
 * At the end it unwinds all the way to depth 0 and replays back to the top,
 * verifying every intermediate snapshot in both directions - the "full
 * roundtrip at every depth" guarantee.
 *
 * ## What "exactly" means
 *
 * `e2e/agent/lib/fuzzOracleCore.ts` owns the canonical serializer and documents
 * every field it drops (all of them monotonic counters or `touch()`/`file_path`
 * artefacts). Map key order is canonicalized rather than dropped, and floats are
 * rounded to 12 significant digits. Shot uuids, `reverse_parity`, the gauge
 * anchors, `merged_at`, all closure metrics and all geometry ARE compared. When
 * two canonical strings still disagree, `projectSnapshot.ts` re-compares them
 * with a 1e-9 absolute tolerance and classifies the result.
 *
 * ## Open app bugs this reproduces
 *
 * None of these are normalized away. The oracle fails on all of them; 1, 2 and 4
 * are classified (`KNOWN_UNDO_ASYMMETRIES` plus `LOOP_CLOSURE_REORDER`) so the
 * message names them rather than reading as a mystery.
 *
 * 4, 5 and 6 need `STALAGMIGHT_FUZZ_FIXTURE=naharon.stalx`: they need loop
 * closures, zero datums and null section metadata present AT LOAD, and the
 * fractal fixture has none of those (all 32 of its sections have a non-null
 * surveyor; naharon has 13 null ones). Fixture diversity is what found them.
 *
 * 1. `run_scenario("undo-redo-fuzz", seed=1, iterations=3)` - create a section,
 *    undo, redo: every shot uuid is re-minted. SECOND MANIFESTATION, only
 *    observable now that runs save (`naharon`, seed 23 x60): the same
 *    `restore_section` path also resets `reverse_parity` and BOTH gauge anchors
 *    (`Section::new`, models/section.rs:301-303), so a redo silently discards the
 *    least-squares gauge pair a save had captured.
 *    `UndoData::CreatedSectionSnapshot` stores a `SectionData`, which has no
 *    uuid field, so redo goes `restore_section` -> `Section::new_with_id` ->
 *    `Shot::new` -> `Uuid::new_v4()`. The sibling `CreateShot` path was
 *    explicitly fixed for this exact reason (a fresh uuid dangles every
 *    `StationKey::AfterShot` anchor and the Ariane export identity).
 * 2. `... seed=11, iterations=150` - undoing a shot INSERT leaves
 *    behind an all-zero `section_offsets` entry the section did not have.
 *    `adjust_section_offset` creates the key while compensating; the undo puts
 *    the value back to 0 but nothing removes the key. Geometrically inert, and
 *    it is serialized into the .stalx.
 * 3. `... seed=2, iterations=36` (fails at #36, depth 11) - appending the FIRST shot into an EMPTY
 *    section and undoing displaces the whole section by that shot's horizontal
 *    vector (1.13 m in the repro), and the displacement RATCHETS on every
 *    further undo/redo cycle. `Project::add_shot` (the append path) is
 *    offset-neutral, but the undo routes through `remove_shot_with_rewire`,
 *    whose `pos == 0` branch unconditionally calls `adjust_section_offset`.
 *    Deliberately NOT classified as tolerable: it is a geometry bug, and the
 *    same branch drops merges / zero datums / station comments keyed to that
 *    section's station 0.
 * 4. `... seed=4, iterations=19` on naharon - undoing a loop-closure removal
 *    puts the closure back at the END of `project.loop_closures` instead of its
 *    original index (`core/state/undo.rs:244` pushes; the removal used
 *    `Vec::remove(pos)`). Order-only, but the order is persisted, indexed by the
 *    frontend, and feeds `resolve_offsets`' adjacency lists.
 * 5. `... seed=5, iterations=7` on naharon - undoing `updateSection` CANNOT
 *    restore a `name` / `surveyor` / `date` that was previously null; the new
 *    value silently survives the undo. The capture is right
 *    (`undo_capture.rs:144-146` builds `Some(None)`), but `SectionUpdates`
 *    (`models/section.rs:122-142`) has only `#[serde(default)]` on those three
 *    fields, so `Some(None)` and `None` BOTH serialize to `null` in
 *    `values_json` and both read back as `None` = "leave it alone". `ShotUpdates`
 *    has `deserialize_with = "double_option"` + `skip_serializing_if` on exactly
 *    these grounds; `SectionUpdates` was left out. Not classified: silent,
 *    persistable data loss.
 * 6. `... seed=21, iterations=60` on naharon - undo FAILS OUTRIGHT: "This shot is
 *    part of a loop ... Both sides are anchored to a zero datum. Use split
 *    instead." Undo of `CreateShot` runs the user-facing `delete_shot`, guards
 *    and all, so an insert into an anchored loop is an action that CANNOT be
 *    undone - and `undo.rs:439-444` pushes the entry back, so it fails the same
 *    way forever and everything beneath it is unreachable. A wedged history is
 *    the worst outcome here; the forward command was permitted, so its inverse
 *    must be too (raw-remove what was inserted, or capture a snapshot pair).
 *    Since jumps were added this seed reaches it through `undoTo(2)` and fails
 *    at "step 2 of 3" - i.e. the multi-step path applies the first undo, then
 *    wedges PARTWAY, which is strictly worse than the single-step case.
 * 7. `... seed=12, iterations=16` with ALLOW_KNOWN_BUGS - `undoTo(7)` (an 8-step
 *    jump, the history dropdown's path) lands on a DIFFERENT state than the same
 *    depth reached by eight single undos: `section_offsets` for two sections are
 *    out by 1.55 m and 3.33 m, and the stations with them.
 *
 *    `undo()`/`redo()` call `invalidate_adjusted_cache()` before and
 *    `reconcile_geometry()` after (src-tauri/src/core/state/undo.rs:23,37 and
 *    :460,466). `undo_to()`/`redo_to()` loop `undo_inner`/`redo_inner` directly
 *    (:854-876, :920-940) and call NEITHER. So the merge realignment that runs
 *    after every single step - `realign_merges()`, which fires once a merge is
 *    more than MERGE_ALIGNMENT_TOLERANCE_M (5 cm) out - never runs for a jump,
 *    and the closure-adjusted cache is left stale on top. N single undos and one
 *    N-wide jump are not the same operation. Deliberately NOT classified as
 *    tolerable: it is metres of geometry, reachable by clicking an entry in the
 *    history dropdown. The fix is to give undo_to/redo_to the same epilogue
 *    undo/redo have (once, after the loop - not per step).
 *
 * 8. OPEN LEAD, root cause NOT yet established:
 *    `... seed=12, iterations=16` with ALLOW_KNOWN_BUGS on fractal - after a
 *    save/reload, `undo` at depth 7 lands with all of `sections[14].shots[3..]`
 *    holding DIFFERENT shots (76 differing paths, shot COUNT unchanged, so the
 *    list is shifted rather than truncated). The suspicion is that a persisted
 *    `CreatedShotSnapshot` addresses its shot by an id the reload has since
 *    renumbered, so its undo removes the wrong slot - but that is not confirmed,
 *    and an id-agnostic-comparison artefact has not been fully excluded either.
 *    Left failing and unclassified deliberately: do not tolerate it until it is
 *    understood.
 *
 * Set `STALAGMIGHT_FUZZ_ALLOW_KNOWN_BUGS=1` to keep going past a mismatch that is
 * ENTIRELY a classified asymmetry (1, 2 and 4; it is logged, counted as the
 * `knownAsymmetry` metric, and the model resyncs). That exists so the rest of
 * the fuzzer can be exercised while those are open - it is deliberately NOT the
 * default, because a green default here would mean the oracle had been weakened.
 * 3, 5, 6 and 7 are never tolerated.
 *
 * ## The persistence boundary
 *
 * Undo history is PERSISTED - both stacks serialize into the .stalx and restore
 * on open - so nothing below a save point is exercised until a run crosses it.
 * Runs now save to a temp path, close and reopen, at least once and up to three
 * times, drawn from a THIRD independent stream (`seed ^ 0x85ebca6b`) and taken
 * IN ADDITION to each iteration's normal move so the primary numbers do not
 * shift. Skipped while the history is deeper than `undo_persist_limit`, since
 * only the newest entries survive the write.
 *
 * Two documented families of undo-less state change live here, and BOTH are
 * subtracted only from comparisons that cross an epoch boundary (a save or a
 * reload bumps the epoch); within an epoch the oracle stays strict, which is what
 * keeps bugs 3 and 7 visible:
 *
 *   - `SAVE_HEALING_MUTATIONS` - `save_project` mints missing shot uuids, dedupes
 *     within-section duplicates, captures missing gauge anchors, drops orphan
 *     `section_offsets` and sanitizes non-finite values, all with no undo entry.
 *   - `RELOAD_RESOLVED_GEOMETRY` - `redrive_offsets_after_load` ends in an
 *     unconditional `resolve_offsets()` ("Zero-trust: never honor a persisted
 *     derivable offset", offsets.rs:186-188), so a reload RECOMPUTES
 *     `section_offsets` and the station coordinates derived from them rather than
 *     restoring them.
 *
 * `Shot::id` is not persisted either - the loader renumbers to
 * `section_id * FEATURE_ID_STRIDE + sequence_order` (read.rs:372) - so from the
 * first reload the model compares id-agnostically (shot ids replaced by position,
 * everything else still exact). Section ids ARE persisted and are compared.
 *
 * ## Three oracles, not one
 *
 * 1. ROUNDTRIP - the snapshot-per-depth comparison above, including the
 *    single-step/jump equivalence.
 * 2. ABSOLUTE INVARIANTS (`checkProjectInvariants`, run in-page on every
 *    observed state). The roundtrip only sees drift BETWEEN states: a command
 *    that corrupts the project and an undo that faithfully restores the
 *    corruption match at every depth. Only an absolute check fires on that.
 * 3. INTEGRITY DELTA - `check_project_integrity`'s own verdict is recorded per
 *    depth alongside the snapshot and must be restored by every history move. A
 *    state that roundtrips while its integrity verdict does not is either a bug
 *    in the checker or a divergence the snapshot cannot see. `integrityCompared`
 *    counts the comparisons so this cannot pass vacuously.
 *
 * ## Determinism
 *
 * Every draw comes from `ctx.rng()`/`randInt`/`pick`, and every target id is
 * read back out of the live project and sorted before it is picked, so
 * `run_scenario("undo-redo-fuzz", seed, iterations)` replays byte-for-byte.
 *
 * The generators read a `TargetingDigest` rather than the raw project state.
 * The digest carries exactly the fields they read, each list in payload order,
 * so every sort and every pick sees the same values in the same sequence - the
 * draw stream, and every repro seed above, is unchanged by the move in-page.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mulberry32, type Scenario, type ScenarioContext } from './framework';
import { DEFAULT_FIXTURE, disableAutoSave, loadFixtureWithoutUndoHistory } from './common';
import {
  LOOP_CLOSURES_PATH,
  LOOP_CLOSURE_REORDER,
  RELOAD_RESOLVED_GEOMETRY,
  SAVE_HEALING_MUTATIONS,
  classifyDiffs,
  describeDiffs,
  diffSnapshots,
  isListPermutationOnly,
  type KnownAsymmetry,
} from '../lib/projectSnapshot';
import type { TargetingDigest } from '../lib/fuzzOracleCore';
import { drawAction } from './undoRedoFuzzActions';
import {
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

/**
 * Which `.stalx` under `e2e/fixtures/` to fuzz. Basename only - anything else is
 * flattened by `fixtureSourcePath`'s `path.basename`, which is the containment
 * guard and stays the only one.
 */
const FIXTURE = process.env.STALAGMIGHT_FUZZ_FIXTURE || DEFAULT_FIXTURE;

/** Move mix. Undo/redo are re-rolled when the stack they need is empty. */
const P_MUTATE = 0.6;
const P_UNDO = 0.25;

/**
 * Share of history moves taken as a MULTI-step jump through
 * `undoTo`/`redoTo` (the history dropdown's path) instead of a single step.
 *
 * Drawn from a SEPARATE PRNG (`mulberry32(seed ^ JUMP_STREAM_SALT)`), never from
 * `ctx.rng()`: an extra draw on the primary stream would shift every subsequent
 * decision and invalidate every recorded repro. The primary stream still decides
 * mutate-vs-undo-vs-redo, every generator and every value; this stream only
 * decides whether a history move is taken in one hop and how wide.
 */
const P_JUMP = 0.1;
const JUMP_STREAM_SALT = 0x9e3779b9;

/**
 * Share of iterations that take a save/close/reopen round trip, drawn from the
 * same secondary stream as jumps (never from `ctx.rng()`).
 *
 * Undo history is PERSISTED - both stacks serialize into the .stalx and restore
 * on open - so nothing below the save point is exercised until a run crosses
 * that boundary. Kept low because a round trip costs a full save plus a full
 * reopen, and capped per run.
 */
const P_SAVE = 0.05;
const MAX_SAVE_RELOADS = 3;
/**
 * Its OWN salt, not the jump stream's. Each optional feature draws from an
 * independent stream so adding one cannot move another's decisions - sharing a
 * stream would have made "add saves" silently change which jumps a seed takes.
 */
const SAVE_STREAM_SALT = 0x85ebca6b;

/** Diffs shown in a failure message (more are counted, not printed). */
const SHOWN_DIFFS = 6;
/** Actions shown in the failure message's history tail. */
const HISTORY_TAIL = 12;
/** Headroom kept below the undo history limit so FIFO trimming can never fire. */
const DEPTH_HEADROOM = 5;

interface SnapshotCheck {
  equal: boolean;
  /** Equal only once floating-point tolerance was applied. */
  floatNoise: boolean;
  /** Save/reload changes subtracted before classifying the rest (empty = none). */
  attributed: KnownAsymmetry[];
  /** Rendered diff block (empty when equal). */
  text: string;
  /** True when every difference is explained by a known open app bug. */
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
 * The SLOW path, reached only after the page has already reported a mismatch:
 * re-compare with numeric tolerance, then work out whether the difference is
 * one of the known open bugs.
 */
function checkSnapshot(expected: string, actual: string, attributable: readonly KnownAsymmetry[]): SnapshotCheck {
  if (expected === actual) return EQUAL;
  // Geometry is re-derived rather than copied on every undo/redo, so a
  // coordinate whose true value is 0 can come back as different femtometre dust.
  const all = diffSnapshots(expected, actual, 200);
  if (all.length === 0) return { ...EQUAL, floatNoise: true };

  // SUBTRACT the paths a save or a reload is documented to change before
  // classifying the rest. Without this a real bug found after a save reads as a
  // pile of gauge-anchor noise with the actual divergence buried in it.
  let diffs = all;
  let attributed: KnownAsymmetry[] = [];
  if (attributable.length > 0) {
    const split = classifyDiffs(all, attributable);
    if (split.known.length > 0) {
      diffs = split.unknown;
      attributed = split.asymmetries;
    }
  }
  if (diffs.length === 0) {
    return {
      equal: false,
      floatNoise: false,
      attributed,
      text: attributed.map((entry) => `  ATTRIBUTED [${entry.id}]: ${entry.description}`).join('\n'),
      onlyKnown: false,
      asymmetries: [],
    };
  }

  const lines = [describeDiffs(diffs.slice(0, SHOWN_DIFFS))];
  if (diffs.length > SHOWN_DIFFS) lines.push(`  ...and ${diffs.length - SHOWN_DIFFS} more differing path(s)`);
  for (const entry of attributed) {
    lines.push(`  (plus attributable change(s) [${entry.id}], subtracted before this diff)`);
  }

  // A shifted list reads as dozens of unrelated value diffs at every index past
  // the move. Prove that shape structurally before falling back to per-path
  // classification, so it is reported as the one thing it is.
  if (attributed.length === 0 && isListPermutationOnly(expected, actual, LOOP_CLOSURES_PATH)) {
    lines.push('  (every difference above is explained by project.loop_closures being REORDERED:');
    lines.push('   same closures, same ids, same metrics, different positions)');
    lines.push(`  KNOWN OPEN APP BUG [${LOOP_CLOSURE_REORDER.id}]: ${LOOP_CLOSURE_REORDER.description}`);
    return {
      equal: false,
      floatNoise: false,
      attributed,
      text: lines.join('\n'),
      onlyKnown: true,
      asymmetries: [LOOP_CLOSURE_REORDER],
    };
  }

  const classified = classifyDiffs(diffs);
  for (const asymmetry of classified.asymmetries) {
    lines.push(`  KNOWN OPEN APP BUG [${asymmetry.id}]: ${asymmetry.description}`);
  }
  return {
    equal: false,
    floatNoise: false,
    attributed,
    text: lines.join('\n'),
    onlyKnown: classified.unknown.length === 0,
    asymmetries: classified.asymmetries,
  };
}

export const undoRedoFuzz: Scenario = {
  name: 'undo-redo-fuzz',
  description:
    'Seeded random mutations interleaved with undo/redo walks; asserts an exact ' +
    'canonical state roundtrip at every history depth, compared in-page.',
  defaultIterations: 40,
  async run(ctx, { iterations }) {
    const { stripped } = await loadFixtureWithoutUndoHistory(ctx, FIXTURE);
    const strippedRows = Object.values(stripped.cleared).reduce((sum, n) => sum + n, 0);
    ctx.setMetric(`fixture:${FIXTURE}`, 1);
    ctx.setMetric('strippedUndoRows', strippedRows);

    if (!(await disableAutoSave(ctx))) {
      throw new Error(
        'could not disable auto-save; a save mutates live state with no undo entry and would ' +
          'desync the model (see disableAutoSave in scenarios/common.ts)',
      );
    }

    const historyLimit = await ctx.eval<number>(`
      const config = window.__E2E_TEST__.projectStore.getState().config;
      return config && config.general && typeof config.general.undo_history_limit === 'number'
        ? config.general.undo_history_limit
        : 100;
    `);

    await injectOracle(ctx);
    const init = await initModel(ctx);

    // Hard expectation, not a tolerance: the fixture's persisted history was
    // deleted from the temp copy before the load, so the app must come up with
    // both stacks empty. Anything else means the strip did not take (a table
    // this build persists that `UNDO_HISTORY_TABLES` does not list, say), and
    // every depth in the model would be measured from the wrong floor.
    const baseUndo = init.undoLen;
    if (baseUndo !== 0 || init.redoLen !== 0) {
      throw new Error(
        `${FIXTURE} opened with inherited history after stripping ` +
          `${strippedRows} row(s): undoLen=${baseUndo} redoLen=${init.redoLen} ` +
          `(cleared ${JSON.stringify(stripped.cleared)}, absent ${JSON.stringify(stripped.missing)})`,
      );
    }

    if (init.invariants.length > 0) {
      throw new Error(
        `${FIXTURE} violates project invariants BEFORE any fuzzing:\n` +
          init.invariants.map((violation) => `  INVARIANT: ${violation}`).join('\n'),
      );
    }

    // Never push so many entries that the stack's FIFO trimming fires - that
    // would silently invalidate snapshots[0] and every depth above it. baseUndo
    // is 0 by the assertion above; it stays in the arithmetic so the bound still
    // reads as "headroom from wherever the stack actually starts".
    const maxDepth = Math.max(1, Math.min(iterations, historyLimit - baseUndo - DEPTH_HEADROOM));

    const history: string[] = [];
    let cursor = 0;
    /** Node's mirror of the page's `snapshots.length - 1`. */
    let top = 0;
    let deepest = 0;
    let maxBytes = init.bytes;
    let undoLen = init.undoLen;
    let redoLen = init.redoLen;
    let digest: TargetingDigest = init.digest;
    const jumpRng = mulberry32((ctx.seed ^ JUMP_STREAM_SALT) >>> 0);
    const saveRng = mulberry32((ctx.seed ^ SAVE_STREAM_SALT) >>> 0);
    let savesDone = 0;
    let reloadsDone = 0;
    const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-fuzz-save-'));
    const savePath = path.join(saveDir, 'fuzz-roundtrip.stalx');
    // Both stacks persist, but only the newest `undo_persist_limit` entries do.
    // Crossing the boundary with a deeper history would silently truncate the
    // restored stack and invalidate the model, so the move is skipped instead.
    const persistLimit = await ctx.eval<number>(`
      const config = window.__E2E_TEST__.projectStore.getState().config;
      return config && config.general && typeof config.general.undo_persist_limit === 'number'
        ? config.general.undo_persist_limit
        : 20;
    `);

    const note = (line: string): void => {
      history.push(line);
    };

    const fail = (headline: string, detail = ''): never => {
      const tail = history.slice(-HISTORY_TAIL).map((line) => `    ${line}`);
      throw new Error(
        [
          headline,
          `  reproduce: run_scenario("undo-redo-fuzz", seed=${ctx.seed}, iterations=${iterations})` +
            `${FIXTURE === DEFAULT_FIXTURE ? '' : ` with STALAGMIGHT_FUZZ_FIXTURE=${FIXTURE}`}` +
            `${ALLOW_KNOWN_BUGS ? ' with STALAGMIGHT_FUZZ_ALLOW_KNOWN_BUGS=1' : ''}`,
          `  fixture=${FIXTURE} depth=${cursor} modelTop=${top} baseUndo=${baseUndo}`,
          ...(detail ? [detail] : []),
          `  last ${tail.length} action(s):`,
          ...tail,
        ].join('\n'),
      );
    };

    /** One fused round trip, timed. */
    const step = async (
      kind: 'mutate' | 'undo' | 'redo' | 'undoTo' | 'redoTo' | 'save' | 'reload',
      action: string,
      actionArgs: unknown[],
      steps = 1,
    ): Promise<StepResponse> => {
      const started = Date.now();
      const res = await runStep(ctx, {
        kind,
        action,
        args: actionArgs,
        cursor,
        undo0: undoLen,
        steps,
      });
      ctx.metric('fusedStepMs', Date.now() - started);
      // Attribution, so the next round of tuning aims at evidence: the store
      // action's own work, the three read-only IPC calls, the in-page
      // canonicalization, and (by subtraction from fusedStepMs) the bridge.
      ctx.metric('actionMs', res.timing.actionMs);
      ctx.metric('observeMs', res.timing.observeMs);
      ctx.metric('canonicalMs', res.timing.canonicalMs);
      ctx.metric('integrityMs', res.timing.integrityMs);
      ctx.metric('steps');
      return res;
    };

    /** The page applied the same bookkeeping rules; prove it landed in the same place. */
    const assertModel = (res: StepResponse, headline: string): void => {
      if (res.cursorAfter !== cursor || res.top !== top) {
        fail(
          headline,
          `  page model says cursor=${res.cursorAfter} top=${res.top}, Node says cursor=${cursor} top=${top}`,
        );
      }
    };

    /**
     * ABSOLUTE well-formedness, checked on every observed state. Independent of
     * the roundtrip comparison: a forward command that corrupts the project and
     * an undo that faithfully restores the corruption match at every depth, so
     * only this fires.
     */
    const assertInvariants = (res: StepResponse, what: string): void => {
      if (res.invariants.length === 0) return;
      fail(
        `project invariant(s) violated after ${what}`,
        res.invariants.map((violation) => `  INVARIANT: ${violation}`).join('\n'),
      );
    };

    const sameIntegrity = (a: IntegrityVerdict, b: IntegrityVerdict): boolean =>
      a.saveBlocked === b.saveBlocked && a.messages.join('\u0000') === b.messages.join('\u0000');

    /**
     * The app runs `check_project_integrity` after every undo/redo anyway, so
     * its verdict is part of the state a history move is supposed to restore. A
     * state that roundtrips while its integrity verdict does not is either a bug
     * in the checker or a divergence the snapshot cannot see.
     */
    const assertIntegrityDelta = (res: StepResponse, what: string): void => {
      const expected = res.integrityExpected;
      if (expected === null) return;
      // Counted so the oracle can be shown to be doing work rather than
      // passing vacuously on a model that never recorded a verdict.
      ctx.metric('integrityCompared');
      if (sameIntegrity(expected, res.integrity)) return;
      const format = (verdict: IntegrityVerdict): string =>
        `saveBlocked=${verdict.saveBlocked} messages=${JSON.stringify(verdict.messages)}`;
      fail(
        `${what} restored the state but NOT the integrity verdict recorded at depth ${cursor}`,
        `  expected: ${format(expected)}\n  actual:   ${format(res.integrity)}`,
      );
    };

    const assertStacks = (headline: string, res: StepResponse): void => {
      const wantUndo = baseUndo + cursor;
      const wantRedo = top - cursor;
      if (res.undoLen !== wantUndo || res.redoLen !== wantRedo) {
        fail(
          headline,
          `  expected undoLen=${wantUndo} redoLen=${wantRedo}, got undoLen=${res.undoLen} redoLen=${res.redoLen}`,
        );
      }
    };

    /**
     * Resolve a mismatch the page reported. Fetches both canonical strings (the
     * only time they cross the bridge) and either tolerates the difference or
     * fails with the full diff.
     */
    const resolveMismatch = async (
      headline: string,
      resyncIntegrity: IntegrityVerdict | null,
      res: StepResponse,
    ): Promise<void> => {
      const pair = await fetchMismatch(ctx);
      // ONLY a comparison that crosses an epoch boundary may subtract the
      // documented undo-less changes. Within an epoch the oracle stays strict -
      // otherwise "a reload re-solves offsets" would permanently hide every
      // section_offsets bug the fuzzer exists to find (bugs 3 and 7).
      const attributable = res.crossesEpoch
        ? [
            ...(savesDone > 0 ? SAVE_HEALING_MUTATIONS : []),
            ...(reloadsDone > 0 ? RELOAD_RESOLVED_GEOMETRY : []),
          ]
        : [];
      const check = checkSnapshot(pair.expected ?? '', pair.actual ?? '', attributable);
      if (check.equal) {
        // Counted, never resynced: keeping the ORIGINAL expectation means the
        // tolerance can never ratchet, only ever absorb the same dust again.
        if (check.floatNoise) ctx.metric('floatNoise');
        return;
      }
      // Every difference was a documented save heal or reload re-solve: record
      // the new baseline and carry on. Nothing else is tolerated here.
      if (check.attributed.length > 0 && check.text.startsWith('  ATTRIBUTED')) {
        ctx.metric('resyncs');
        for (const entry of check.attributed) ctx.metric(`resync:${entry.id}`);
        top = await resyncModel(ctx, pair.index, resyncIntegrity);
        return;
      }
      if (ALLOW_KNOWN_BUGS && check.onlyKnown) {
        ctx.metric('knownAsymmetry');
        for (const asymmetry of check.asymmetries) ctx.metric(`known:${asymmetry.id}`);
        ctx.log(`tolerated known asymmetry at depth ${cursor}: ${check.asymmetries.map((a) => a.id).join(', ')}`);
        // Resync so one open bug does not cascade into every later comparison.
        top = await resyncModel(ctx, pair.index, resyncIntegrity);
        return;
      }
      fail(headline, check.text);
    };

    const record = (res: StepResponse): void => {
      undoLen = res.undoLen;
      redoLen = res.redoLen;
      digest = res.digest;
      maxBytes = Math.max(maxBytes, res.bytes);
      deepest = Math.max(deepest, cursor);
    };

    /**
     * One history move. `jumpSteps` takes it through `undoTo`/`redoTo` - the
     * history dropdown's multi-step path - instead of a single `undo`/`redo`.
     *
     * The oracle is deliberately the SAME snapshot array either way: the state a
     * jump lands on must equal the one single steps recorded at that depth. That
     * equivalence is not free - `undo_to`/`redo_to` loop `undo_inner`/`redo_inner`
     * and call NEITHER `invalidate_adjusted_cache()` NOR `reconcile_geometry()`,
     * both of which `undo()`/`redo()` do (verified in
     * src-tauri/src/core/state/undo.rs) - so a divergence here is a real product
     * bug reachable from the dropdown.
     */
    const walk = async (
      direction: 'undo' | 'redo',
      tag: string,
      jumpSteps: number | null = null,
    ): Promise<void> => {
      const steps = jumpSteps ?? 1;
      const back = direction === 'undo';
      const jumped = jumpSteps !== null;
      const action = jumped ? (back ? 'undoTo' : 'redoTo') : direction;
      const label = jumped ? `${action}(${steps - 1})[${steps} step(s)]` : direction;
      const beforeUndo = undoLen;
      const beforeRedo = redoLen;
      const res = await step(
        jumped ? (back ? 'undoTo' : 'redoTo') : direction,
        action,
        jumped ? [steps - 1] : [],
        steps,
      );
      if (!res.actionOk || res.commandSuccess === false) {
        note(`${tag} ${label} -> FAILED`);
        fail(
          `${label} at depth ${cursor} failed outright`,
          `  error: ${res.commandError ?? res.actionError ?? 'unknown'}`,
        );
      }
      cursor += back ? -steps : steps;
      note(
        `${tag} ${label} -> depth ${cursor} (undo ${beforeUndo}->${res.undoLen}, redo ${beforeRedo}->${res.redoLen})`,
      );
      assertInvariants(res, label);
      assertModel(res, `${label} left the page model where Node did not expect it`);
      assertStacks(`${label} left the history stacks in an unexpected shape`, res);
      if (res.verdict !== 'equal') {
        await resolveMismatch(
          `${label} did not restore the state recorded at depth ${cursor}`,
          res.integrity,
          res,
        );
      }
      assertIntegrityDelta(res, label);
      record(res);
      ctx.metric(direction === 'undo' ? 'undos' : 'redos');
      if (jumped) {
        ctx.metric('jumps');
        ctx.metric(`jump:${action}`);
        ctx.metric('jumpSteps', steps);
      }
    };

    /**
     * Save, close, reopen: the persistence boundary.
     *
     * Undo history lives in the .stalx (both stacks, sequence renumbered), so
     * until a run crosses this boundary nothing below it is exercised at all.
     * Three separate oracles run here:
     *
     *   1. SAVE IS ATTRIBUTABLE. `save_project` heals live state with no undo
     *      entry - `ensure_shot_uuids`, `ensure_unique_shot_uuids`,
     *      `capture_missing_gauge_anchors`, the orphan `section_offsets` retain,
     *      non-finite sanitize. Every path that changes must match
     *      `SAVE_HEALING_MUTATIONS` by path AND direction; anything else fails.
     *   2. THE STACKS SURVIVE. Both lengths must come back exactly.
     *   3. THE RESTORED STACK IS THE SAME HISTORY. From here the model compares
     *      id-agnostically (the loader renumbers `Shot::id` to
     *      `section_id * FEATURE_ID_STRIDE + sequence_order`), and the run's
     *      final unwind/rewind then walks the whole RESTORED stack against the
     *      snapshots recorded before the save.
     */
    const saveAndReload = async (tag: string): Promise<void> => {
      // The save is about to make undo-less changes, so everything recorded so
      // far belongs to the previous epoch.
      await bumpEpoch(ctx);
      const saveRes = await step('save', 'saveProject', [savePath]);
      if (!saveRes.actionOk || saveRes.commandSuccess === false) {
        note(`${tag} save -> FAILED`);
        fail('saveProject failed', `  error: ${saveRes.commandError ?? saveRes.actionError ?? 'unknown'}`);
      }
      note(`${tag} save -> ok (depth ${cursor}, undo ${saveRes.undoLen}, redo ${saveRes.redoLen})`);
      assertInvariants(saveRes, 'save');
      assertStacks('save changed the history stacks', saveRes);
      savesDone += 1;
      if (saveRes.verdict !== 'equal') {
        await resolveMismatch(
          'save mutated the project in a way SAVE_HEALING_MUTATIONS does not account for',
          saveRes.integrity,
          saveRes,
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

      // Switch BEFORE re-observing so both sides of the comparison are in the
      // same form. Idempotent, so later reloads are a no-op.
      await enableIdAgnosticModel(ctx);
      await bumpEpoch(ctx);
      reloadsDone += 1;
      const res = await observeOnly(ctx, cursor);
      note(`${tag} reload -> depth ${cursor} (undo ${res.undoLen}, redo ${res.redoLen})`);
      assertInvariants(res, 'reload');
      assertStacks('the persisted history did not come back intact', res);
      if (res.verdict !== 'equal') {
        await resolveMismatch(
          'reopening the saved project did not restore the state it was saved at',
          res.integrity,
          res,
        );
      }
      assertIntegrityDelta(res, 'reload');
      record(res);
      ctx.metric('reloads');
    };

    /** Should this iteration cross the save/reload boundary? */
    const wantSaveReload = (): boolean => {
      if (savesDone >= MAX_SAVE_RELOADS) return false;
      // Only the newest `undo_persist_limit` entries survive the write, so a
      // deeper history would come back truncated - skip rather than model it.
      if (top > persistLimit) {
        ctx.metric('savesSkippedDeepHistory');
        return false;
      }
      return saveRng() < P_SAVE;
    };

    /**
     * How wide a jump to take, or null for a single step. Drawn from the
     * SEPARATE stream so the primary sequence is untouched.
     */
    const drawJump = (direction: 'undo' | 'redo'): number | null => {
      const reach = direction === 'undo' ? cursor : top - cursor;
      if (reach < 1) return null;
      if (jumpRng() >= P_JUMP) return null;
      // 1..reach. A 1-step jump is still worth taking: undo_to(0) reaches the
      // same depth through a different backend path than undo().
      return 1 + Math.floor(jumpRng() * reach);
    };

    for (let iteration = 1; iteration <= iterations; iteration++) {
      const tag = `#${iteration}`;
      // Drawn from the SECONDARY stream, and taken IN ADDITION to this
      // iteration's normal move rather than instead of it: consuming the
      // iteration would leave the run with fewer mutations than the same seed
      // produced before, and the point of the secondary stream is that adding a
      // feature does not move the primary numbers.
      if (wantSaveReload()) await saveAndReload(tag);
      const roll = ctx.rng();
      let move: 'mutate' | 'undo' | 'redo' =
        roll < P_MUTATE ? 'mutate' : roll < P_MUTATE + P_UNDO ? 'undo' : 'redo';
      if (move === 'redo' && cursor >= top) move = cursor > 0 ? 'undo' : 'mutate';
      if (move === 'undo' && cursor === 0) move = 'mutate';
      if (move === 'mutate' && cursor >= maxDepth) move = 'undo';

      if (move !== 'mutate') {
        await walk(move, tag, drawJump(move));
        continue;
      }

      const action = drawAction(ctx, digest);
      const beforeUndo = undoLen;
      const beforeRedo = redoLen;
      const res = await step('mutate', action.action, action.args);
      const accepted = res.actionOk && res.commandSuccess !== false;
      const pushed = res.undoLen - beforeUndo;
      note(
        `${tag} ${action.label} -> ${accepted ? 'ok' : 'rejected'} ` +
          `(undo ${beforeUndo}->${res.undoLen}, redo ${beforeRedo}->${res.redoLen})`,
      );

      if (!accepted) {
        ctx.metric('rejected');
        ctx.metric(`rejected:${action.action}`);
        if (pushed !== 0 || res.redoLen !== beforeRedo) {
          fail(
            'a REJECTED command changed the history stacks',
            `  error: ${res.commandError ?? res.actionError ?? 'unknown'}\n` +
              `  undo ${beforeUndo}->${res.undoLen}, redo ${beforeRedo}->${res.redoLen}`,
          );
        }
        assertInvariants(res, `a rejected ${action.action}`);
        assertModel(res, 'a rejected command moved the page model');
        if (res.verdict !== 'equal') {
          await resolveMismatch(
            `a REJECTED command (${action.action}) mutated the project: ` +
              `${res.commandError ?? res.actionError ?? 'unknown'}`,
            res.integrity,
            res,
          );
        }
        assertIntegrityDelta(res, `a rejected ${action.action}`);
        record(res);
        continue;
      }

      if (pushed === 1) {
        if (res.redoLen !== 0) {
          fail(
            'a successful command did not clear the redo stack',
            `  redo ${beforeRedo}->${res.redoLen} after ${action.label}`,
          );
        }
        cursor += 1;
        top = cursor;
        assertInvariants(res, action.label);
        assertModel(res, 'the page recorded the new snapshot at a different depth than Node expected');
        if (res.verdict !== 'recorded') {
          fail(`the page did not record a snapshot for a pushed entry (verdict=${res.verdict})`);
        }
        record(res);
        ctx.metric('mutations');
        ctx.metric(`op:${action.action}`);
        continue;
      }

      if (pushed !== 0) {
        fail(
          `a single command pushed ${pushed} undo entries (expected 0 or 1)`,
          `  after ${action.label}`,
        );
      }

      // Succeeded without pushing an entry: a no-op command. It must not have
      // touched the project; it MAY have cleared the redo stack.
      ctx.metric('noops');
      ctx.metric(`noop:${action.action}`);
      if (res.undoLen >= historyLimit - 1) {
        fail(
          'the undo stack hit its history limit; FIFO trimming invalidates the model',
          `  undoLen=${res.undoLen} limit=${historyLimit}`,
        );
      }
      if (res.redoLen === 0) top = cursor;
      else if (res.redoLen !== beforeRedo) {
        fail(
          'a no-op command changed the redo stack without clearing it',
          `  redo ${beforeRedo}->${res.redoLen} after ${action.label}`,
        );
      }
      assertInvariants(res, `a no-op ${action.action}`);
      assertModel(res, 'a no-op command moved the page model');
      if (res.verdict !== 'equal') {
        await resolveMismatch(
          `a no-op command (${action.action}) changed the project state`,
          res.integrity,
          res,
        );
      }
      assertIntegrityDelta(res, `a no-op ${action.action}`);
      record(res);
    }

    // Cross the persistence boundary at least once per run, so the final
    // unwind/rewind below walks a RESTORED stack rather than an in-memory one.
    if (savesDone === 0 && top > 0 && top <= persistLimit) {
      await saveAndReload('boundary');
    }

    // Full roundtrip: unwind every entry, then replay every entry, verifying
    // the recorded snapshot at each depth in both directions.
    const summit = top;
    while (cursor > 0) await walk('undo', 'unwind');
    while (cursor < summit) await walk('redo', 'rewind');

    if (cursor !== summit) fail(`roundtrip ended at depth ${cursor}, expected ${summit}`);

    try {
      fs.rmSync(saveDir, { recursive: true, force: true });
    } catch {
      // Best-effort: a leftover temp dir is not a scenario failure.
    }

    ctx.setMetric('modelDepth', summit);
    ctx.setMetric('maxDepth', deepest);
    ctx.setMetric('snapshotBytesMax', maxBytes);
    ctx.setMetric('historyLimit', historyLimit);
    ctx.log(
      `fixture=${FIXTURE} (stripped ${strippedRows} inherited undo row(s)) seed=${ctx.seed}: ` +
        `${ctx.metrics.mutations ?? 0} mutations, ${ctx.metrics.undos ?? 0} undos, ` +
        `${ctx.metrics.redos ?? 0} redos, ${ctx.metrics.rejected ?? 0} rejected, ` +
        `${ctx.metrics.noops ?? 0} no-ops; max depth ${deepest}; snapshot <=${maxBytes}B`,
    );
  },
};
