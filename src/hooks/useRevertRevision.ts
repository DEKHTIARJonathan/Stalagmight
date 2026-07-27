import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../store/uiStore';
import { useSpeleoStore, asDoneKind } from '../store/speleoStore';
import { useSpeleoActions } from './useSpeleoActions';
import { useRestoreRevision } from './useRestoreRevision';
import { humanizeSpeleoError, unpushedLocalEdits } from '../utils/speleoError';

export interface RevertRevisionArgs {
  projectId: string;
  projectName: string;
  /** Full commit SHA to revert to. */
  hexsha: string;
  /** Short SHA for the copy. */
  shortSha: string;
  /** Commit message for the push that publishes the revert; `null` lets the server pick. */
  message: string | null;
  /**
   * Waive the backend's un-pushed-edits guard. Only ever `true` for the dialog's
   * armed second press, after the user has been told which local work it replaces.
   */
  discardLocal?: boolean;
  /**
   * Resume a revert whose restore already landed: re-issue ONLY the upload +
   * release, against the working copy this flow already swapped in and the write
   * lock it is still holding.
   *
   * Valid in exactly the two outcomes that leave things standing that way -
   * `push_failed` and `push_unconfirmed` - which both keep the lock AND the dirty
   * bit precisely so a retry can recover (`DoneResult::PushUnconfirmed` says so in
   * as many words). Re-running the whole composite from either is wrong twice
   * over. It re-downloads the revision and swaps the tree in again under the
   * discard policy, resetting undo/redo and dropping anything edited since. And
   * where the upload actually LANDED but the local record of it did not (a 200
   * whose body did not parse), it re-enters Start editing's reconcile, which has
   * no authorship recovery: our own just-landed commit reads as a divergence, so
   * the lock is released and the user is asked to resolve a conflict against
   * themselves, with a discard as the loudest way out. The push path classifies
   * that same commit as ours and finishes cleanly, so the retry has to stay on it.
   *
   * Skips the pre-flight un-pushed-edits guard by construction: the restore is
   * what SET that bit, so the guard would refuse the retry over the revert's own
   * tree.
   */
  resumeAtPush?: boolean;
  /** Progress callback, so a three-round-trip operation is legible while it runs. */
  onStep?: (step: 'locking' | 'restoring' | 'pushing') => void;
}

/**
 * What the publish tail needs - a subset of {@link RevertRevisionArgs}. `onStep` is
 * spelled out rather than `Pick`ed because `exactOptionalPropertyTypes` stops a
 * picked optional accepting an EXPLICIT `undefined`, which is exactly what a caller
 * forwarding its own optional callback passes.
 */
type PublishArgs = Pick<RevertRevisionArgs, 'message' | 'shortSha'> & {
  onStep?: RevertRevisionArgs['onStep'];
};

/**
 * What the revert ended up doing, so the dialog can say it exactly. `lockHeld`
 * answers the question the user actually has after a failure - "am I now holding a
 * lock I did not have?" - which the generic error text cannot.
 */
export type RevertOutcome =
  | { kind: 'reverted' }
  | { kind: 'needs_discard'; lockHeld: boolean }
  | { kind: 'diverged' }
  | { kind: 'locked_by'; email: string | null }
  | { kind: 'lock_failed' }
  | { kind: 'restore_failed'; message: string; lockHeld: boolean }
  | { kind: 'push_failed' }
  /** The edit gate dropped mid-flight (usually a 401 auto-drop): nothing uploaded,
      nothing released, and - unlike `push_failed` - no lock held to retry with. */
  | { kind: 'not_editing' }
  | { kind: 'push_unconfirmed' };

/**
 * Revert a SpeleoDB revision from a READ-ONLY project: take the write lock, check
 * the revision out, upload it as a new revision, and release the lock again -
 * ending read-only exactly as it started.
 *
 * There is no backend verb for this and there should not be: `speleodb_restore_revision`
 * with `restore: true` refuses unless the edit gate is open, which is what stops a
 * revert quietly skipping the acquire. So this composes the three existing verbs and
 * owns the unwinding when a middle step fails - the part a caller would otherwise get
 * wrong, because "release what we took" is only correct while the copy is clean.
 *
 * It also owns RESUMING (`resumeAtPush`), for the same reason: once the restore has
 * landed, the only correct retry is the upload on its own, and the caller that most
 * wants to retry is the one holding the least context about why.
 */
export function useRevertRevision() {
  const { t } = useTranslation();
  const showToast = useUIStore((s) => s.showToast);
  const { startEditing, done } = useSpeleoActions();
  const restoreRevision = useRestoreRevision();

  // The tail of the revert - upload the restored tree, release the lock, and say
  // what came back. Split out so the `resumeAtPush` retry enters HERE instead of at
  // the top, and so the done-result -> RevertOutcome mapping stays in ONE place: a
  // second copy of it (in the dialog, say) would be free to drift from this one.
  const publish = useCallback(
    async ({ message, shortSha, onStep }: PublishArgs): Promise<RevertOutcome> => {
      onStep?.('pushing');
      const result = await done(message);
      // A thrown call returns null; `useSpeleoActions.done` has already toasted it and
      // raised the #260 push-failure banner, whose Retry re-issues the upload. Never
      // auto-release from here: that would leave the reverted tree sitting as un-pushed
      // edits with no lock over them.
      if (result === null) return { kind: 'push_failed' };
      const kind = asDoneKind(result.kind);
      if (kind === 'released') {
        showToast(t('speleodb.revert.done', { sha: shortSha }), 'speleodb-revert', 'success');
        return { kind: 'reverted' };
      }
      if (kind === 'push_unconfirmed') return { kind: 'push_unconfirmed' };
      if (kind === 'divergence_needed') return { kind: 'diverged' };
      // `not_editing`: the edit gate dropped under us mid-flight (a 401 auto-drop is
      // the usual way in), so nothing was uploaded and nothing released. It reaches
      // the same dead end as a failed push - the revert exists only in the working
      // copy - but it is NOT the same situation and must not borrow that message:
      // `push_failed` tells the user they are holding the write lock and can Retry
      // from the banner, and here they are holding nothing. Sending them to a Retry
      // that cannot work is worse than saying plainly that they were signed out.
      return { kind: 'not_editing' };
    },
    [t, showToast, done],
  );

  return useCallback(
    async ({
      projectId,
      projectName,
      hexsha,
      shortSha,
      message,
      discardLocal = false,
      resumeAtPush = false,
      onStep,
    }: RevertRevisionArgs): Promise<RevertOutcome> => {
      // The restore already landed and the lock is still ours, so the upload is the
      // only step outstanding - see `resumeAtPush`. Deliberately AHEAD of the
      // pre-flight below: the restore is what set the bit that guard tests, so
      // running it here would refuse the retry over the revert's own tree.
      if (resumeAtPush) return publish({ message, shortSha, onStep });

      // Pre-flight, deliberately BEFORE any IPC: a copy with un-pushed edits will be
      // refused by the restore anyway, so taking the lock first would block another
      // user for the duration of a call we already know fails. Read fresh from the
      // store rather than from a render snapshot - an autosave or a poll can have
      // flipped the bit since the dialog last rendered.
      if (!discardLocal && (useSpeleoStore.getState().link?.hasUnpushedEdits ?? false)) {
        return { kind: 'needs_discard', lockHeld: false };
      }

      onStep?.('locking');
      if (!(await startEditing())) {
        // `startEditing` resolves false for three different reasons, and only one of
        // them leaves anything for us to say.
        if (useSpeleoStore.getState().divergence !== null) {
          // The backend released the lock it took, and App.tsx has already swapped in
          // the divergence dialog over ours. Nothing to unwind, nothing to report.
          return { kind: 'diverged' };
        }
        const link = useSpeleoStore.getState().link;
        // `useSpeleoActions` has already toasted the holder; report it so the dialog
        // stays open and the user can retry once they release.
        if (link?.lockedByOther) return { kind: 'locked_by', email: link.lockHolder };
        return { kind: 'lock_failed' };
      }

      onStep?.('restoring');
      try {
        // Quiet: this restore is a middle step, and its toast tells the user to push -
        // which is precisely what the next line does for them.
        await restoreRevision({
          projectId,
          projectName,
          hexsha,
          shortSha,
          restore: true,
          discardLocal,
          quiet: true,
        });
      } catch (e) {
        const refusedForLocalEdits = unpushedLocalEdits(e);
        // Ask the BACKEND whether the copy is dirty, because that is the bit
        // `speleodb_done` decides on - `message: None` selects the commit message,
        // it does not suppress the upload. Reading only the frontend mirror made
        // this release able to publish the very edits it was about to ask the user
        // to confirm discarding: the pre-flight above has already forced the local
        // bit to false on the `discardLocal: false` run, so `dirty` was false by
        // construction, while the backend row could be dirty from an autosave that
        // landed between the pre-flight and this call - which is one of the ways
        // the restore throws `unpushedLocalEdits` in the first place.
        //
        // That error IS the backend saying the bit is set, so it settles the
        // question on its own; the refresh covers the other failure kinds.
        if (!refusedForLocalEdits) await useSpeleoStore.getState().refreshLinkStatus();
        const dirty =
          refusedForLocalEdits || (useSpeleoStore.getState().link?.hasUnpushedEdits ?? false);
        // Hand the lock back ONLY while the copy is clean. `done(null)` is the one
        // release verb that both skips the push (the dirty bit is clear, so there is
        // nothing to upload) and drops the edit gate. While the copy IS dirty we keep
        // the lock on purpose: releasing would strand the user's own un-pushed work
        // with nothing protecting it, and `done(message)` would publish edits they
        // never asked to publish.
        //
        // `lockHeld` answers "am I now holding a lock I did not have?", so it must
        // key on whether a lock IS held, not on whether this release succeeded.
        // Folding every non-`released` answer into `true` made `not_editing` - the
        // edit gate having already dropped under us, usually a 401 auto-drop - report
        // "You still hold the write lock" for a gate that was demonstrably gone. A
        // thrown release (`null`) genuinely leaves it unknown, and staying on the
        // pessimistic answer there is right: being told to check a lock we no longer
        // hold is a wasted trip, being told nothing about one we DO hold is a
        // stranded server mutex.
        let lockHeld = true;
        if (!dirty) {
          const resolved = await done(null);
          const kind = resolved ? asDoneKind(resolved.kind) : null;
          lockHeld = !(kind === 'released' || kind === 'not_editing');
        }
        if (unpushedLocalEdits(e)) return { kind: 'needs_discard', lockHeld };
        return {
          kind: 'restore_failed',
          message: humanizeSpeleoError(e, t('speleodb.revert.errors.restorePrefix', { sha: shortSha })),
          lockHeld,
        };
      }

      return publish({ message, shortSha, onStep });
    },
    [t, startEditing, done, restoreRevision, publish],
  );
}
