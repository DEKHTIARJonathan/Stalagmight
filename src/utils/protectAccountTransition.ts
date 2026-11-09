import { confirm } from '@tauri-apps/plugin-dialog';
import { useProjectStore } from '../store/projectStore';
import { useSpeleoStore } from '../store/speleoStore';
import { useUIStore } from '../store/uiStore';
import { isProjectRequestCurrent, reserveProjectRequest } from './projectTransition';
import { discardWorkspaceDrafts, hasWorkspaceDrafts } from './workspaceDrafts';

/** Account replacement protects both forms and the unsaved survey snapshot. */
export async function protectAccountTransition(): Promise<boolean> {
  const before = useProjectStore.getState();
  const project = before.project;
  const generation = useSpeleoStore.getState().sessionGeneration;
  if (!before.isDirty && !hasWorkspaceDrafts()) return true;
  const request = reserveProjectRequest();
  const current = () => isProjectRequestCurrent(request) &&
    useSpeleoStore.getState().sessionGeneration === generation;
  const ownsProject = () => current() && useProjectStore.getState().project === project;
  const accepted = await confirm('Discard unsaved form and survey changes before changing the account or server?', {
    kind: 'warning', okLabel: 'Discard changes', cancelLabel: 'Cancel',
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
