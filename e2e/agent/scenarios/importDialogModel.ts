/**
 * The import fuzzer's MODEL of the DMP import flow: what screens exist, what
 * controls each one has, how to get OFF each one, and when the walk has to stop
 * exploring and start leaving.
 *
 * Nothing here talks to the app. It is the part a reader can check against
 * `src/components/Dialogs/` by eye, and the part `lib/importDialogActions.test.ts`
 * pins against the bridge's allowlists.
 *
 * ## Progress forcing, and why it is not a timeout
 *
 * A random walk over a wizard does not terminate on its own: `toggle-alternatives`
 * and `section-name-input` are always there, always legal, and never advance
 * anything. Left alone, a flow spends its whole step budget on one screen and
 * the run reports coverage it never had.
 *
 * So each screen names the ONE move that advances it and the sequence that
 * abandons the flow from it. After `FORCE_ADVANCE_AT` steps on the same screen
 * the walk stops drawing and plays the advancing move; after `FORCE_ESCAPE_AT`
 * it plays the escape. That keeps the budget spent on flows rather than on one
 * screen, and it makes "stuck" mean something precise:
 *
 *   ESCAPE oracle - an escape that has not reached `idle` with no placement
 *   within `ESCAPE_BUDGET` forced steps is a WEDGE, and the scenario throws.
 *   A user who cannot leave a dialog has no other recourse, so neither does this.
 *
 *   WEDGE oracle - a non-idle screen with ZERO actionable testids in the whole
 *   inventory is a dead end by construction, and the scenario throws on the spot
 *   rather than spending the escape budget proving it.
 *
 * Both are absolute. There is no tolerance and no known-bug list: if either
 * fires, either the app wedged or this model is wrong about the screen, and both
 * are worth stopping for.
 */
import type { ScreenId } from '../lib/importScreenDigest';

export type { ScreenId };

/** Screens on which the walk is inside a flow (i.e. a flow is in progress). */
export const IN_FLOW_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>([
  'dmp-select',
  'zero-datum-select',
  'zero-datum-config',
  'wiz-init',
  'wiz-suggest',
  'wiz-no-suggest',
  'wiz-manual',
  'wiz-placing',
  'wiz-done',
  'wiz-error',
  'wiz-blank',
  'wiz-confirm',
  'map-placement',
  'new-project',
  'receipt',
  'blocked',
  'as-new-project',
  'orphan-placement',
  'error',
  'first-run',
]);

/**
 * Every testid the generators may target, plus the prefix patterns the digest
 * expands against the live DOM.
 *
 * Verified against the components, one by one - `DmpSelectionDialog.tsx`,
 * `ZeroDatumSelectionDialog.tsx`, `ZeroDatumConfigDialog.tsx`,
 * `DmpNewImportDialog.tsx` (+ `WizardScrollBody`/`WizardMapPanel`),
 * `NewProjectForImportDialog.tsx`, `ImportReceiptDialog.tsx`,
 * `ImportBlockedDialog.tsx`, `ImportAsNewProjectDialog.tsx`,
 * `OrphanPlacementDialog.tsx`, `ErrorDialog.tsx`, `SectionMetadataForm.tsx`,
 * `ShotTableEditor.tsx` + `SpreadsheetGrid/` and `Toolbar.tsx`/`GlobalView.tsx`.
 * A testid that is not in a component is a control the fuzzer silently never
 * reaches, which is the failure mode this list exists to prevent.
 */
export const TESTID_INVENTORY: readonly string[] = [
  // --- entry points ---------------------------------------------------------
  'toolbar-import-button',
  'global-open-import-button',
  // --- first-run modal (rendered OUTSIDE activeDialog; covers everything) ----
  'telemetry-opt-in-dialog',
  'telemetry-opt-in-no',
  // --- dmp-select -----------------------------------------------------------
  'dmp-selection-dialog',
  'select-all-button',
  'select-none-button',
  'invert-selection-button',
  'default-surveyor-input',
  'default-date-input',
  'continue-button',
  'cancel-button',
  'section-checkbox-*',
  // --- zero-datum-select ----------------------------------------------------
  'zero-datum-selection-dialog',
  'zero-datum-selection-cancel',
  'zero-datum-selection-back',
  'zero-datum-selection-skip',
  'zero-datum-section-card-*',
  // --- zero-datum-config ----------------------------------------------------
  'zero-datum-config-dialog',
  'zero-datum-station-select',
  'zero-datum-gps-input',
  'zero-datum-config-cancel',
  'zero-datum-config-back',
  'zero-datum-config-confirm',
  // --- wizard ---------------------------------------------------------------
  'dmp-new-import-dialog',
  'back-button',
  'skip-button',
  'confirm-button',
  'retry-button',
  'segment-skip-button',
  'segment-place-button',
  'segment-place-on-map-button',
  'toggle-alternatives',
  'alternative-*',
  'merge-station-select',
  'overlap-mode-select',
  'segment-mode-suggestion-input',
  'segment-mode-from-existing-input',
  'segment-mode-manual-input',
  'segment-mode-discard-input',
  'from-existing-import-section-select',
  'from-existing-import-station-select',
  'from-existing-section-select',
  'from-existing-station-select',
  'manual-import-section-select',
  'manual-import-station-select',
  // --- wizard confirm overlays ---------------------------------------------
  'cancel-confirm-dialog',
  'cancel-confirm-continue',
  'confirm-cancel-button',
  'back-confirm-dialog',
  'back-confirm-continue',
  'confirm-back-button',
  // --- shared section metadata (all three editing screens) ------------------
  'section-name-input',
  'section-surveyor-input',
  'section-date-input',
  'section-quality-input',
  'section-reverse-checkbox',
  'section-direction-select',
  'section-color-hex-input',
  // --- shot table -----------------------------------------------------------
  'shot-table-container',
  'shot-editor-expand',
  'shot-editor-cell-editor',
  'shot-editor-row-*',
  'shot-editor-gutter-*',
  'shot-editor-cell-*',
  'shot-frozen-*',
  'shot-editor-context-menu',
  'shot-editor-context-insert-above',
  'shot-editor-context-insert-below',
  'shot-editor-context-delete-rows',
  'shot-editor-context-clear',
  'shot-editor-context-fill-down',
  'shot-editor-context-copy',
  'shot-editor-context-paste',
  // --- new project for import ----------------------------------------------
  'new-project-for-import-dialog',
  'project-name-input',
  'project-save-path-input',
  'project-location-input',
  'new-project-for-import-cancel',
  'create-and-continue-button',
  // --- receipt / blocked / as-new-project / error ---------------------------
  'import-receipt-dialog',
  'import-receipt-details',
  'import-receipt-continue',
  'import-blocked-dialog',
  'import-blocked-stay',
  'import-blocked-switch',
  'import-as-new-project-dialog',
  'import-as-new-project-cancel',
  'import-as-new-project-confirm',
  'error-dialog',
  'error-dialog-close',
  // --- orphan placement (raised AFTER a DMP import commits) -----------------
  'orphan-placement-dialog',
  'orphan-accept',
  'orphan-skip',
  'orphan-accept-all',
  'orphan-close',
  // --- dirty-discard overlay ------------------------------------------------
  'dirty-dialog-keep-editing',
  'dirty-dialog-discard',
];

/** Selects whose option values the digest should report when it can read them. */
export const SELECT_TESTIDS: readonly string[] = [
  'zero-datum-station-select',
  'merge-station-select',
  'overlap-mode-select',
  'section-direction-select',
  'from-existing-import-section-select',
  'from-existing-import-station-select',
  'from-existing-section-select',
  'from-existing-station-select',
  'manual-import-section-select',
  'manual-import-station-select',
];

/** `overlap-mode-select`'s option values are static (see DmpNewImportDialog). */
export const OVERLAP_MODES: readonly string[] = ['interpolate', 'import_data', 'existing_data', 'keep_both'];

/** The one move that makes a screen progress when the walk has stalled on it. */
export const ADVANCE_MOVE: Readonly<Partial<Record<ScreenId, string>>> = {
  'dmp-select': 'continue-button',
  'zero-datum-select': 'zero-datum-selection-skip',
  'zero-datum-config': 'zero-datum-config-confirm',
  'wiz-suggest': 'confirm-button',
  'wiz-no-suggest': 'cancel-button',
  'wiz-manual': 'segment-place-button',
  'wiz-done': 'cancel-button',
  'wiz-error': 'retry-button',
  'wiz-confirm': 'cancel-confirm-continue',
  'new-project': 'create-and-continue-button',
  receipt: 'import-receipt-continue',
  blocked: 'import-blocked-stay',
  'as-new-project': 'import-as-new-project-cancel',
  'orphan-placement': 'orphan-close',
  error: 'error-dialog-close',
  'first-run': 'telemetry-opt-in-no',
};

/**
 * How to abandon the flow from each screen, in order. The bridge plays the first
 * entry that is ACTIONABLE and skips the rest; `Escape` is spelled as the
 * pseudo-testid `key:Escape`.
 *
 * `wiz-confirm` deliberately escapes by CONFIRMING the cancel
 * (`confirm-cancel-button`), not by continuing: the walk only reaches that
 * overlay on its way out, so continuing would put it straight back in the flow
 * it is trying to leave and burn the whole escape budget on a loop.
 */
export const ESCAPE_PATH: Readonly<Record<ScreenId, readonly string[]>> = {
  idle: [],
  'dmp-select': ['dirty-dialog-discard', 'cancel-button', 'key:Escape'],
  'zero-datum-select': ['zero-datum-selection-cancel', 'key:Escape'],
  'zero-datum-config': ['zero-datum-config-cancel', 'key:Escape'],
  'wiz-init': ['cancel-button', 'key:Escape'],
  'wiz-suggest': ['cancel-button', 'key:Escape'],
  'wiz-no-suggest': ['cancel-button', 'key:Escape'],
  'wiz-manual': ['cancel-button', 'key:Escape'],
  'wiz-placing': ['cancel-button', 'key:Escape'],
  'wiz-done': ['cancel-button', 'key:Escape'],
  'wiz-error': ['cancel-button', 'key:Escape'],
  'wiz-blank': ['cancel-button', 'key:Escape'],
  'wiz-confirm': ['confirm-cancel-button', 'confirm-back-button', 'key:Escape'],
  'map-placement': ['key:Escape'],
  'new-project': ['dirty-dialog-discard', 'new-project-for-import-cancel', 'key:Escape'],
  receipt: ['import-receipt-continue', 'key:Escape'],
  blocked: ['import-blocked-stay', 'key:Escape'],
  'as-new-project': ['import-as-new-project-cancel', 'key:Escape'],
  'orphan-placement': ['orphan-close', 'key:Escape'],
  error: ['error-dialog-close', 'key:Escape'],
  'first-run': ['telemetry-opt-in-no'],
  unknown: ['key:Escape'],
};

/**
 * Screens whose affordances are NOT testids, and which the WEDGE oracle
 * therefore cannot judge.
 *
 * `map-placement` is driven by clicking the MAP and by Escape; the wizard behind
 * it is `display:none` (DialogWrapper's `hidden` prop) while a placement is
 * running, so every testid in the inventory is legitimately non-actionable. A
 * wedge oracle that counted that as a dead end would fire on the app working
 * exactly as designed. A placement that genuinely cannot be left is still caught
 * - by the ESCAPE oracle, which requires Escape to reach `idle` inside its
 * budget.
 */
export const WEDGE_EXEMPT_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>(['map-placement']);

/** Steps on one screen before the walk plays that screen's advancing move. */
export const FORCE_ADVANCE_AT = 8;
/** Steps on one screen before the walk gives up and abandons the flow. */
export const FORCE_ESCAPE_AT = 16;
/** Forced steps an escape gets to reach `idle`. Exceeding it is a FAILURE. */
export const ESCAPE_BUDGET = 6;

/** What the walk should do next, given how long it has sat on one screen. */
export type ProgressMode = 'draw' | 'advance' | 'escape';

export function progressMode(stepsOnScreen: number): ProgressMode {
  if (stepsOnScreen >= FORCE_ESCAPE_AT) return 'escape';
  if (stepsOnScreen >= FORCE_ADVANCE_AT) return 'advance';
  return 'draw';
}

/** Has the escape landed? `idle` with nothing on the map is the only answer. */
export function isEscaped(screen: ScreenId, placement: boolean): boolean {
  return screen === 'idle' && !placement;
}
