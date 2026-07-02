/**
 * Component test (#207) - the Create-on-SpeleoDB Publish dialog.
 *
 * Covers the submit gating (name + country + valid coords), the `speleodb_publish`
 * payload, and the load-guard: a failed reopen must NOT claim success or close.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const invokeIpcMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/ipc', () => ({ invokeIpc: invokeIpcMock, getErrorMessage: (_e: unknown, f: string) => f }));

import PublishToSpeleoDbDialog from './PublishToSpeleoDbDialog';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';

let loadProjectMock: ReturnType<typeof vi.fn>;
let closeDialogMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokeIpcMock.mockReset();
  loadProjectMock = vi.fn(async () => ({ success: true }));
  closeDialogMock = vi.fn();
  useProjectStore.setState({
    project: { name: 'My Cave', zero_datums: [] } as never,
    loadProject: loadProjectMock,
  });
  useSpeleoStore.setState({
    refreshLinkStatus: vi.fn(async () => {}),
    clearSession: vi.fn(),
  });
  useUIStore.setState({ closeDialog: closeDialogMock, showToast: vi.fn() });
});

describe('PublishToSpeleoDbDialog', () => {
  it('gates Publish on a chosen country and publishes with the right params', async () => {
    invokeIpcMock.mockResolvedValue({
      project_id: 'p1',
      endpoint: 'https://x',
      local_path: '/cache/p1/project.stalx',
    });
    render(<PublishToSpeleoDbDialog />);

    // Name prefilled from the project; country still unchosen -> Publish disabled.
    expect(screen.getByTestId('publish-to-speleodb-dialog-name')).toHaveValue('My Cave');
    expect(screen.getByTestId('publish-to-speleodb-dialog-submit')).toBeDisabled();

    await userEvent.selectOptions(screen.getByTestId('publish-to-speleodb-dialog-country'), 'US');
    const submit = screen.getByTestId('publish-to-speleodb-dialog-submit');
    expect(submit).toBeEnabled();
    await userEvent.click(submit);

    await waitFor(() => {
      const call = invokeIpcMock.mock.calls.find((c) => c[0] === 'speleodb_publish');
      expect(call).toBeTruthy();
      expect(call![1]).toEqual({
        params: {
          name: 'My Cave',
          description: '',
          country: 'US',
          visibility: 'PRIVATE',
          latitude: null,
          longitude: null,
        },
      });
    });
    // Reloaded the now-remote project and closed on success.
    await waitFor(() => expect(loadProjectMock).toHaveBeenCalledWith('/cache/p1/project.stalx'));
    await waitFor(() => expect(closeDialogMock).toHaveBeenCalled());
  });

  it('does NOT close or claim success when the reopen fails', async () => {
    invokeIpcMock.mockResolvedValue({
      project_id: 'p1',
      endpoint: 'https://x',
      local_path: '/cache/p1/project.stalx',
    });
    loadProjectMock.mockResolvedValue({ success: false });
    render(<PublishToSpeleoDbDialog />);

    await userEvent.selectOptions(screen.getByTestId('publish-to-speleodb-dialog-country'), 'US');
    await userEvent.click(screen.getByTestId('publish-to-speleodb-dialog-submit'));

    await waitFor(() => expect(loadProjectMock).toHaveBeenCalled());
    expect(closeDialogMock).not.toHaveBeenCalled();
  });

  it('blocks submit on an out-of-range coordinate pair', async () => {
    render(<PublishToSpeleoDbDialog />);
    await userEvent.selectOptions(screen.getByTestId('publish-to-speleodb-dialog-country'), 'US');
    await userEvent.type(screen.getByTestId('publish-to-speleodb-dialog-latitude'), '999');
    await userEvent.type(screen.getByTestId('publish-to-speleodb-dialog-longitude'), '0');
    expect(screen.getByTestId('publish-to-speleodb-dialog-submit')).toBeDisabled();
    expect(screen.getByTestId('publish-to-speleodb-dialog-coords-error')).toBeInTheDocument();
  });
});
