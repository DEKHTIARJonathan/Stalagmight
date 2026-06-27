import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectStore } from '../projectStore';
import { useUIStore } from '../uiStore';
import { EDIT_DISABLED, READ_ONLY_EDIT_NOTICE } from '../../utils/editErrors';

const invokeIpcMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
}));

/**
 * #191 read-only edit gate — executeCommand failure handling. When the backend
 * rejects a mutation on a remote project opened read-only it RETURNS
 * `{success:false, error:"EDIT_DISABLED…"}` (a struct, not a throw). executeCommand
 * must then:
 *  (a) ALWAYS re-sync the view to backend truth, discarding any optimistic edit —
 *      the load-bearing guard against the "shots vanish on drag" regression (a
 *      committed drag preview was left stranded because the success-only refresh
 *      never fired); this also holds on a genuine IPC throw (re-sync, then re-throw);
 *  (b) surface ONE friendly read-only toast, while NON-read-only failures stay
 *      silent here (dialogs render their own inline error — no double message).
 */
describe('projectStore executeCommand failure handling (#191 read-only gate)', () => {
  let showToast: ReturnType<typeof vi.fn>;
  let refreshProjectState: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    refreshProjectState = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({
      refreshProjectState,
      checkProjectIntegrity: vi.fn().mockResolvedValue(undefined),
    } as Partial<ReturnType<typeof useProjectStore.getState>> as never);
    showToast = vi.fn();
    useUIStore.setState({
      showToast,
    } as Partial<ReturnType<typeof useUIStore.getState>> as never);
  });

  it('re-syncs the view AND shows the read-only notice on an EDIT_DISABLED rejection', async () => {
    invokeIpcMock.mockResolvedValue({
      success: false,
      error: `${EDIT_DISABLED}: Move section is disabled: this SpeleoDB project is open read-only.`,
    });

    const result = await useProjectStore.getState().moveSection(1, { x: 1, y: 2, z: 0 });

    expect(result.success).toBe(false);
    // (a) anti-"vanishing shots": a rejected edit re-syncs to backend truth.
    expect(refreshProjectState).toHaveBeenCalled();
    // (b) one friendly read-only toast.
    expect(showToast).toHaveBeenCalledWith(READ_ONLY_EDIT_NOTICE, 'edit-disabled');
  });

  it('re-syncs but does NOT toast on a non-read-only failure (dialogs own inline errors)', async () => {
    invokeIpcMock.mockResolvedValue({ success: false, error: 'Invalid offset' });

    await useProjectStore.getState().moveSection(1, { x: 1, y: 2, z: 0 });

    expect(refreshProjectState).toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('re-syncs then re-throws on a genuine IPC rejection (no stranded optimistic edit)', async () => {
    invokeIpcMock.mockRejectedValue(new Error('transport down'));

    await expect(
      useProjectStore.getState().moveSection(1, { x: 1, y: 2, z: 0 })
    ).rejects.toThrow('transport down');

    // The throw must still re-sync (so a committed drag preview can't be stranded),
    // then propagate so callers' existing error handling is unchanged.
    expect(refreshProjectState).toHaveBeenCalled();
  });
});
