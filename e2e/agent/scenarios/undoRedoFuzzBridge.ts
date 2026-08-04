/**
 * The webview half of the undo-redo-fuzz oracle: the eval bodies that run a
 * step entirely in-page, and their typed request/response contract.
 *
 * ## Why
 *
 * The scenario used to do two WebDriver round trips per iteration - one to call
 * the store action, one to fetch `get_project_state` - and canonicalize the
 * whole payload in Node. That payload is ~60 KB on the fractal fixture and
 * ~277 KB on naharon, so the bridge, not the app, was the cost.
 *
 * Now one `executeAsync` per step: call the action, read the state and both
 * history stacks, canonicalize, compare against the model, and return a verdict
 * plus a ~20x smaller targeting digest. The full canonical strings cross the
 * bridge ONLY when they disagree, which is the rare path and is where Node's
 * tolerant diff and bug classification live.
 *
 * ## What did NOT change
 *
 * - The mutation and undo/redo still go through
 *   `window.__E2E_TEST__.projectStore.getState()[action](...args)`, exactly as
 *   `callStoreAction` did. That boundary is deliberate: going straight to IPC
 *   would leave the frontend store stale, and it is the boundary that surfaced
 *   the `updateSection`-cannot-clear-null and undo-fails-outright bugs.
 * - Args are still handed to WebDriver as script arguments, so the same JSON
 *   serialization applies (an absent key stays absent - the `ShotUpdates`
 *   double-option distinction survives by construction).
 * - The BEFORE stack lengths are supplied by Node from the previous step's
 *   response rather than re-read, which is exactly what the two-round-trip
 *   version compared against.
 * - The model bookkeeping (truncate on redo-clear, push on a new entry) applies
 *   the same rules in the same order; Node re-derives cursor/top independently
 *   and asserts the page agrees, so a divergence fails loudly instead of
 *   silently weakening the oracle.
 *
 * The authoritative snapshot array lives in ONE place - the page - and is
 * strictly read-only with respect to app state: the injected oracle only ever
 * calls `get_project_state` / `get_undo_stack` / `get_redo_stack`.
 */
import type { ScenarioContext } from './framework';
import { ORACLE_GLOBAL, oracleInjectionSource, type TargetingDigest } from '../lib/fuzzOracleCore';

/** What Node asks the page to do for one step. */
export interface StepRequest {
  kind: 'mutate' | 'undo' | 'redo';
  /** projectStore action name. */
  action: string;
  args: unknown[];
  /** Node's current undo depth. */
  cursor: number;
  /** Undo-stack length before this step (from the previous response). */
  undo0: number;
}

/** Everything Node needs to run its case analysis, and nothing else. */
export interface StepResponse {
  /** False when the action threw (the `callStoreAction` `ok:false` case). */
  actionOk: boolean;
  actionError: string | null;
  /** `CommandResult.success`, or null when the action returned no such field. */
  commandSuccess: boolean | null;
  commandError: string | null;
  undoLen: number;
  redoLen: number;
  /** Canonical snapshot length in bytes (the string never crosses the bridge). */
  bytes: number;
  /**
   * `recorded` - a new entry was pushed and its snapshot stored.
   * `equal` / `differ` - compared against the model at `comparedIndex`.
   * `unexpected` - the command pushed something other than 0 or 1 entries;
   *   the page changed nothing and Node fails.
   */
  verdict: 'recorded' | 'equal' | 'differ' | 'unexpected';
  /** Index the comparison used (-1 when nothing was compared). */
  comparedIndex: number;
  cursorAfter: number;
  /** `snapshots.length - 1` after the step. */
  top: number;
  digest: TargetingDigest;
}

/** The initial observation, taken before any action. */
export interface InitResponse {
  undoLen: number;
  redoLen: number;
  bytes: number;
  digest: TargetingDigest;
}

const ORACLE = `globalThis.${ORACLE_GLOBAL}`;

/** Shared preamble: resolve the oracle and the two app handles it reads through. */
const PREAMBLE = `
  const O = ${ORACLE};
  if (!O) throw new Error('fuzz oracle is not injected');
  const core = window.__TAURI__ && window.__TAURI__.core;
  if (!core || typeof core.invoke !== 'function') throw new Error('window.__TAURI__.core.invoke unavailable');
`;

/** Read state + both stack lengths, canonicalize, digest. Read-only. */
const OBSERVE = `
  const project = await core.invoke('get_project_state');
  if (project === null || project === undefined) {
    throw new Error('get_project_state returned null: the project closed mid-run');
  }
  const undoLen = (await core.invoke('get_undo_stack')).length;
  const redoLen = (await core.invoke('get_redo_stack')).length;
  const canonical = O.canonical(project);
  const digest = O.digest(project);
`;

/** Install the oracle (and reset its model) for this run. */
export async function injectOracle(ctx: ScenarioContext): Promise<void> {
  await ctx.eval<boolean>(`${oracleInjectionSource()}\nreturn true;`);
}

/** Record `snapshots[0]` and report the opening observation. */
export async function initModel(ctx: ScenarioContext): Promise<InitResponse> {
  return ctx.eval<InitResponse>(`
    ${PREAMBLE}
    ${OBSERVE}
    O.snapshots = [canonical];
    O.lastExpected = null;
    O.lastActual = null;
    O.mismatchIndex = -1;
    return { undoLen: undoLen, redoLen: redoLen, bytes: canonical.length, digest: digest };
  `);
}

/**
 * One fused step. The case analysis here MIRRORS the scenario's - Node
 * re-derives `cursorAfter`/`top` and asserts they match, so the two cannot
 * drift apart unnoticed.
 */
export async function runStep(ctx: ScenarioContext, request: StepRequest): Promise<StepResponse> {
  return ctx.eval<StepResponse>(
    `
    const req = args[0];
    ${PREAMBLE}
    const store = window.__E2E_TEST__ && window.__E2E_TEST__.projectStore;
    if (!store) throw new Error('window.__E2E_TEST__.projectStore unavailable');

    let actionOk = true;
    let actionError = null;
    let commandSuccess = null;
    let commandError = null;
    const action = store.getState()[req.action];
    if (typeof action !== 'function') {
      actionOk = false;
      actionError = 'action ' + req.action + ' is not a function';
    } else {
      try {
        const result = await Promise.resolve(action.apply(undefined, req.args));
        if (result && typeof result === 'object') {
          if ('success' in result) commandSuccess = !!result.success;
          if (result.error !== null && result.error !== undefined) commandError = String(result.error);
        }
      } catch (err) {
        actionOk = false;
        actionError = String(err);
      }
    }
    const accepted = actionOk && commandSuccess !== false;

    ${OBSERVE}

    let cursorAfter = req.cursor;
    let comparedIndex = -1;
    let verdict = null;
    if (req.kind === 'mutate') {
      const pushed = undoLen - req.undo0;
      if (!accepted) {
        comparedIndex = req.cursor;
      } else if (pushed === 1) {
        O.snapshots.length = req.cursor + 1;
        O.snapshots.push(canonical);
        cursorAfter = req.cursor + 1;
        verdict = 'recorded';
      } else if (pushed === 0) {
        // A no-op command may still have cleared the redo stack, which
        // truncates the model's forward branch BEFORE the comparison.
        if (redoLen === 0) O.snapshots.length = req.cursor + 1;
        comparedIndex = req.cursor;
      } else {
        verdict = 'unexpected';
      }
    } else {
      cursorAfter = req.cursor + (req.kind === 'undo' ? -1 : 1);
      comparedIndex = cursorAfter;
    }

    if (verdict === null) {
      const expected = O.snapshots[comparedIndex];
      verdict = expected === canonical ? 'equal' : 'differ';
      if (verdict === 'differ') {
        O.lastExpected = expected === undefined ? null : expected;
        O.lastActual = canonical;
        O.mismatchIndex = comparedIndex;
      }
    }

    return {
      actionOk: actionOk,
      actionError: actionError,
      commandSuccess: commandSuccess,
      commandError: commandError,
      undoLen: undoLen,
      redoLen: redoLen,
      bytes: canonical.length,
      verdict: verdict,
      comparedIndex: comparedIndex,
      cursorAfter: cursorAfter,
      top: O.snapshots.length - 1,
      digest: digest,
    };
  `,
    [request],
  );
}

/**
 * Fetch the mismatching pair. The ONLY place a full canonical string crosses
 * the bridge, and only after the page has already said they differ.
 */
export async function fetchMismatch(
  ctx: ScenarioContext,
): Promise<{ expected: string | null; actual: string | null; index: number }> {
  return ctx.eval(`
    const O = ${ORACLE};
    if (!O) throw new Error('fuzz oracle is not injected');
    return { expected: O.lastExpected, actual: O.lastActual, index: O.mismatchIndex };
  `);
}

/**
 * Accept the actual state as the model's expectation at `index`.
 * Only ever called for a mismatch that is ENTIRELY a classified known bug and
 * only under `STALAGMIGHT_FUZZ_ALLOW_KNOWN_BUGS=1`, so one open bug does not
 * cascade into every later comparison.
 */
export async function resyncModel(ctx: ScenarioContext, index: number): Promise<number> {
  return ctx.eval<number>(
    `
    const req = args[0];
    const O = ${ORACLE};
    if (!O) throw new Error('fuzz oracle is not injected');
    if (O.mismatchIndex !== req.index) {
      throw new Error('resync index ' + req.index + ' does not match the recorded mismatch ' + O.mismatchIndex);
    }
    if (O.lastActual === null) throw new Error('no recorded mismatch to resync from');
    O.snapshots[req.index] = O.lastActual;
    return O.snapshots.length - 1;
  `,
    [{ index }],
  );
}
