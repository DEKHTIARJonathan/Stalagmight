import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';
import { useSpeleoStore } from '../store/speleoStore';
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
  startEditing: () => Promise<void>;
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

  const handleError = useCallback(
    (e: unknown, prefixKey: string) => {
      // A dead token collapses the shell to read-only (mirrors the backend gate
      // drop); other errors are transient - surface and let the user retry.
      if (speleoErrorAction(e) === 'ReLogin') clearSession();
      showToast(humanizeSpeleoError(e, t(prefixKey)), 'speleodb-action-error');
    },
    [clearSession, showToast, t],
  );

  const startEditing = useCallback(async () => {
    setBusy(true);
    try {
      const result = await invokeIpc<StartEditingResult>('speleodb_start_editing');
      applyStartEditing(result);
      switch (result.kind) {
        case 'editing':
          showToast(t('speleodb.editBar.toasts.editing'), 'speleodb-editing');
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
          );
          break;
        case 'divergence_needed':
          // #198 seam: applyStartEditing recorded the divergence origin.
          break;
      }
    } catch (e) {
      handleError(e, 'speleodb.editBar.toasts.startFailed');
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
      showToast(t('speleodb.forceEdit.toasts.active'), 'speleodb-force-edit');
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
      try {
        const result = await invokeIpc<PushResult>('speleodb_push', { message: message ?? null });
        applyPush(result);
        if (result.kind === 'pushed') {
          showToast(t('speleodb.editBar.toasts.pushed'), 'speleodb-pushed');
          noteNoAnchorIfNeeded();
          await flushToDiskAfterPush();
        }
        // divergence_needed / push_unconfirmed surface via the store (#198/#200 seams);
        // the returned kind lets the dialog stay open to resolve them.
        return result;
      } catch (e) {
        handleError(e, 'speleodb.editBar.toasts.pushFailed');
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
    ],
  );

  const done = useCallback(
    async (message?: string | null): Promise<DoneResult | null> => {
      setBusy(true);
      try {
        const result = await invokeIpc<DoneResult>('speleodb_done', { message: message ?? null });
        applyDone(result);
        switch (result.kind) {
          case 'released':
            showToast(t('speleodb.editBar.toasts.released'), 'speleodb-released');
            noteNoAnchorIfNeeded();
            await flushToDiskAfterPush();
            break;
          case 'push_unconfirmed':
            // #200 seam: applyDone raised the push_unconfirmed banner.
            break;
          case 'divergence_needed':
            // #198 seam: applyDone recorded the divergence origin.
            break;
        }
        return result;
      } catch (e) {
        handleError(e, 'speleodb.editBar.toasts.doneFailed');
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
    ],
  );

  const takeRemote = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    try {
      // Backend re-pulls + resets the tree to the server tip IN PLACE (close +
      // reopen), discarding the local edits. It stays the same open path, so
      // loadProject would short-circuit on the "already open" guard WITHOUT
      // re-reading - leaving the just-discarded edits on screen under a success
      // toast (agent-harness campaign ws15). Pull the swapped geometry + link
      // state in explicitly, exactly as update()'s fast_forwarded arm and restore
      // do. Clear the (section_id, station_index)-keyed selection first: the reset
      // tree may not carry it.
      await invokeIpc<string>('speleodb_take_remote');
      clearSelection();
      await refreshProjectState();
      // The reset tree can differ structurally from the diverged one on screen;
      // re-scan so the integrity banner reflects the server version (fire-and-forget).
      void useProjectStore.getState().checkProjectIntegrity();
      await refreshLinkStatus();
      showToast(t('speleodb.editBar.toasts.tookRemote'), 'speleodb-took-remote');
      return true;
    } catch (e) {
      handleError(e, 'speleodb.editBar.toasts.takeRemoteFailed');
      return false;
    } finally {
      bumpPoll();
      setBusy(false);
    }
  }, [
    clearSelection,
    refreshProjectState,
    refreshLinkStatus,
    showToast,
    t,
    handleError,
    setBusy,
    bumpPoll,
  ]);

  return { busy, startEditing, forceEdit, update, push, done, takeRemote };
}
