import { beforeEach, expect, it, vi } from 'vitest';
import { dispatchProjectSave } from '../dispatchProjectSave';
import { setUploadContinuation } from '../uploadContinuation';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore, type SpeleoLinkState } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';
vi.mock('../ipc', () => ({ invokeIpc: vi.fn(), getErrorMessage: String }));
const link: SpeleoLinkState = { permission: 'READ_AND_WRITE', editState: 'editing', lockHolder: null,
  lockedByOther: false, hasUnpushedEdits: true, unwound: false, undoMode: 'full', remoteState: 'up_to_date', noAccess: false, serverError: null };
beforeEach(() => {
  setUploadContinuation(null);
  useProjectStore.setState({ project: { file_path: '/synthetic.stalx' } as never, isDirty: false, saveProject: vi.fn(async () => ({ success: true }) as never) });
  useSpeleoStore.setState({ link: null });
  useUIStore.setState({ openDialog: vi.fn(), showToast: vi.fn() });
});
it('keeps local Save local', async () => {
  await dispatchProjectSave();
  expect(useProjectStore.getState().saveProject).toHaveBeenCalledOnce();
  expect(useUIStore.getState().openDialog).not.toHaveBeenCalled();
});
it.each(['editing', 'read-only'] as const)('uses upload confirmation for a remote %s session without uploading immediately', async (editState) => {
  useSpeleoStore.setState({ link: { ...link, editState } });
  await dispatchProjectSave({ closeAfterSave: true });
  expect(useUIStore.getState().openDialog).toHaveBeenCalledWith('speleodb-done', { mode: 'push', closeAfterSave: true });
  expect(useProjectStore.getState().saveProject).not.toHaveBeenCalled();
});
it('reports no changes without creating an empty upload', async () => {
  useSpeleoStore.setState({ link: { ...link, hasUnpushedEdits: false } });
  await dispatchProjectSave();
  expect(useUIStore.getState().showToast).toHaveBeenCalledWith('No changes to upload', expect.any(String), 'info');
  expect(useUIStore.getState().openDialog).not.toHaveBeenCalled();
});
it('retains the close continuation across recovery', async () => {
  useSpeleoStore.setState({ link });
  setUploadContinuation({ path: '/synthetic.stalx', message: 'Retained description', closeAfterSave: true });
  await dispatchProjectSave();
  expect(useUIStore.getState().openDialog).toHaveBeenCalledWith('speleodb-done', { mode: 'push', closeAfterSave: true });
});
