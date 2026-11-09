import { confirm } from '@tauri-apps/plugin-dialog';
import { useProjectStore } from '../store/projectStore';
import { useSpeleoStore } from '../store/speleoStore';
import { useUIStore } from '../store/uiStore';
import { discardWorkspaceDrafts, hasWorkspaceDrafts } from './workspaceDrafts';

/** Account replacement protects both forms and the unsaved survey snapshot. */
export async function protectAccountTransition(): Promise<boolean> {
  const before = useProjectStore.getState();
  const project = before.project;
  const generation = useSpeleoStore.getState().sessionGeneration;
  if (!before.isDirty && !hasWorkspaceDrafts()) return true;
  const accepted = await confirm('Discard unsaved form and survey changes before changing the account or server?', {
    kind: 'warning', okLabel: 'Discard changes', cancelLabel: 'Cancel',
  });
  if (!accepted || useProjectStore.getState().project !== project ||
      useSpeleoStore.getState().sessionGeneration !== generation) return false;
  discardWorkspaceDrafts();
  if (!before.isDirty) return true;
  const closed = await useProjectStore.getState().closeProject();
  if (!closed.success) return false;
  if (project?.file_path) {
    const opened = await useProjectStore.getState().loadProject(project.file_path, { accessConfirmed: true, acquireLock: false });
    return opened.success;
  }
  useUIStore.getState().setView('global');
  return true;
}
