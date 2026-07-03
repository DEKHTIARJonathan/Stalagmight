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
  const refreshProjectState = useProjectStore((s) => s.refreshProjectState);
  const refreshLinkStatus = useSpeleoStore((s) => s.refreshLinkStatus);

  return useCallback(
    async ({ projectId, projectName, hexsha, shortSha, restore }: RestoreRevisionArgs) => {
      await invokeIpc<SpeleoOpenResult>('speleodb_restore_revision', {
        projectId,
        projectName,
        hexsha,
        restore,
      });
      // The backend closed + reopened the project at the swapped tree; pull the new
      // geometry + link state in. The on-disk copy IS the checked-out tree (saved),
      // so it is clean until the user edits.
      setView('single');
      await refreshProjectState();
      useProjectStore.setState({ isDirty: false });
      await refreshLinkStatus();
      showToast(
        restore
          ? t('speleodb.restore.doneToast', { sha: shortSha })
          : t('speleodb.restore.viewToast', { sha: shortSha }),
        'speleodb-restore',
      );
    },
    [t, showToast, setView, refreshProjectState, refreshLinkStatus],
  );
}
