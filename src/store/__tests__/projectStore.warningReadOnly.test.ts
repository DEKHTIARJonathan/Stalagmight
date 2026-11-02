/**
 * #576 NF-W2RO-2: resolving (Ignore) or reopening a validation warning on a project
 * the backend will not let the user edit - a SpeleoDB project without the lock, a
 * newer-version file, the Plan/Export workspace - is refused with the coded
 * EDIT_DISABLED error. These two actions call the IPC directly rather than through the
 * store's edit path, and swallowed that refusal with a console.error: the Ignore just
 * did not happen (or showed a bare "Could not apply the fix."), and the reopen gave no
 * feedback at all. They now show the same friendly read-only notice, under the same
 * key, as every other edit; any other failure keeps the resolve flow's own message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import { useProjectStore } from '../projectStore';
import { useUIStore } from '../uiStore';
import { TOAST_KEYS } from '../../utils/toastKeys';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/ipc', () => ({ invokeIpc: invokeIpcMock }));

const WORKSPACE_REFUSAL =
  'EDIT_DISABLED: WORKSPACE_READ_ONLY: Resolve warning is disabled in Plan and Export. Switch to Survey to edit.';

const toasts = () => useUIStore.getState().toasts.map((t) => [t.message, t.key, t.kind]);

beforeEach(() => {
  vi.clearAllMocks();
  useUIStore.setState({ toasts: [] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a refused warning resolve/unresolve says why (NF-W2RO-2)', () => {
  it('resolve: the read-only notice, and nothing reports a resolve', async () => {
    invokeIpcMock.mockRejectedValue(WORKSPACE_REFUSAL);
    const ok = await useProjectStore.getState().resolveWarning(1, 2, 'distance');

    expect(ok).toBe(false);
    expect(toasts()).toEqual([[i18n.t('editGate.workspaceReadOnlyNotice'), TOAST_KEYS.EDIT_DISABLED, 'warning']]);
  });

  it('unresolve: the read-only notice', async () => {
    invokeIpcMock.mockRejectedValue(WORKSPACE_REFUSAL);
    await useProjectStore.getState().unresolveWarning(1, 2, 'distance');

    expect(toasts()).toEqual([[i18n.t('editGate.workspaceReadOnlyNotice'), TOAST_KEYS.EDIT_DISABLED, 'warning']]);
  });

  it('resolve: any other failure keeps its own message, once', async () => {
    invokeIpcMock.mockRejectedValue('Shot not found');
    const ok = await useProjectStore.getState().resolveWarning(1, 2, 'distance');

    expect(ok).toBe(false);
    expect(toasts()).toEqual([[i18n.t('detailPanel.warnings.resolveFailed'), TOAST_KEYS.WARNING_RESOLVE, 'error']]);
  });
});
