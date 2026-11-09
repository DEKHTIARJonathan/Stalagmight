import { getUploadContinuation } from './uploadContinuation';
import { useProjectStore } from '../store/projectStore';
import { useSpeleoStore } from '../store/speleoStore';
import { useUIStore } from '../store/uiStore';
import { saveProjectAs } from './projectActions';
import { getErrorMessage } from './ipc';
import { surfaceSaveFailure } from './saveFeedback';

/** Explicit Save only. Autosave and autosave retry call saveProject directly. */
export async function dispatchProjectSave(opts?: { closeAfterSave?: boolean }) {
  const state = useProjectStore.getState();
  const ui = useUIStore.getState();
  const link = useSpeleoStore.getState().link;
  if (!state.project) return null;
  if (link) {
    if (!link.hasUnpushedEdits && !state.isDirty && !opts?.closeAfterSave && link.editState === 'editing') {
      ui.showToast('No changes to upload', 'speleodb-no-upload-changes', 'info');
      return null;
    }
    const pending = getUploadContinuation(state.project.file_path);
    ui.openDialog('speleodb-done', { mode: 'push', closeAfterSave: opts?.closeAfterSave === true || pending?.closeAfterSave === true });
    return null;
  }
  if (!state.project.file_path) return saveProjectAs(opts);
  try {
    const result = await state.saveProject();
    if (result && !result.success) surfaceSaveFailure(result.error, ui.openDialog);
    return result;
  } catch (error) {
    const message = getErrorMessage(error, 'Failed to save');
    surfaceSaveFailure(message, ui.openDialog);
    return { success: false, error: message };
  }
}
