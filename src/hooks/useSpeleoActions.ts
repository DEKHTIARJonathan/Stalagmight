import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';
import { useSpeleoStore, asPushKind, asDoneKind } from '../store/speleoStore';
import { invokeIpc } from '../utils/ipc';
import { speleoErrorAction, humanizeSpeleoError } from '../utils/speleoError';
import type {
  DoneResult,
  PushResult,
  StartEditingResult,
  UpdateResult,
} from '../types/ipc.generated';

/**
 * The single-writer hand-off verbs (#204), with backend-result routing. Keeps
 * the SpeleoEditBar / SpeleoDoneDialog presentational: each verb invokes the IPC,
 * feeds the result to the shared `speleoStore` (which owns the edit-state
 * transitions + #198 divergence / #200 banner seams), reloads the project on a
 * fast-forward (the backend swapped the tree in place), and surfaces outcomes as
 * toasts. A `ReLogin` error drops the session so the bar collapses to read-only.
 */
export interface SpeleoActions {
  busy: boolean;
  /** Acquire the write lock + reconcile. Resolves `true` only when we actually
      hold the lock afterwards (`editing` / `fast_forwarded`); `false` on a
      contended lock, a reported divergence, or a thrown call - all of which
      already surface their own toast / routing. Callers that hand the shell over
      on success (the held-lock prompt) MUST check it: treating a refusal as
      success there dismisses the prompt and discards the remaining locks. */
  startEditing: () => Promise<boolean>;
  /** #213 (E2): enter optimistic force-edit - edit WITHOUT the write lock (offline,
      or while someone else holds it). Gated on the `allow_force_edit` opt-in (the
      backend refuses otherwise) and behind a big-red destructive confirm; the caller
      must gate this on that confirm. Re-seeds the link (→ editing + `forceEditing`).
      Returns `true` only on success so the confirm dialog closes on success and stays
      open (error toast shown) on a backend refusal, rather than dismissing as if it
      worked. */
  forceEdit: () => Promise<boolean>;
  update: () => Promise<void>;
  /** Push edits without releasing the lock (T2d) - collects an optional message.
      Returns the backend outcome (or `null` if the call threw) so callers can keep
      a dialog open on a `divergence_needed` / `push_unconfirmed` result. */
  push: (message?: string | null) => Promise<PushResult | null>;
  /** The backend outcome, or `null` if the call threw. Callers key off `.kind`
      (e.g. the close flow only leaves once the lock is actually `released`). */
  done: (message?: string | null) => Promise<DoneResult | null>;
  /** #198 "Take remote": DISCARD local unpushed edits and reset to the server
      tip. Returns `true` once the tree is reloaded, `false` if the call threw.
      The caller must gate this behind a destroy-confirmation. */
  takeRemote: () => Promise<boolean>;
}

export function useSpeleoActions(): SpeleoActions {
  const { t } = useTranslation();
  // Shared busy so the status button and the hamburger submenu gate on the same
  // in-flight lock and can't double-issue a verb (fix 12).
  const busy = useSpeleoStore((s) => s.busy);
  const setBusy = useSpeleoStore((s) => s.setBusy);
  const showToast = useUIStore((s) => s.showToast);
  const loadProject = useProjectStore((s) => s.loadProject);
  const refreshProjectState = useProjectStore((s) => s.refreshProjectState);
  const clearSelection = useUIStore((s) => s.clearSelection);
  const applyStartEditing = useSpeleoStore((s) => s.applyStartEditing);
  const applyUpdate = useSpeleoStore((s) => s.applyUpdate);
  const applyDone = useSpeleoStore((s) => s.applyDone);
  const applyPush = useSpeleoStore((s) => s.applyPush);
  const bumpPoll = useSpeleoStore((s) => s.bumpPoll);
  const clearSession = useSpeleoStore((s) => s.clearSession);
  const refreshLinkStatus = useSpeleoStore((s) => s.refreshLinkStatus);
  const raiseNoAnchorBanner = useSpeleoStore((s) => s.raiseNoAnchorBanner);
  const raisePushFailedBanner = useSpeleoStore((s) => s.raisePushFailedBanner);
  const clearPushFailedBanner = useSpeleoStore((s) => s.clearPushFailedBanner);

  // #200 (D2): a push/unlock of a survey with NO georeferenced zero datum means the
  // server generates no new web-viewer GeoJSON. Surface the non-blocking notice; the
  // push itself already succeeded and is never blocked. Checked from the local
  // project (the same zero-datum set export_tml roots the .tml anchor on).
  const noteNoAnchorIfNeeded = useCallback(() => {
    if ((useProjectStore.getState().project?.zero_datums.length ?? 0) === 0) {
      raiseNoAnchorBanner();
    }
  }, [raiseNoAnchorBanner]);

  // A confirmed push/unlock already flushed the survey to disk (the backend's
  // speleodb_upload runs save_project before the upload), but the projectStore's
  // `isDirty` flag is a separate concept that stays set until the FE saves. Left
  // alone it clears only on the 30s autosave debounce, so exiting in that window
  // fires a false "Unsaved Changes" prompt for edits that are already on disk (and
  // pushed to SpeleoDB). Re-flush from the FE now to clear `isDirty` immediately;
  // saveProject writes the current in-memory state, so a late edit is captured too.
  // Best-effort and quiet (autosave semantics): a failed flush leaves `isDirty` set,
  // which is the safe direction since the push already persisted the same edits.
  const flushToDiskAfterPush = useCallback(async () => {
    try {
      await useProjectStore.getState().saveProject(undefined, true);
    } catch {
      /* best-effort; isDirty stays set, which safely re-prompts on exit */
    }
  }, []);

  /** Toast the failure and return the humanized line, so a caller that also wants a
      durable surface (#260's push-failure banner) reuses the exact same wording. */
  const handleError = useCallback(
    (e: unknown, prefixKey: string): string => {
      // A dead token collapses the shell to read-only (mirrors the backend gate
      // drop); other errors are transient - surface and let the user retry.
      if (speleoErrorAction(e) === 'ReLogin') clearSession();
      const message = humanizeSpeleoError(e, t(prefixKey));
      showToast(message, 'speleodb-action-error', 'error');
      return message;
    },
    [clearSession, showToast, t],
  );

  const startEditing = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await invokeIpc<StartEditingResult>('speleodb_start_editing');
      applyStartEditing(result);
      switch (result.kind) {
        case 'editing':
          showToast(t('speleodb.editBar.toasts.editing'), 'speleodb-editing', 'success');
          break;
        case 'fast_forwarded':
          // Backend swapped the tree; reload so the view matches. loadProject
          // short-circuits when the backend reopened the SAME path (its "already
          // open" guard returns without re-reading), so pull the swapped geometry +
          // link state in explicitly - otherwise the old tree stays on screen. Clear
          // the (section_id, station_index)-keyed selection, which the swapped tree may
          // not carry (loadProject's full path clears it; this path bypasses it).
          clearSelection();
          await loadProject(result.local_path);
          await refreshProjectState();
          // Re-scan integrity: the fast-forwarded tree can differ structurally from the
          // one on screen (identity-guarded, fire-and-forget).
          void useProjectStore.getState().checkProjectIntegrity();
          await refreshLinkStatus();
          break;
        case 'locked_by':
          showToast(
            t('speleodb.editBar.toasts.lockedBy', {
              email: result.email ?? t('speleodb.editBar.someone'),
            }),
            'speleodb-locked-by',
            'warning',
          );
          // Someone else holds it - we did NOT get the lock.
          return false;
        case 'divergence_needed':
          // #198 seam: applyStartEditing recorded the divergence origin. The
          // divergence dialog decides what happens next; nothing is held yet.
          return false;
        default: {
          // A variant this frontend has not been taught must NOT fall through to
          // the permissive `return true` below. That answer means "we hold the
          // lock", and callers act on it destructively: the held-lock prompt
          // dismisses itself AND discards every remaining lock, with no way to
          // re-raise it until the next login scan. The `never` binding makes a new
          // backend variant a COMPILE error here; at runtime it answers "no".
          const _exhaustive: never = result;
          void _exhaustive;
          console.warn('[speleodb] unhandled start-editing result:', result);
          return false;
        }
      }
      return true;
    } catch (e) {
      handleError(e, 'speleodb.editBar.toasts.startFailed');
      return false;
    } finally {
      // Reset the poll timer so the next poll is a full interval out - a buffer
      // past the just-issued lock change the server mutex may not yet reflect (1b).
      bumpPoll();
      setBusy(false);
    }
  }, [applyStartEditing, loadProject, refreshProjectState, refreshLinkStatus, clearSelection, showToast, t, handleError, setBusy, bumpPoll]);

  const forceEdit = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    try {
      // No result payload: the backend flips the edit gate + force-edit flag.
      // Re-seed the link so `editState → editing` and `forceEditing → true` drive
      // the read-only badge off and the big-red banner on.
      await invokeIpc<null>('speleodb_force_edit');
      await refreshLinkStatus();
      showToast(t('speleodb.forceEdit.toasts.active'), 'speleodb-force-edit', 'warning');
      return true;
    } catch (e) {
      // Backend refusal (opt-in off / link lost / already lock-held): surface the
      // toast and report failure so the confirm dialog stays open instead of
      // dismissing as if force-edit engaged.
      handleError(e, 'speleodb.forceEdit.toasts.failed');
      return false;
    } finally {
      bumpPoll();
      setBusy(false);
    }
  }, [refreshLinkStatus, showToast, t, handleError, setBusy, bumpPoll]);

  const update = useCallback(async () => {
    setBusy(true);
    try {
      const result = await invokeIpc<UpdateResult>('speleodb_update');
      applyUpdate(result);
      switch (result.kind) {
        case 'up_to_date':
          showToast(t('speleodb.editBar.toasts.upToDate'), 'speleodb-up-to-date');
          break;
        case 'fast_forwarded':
          // See startEditing: the FF reload swapped the tree in the backend, but
          // loadProject short-circuits on the reopened path - pull geometry + link
          // state in so Update actually resets the view to the new tip. Clear the stale
          // selection for the same reason as the startEditing arm.
          clearSelection();
          await loadProject(result.local_path);
          await refreshProjectState();
          // Re-scan integrity: the fast-forwarded tree can differ structurally from the
          // one on screen (identity-guarded, fire-and-forget).
          void useProjectStore.getState().checkProjectIntegrity();
          await refreshLinkStatus();
          break;
        case 'divergence_needed':
          break;
      }
    } catch (e) {
      handleError(e, 'speleodb.editBar.toasts.updateFailed');
    } finally {
      bumpPoll();
      setBusy(false);
    }
  }, [applyUpdate, loadProject, refreshProjectState, refreshLinkStatus, clearSelection, showToast, t, handleError, setBusy, bumpPoll]);

  const push = useCallback(
    async (message?: string | null): Promise<PushResult | null> => {
      setBusy(true);
      // A fresh attempt supersedes the previous failure banner (#260); a landed push
      // clears the whole slot via applyPush, and a new throw re-raises it below.
      clearPushFailedBanner();
      try {
        const result = await invokeIpc<PushResult>('speleodb_push', { message: message ?? null });
        applyPush(result);
        const kind = asPushKind(result.kind);
        if (kind === 'pushed') {
          showToast(t('speleodb.editBar.toasts.pushed'), 'speleodb-pushed', 'success');
          noteNoAnchorIfNeeded();
          await flushToDiskAfterPush();
        } else if (kind === 'not_editing') {
          // Nothing was uploaded: the edit gate was already closed (a 401 auto-drop
          // is the common way in, and the push-failure banner's Retry is the common
          // way to re-issue from there). A green "Changes pushed to SpeleoDB." here
          // was a lie that also cost the flush + no-anchor check their meaning, so
          // say what actually happened and name the way out.
          showToast(t('speleodb.editBar.toasts.notEditing'), 'speleodb-not-editing', 'warning');
        }
        // divergence_needed / push_unconfirmed surface via the store (#198/#200 seams);
        // the returned kind lets the dialog stay open to resolve them.
        return result;
      } catch (e) {
        // Toast (immediate) AND banner (durable): the toast auto-clears after 3 s, so
        // without the banner a failed upload left no surface at all (#260).
        const humanized = handleError(e, 'speleodb.editBar.toasts.pushFailed');
        raisePushFailedBanner({
          message: humanized,
          origin: 'push',
          pushMessage: message ?? null,
        });
        return null;
      } finally {
        bumpPoll();
        setBusy(false);
      }
    },
    [
      applyPush,
      showToast,
      t,
      handleError,
      setBusy,
      bumpPoll,
      noteNoAnchorIfNeeded,
      flushToDiskAfterPush,
      raisePushFailedBanner,
      clearPushFailedBanner,
    ],
  );

  const done = useCallback(
    async (message?: string | null): Promise<DoneResult | null> => {
      setBusy(true);
      clearPushFailedBanner();
      // #260: "Changes uploaded and the write lock released." lied whenever there was nothing to
      // upload (releasing a lock taken but never edited against). The remote dirty bit
      // is the one that means "local edits not yet on the server" - projectStore's
      // `isDirty` is the unrelated unsaved-to-disk flag - and `done` clears it, so read
      // it BEFORE the call.
      const hadUnpushedEdits = useSpeleoStore.getState().link?.hasUnpushedEdits ?? false;
      try {
        const result = await invokeIpc<DoneResult>('speleodb_done', { message: message ?? null });
        applyDone(result);
        switch (asDoneKind(result.kind)) {
          case 'released':
            showToast(
              hadUnpushedEdits
                ? t('speleodb.editBar.toasts.released')
                : t('speleodb.editBar.toasts.releasedNothingToUpload'),
              'speleodb-released',
              'success',
            );
            noteNoAnchorIfNeeded();
            await flushToDiskAfterPush();
            break;
          case 'push_unconfirmed':
            // #200 seam: applyDone raised the push_unconfirmed banner.
            break;
          case 'divergence_needed':
            // #198 seam: applyDone recorded the divergence origin.
            break;
          case 'not_editing':
            // No lock was held, so nothing was uploaded AND nothing was released.
            // `applyDone` deliberately left the dirty bit alone; callers key off
            // `kind === 'released'`, so the close/quit dialogs correctly stay open.
            showToast(t('speleodb.editBar.toasts.notEditing'), 'speleodb-not-editing', 'warning');
            break;
        }
        return result;
      } catch (e) {
        const humanized = handleError(e, 'speleodb.editBar.toasts.doneFailed');
        raisePushFailedBanner({
          message: humanized,
          origin: 'done',
          pushMessage: message ?? null,
        });
        return null;
      } finally {
        bumpPoll();
        setBusy(false);
      }
    },
    [
      applyDone,
      showToast,
      t,
      handleError,
      setBusy,
      bumpPoll,
      noteNoAnchorIfNeeded,
      flushToDiskAfterPush,
      raisePushFailedBanner,
      clearPushFailedBanner,
    ],
  );

  const takeRemote = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    try {
      // Backend re-pulls + resets the tree to the server tip and returns the
      // reloaded path; loadProject re-seeds the link status (→ read-only).
      const localPath = await invokeIpc<string>('speleodb_take_remote');
      // If the reload was superseded (the user opened another project mid-pull),
      // don't claim success: the backend reset already happened, but the view the
      // caller thinks it reloaded is not showing. Skip the toast + return false so
      // the divergence dialog doesn't close over a project the user left.
      const { success } = await loadProject(localPath);
      if (!success) return false;
      showToast(t('speleodb.editBar.toasts.tookRemote'), 'speleodb-took-remote', 'success');
      return true;
    } catch (e) {
      handleError(e, 'speleodb.editBar.toasts.takeRemoteFailed');
      return false;
    } finally {
      bumpPoll();
      setBusy(false);
    }
  }, [loadProject, showToast, t, handleError, setBusy, bumpPoll]);

  return { busy, startEditing, forceEdit, update, push, done, takeRemote };
}
