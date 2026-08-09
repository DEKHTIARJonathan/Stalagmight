import { useGasPlanStore } from '../store/gasPlanStore';
import { useProjectStore } from '../store/projectStore';
import {
  speleoProjectSessionStillCurrent,
  type SpeleoProjectSessionIdentity,
  useSpeleoStore,
} from '../store/speleoStore';
import { useUIStore } from '../store/uiStore';
import { runTreeReplacement } from './projectTransition';

/**
 * Reconcile every frontend store after the backend replaces the open survey tree in place.
 * Returns false when the request belongs to a project or login session that is no longer current.
 *
 * [#473] `treeReplaced` says whether the bytes on disk actually changed. Not every caller
 * of this seam replaces a tree: `discardChanges` calls it even when the backend returned
 * `null` (the lock was released and nothing was swapped), and the rest of the
 * reconciliation is harmless there. Re-reading the discarded-history flag is NOT
 * harmless, because it clears the user's dismissal - so on a plain lock release the
 * banner they dismissed came straight back.
 *
 * REQUIRED, deliberately, with no default. A `= false` default reads like the safe
 * choice and is the opposite: it is unreachable today (every call site passes the
 * argument), so its only possible effect is to let a FUTURE call site omit it and
 * silently skip the re-read - which is the silent history loss this issue exists to
 * prevent, reintroduced with no type error to catch it. Making it required turns that
 * omission into a compile error instead.
 */
export async function applySpeleoTreeReplacement(
  issuedFor: SpeleoProjectSessionIdentity | undefined,
  treeReplaced: boolean,
): Promise<boolean> {
  return runTreeReplacement(async () => {
    if (issuedFor && !speleoProjectSessionStillCurrent(issuedFor)) return false;

    const ui = useUIStore.getState();
    ui.clearSelection();
    ui.resetToolTransientsForProjectSwitch();
    ui.setDistanceGradientOrigin(null);
    useGasPlanStore.getState().reset();
    ui.setView('single');

    await useProjectStore.getState().refreshProjectState();
    if (issuedFor && !speleoProjectSessionStillCurrent(issuedFor)) return false;

    useProjectStore.setState({ isDirty: false });
    void useProjectStore.getState().checkProjectIntegrity();
    // [#473] Re-ask whether the SWAPPED tree could read its history.
    //
    // This seam is the reason the check belongs here rather than in the App effect that
    // normally drives it. That effect keys on `file_path` + `isLoading`, and an in-place
    // revision swap changes NEITHER: the backend closes and reopens DIFFERENT bytes at
    // the SAME path (`speleodb_revisions.rs`), and the frontend deliberately does not
    // call `loadProject` (it would short-circuit on the already-open project), so the
    // effect never re-fires. Without this a restored revision with an unreadable history
    // showed no banner at all, and restoring a clean revision left the previous tree's
    // banner standing over a healthy project.
    //
    // Both fields are reset in ONE synchronous write, before the async re-read. Clearing
    // only the dismissal would leave the PREVIOUS tree's `historyDiscarded` on screen
    // until the reply lands, which flashes a false data-loss banner over a healthy
    // project - the reply then corrects it, but the flash is the same wrong claim the
    // banner exists to avoid making.
    if (treeReplaced) {
      useProjectStore.setState({ historyDiscarded: false, historyDiscardedDismissed: false });
      void useProjectStore.getState().checkHistoryDiscarded();
    }
    await useSpeleoStore.getState().refreshLinkStatus();
    if (issuedFor && !speleoProjectSessionStillCurrent(issuedFor)) return false;
    useSpeleoStore.getState().invalidateChainTargets();
    return true;
  });
}
