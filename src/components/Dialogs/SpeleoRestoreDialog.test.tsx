/**
 * Component test (#218) - the restore-revision confirm. On confirm it runs
 * speleodb_restore_revision then reloads the project; it warns about unsaved
 * changes, and surfaces a failure without reloading. Restore never fires on
 * mount or cancel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/ipc', () => ({
  invokeIpc: invokeIpcMock,
  getErrorMessage: (_e: unknown, f?: string) => f ?? 'error',
}));

import SpeleoRestoreDialog from './SpeleoRestoreDialog';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore } from '../../store/speleoStore';

let closeDialogMock: ReturnType<typeof vi.fn>;
let showToastMock: ReturnType<typeof vi.fn>;
let refreshProjectStateMock: ReturnType<typeof vi.fn>;
let refreshLinkStatusMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokeIpcMock.mockReset();
  closeDialogMock = vi.fn();
  showToastMock = vi.fn();
  refreshProjectStateMock = vi.fn(async () => {});
  refreshLinkStatusMock = vi.fn(async () => {});
  useUIStore.setState({
    closeDialog: closeDialogMock,
    showToast: showToastMock,
    setView: vi.fn(),
    dialogData: { projectId: 'p1', projectName: 'Cave A', hexsha: 'abcdef0123', shortSha: 'abcdef01' },
  });
  useProjectStore.setState({ refreshProjectState: refreshProjectStateMock, isDirty: false });
  useSpeleoStore.setState({ refreshLinkStatus: refreshLinkStatusMock });
});

describe('SpeleoRestoreDialog (#218)', () => {
  it('does not restore on mount or cancel', async () => {
    render(<SpeleoRestoreDialog />);
    expect(screen.getByTestId('speleodb-restore-dialog')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('speleodb-restore-cancel'));
    expect(invokeIpcMock.mock.calls.some((c) => c[0] === 'speleodb_restore_revision')).toBe(false);
    expect(closeDialogMock).toHaveBeenCalled();
  });

  it('confirm restores the revision then refreshes the swapped tree', async () => {
    invokeIpcMock.mockResolvedValue({ local_path: '/cache/p1.stalx', concurrent_session: false });
    render(<SpeleoRestoreDialog />);
    await userEvent.click(screen.getByTestId('speleodb-restore-confirm-btn'));

    // The backend reopened the restored tree; the FE pulls the swapped geometry +
    // link state (not loadProject, which would short-circuit on the open project).
    await waitFor(() => expect(refreshProjectStateMock).toHaveBeenCalled());
    expect(refreshLinkStatusMock).toHaveBeenCalled();
    const call = invokeIpcMock.mock.calls.find((c) => c[0] === 'speleodb_restore_revision');
    expect(call?.[1]).toEqual({
      projectId: 'p1',
      projectName: 'Cave A',
      hexsha: 'abcdef0123',
      restore: true,
    });
    expect(closeDialogMock).toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalled();
  });

  it('warns about unsaved changes when the project is dirty', () => {
    useProjectStore.setState({ isDirty: true });
    render(<SpeleoRestoreDialog />);
    expect(screen.getByTestId('speleodb-restore-unsaved-warning')).toBeInTheDocument();
  });

  it('surfaces an error and does not refresh when the restore fails', async () => {
    invokeIpcMock.mockRejectedValue({ message: 'offline' });
    render(<SpeleoRestoreDialog />);
    await userEvent.click(screen.getByTestId('speleodb-restore-confirm-btn'));

    await waitFor(() =>
      expect(screen.getByTestId('speleodb-restore-error')).toBeInTheDocument(),
    );
    expect(refreshProjectStateMock).not.toHaveBeenCalled();
  });
});
