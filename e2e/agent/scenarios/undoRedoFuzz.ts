/**
 * undo-redo-fuzz: a seeded random-action undo/redo fuzzer.
 *
 * Loads a real `.stalx` fixture, then walks a randomized stream of REAL
 * mutating commands (through the projectStore actions, so the frontend store
 * stays in step with the backend) interleaved with random undo/redo moves, and
 * asserts after every single move that the project state is EXACTLY the state
 * previously recorded at that undo-stack depth.
 *
 * ## The model
 *
 * `snapshots[d]` is the expected normalized `get_project_state` at undo depth
 * `d` (`snapshots[0]` = the state right after the fixture opened). `cursor` is
 * the current depth; the ground truth for it is the backend's own
 * `get_undo_stack` / `get_redo_stack` lengths, re-read after every move, so the
 * model can never quietly drift away from the app.
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
 * `e2e/agent/lib/projectSnapshot.ts` owns the normalization and documents every
 * field it drops (all of them monotonic counters or `touch()`/`file_path`
 * artefacts). Map key order is canonicalized rather than dropped, and floats are
 * rounded to 12 significant digits. Shot uuids, `reverse_parity`, the gauge
 * anchors, `merged_at`, all closure metrics and all geometry ARE compared.
 *
 * ## Open app bugs this reproduces
 *
 * None of these are normalized away. The oracle fails on all three; the first
 * two are classified in `projectSnapshot.ts`'s `KNOWN_UNDO_ASYMMETRIES` so the
 * message names them rather than reading as a mystery.
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
 *
 * Set `STALAGMIGHT_FUZZ_ALLOW_KNOWN_BUGS=1` to keep going past a mismatch whose
 * every differing path is a CLASSIFIED asymmetry (1 and 2; it is logged, counted
 * as the `knownAsymmetry` metric, and the model resyncs). That exists so the
 * rest of the fuzzer can be exercised while those are open - it is deliberately
 * NOT the default, because a green default here would mean the oracle had been
 * weakened.
 *
 * ## Determinism
 *
 * Every draw comes from `ctx.rng()`/`randInt`/`pick`, and every target id is
 * read back out of the live project and sorted before it is picked, so
 * `run_scenario("undo-redo-fuzz", seed, iterations)` replays byte-for-byte.
 */
import type { Scenario, ScenarioContext } from './framework';
import { DEFAULT_FIXTURE, disableAutoSave, ensureProjectLoaded } from './common';
import {
  classifyDiffs,
  describeDiffs,
  diffSnapshots,
  snapshotProjectState,
  type KnownAsymmetry,
} from '../lib/projectSnapshot';
import { drawAction, type RawProjectState } from './undoRedoFuzzActions';

/** Opt in to surviving a mismatch that is entirely a documented open app bug. */
const ALLOW_KNOWN_BUGS = process.env.STALAGMIGHT_FUZZ_ALLOW_KNOWN_BUGS === '1';

/** Move mix. Undo/redo are re-rolled when the stack they need is empty. */
const P_MUTATE = 0.6;
const P_UNDO = 0.25;

/** Diffs shown in a failure message (more are counted, not printed). */
const SHOWN_DIFFS = 6;
/** Actions shown in the failure message's history tail. */
const HISTORY_TAIL = 12;
/** Headroom kept below the undo history limit so FIFO trimming can never fire. */
const DEPTH_HEADROOM = 5;

/** One observation of backend truth: normalized state + both stack lengths. */
interface Observed {
  raw: RawProjectState;
  json: string;
  bytes: number;
  undoLen: number;
  redoLen: number;
}

/**
 * Read the whole oracle in ONE webview round trip. The two history stacks are
 * counted in the page (they carry preview data for up to 100 entries each);
 * only the project state itself crosses the WebDriver bridge.
 */
const READ_STATE_JS = `
  const core = window.__TAURI__ && window.__TAURI__.core;
  if (!core || typeof core.invoke !== 'function') throw new Error('window.__TAURI__.core.invoke unavailable');
  const state = await core.invoke('get_project_state');
  const undo = await core.invoke('get_undo_stack');
  const redo = await core.invoke('get_redo_stack');
  return { state, undoLen: undo.length, redoLen: redo.length };
`;

async function readObserved(ctx: ScenarioContext): Promise<Observed> {
  const started = Date.now();
  const read = await ctx.eval<{ state: unknown; undoLen: number; redoLen: number }>(READ_STATE_JS);
  ctx.metric('oracleReadMs', Date.now() - started);
  if (read.state === null || read.state === undefined) {
    throw new Error('get_project_state returned null: the project closed mid-run');
  }
  const json = snapshotProjectState(read.state);
  return {
    raw: read.state as RawProjectState,
    json,
    bytes: json.length,
    undoLen: read.undoLen,
    redoLen: read.redoLen,
  };
}

interface SnapshotCheck {
  equal: boolean;
  /** Equal only once floating-point tolerance was applied (see projectSnapshot.ts). */
  floatNoise: boolean;
  /** Rendered diff block (empty when equal). */
  text: string;
  /** True when every differing path is explained by a known open app bug. */
  onlyKnown: boolean;
  asymmetries: KnownAsymmetry[];
}

const EQUAL: SnapshotCheck = { equal: true, floatNoise: false, text: '', onlyKnown: false, asymmetries: [] };

function checkSnapshot(expected: string, actual: string): SnapshotCheck {
  // Fast path: the canonical strings match outright.
  if (expected === actual) return EQUAL;
  // Slow path: re-compare with numeric tolerance. Geometry is re-derived rather
  // than copied on every undo/redo, so a coordinate whose true value is 0 can
  // come back as different femtometre-scale dust.
  const diffs = diffSnapshots(expected, actual, 200);
  if (diffs.length === 0) return { ...EQUAL, floatNoise: true };
  const classified = classifyDiffs(diffs);
  const lines = [describeDiffs(diffs.slice(0, SHOWN_DIFFS))];
  if (diffs.length > SHOWN_DIFFS) lines.push(`  ...and ${diffs.length - SHOWN_DIFFS} more differing path(s)`);
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
    'normalized state roundtrip at every history depth.',
  defaultIterations: 40,
  async run(ctx, { iterations }) {
    await ensureProjectLoaded(ctx, DEFAULT_FIXTURE);
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

    let observed = await readObserved(ctx);
    const baseUndo = observed.undoLen;
    if (observed.redoLen !== 0) {
      throw new Error(
        `fixture opened with a non-empty redo stack (${observed.redoLen}); the model can only ` +
          'redo entries it created',
      );
    }

    // Never push so many entries that the stack's FIFO trimming fires - that
    // would silently invalidate snapshots[0] and every depth above it.
    const maxDepth = Math.max(1, Math.min(iterations, historyLimit - baseUndo - DEPTH_HEADROOM));

    const snapshots: string[] = [observed.json];
    const history: string[] = [];
    let cursor = 0;
    let deepest = 0;
    let maxBytes = observed.bytes;

    const note = (line: string): void => {
      history.push(line);
    };

    const fail = (headline: string, detail = ''): never => {
      const tail = history.slice(-HISTORY_TAIL).map((line) => `    ${line}`);
      throw new Error(
        [
          headline,
          `  reproduce: run_scenario("undo-redo-fuzz", seed=${ctx.seed}, iterations=${iterations})` +
            `${ALLOW_KNOWN_BUGS ? ' with STALAGMIGHT_FUZZ_ALLOW_KNOWN_BUGS=1' : ''}`,
          `  depth=${cursor} modelTop=${snapshots.length - 1} baseUndo=${baseUndo}`,
          ...(detail ? [detail] : []),
          `  last ${tail.length} action(s):`,
          ...tail,
        ].join('\n'),
      );
    };

    /**
     * Compare backend truth against the model. Returns true when the caller
     * should keep going (equal, or a tolerated known-bug mismatch).
     */
    const assertSnapshot = (headline: string, actual: string): void => {
      const check = checkSnapshot(snapshots[cursor] ?? '', actual);
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
        snapshots[cursor] = actual;
        return;
      }
      fail(headline, check.text);
    };

    const assertStacks = (headline: string, next: Observed): void => {
      const wantUndo = baseUndo + cursor;
      const wantRedo = snapshots.length - 1 - cursor;
      if (next.undoLen !== wantUndo || next.redoLen !== wantRedo) {
        fail(
          headline,
          `  expected undoLen=${wantUndo} redoLen=${wantRedo}, got undoLen=${next.undoLen} redoLen=${next.redoLen}`,
        );
      }
    };

    const record = (next: Observed): void => {
      observed = next;
      maxBytes = Math.max(maxBytes, next.bytes);
      deepest = Math.max(deepest, cursor);
    };

    const step = async (direction: 'undo' | 'redo', tag: string): Promise<void> => {
      const before = observed;
      const res = (await ctx.callAction('project', direction, [])) as {
        ok: boolean;
        error?: string;
        result?: { success?: boolean; error?: string };
      };
      if (!res.ok || res.result?.success === false) {
        note(`${tag} ${direction} -> FAILED`);
        fail(
          `${direction} at depth ${cursor} failed outright`,
          `  error: ${res.result?.error ?? res.error ?? 'unknown'}`,
        );
      }
      const next = await readObserved(ctx);
      cursor += direction === 'undo' ? -1 : 1;
      note(
        `${tag} ${direction} -> depth ${cursor} (undo ${before.undoLen}->${next.undoLen}, redo ${before.redoLen}->${next.redoLen})`,
      );
      assertStacks(`${direction} left the history stacks in an unexpected shape`, next);
      assertSnapshot(`${direction} did not restore the state recorded at depth ${cursor}`, next.json);
      record(next);
      ctx.metric(direction === 'undo' ? 'undos' : 'redos');
    };

    for (let iteration = 1; iteration <= iterations; iteration++) {
      const tag = `#${iteration}`;
      const top = snapshots.length - 1;
      const roll = ctx.rng();
      let move: 'mutate' | 'undo' | 'redo' =
        roll < P_MUTATE ? 'mutate' : roll < P_MUTATE + P_UNDO ? 'undo' : 'redo';
      if (move === 'redo' && cursor >= top) move = cursor > 0 ? 'undo' : 'mutate';
      if (move === 'undo' && cursor === 0) move = 'mutate';
      if (move === 'mutate' && cursor >= maxDepth) move = 'undo';

      if (move !== 'mutate') {
        await step(move, tag);
        continue;
      }

      const action = drawAction(ctx, observed.raw);
      const before = observed;
      const res = (await ctx.callAction('project', action.action, action.args)) as {
        ok: boolean;
        error?: string;
        result?: { success?: boolean; error?: string };
      };
      const accepted = res.ok && res.result?.success !== false;
      const next = await readObserved(ctx);
      const pushed = next.undoLen - before.undoLen;
      note(
        `${tag} ${action.label} -> ${accepted ? 'ok' : 'rejected'} ` +
          `(undo ${before.undoLen}->${next.undoLen}, redo ${before.redoLen}->${next.redoLen})`,
      );

      if (!accepted) {
        ctx.metric('rejected');
        ctx.metric(`rejected:${action.action}`);
        if (pushed !== 0 || next.redoLen !== before.redoLen) {
          fail(
            'a REJECTED command changed the history stacks',
            `  error: ${res.result?.error ?? res.error ?? 'unknown'}\n` +
              `  undo ${before.undoLen}->${next.undoLen}, redo ${before.redoLen}->${next.redoLen}`,
          );
        }
        assertSnapshot(
          `a REJECTED command (${action.action}) mutated the project: ` +
            `${res.result?.error ?? res.error ?? 'unknown'}`,
          next.json,
        );
        record(next);
        continue;
      }

      if (pushed === 1) {
        if (next.redoLen !== 0) {
          fail(
            'a successful command did not clear the redo stack',
            `  redo ${before.redoLen}->${next.redoLen} after ${action.label}`,
          );
        }
        snapshots.length = cursor + 1;
        snapshots.push(next.json);
        cursor += 1;
        record(next);
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
      if (next.undoLen >= historyLimit - 1) {
        fail(
          'the undo stack hit its history limit; FIFO trimming invalidates the model',
          `  undoLen=${next.undoLen} limit=${historyLimit}`,
        );
      }
      if (next.redoLen === 0) snapshots.length = cursor + 1;
      else if (next.redoLen !== before.redoLen) {
        fail(
          'a no-op command changed the redo stack without clearing it',
          `  redo ${before.redoLen}->${next.redoLen} after ${action.label}`,
        );
      }
      assertSnapshot(`a no-op command (${action.action}) changed the project state`, next.json);
      record(next);
    }

    // Full roundtrip: unwind every entry, then replay every entry, verifying
    // the recorded snapshot at each depth in both directions.
    const summit = snapshots.length - 1;
    while (cursor > 0) await step('undo', 'unwind');
    while (cursor < summit) await step('redo', 'rewind');

    if (cursor !== summit) fail(`roundtrip ended at depth ${cursor}, expected ${summit}`);

    ctx.setMetric('modelDepth', summit);
    ctx.setMetric('maxDepth', deepest);
    ctx.setMetric('snapshotBytesMax', maxBytes);
    ctx.setMetric('historyLimit', historyLimit);
    ctx.log(
      `seed=${ctx.seed}: ${ctx.metrics.mutations ?? 0} mutations, ${ctx.metrics.undos ?? 0} undos, ` +
        `${ctx.metrics.redos ?? 0} redos, ${ctx.metrics.rejected ?? 0} rejected, ` +
        `${ctx.metrics.noops ?? 0} no-ops; max depth ${deepest}; snapshot <=${maxBytes}B`,
    );
  },
};
