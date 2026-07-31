import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';
import { useSpeleoStore } from '../store/speleoStore';
import { useGasPlanStore } from '../store/gasPlanStore';
import { invokeIpc } from '../utils/ipc';
import type { SpeleoOpenResult } from '../types/ipc.generated';

export interface RestoreRevisionArgs {
  projectId: string;
  projectName: string;
  /** Full commit SHA to check out. */
  hexsha: string;
  /** Short SHA for the toast copy. */
  shortSha: string;
  /**
   * `true` = editable **Restore** (the user holds the lock; the tree becomes a
   * pushable unpushed edit). `false` = read-only **View** (a peek that Update
   * fast-forwards away).
   */
  restore: boolean;
  /**
   * Waive the backend's un-pushed-edits guard. Only ever `true` for a **Restore**
   * the user has confirmed a SECOND time, having been told which local changes it
   * discards (see `SpeleoRestoreDialog`'s armed step). A View never sets it - a
   * read-only peek must stay non-destructive.
   */
  discardLocal?: boolean;
  /**
   * Suppress the final toast. Set by the revert flow (`useRevertRevision`), where
   * this restore is a MIDDLE step: "Restored to revision X. Push to make it the
   * latest." misdirects when the same flow is about to push and release for you.
   * Everything else about the call is unchanged.
   */
  quiet?: boolean;
  /**
   * [#258] The dump entry the user picked, when this call is a retry from the
   * ambiguity picker. Absent on a first attempt, which is what makes the backend
   * classify normally.
   */
  entryPath?: string;
  /**
   * [#303] The "Unwind to previous SpeleoDB version" flavour: KEEP the downloaded
   * copy's undo history instead of dropping it, because that history is what the
   * action came for. Only the Unwind sets it, and the backend enforces its extra
   * preconditions (an empty undo stack, and any dirt being a previous Unwind's own
   * doing) rather than trusting this flag.
   */
  keepUndoHistory?: boolean;
  /**
   * [#303] The user was shown, and accepted, that this Unwind throws away un-pushed work -
   * the copy is dirty with no Unwind chain pointer to account for it, so the swap replaces
   * edits that were never pushed (typically ones the user undid, now on the redo stack).
   *
   * An acknowledgement, not a decision: the backend re-derives the same predicate that put
   * `discards_unpushed` on the unwind target, and without this flag it refuses exactly as
   * before. Only `SpeleoUnwindDialog` sets it, and only when it actually rendered the
   * warning.
   */
  discardUnpushed?: boolean;
  /**
   * [#303] This chain step walks FORWARD (toward BASE) rather than back. It selects which
   * stack the backend requires empty before the swap: going back, the undo stack, so the
   * tree sits at the parent's state; going forward, the redo stack, so every operation of
   * the commit being sat on has been re-applied and the child's history stacks on cleanly.
   * Only meaningful alongside `keepUndoHistory`, and clamped to it below.
   */
  chainForward?: boolean;
}

/**
 * Shared "check a SpeleoDB revision out into the working copy" flow (#218), used by
 * both the read-only View action and the editable Restore confirm.
 *
 * [#258] Deliberately KNOWS NOTHING about the ambiguous-dump picker. It only carries
 * `entryPath` and rethrows the typed rejection; each caller raises the picker itself,
 * because each owns a different retry. The revert composite in particular has already
 * handed the write lock back by the time it can ask, so its retry has to re-run the
 * whole thing rather than this one step - a picker raised from here offered a button
 * that the backend's edit gate would refuse. The backend
 * reopens the swapped tree in place, so this pulls it into the view via
 * `refreshProjectState` + `refreshLinkStatus` (loadProject would short-circuit on the
 * already-open project) and toasts. Throws on failure so the caller surfaces it.
 */
export function useRestoreRevision() {
  const { t } = useTranslation();
  const showToast = useUIStore((s) => s.showToast);
  const setView = useUIStore((s) => s.setView);
  const clearSelection = useUIStore((s) => s.clearSelection);
  const refreshProjectState = useProjectStore((s) => s.refreshProjectState);
  const refreshLinkStatus = useSpeleoStore((s) => s.refreshLinkStatus);

  return useCallback(
    async ({
      projectId,
      projectName,
      hexsha,
      shortSha,
      restore,
      discardLocal = false,
      quiet = false,
      entryPath,
      keepUndoHistory = false,
      discardUnpushed = false,
      chainForward = false,
    }: RestoreRevisionArgs) => {
      // The backend hardcodes concurrent_session:false for an in-place revision swap
      // (the open project is unchanged), so unlike the open/adopt flow there is no
      // concurrent-session notice to surface here.
      await invokeIpc<SpeleoOpenResult>('speleodb_restore_revision', {
        projectId,
        projectName,
        hexsha,
        restore,
        // Never waived for a View, whatever the caller passed.
        discardLocal: restore && discardLocal,
        entryPath: entryPath ?? null,
        // [#303] Likewise only meaningful for a Restore: a View leaves the project
        // read-only, so there would be nothing to undo with the history it kept.
        keepUndoHistory: restore && keepUndoHistory,
        // ...and the acknowledgement only means anything alongside that history-keeping
        // Restore, which is the only shape the backend consults it for.
        discardUnpushed: restore && keepUndoHistory && discardUnpushed,
        // ...and likewise the direction, which only selects a guard that a
        // history-keeping Restore is the one caller to reach.
        chainForward: restore && keepUndoHistory && chainForward,
      });
      // The backend closed + reopened the project at the swapped tree; pull the new
      // geometry + link state in. The on-disk copy IS the checked-out tree (saved),
      // so it is clean until the user edits. Clear the selection first: it is keyed by
      // (section_id, station_index) which the swapped tree may not carry, so a stale
      // selection could highlight a different station (loadProject's full path clears
      // it too; this swap path bypasses that path).
      clearSelection();
      // ...and every OTHER per-project ref with it. `clearSelection` was the whole
      // reset here, but merge endpoints, the comment target and the measure endpoints
      // are keyed the same `(section_id, station_index)` / `(section_id, shot_id)` way
      // and live in the same store. A project switch resets all of them through
      // `loadProject`; this swap replaces the tree just as thoroughly and bypasses
      // `loadProject` entirely, so it was the one replacement path that kept them.
      //
      // #258 is what makes that dangerous rather than untidy. Two `.stalx` under one
      // SpeleoDB project are independent SQLite databases with independently assigned
      // section ids, so a picker answer can now swap in a DIFFERENT survey whose ids
      // collide by construction - and a half-armed merge would then resolve its stored
      // endpoint against whatever holds that id in the new tree.
      useUIStore.getState().resetToolTransientsForProjectSwitch();
      // [#345] The gas-plan store is per-survey runtime state - pins, the loaded-plan
      // baseline, and (since #317) their captured anchors - and has exactly ONE
      // production caller of `reset()`: `applyDisplaySettings`, reached only via
      // `loadProject`/`createProject`. This swap bypasses that path entirely, same as
      // the tool transients above, so without this call a live plan's positional pins
      // would silently rename themselves onto whatever stations the swapped-in tree
      // happens to have at those indices - and #258 means that tree can be a genuinely
      // DIFFERENT survey whose section ids collide with the old one by construction.
      // The anchor-capture staleness guard only compares pin VALUES, not project
      // identity (see the guard's own comment in gasPlanStore.ts), so this load path
      // is the one thing that defeats it. Not routed through `applyDisplaySettings`
      // itself: that function also forces `appMode` back to survey, resets display
      // toggles (geometryMode, showDevStats, showIssueSeverity, the Plan/Export
      // snapshots) and expects a `DisplaySettings` payload this flow never fetches -
      // all display-preference behaviour this swap has no business touching.
      useGasPlanStore.getState().reset();
      setView('single');
      await refreshProjectState();
      useProjectStore.setState({ isDirty: false });
      // The swapped-in revision can carry a different structural-integrity profile than
      // the tree that was on screen; re-scan so the banner reflects the checked-out
      // tree instead of the pre-swap one (fire-and-forget, identity-guarded).
      void useProjectStore.getState().checkProjectIntegrity();
      await refreshLinkStatus();
      if (!quiet) {
        showToast(
          restore
            ? t('speleodb.restore.doneToast', { sha: shortSha })
            : t('speleodb.restore.viewToast', { sha: shortSha }),
          'speleodb-restore',
          // A completed restore rewrote the tree; "now viewing revision X" is just
          // a statement of where you are.
          restore ? 'success' : 'info',
        );
      }
    },
    [
      t,
      showToast,
      setView,
      clearSelection,
      refreshProjectState,
      refreshLinkStatus,
    ],
  );
}
