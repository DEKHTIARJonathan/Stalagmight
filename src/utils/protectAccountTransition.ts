import i18n from '../i18n';
import { useProjectStore } from '../store/projectStore';
import { useSpeleoStore } from '../store/speleoStore';
import { useUIStore } from '../store/uiStore';
import { isProjectRequestCurrent, reserveProjectRequest } from './projectTransition';
import { discardWorkspaceDrafts } from './workspaceDrafts';
import { askExitConfirm } from './exitConfirm';

/**
 * Account replacement protects the unsaved survey snapshot.
 *
 * SpeleoDB locks and un-uploaded work are NOT this guard's business: the sign-out
 * guard (`utils/speleoSignOut`) runs first and resolves them (upload / discard /
 * hand back). Nor are SpeleoDB form drafts the account change itself drops: the
 * caller asks about those first (`confirmWorkspaceDrafts`). What is left here is
 * unsaved edits outside a held lock: the project is reopened from disk without
 * them, which also drops any draft still tied to it - asked in-app, like every
 * exit prompt.
 */
export async function protectAccountTransition(): Promise<boolean> {
  const before = useProjectStore.getState();
  const project = before.project;
  const generation = useSpeleoStore.getState().sessionGeneration;
  if (!before.isDirty) return true;
  const request = reserveProjectRequest();
  const current = () => isProjectRequestCurrent(request) &&
    useSpeleoStore.getState().sessionGeneration === generation;
  const ownsProject = () => current() && useProjectStore.getState().project === project;
  const accepted = await askExitConfirm({
    title: i18n.t('speleoExitPrompt.account.title'),
    message: i18n.t('speleoExitPrompt.account.message'),
    confirmLabel: i18n.t('speleoExitPrompt.account.confirm'),
    cancelLabel: i18n.t('common.actions.cancel'),
  });
  if (!accepted || !ownsProject()) return false;
  discardWorkspaceDrafts();
  const closed = await useProjectStore.getState().closeProject({ request, isCurrent: ownsProject });
  if (!closed.success || !current() || useProjectStore.getState().project !== null) return false;
  if (project?.file_path) {
    const opened = await useProjectStore.getState().loadProject(project.file_path, { accessConfirmed: true, acquireLock: false, request });
    return opened.success && current();
  }
  useUIStore.getState().setView('global');
  return true;
}
