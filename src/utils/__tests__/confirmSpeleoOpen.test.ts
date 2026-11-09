import { beforeEach, expect, it, vi } from 'vitest';
import { confirmSpeleoFileOpen, confirmSpeleoOpen } from '../confirmSpeleoOpen';
import type { SpeleoProjectSummary } from '../../types/ipc.generated';

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: mocks.confirm }));
vi.mock('../ipc', () => ({ invokeIpc: mocks.invoke }));
const project: SpeleoProjectSummary = {
  id: 'synthetic', name: 'Synthetic', permission: 'READ_AND_WRITE',
  lock_holder: 'editor@example.com', type_tag: 'STALAGMIGHT', latest_commit_sha: null,
};
beforeEach(() => {
  mocks.confirm.mockReset();
  mocks.invoke.mockReset();
});
it.each(['READ_ONLY', 'READ_AND_WRITE'] as const)('does not warn from potentially stale %s listing metadata', async (permission) => {
  expect(await confirmSpeleoOpen({ ...project, permission })).toBe(true);
  expect(mocks.confirm).not.toHaveBeenCalled();
});
it('retains local metadata preflight without showing an advance lock warning', async () => {
  mocks.invoke.mockResolvedValue({ project, verification: 'unavailable' });
  expect(await confirmSpeleoFileOpen('/synthetic.stalx', () => true, true)).toBe(true);
  expect(mocks.invoke).toHaveBeenCalledWith('speleodb_project_access_at', { path: '/synthetic.stalx', localOnly: true });
  expect(mocks.confirm).not.toHaveBeenCalled();
});
it('suppresses a probe that lost request ownership', async () => {
  mocks.invoke.mockResolvedValue({ project });
  expect(await confirmSpeleoFileOpen('/synthetic.stalx', () => false)).toBe(false);
});
