import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';
import { useSpeleoStore } from '../store/speleoStore';
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
}

/**
 * Shared "check a SpeleoDB revision out into the working copy" flow (#218), used by
 * both the read-only View action and the editable Restore confirm. The backend
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
      });
      // The backend closed + reopened the project at the swapped tree; pull the new
      // geometry + link state in. The on-disk copy IS the checked-out tree (saved),
      // so it is clean until the user edits. Clear the selection first: it is keyed by
      // (section_id, station_index) which the swapped tree may not carry, so a stale
      // selection could highlight a different station (loadProject's full path clears
      // it too; this swap path bypasses that path).
      clearSelection();
      setView('single');
      await refreshProjectState();
      useProjectStore.setState({ isDirty: false });
      // The swapped-in revision can carry a different structural-integrity profile than
      // the tree that was on screen; re-scan so the banner reflects the checked-out
      // tree instead of the pre-swap one (fire-and-forget, identity-guarded).
      void useProjectStore.getState().checkProjectIntegrity();
      await refreshLinkStatus();
      showToast(
        restore
          ? t('speleodb.restore.doneToast', { sha: shortSha })
          : t('speleodb.restore.viewToast', { sha: shortSha }),
        'speleodb-restore',
        // A completed restore rewrote the tree; "now viewing revision X" is just
        // a statement of where you are.
        restore ? 'success' : 'info',
      );
    },
    [t, showToast, setView, clearSelection, refreshProjectState, refreshLinkStatus],
  );
}
