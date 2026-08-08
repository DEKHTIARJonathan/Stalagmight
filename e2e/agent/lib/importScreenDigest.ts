/**
 * The import fuzzer's SCREEN ORACLE: one self-contained function that says what
 * the app is showing and what can be clicked on it.
 *
 * Same shape, and for the same reason, as `fuzzOracleCore.ts`: the function
 * below is dependency-free - no imports, no module-scope references, every
 * helper nested - so `importScreenInjectionSource()` can serialize it with
 * `Function.prototype.toString()` and the page evaluates literally the code Node
 * type-checks. `new Function` closes over nothing, so a stray outer reference
 * would surface as a ReferenceError on the first call rather than as a subtly
 * different oracle.
 *
 * ## Why a digest at all
 *
 * A UI fuzzer's step is "look, choose, click". The "look" half is ~40 DOM
 * queries plus a `get_project_state`; doing it as one WebDriver call per query
 * would make the bridge, not the app, the cost - the same argument
 * `undoRedoFuzzBridge.ts` makes for its fused step. So the whole observation is
 * one in-page pass returning a few hundred bytes.
 *
 * ## The testid inventory lives in TS, not in this string
 *
 * `spec.inventory` is passed IN (`scenarios/importDialogModel.ts` owns it), so
 * adding a control the generators can reach is a TypeScript edit with a unit
 * test behind it rather than a change to an injected string literal. An entry
 * ending in `*` is a PREFIX PATTERN: the digest expands it against the live DOM,
 * which is how dynamic ids (`section-checkbox-7`, `shot-editor-cell-3-length`)
 * become concrete targets a generator can draw from.
 *
 * ## Classification
 *
 * `live[testid]` is 0 = absent, 1 = present but not actionable (invisible,
 * `disabled`, or `aria-disabled`), 2 = actionable. The middle value is
 * load-bearing: it is what the `race-continue` generator aims at, and what the
 * WEDGE oracle counts.
 *
 * A NOTE ON VISIBILITY. `DialogWrapper` supports a `hidden` prop that sets
 * `display:none` on the OUTER container while leaving the subtree mounted, and
 * `DmpNewImportDialog` uses it whenever it re-opens to auto-start map placement.
 * So presence is not visibility, and every screen decision here is made on
 * visibility (a zero-area bounding rect, which a `display:none` ancestor
 * produces on every descendant).
 */

/** Screens the DMP import flow can be on. `importDialogModel.ts` re-exports it. */
export type ScreenId =
  | 'idle'
  | 'dmp-select'
  | 'zero-datum-select'
  | 'zero-datum-config'
  | 'wiz-init'
  | 'wiz-suggest'
  | 'wiz-no-suggest'
  | 'wiz-manual'
  | 'wiz-placing'
  | 'wiz-done'
  | 'wiz-error'
  /**
   * The wizard is up and NO phase marker is rendered.
   *
   * Not folded into `unknown` (which the scenario fails on), because the source
   * has a documented marker-less state: `phase === 'done'` with
   * `placedCount !== totalSelected` renders an empty centered container, and the
   * suggestion/placing transitions pass through the same gap. Failing on a
   * transient the app is entitled to render would be a fabricated bug. It is
   * still counted, and the progress-forcing rules in `importDialogModel.ts`
   * escape from it like any other screen, so a PERSISTENT one is caught.
   */
  | 'wiz-blank'
  | 'wiz-confirm'
  | 'map-placement'
  | 'new-project'
  | 'receipt'
  | 'blocked'
  | 'as-new-project'
  | 'orphan-placement'
  | 'error'
  /** A visible dialog this build's table does not name. The scenario FAILS. */
  | 'unknown';

/** What the receipt dialog is showing, read before it is dismissed. */
export interface ReceiptDigest {
  /** `import-receipt-summary` text - "N sections - M shots [- K loops]". */
  summary: string;
  /** Warnings rendered in the always-visible list. */
  shown: number;
  /** Warnings rendered in the expanded list (0 unless details are open). */
  more: number;
  /** Is the View-details toggle present (i.e. are there hidden warnings)? */
  hasDetails: boolean;
  /** Is `import-receipt-unit-conversion` rendered? */
  unitConversion: boolean;
}

export interface ImportScreenDigest {
  screen: ScreenId;
  /** `uiStore.activeDialog` verbatim. */
  dialog: string | null;
  /** `uiStore.placementMode !== null`. */
  placement: boolean;
  /** `uiStore.importContext`. */
  ctx: 'new-project' | 'existing-project' | null;
  /** `uiStore.dmpImportWizardPhase` (only ever suggesting/manual_placing/null). */
  phase: string | null;
  hasProject: boolean;
  /**
   * App.tsx's `isImportInProgress` useMemo, replicated. It is a component-local
   * value with no store field behind it, so the four clauses are mirrored here;
   * `importFlowOracles.ts`'s F2 is what asserts it comes back false.
   */
  importInProgress: boolean;
  /** testid -> 0 absent | 1 present-but-not-actionable | 2 actionable. */
  live: Record<string, 0 | 1 | 2>;
  /** select testid -> option values readable RIGHT NOW (see the header note). */
  opts: Record<string, string[]>;
  /** Rendered shot-table rows (the grid virtualizes, so this is the window). */
  rows: number;
  /** Visible row indices carrying a `shot-frozen-*` lock icon. */
  frozen: number[];
  /** The grid's active row (`data-active`), or null. */
  activeRow: number | null;
  /**
   * Visible row indices inside the grid's current selection.
   *
   * Load-bearing, not diagnostics: `handleDeleteShots` in the DMP wizard
   * REFUSES a selection made entirely of frozen rows (toast
   * `dmp-wizard-frozen-delete`, no rows removed), and the only way to assert
   * that expected refusal is to know what was selected before the delete.
   */
  selRows: number[];
  /** `data-toast-key` of every live toast - stable, unlike the i18n text. */
  toast: string[];
  /** First error text on screen (wizard error, error dialog, GPS error). */
  err: string | null;
  /** Is the React error boundary showing its fallback? */
  boundary: boolean;
  /** `checkProjectInvariants` on the live state; `[]` with no project open. */
  inv: string[];
  /** `get_undo_stack().length`, or -1 with no project open. */
  undo: number;
  /** Section / shot counts, or -1 with no project open. */
  sections: number;
  shots: number;
  /** Non-null only while the receipt dialog is up. */
  receipt: ReceiptDigest | null;
  /** Is a `DialogWrapper` discard-confirm overlay up? */
  dirty: boolean;
}

/** What the caller wants observed. Passed in so the lists live in TypeScript. */
export interface ImportScreenSpec {
  /** Concrete testids, plus `prefix*` patterns expanded against the DOM. */
  inventory: readonly string[];
  /** Selects whose currently-readable option values should be reported. */
  selects: readonly string[];
}

/** Global the injected copy installs itself under. */
export const IMPORT_SCREEN_GLOBAL = '__IMPORT_SCREEN__';

/**
 * SELF-CONTAINED. Keep it dependency-free - it is injected into the webview
 * verbatim (see the module header).
 */
export async function computeImportScreenDigest(
  spec: ImportScreenSpec,
): Promise<ImportScreenDigest> {
  const doc = document;
  const safe = (testid: string): boolean => !/["\\]/.test(testid);
  const one = (testid: string): Element | null =>
    safe(testid) ? doc.querySelector('[data-testid="' + testid + '"]') : null;
  const many = (testid: string): Element[] =>
    safe(testid) ? Array.prototype.slice.call(doc.querySelectorAll('[data-testid="' + testid + '"]')) : [];
  const byPrefix = (prefix: string): Element[] =>
    safe(prefix) ? Array.prototype.slice.call(doc.querySelectorAll('[data-testid^="' + prefix + '"]')) : [];

  const visible = (el: Element | null): boolean => {
    if (!el) return false;
    const node = el as HTMLElement;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const shown = (testid: string): boolean => visible(one(testid));
  const textOf = (testid: string): string | null => {
    const el = one(testid);
    return el ? (el.textContent || '').trim().slice(0, 300) : null;
  };

  // ---- stores -------------------------------------------------------------
  const testApi = (window as unknown as { __E2E_TEST__?: Record<string, { getState: () => Record<string, unknown> }> })
    .__E2E_TEST__;
  if (!testApi || !testApi.uiStore || !testApi.projectStore) {
    throw new Error('window.__E2E_TEST__ stores unavailable; start an E2E build');
  }
  const ui = testApi.uiStore.getState();
  const projectState = testApi.projectStore.getState();
  const dialog = (ui.activeDialog as string | null) ?? null;
  const dialogData = (ui.dialogData as Record<string, unknown>) || {};
  const placement = ui.placementMode !== null && ui.placementMode !== undefined;
  const hasProject = !!projectState.project;

  // App.tsx's `isImportInProgress`, clause for clause. It is a component-local
  // useMemo with no store field behind it, so there is nothing to read instead.
  const importInProgress =
    (dialog === 'dmp-selection' && !!dialogData.dmpFile) ||
    (dialog === 'dmp-import-new' && !!dialogData.dmpFile) ||
    ((dialog === 'gpx-selection' || dialog === 'gpx-placement') && !!dialogData.gpxFile) ||
    (dialog === 'new-project-for-import' &&
      !!(dialogData.dmpFile || dialogData.tmlFile || dialogData.gpxFile || dialogData.compassFile || dialogData.wallsFile));

  // ---- screen -------------------------------------------------------------
  // Priority order. `orphan-placement-dialog` is checked BEFORE the wizard
  // phases on purpose: OrphanPlacementDialog renders `wizard-suggestion`,
  // `merge-station-select`, `overlap-mode-select`, `toggle-alternatives` and
  // `alternative-N` too, so a phase lookup that did not first establish WHICH
  // dialog is up would classify it as the DMP wizard and drive the wrong
  // generators at it.
  const wizardUp = shown('dmp-new-import-dialog');
  let screen: string;
  if (shown('cancel-confirm-dialog') || shown('back-confirm-dialog')) screen = 'wiz-confirm';
  else if (shown('dmp-selection-dialog')) screen = 'dmp-select';
  else if (shown('zero-datum-selection-dialog')) screen = 'zero-datum-select';
  else if (shown('zero-datum-config-dialog')) screen = 'zero-datum-config';
  else if (shown('orphan-placement-dialog')) screen = 'orphan-placement';
  else if (wizardUp) {
    if (shown('wizard-importing-zero-datum') || shown('wizard-calculating') || shown('wizard-early-importing')) {
      screen = 'wiz-init';
    } else if (shown('wizard-suggestion')) screen = 'wiz-suggest';
    else if (shown('wizard-no-suggestions')) screen = 'wiz-no-suggest';
    else if (shown('wizard-manual-placing')) screen = 'wiz-manual';
    else if (shown('wizard-placing')) screen = 'wiz-placing';
    else if (shown('wizard-all-placed')) screen = 'wiz-done';
    else if (shown('wizard-error')) screen = 'wiz-error';
    else screen = 'wiz-blank';
  } else if (shown('new-project-for-import-dialog')) screen = 'new-project';
  else if (shown('import-receipt-dialog')) screen = 'receipt';
  else if (shown('import-blocked-dialog')) screen = 'blocked';
  else if (shown('import-as-new-project-dialog')) screen = 'as-new-project';
  else if (shown('error-dialog')) screen = 'error';
  else if (placement) screen = 'map-placement';
  else if (dialog === null) screen = 'idle';
  else screen = 'unknown';

  // A dialog whose root is mounted but not visible (the wizard's `hidden` prop)
  // must not read as `unknown` just because `activeDialog` is still set.
  if (screen === 'unknown' && placement) screen = 'map-placement';

  // ---- live inventory -----------------------------------------------------
  const live: Record<string, 0 | 1 | 2> = {};
  const classify = (el: Element | null): 0 | 1 | 2 => {
    if (!el) return 0;
    if (!visible(el)) return 1;
    const node = el as HTMLElement & { disabled?: boolean };
    const off =
      node.disabled === true ||
      node.hasAttribute('disabled') ||
      el.getAttribute('aria-disabled') === 'true';
    return off ? 1 : 2;
  };
  const PATTERN_CAP = 240;
  for (let i = 0; i < spec.inventory.length; i++) {
    const entry = spec.inventory[i] as string;
    if (entry.charAt(entry.length - 1) === '*') {
      const prefix = entry.slice(0, entry.length - 1);
      const found = byPrefix(prefix);
      for (let j = 0; j < found.length && j < PATTERN_CAP; j++) {
        const id = found[j].getAttribute('data-testid');
        // Reported as-is. A prefix can over-match slightly (`shot-editor-cell-`
        // also catches `shot-editor-cell-editor`), and that is wanted: every id
        // it catches is a real control, and the generators draw only from ids
        // the model's own patterns describe.
        if (id !== null && live[id] === undefined) live[id] = classify(found[j]);
      }
      continue;
    }
    live[entry] = classify(one(entry));
  }

  // ---- selects ------------------------------------------------------------
  const opts: Record<string, string[]> = {};
  for (let i = 0; i < spec.selects.length; i++) {
    const id = spec.selects[i] as string;
    const trigger = one(id);
    if (!trigger) continue;
    if (trigger.tagName.toLowerCase() === 'select') {
      const values: string[] = [];
      const options = trigger.querySelectorAll('option');
      for (let j = 0; j < options.length; j++) values.push((options[j] as HTMLOptionElement).value);
      opts[id] = values;
      continue;
    }
    // A custom `Select` portals its listbox to document.body and only mounts it
    // while open, so this reports values only for a select that is open right
    // now. Everything else is drawn blind and skipped-and-counted by the bridge
    // when the option turns out not to exist - which is the documented
    // impossible-move rule, not a gap.
    const portaled = byPrefix(id + '-option-');
    if (portaled.length === 0) continue;
    const values: string[] = [];
    for (let j = 0; j < portaled.length && j < PATTERN_CAP; j++) {
      const value = portaled[j].getAttribute('data-value');
      if (value !== null) values.push(value);
    }
    opts[id] = values;
  }

  // ---- grid ---------------------------------------------------------------
  const rowNodes = byPrefix('shot-editor-row-');
  const frozen: number[] = [];
  const frozenNodes = byPrefix('shot-frozen-');
  for (let i = 0; i < frozenNodes.length; i++) {
    const id = frozenNodes[i].getAttribute('data-testid') || '';
    const index = Number(id.slice('shot-frozen-'.length));
    if (Number.isInteger(index) && index >= 0) frozen.push(index);
  }
  frozen.sort((a, b) => a - b);

  const rowIndexOf = (el: Element, prefix: string): number => {
    const id = el.getAttribute('data-testid') || '';
    const rest = id.slice(prefix.length);
    const cut = rest.indexOf('-');
    const index = Number(cut >= 0 ? rest.slice(0, cut) : rest);
    return Number.isInteger(index) && index >= 0 ? index : -1;
  };
  let activeRow: number | null = null;
  for (let i = 0; i < rowNodes.length; i++) {
    if (rowNodes[i].getAttribute('data-active') === 'true') {
      const index = rowIndexOf(rowNodes[i], 'shot-editor-row-');
      if (index >= 0) activeRow = index;
    }
  }
  const selected: Record<string, true> = {};
  const cellNodes = byPrefix('shot-editor-cell-');
  for (let i = 0; i < cellNodes.length; i++) {
    if (cellNodes[i].getAttribute('data-in-selection') !== 'true') continue;
    const index = rowIndexOf(cellNodes[i], 'shot-editor-cell-');
    if (index >= 0) selected[String(index)] = true;
  }
  const selRows = Object.keys(selected)
    .map((key) => Number(key))
    .sort((a, b) => a - b);

  // ---- toasts / errors ----------------------------------------------------
  const toast: string[] = [];
  const toastNodes = many('toast');
  for (let i = 0; i < toastNodes.length; i++) {
    toast.push(toastNodes[i].getAttribute('data-toast-key') || '(unkeyed)');
  }
  const err = textOf('wizard-error') ?? textOf('error-dialog') ?? textOf('zero-datum-gps-error');

  // ---- receipt ------------------------------------------------------------
  let receipt: ReceiptDigest | null = null;
  if (screen === 'receipt') {
    const listItems = (testid: string): number => {
      const list = one(testid);
      return list ? list.querySelectorAll('li').length : 0;
    };
    receipt = {
      summary: textOf('import-receipt-summary') ?? '',
      shown: listItems('import-receipt-warnings'),
      more: listItems('import-receipt-warnings-more'),
      hasDetails: !!one('import-receipt-details'),
      unitConversion: !!one('import-receipt-unit-conversion'),
    };
  }

  // ---- project state ------------------------------------------------------
  let inv: string[] = [];
  let undo = -1;
  let sections = -1;
  let shots = -1;
  if (hasProject) {
    const core = (window as unknown as { __TAURI__?: { core?: { invoke?: (c: string) => Promise<unknown> } } }).__TAURI__
      ?.core;
    if (!core || typeof core.invoke !== 'function') throw new Error('window.__TAURI__.core.invoke unavailable');
    const state = (await core.invoke('get_project_state')) as
      | { project?: { sections?: { shots?: unknown[] }[] } }
      | null;
    if (state) {
      const oracle = (globalThis as unknown as { __FUZZ_ORACLE__?: { invariants?: (s: unknown) => string[] } })
        .__FUZZ_ORACLE__;
      if (!oracle || typeof oracle.invariants !== 'function') {
        throw new Error('the fuzz oracle is not injected; inject it before the screen digest');
      }
      inv = oracle.invariants(state);
      const list = state.project && Array.isArray(state.project.sections) ? state.project.sections : [];
      sections = list.length;
      shots = 0;
      for (let i = 0; i < list.length; i++) {
        const own = list[i] && Array.isArray(list[i].shots) ? (list[i].shots as unknown[]).length : 0;
        shots += own;
      }
      undo = ((await core.invoke('get_undo_stack')) as unknown[]).length;
    }
  }

  return {
    screen: screen as ScreenId,
    dialog,
    placement,
    ctx: (ui.importContext as 'new-project' | 'existing-project' | null) ?? null,
    phase: (ui.dmpImportWizardPhase as string | null) ?? null,
    hasProject,
    importInProgress,
    live,
    opts,
    rows: rowNodes.length,
    frozen,
    activeRow,
    selRows,
    toast,
    err,
    boundary: !!one('error-boundary-fallback'),
    inv,
    undo,
    sections,
    shots,
    receipt,
    dirty: byPrefix('dirty-dialog-').length > 0,
  };
}

/**
 * The injectable source of exactly the function above, installed under
 * `globalThis.__IMPORT_SCREEN__`.
 *
 * The `async function` prefix check is the same guard `oracleInjectionSource`
 * applies: a toolchain that renamed or wrapped the declaration would otherwise
 * inject something subtly different from what Node type-checked, which is the
 * one thing this design must never do.
 */
export function importScreenInjectionSource(): string {
  const source = computeImportScreenDigest.toString();
  if (!source.startsWith('async function computeImportScreenDigest(')) {
    throw new Error(
      `the screen digest is not a plain async function declaration; refusing to inject: ${source.slice(0, 80)}`,
    );
  }
  return [
    '(function () {',
    source,
    `globalThis.${IMPORT_SCREEN_GLOBAL} = { digest: computeImportScreenDigest };`,
    '})();',
  ].join('\n');
}
