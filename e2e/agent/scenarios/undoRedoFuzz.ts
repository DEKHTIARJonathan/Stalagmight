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
 *    undo, redo: every shot uuid is re-minted.
 *    `UndoData::CreatedSectionSnapshot` stores a `SectionData`, which has no
 *    uuid field, so redo goes `restore_section` -> `Section::new_with_id` ->
 *    `Shot::new` -> `Uuid::new_v4()`. The sibling `CreateShot` path was
 *    explicitly fixed for this exact reason (a fresh uuid dangles every
 *    `StationKey::AfterShot` anchor and the Ariane export identity).
 * 2. `... seed=11, iterations=150` (and seed 12) - undoing a shot INSERT leaves
 *    behind an all-zero `section_offsets` entry the section did not have.
 *    `adjust_section_offset` creates the key while compensating; the undo puts
 *    the value back to 0 but nothing removes the key. Geometrically inert, and
 *    it is serialized into the .stalx.
 * 3. `... seed=2, iterations=36` - appending the FIRST shot into an EMPTY
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
 *
 * Set `STALAGMIGHT_FUZZ_ALLOW_KNOWN_BUGS=1` to keep going past a mismatch that is
 * ENTIRELY a classified asymmetry (1, 2 and 4; it is logged, counted as the
 * `knownAsymmetry` metric, and the model resyncs). That exists so the rest of
 * the fuzzer can be exercised while those are open - it is deliberately NOT the
 * default, because a green default here would mean the oracle had been weakened.
 * 3, 5 and 6 are never tolerated.
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
import type { Scenario, ScenarioContext } from './framework';
import { DEFAULT_FIXTURE, disableAutoSave, loadFixtureWithoutUndoHistory } from './common';
import {
  LOOP_CLOSURES_PATH,
  LOOP_CLOSURE_REORDER,
  classifyDiffs,
  describeDiffs,
  diffSnapshots,
  isListPermutationOnly,
  type KnownAsymmetry,
} from '../lib/projectSnapshot';
import type { TargetingDigest } from '../lib/fuzzOracleCore';
import { drawAction } from './undoRedoFuzzActions';
import {
  fetchMismatch,
  initModel,
  injectOracle,
  resyncModel,
  runStep,
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
  /** Rendered diff block (empty when equal). */
  text: string;
  /** True when every difference is explained by a known open app bug. */
  onlyKnown: boolean;
  asymmetries: KnownAsymmetry[];
}

const EQUAL: SnapshotCheck = { equal: true, floatNoise: false, text: '', onlyKnown: false, asymmetries: [] };

/**
 * The SLOW path, reached only after the page has already reported a mismatch:
 * re-compare with numeric tolerance, then work out whether the difference is
 * one of the known open bugs.
 */
function checkSnapshot(expected: string, actual: string): SnapshotCheck {
  if (expected === actual) return EQUAL;
  // Geometry is re-derived rather than copied on every undo/redo, so a
  // coordinate whose true value is 0 can come back as different femtometre dust.
  const diffs = diffSnapshots(expected, actual, 200);
  if (diffs.length === 0) return { ...EQUAL, floatNoise: true };

  const lines = [describeDiffs(diffs.slice(0, SHOWN_DIFFS))];
  if (diffs.length > SHOWN_DIFFS) lines.push(`  ...and ${diffs.length - SHOWN_DIFFS} more differing path(s)`);

  // A shifted list reads as dozens of unrelated value diffs at every index past
  // the move. Prove that shape structurally before falling back to per-path
  // classification, so it is reported as the one thing it is.
  if (isListPermutationOnly(expected, actual, LOOP_CLOSURES_PATH)) {
    lines.push('  (every difference above is explained by project.loop_closures being REORDERED:');
    lines.push('   same closures, same ids, same metrics, different positions)');
    lines.push(`  KNOWN OPEN APP BUG [${LOOP_CLOSURE_REORDER.id}]: ${LOOP_CLOSURE_REORDER.description}`);
    return {
      equal: false,
      floatNoise: false,
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
      kind: 'mutate' | 'undo' | 'redo',
      action: string,
      actionArgs: unknown[],
    ): Promise<StepResponse> => {
      const started = Date.now();
      const res = await runStep(ctx, { kind, action, args: actionArgs, cursor, undo0: undoLen });
      ctx.metric('fusedStepMs', Date.now() - started);
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
    const resolveMismatch = async (headline: string): Promise<void> => {
      const pair = await fetchMismatch(ctx);
      const check = checkSnapshot(pair.expected ?? '', pair.actual ?? '');
      if (check.equal) {
        // Counted, never resynced: keeping the ORIGINAL expectation means the
        // tolerance can never ratchet, only ever absorb the same dust again.
        if (check.floatNoise) ctx.metric('floatNoise');
        return;
      }
      if (ALLOW_KNOWN_BUGS && check.onlyKnown) {
        ctx.metric('knownAsymmetry');
        for (const asymmetry of check.asymmetries) ctx.metric(`known:${asymmetry.id}`);
        ctx.log(`tolerated known asymmetry at depth ${cursor}: ${check.asymmetries.map((a) => a.id).join(', ')}`);
        // Resync so one open bug does not cascade into every later comparison.
        top = await resyncModel(ctx, pair.index);
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

    const walk = async (direction: 'undo' | 'redo', tag: string): Promise<void> => {
      const beforeUndo = undoLen;
      const beforeRedo = redoLen;
      const res = await step(direction, direction, []);
      if (!res.actionOk || res.commandSuccess === false) {
        note(`${tag} ${direction} -> FAILED`);
        fail(
          `${direction} at depth ${cursor} failed outright`,
          `  error: ${res.commandError ?? res.actionError ?? 'unknown'}`,
        );
      }
      cursor += direction === 'undo' ? -1 : 1;
      note(
        `${tag} ${direction} -> depth ${cursor} (undo ${beforeUndo}->${res.undoLen}, redo ${beforeRedo}->${res.redoLen})`,
      );
      assertModel(res, `${direction} left the page model where Node did not expect it`);
      assertStacks(`${direction} left the history stacks in an unexpected shape`, res);
      if (res.verdict !== 'equal') {
        await resolveMismatch(`${direction} did not restore the state recorded at depth ${cursor}`);
      }
      record(res);
      ctx.metric(direction === 'undo' ? 'undos' : 'redos');
    };

    for (let iteration = 1; iteration <= iterations; iteration++) {
      const tag = `#${iteration}`;
      const roll = ctx.rng();
      let move: 'mutate' | 'undo' | 'redo' =
        roll < P_MUTATE ? 'mutate' : roll < P_MUTATE + P_UNDO ? 'undo' : 'redo';
      if (move === 'redo' && cursor >= top) move = cursor > 0 ? 'undo' : 'mutate';
      if (move === 'undo' && cursor === 0) move = 'mutate';
      if (move === 'mutate' && cursor >= maxDepth) move = 'undo';

      if (move !== 'mutate') {
        await walk(move, tag);
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
        assertModel(res, 'a rejected command moved the page model');
        if (res.verdict !== 'equal') {
          await resolveMismatch(
            `a REJECTED command (${action.action}) mutated the project: ` +
              `${res.commandError ?? res.actionError ?? 'unknown'}`,
          );
        }
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
      assertModel(res, 'a no-op command moved the page model');
      if (res.verdict !== 'equal') {
        await resolveMismatch(`a no-op command (${action.action}) changed the project state`);
      }
      record(res);
    }

    // Full roundtrip: unwind every entry, then replay every entry, verifying
    // the recorded snapshot at each depth in both directions.
    const summit = top;
    while (cursor > 0) await walk('undo', 'unwind');
    while (cursor < summit) await walk('redo', 'rewind');

    if (cursor !== summit) fail(`roundtrip ended at depth ${cursor}, expected ${summit}`);

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
