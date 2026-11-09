import i18n from '../i18n';
import { useProjectStore } from '../store/projectStore';
import { useSpeleoStore } from '../store/speleoStore';
import { useUIStore } from '../store/uiStore';
import { isProjectRequestCurrent, reserveProjectRequest } from './projectTransition';
import { discardWorkspaceDrafts, hasWorkspaceDrafts } from './workspaceDrafts';
import { askExitConfirm } from './exitConfirm';

/**
 * Account replacement protects both forms and the unsaved survey snapshot.
 *
 * SpeleoDB locks and un-uploaded work are NOT this guard's business: the sign-out
 * guard (`utils/speleoSignOut`) runs first and resolves them (upload / discard /
 * hand back). What is left here is form drafts and unsaved edits outside a held
 * lock, which the account change discards - asked in-app, like every exit prompt.
 */
export async function protectAccountTransition(): Promise<boolean> {
  const before = useProjectStore.getState();
  const project = before.project;
  const generation = useSpeleoStore.getState().sessionGeneration;
  if (!before.isDirty && !hasWorkspaceDrafts()) return true;
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
  if (!before.isDirty) return true;
  const closed = await useProjectStore.getState().closeProject({ request, isCurrent: ownsProject });
  if (!closed.success || !current() || useProjectStore.getState().project !== null) return false;
  if (project?.file_path) {
    const opened = await useProjectStore.getState().loadProject(project.file_path, { accessConfirmed: true, acquireLock: false, request });
    return opened.success && current();
  }
  useUIStore.getState().setView('global');
  return true;
}
